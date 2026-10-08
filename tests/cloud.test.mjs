// Online sync decisions and engine (against an in-memory server), store.replaceState, and the Web Push
// sender used by the send-reminders function.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  plan, resolve, payloadOf, withLocalMeta, canonicalJson, contentHash, lastChange, createSync,
} from '../app/js/sync.js';
import * as store from '../app/js/store.js';
import {
  encryptPayload, importVapidKeys, vapidAuthorization, sendPush, fromBase64Url, toBase64Url,
} from '../supabase/functions/send-reminders/webpush.js';
import { subscriptionKeys, decryptPush, checkVapid } from './push-receiver.mjs';

// ---------- pure decisions ----------

test('plan: what to do from the revisions and local changes', () => {
  // First sync after signing in (baseRev 0).
  assert.equal(plan({ baseRev: 0, dirty: false, remote: null, localProducts: 3 }), 'upload'); // account has no copy
  assert.equal(plan({ baseRev: 0, dirty: false, remote: null, localProducts: 0 }), 'upload');
  assert.equal(plan({ baseRev: 0, dirty: true, remote: { rev: 4 }, localProducts: 0 }), 'pull'); // phone has no products
  assert.equal(plan({ baseRev: 0, dirty: false, remote: { rev: 4 }, localProducts: 2 }), 'compare'); // both may have data
  // Later syncs.
  assert.equal(plan({ baseRev: 4, dirty: false, remote: { rev: 4 }, localProducts: 2 }), 'none');
  assert.equal(plan({ baseRev: 4, dirty: true, remote: { rev: 4 }, localProducts: 2 }), 'upload');
  assert.equal(plan({ baseRev: 4, dirty: false, remote: { rev: 6 }, localProducts: 2 }), 'pull'); // newer online, nothing here
  assert.equal(plan({ baseRev: 4, dirty: true, remote: { rev: 6 }, localProducts: 2 }), 'compare'); // both changed
  assert.equal(plan({ baseRev: 4, dirty: true, remote: null, localProducts: 2 }), 'gone'); // deleted elsewhere
});

test('resolve: which copy stays', () => {
  const base = { localProducts: 2, remoteProducts: 3, localChangedAt: 2000, remoteChangedAt: 1000 };
  assert.equal(resolve({ ...base, firstSync: true, sameContent: true }), 'same');
  assert.equal(resolve({ ...base, firstSync: false, sameContent: true }), 'same');
  // First sync: an empty side gives way, otherwise ask.
  assert.equal(resolve({ ...base, firstSync: true, sameContent: false }), 'ask');
  assert.equal(resolve({ ...base, firstSync: true, sameContent: false, remoteProducts: 0 }), 'keep-local');
  assert.equal(resolve({ ...base, firstSync: true, sameContent: false, localProducts: 0 }), 'keep-remote');
  // Later: the newer change wins, whatever the sizes.
  assert.equal(resolve({ ...base, firstSync: false, sameContent: false }), 'keep-local');
  assert.equal(resolve({ ...base, firstSync: false, sameContent: false, remoteChangedAt: 3000 }), 'keep-remote');
  assert.equal(resolve({ ...base, firstSync: false, sameContent: false, localProducts: 0, remoteChangedAt: 1500 }), 'keep-local');
});

test('payload: this phone\'s own meta fields stay out, and are kept when taking the online copy', () => {
  const local = { products: [], batches: [], meta: { createdAt: 1, rev: 7, siteId: 'site-a', lastBackupAt: 5 } };
  assert.deepEqual(payloadOf(local).meta, { createdAt: 1 });
  const remote = { products: [{ id: 'p' }], batches: [], meta: { createdAt: 1, siteId: 'other', rev: 99 } };
  assert.deepEqual(withLocalMeta(remote, local).meta, { createdAt: 1, siteId: 'site-a', lastBackupAt: 5 });
  assert.deepEqual(withLocalMeta(remote, { meta: {} }).meta, { createdAt: 1 });
});

test('content hash ignores key order (Postgres reorders keys) and this phone\'s own fields', () => {
  const a = { products: [{ id: 'p', name: 'Tea', unit: 'box' }], batches: [], meta: { createdAt: 1, rev: 3 } };
  const b = { meta: { siteId: 's', createdAt: 1, rev: 9 }, batches: [], products: [{ unit: 'box', name: 'Tea', id: 'p' }] };
  assert.equal(canonicalJson({ b: 1, a: [2, { d: 3, c: undefined }] }), '{"a":[2,{"d":3}],"b":1}');
  assert.equal(contentHash(a), contentHash(b));
  assert.notEqual(contentHash(a), contentHash({ ...a, products: [{ id: 'p', name: 'Tea', unit: 'bag' }] }));
});

test('lastChange: newest event or product touch', () => {
  assert.equal(lastChange({ meta: { createdAt: 10 }, events: [{ at: 50 }, { at: 30 }], products: [{ touchedAt: 40 }] }), 50);
  assert.equal(lastChange({ meta: {}, events: [], products: [] }), null);
});

// ---------- the engine, against an in-memory server ----------

const pantry = (...names) => ({
  version: 1, settings: { warnDays: 7 }, locations: [], categories: [],
  products: names.map(n => ({ id: n, name: n })), batches: [], events: [], shopping: [], meta: { createdAt: 1 },
});
const names = s => s.products.map(p => p.name).sort();
/** Postgres hands JSON back with its keys in another order: so does the fake server. */
const reorder = v => (Array.isArray(v) ? v.map(reorder) : v && typeof v === 'object'
  ? Object.fromEntries(Object.keys(v).reverse().map(k => [k, reorder(v[k])])) : v);

/** Behaves like save_pantry / stash_pantry: compare-and-swap on rev, replaced copies into history. */
function fakeServer() {
  const server = { row: null, history: [], saves: 0 };
  server.api = device => ({
    async head() {
      const r = server.row;
      return r && { rev: r.rev, changedAt: r.changedAt, device: r.device, products: r.state.products.length };
    },
    async fetch() {
      const r = server.row;
      return r && { state: reorder(structuredClone(r.state)), rev: r.rev, changedAt: r.changedAt, device: r.device };
    },
    async save({ state, baseRev, changedAt, reason }) {
      server.saves++;
      if (!server.row) {
        if (baseRev) return { ok: false, reason: 'missing', rev: 0 };
        server.row = { state: structuredClone(state), rev: 1, changedAt, device };
        return { ok: true, rev: 1 };
      }
      if (server.row.rev !== baseRev) return { ok: false, reason: 'conflict', rev: server.row.rev };
      if (reason || server.row.device !== device) server.history.push({ ...server.row, reason: reason || 'other-device' });
      server.row = { state: structuredClone(state), rev: server.row.rev + 1, changedAt, device };
      return { ok: true, rev: server.row.rev };
    },
    async stash({ state, changedAt, reason }) {
      server.history.push({ state: structuredClone(state), rev: null, changedAt, device, reason });
    },
  });
  return server;
}

/** A phone: its own state (with meta.rev like store.js), sync bookkeeping and engine. */
function phone(server, clock, label, initial, wrap = api => api) {
  let state = { ...structuredClone(initial), meta: { ...initial.meta, rev: 1 } };
  let saved = null;
  const local = {
    getState: () => state,
    replaceState(next) {
      state = { ...structuredClone(next), meta: { ...structuredClone(next.meta), rev: state.meta.rev + 1 } };
      return state;
    },
  };
  const meta = { load: () => saved || { baseRev: 0, syncedRev: null, hash: null, changedAt: null, syncedAt: null }, save: m => (saved = m) };
  const engine = createSync({ api: wrap(server.api(label)), store: local, meta, now: () => clock.t });
  return {
    engine,
    get state() {
      return state;
    },
    get meta() {
      return meta.load();
    },
    /** A change made on this phone (store.js would notify cloud.js, which calls noteLocalChange). */
    change(fn) {
      const d = structuredClone(state);
      fn(d);
      d.meta.rev = state.meta.rev + 1;
      state = d;
      engine.noteLocalChange();
    },
    sync: opts => engine.syncOnce(opts),
  };
}

test('sign-in: an account without an online copy gets this phone\'s pantry; an empty phone takes it', async () => {
  const server = fakeServer();
  const clock = { t: 1000 };
  const a = phone(server, clock, 'A', pantry('Milk', 'Tea'));
  assert.deepEqual(await a.sync(), { action: 'uploaded' });
  assert.deepEqual(names(server.row.state), ['Milk', 'Tea']);
  assert.equal(server.row.state.meta.rev, undefined); // this phone's own fields aren't uploaded
  assert.equal(a.meta.baseRev, 1);
  assert.deepEqual(await a.sync(), { action: 'none' });

  const b = phone(server, clock, 'B', { ...pantry(), meta: { createdAt: 5, siteId: 'b-site' } });
  assert.deepEqual(await b.sync(), { action: 'pulled' });
  assert.deepEqual(names(b.state), ['Milk', 'Tea']);
  assert.equal(b.state.meta.siteId, 'b-site'); // the site this phone shows is its own business
  assert.deepEqual(await b.sync(), { action: 'none' });
  assert.equal(server.history.length, 0);
});

test('sign-in with a pantry on both sides: ask, and keep the other copy in the history', async () => {
  for (const choice of ['local', 'remote']) {
    const server = fakeServer();
    const clock = { t: 1000 };
    await phone(server, clock, 'A', pantry('Milk')).sync();
    clock.t = 2000;
    const b = phone(server, clock, 'B', pantry('Coffee', 'Sugar'));
    const asked = await b.sync();
    assert.equal(asked.action, 'ask');
    assert.deepEqual(asked.local.products, 2);
    // The first upload's "last change" comes from the copy's own data (created at 1 in this fixture).
    assert.deepEqual(asked.remote, { products: 1, changedAt: 1, device: 'A' });
    assert.equal(server.saves, 1); // nothing was replaced while asking

    const done = await b.sync({ choice });
    assert.equal(done.action, choice === 'local' ? 'kept-local' : 'kept-remote');
    const kept = choice === 'local' ? ['Coffee', 'Sugar'] : ['Milk'];
    const other = choice === 'local' ? ['Milk'] : ['Coffee', 'Sugar'];
    assert.deepEqual(names(server.row.state), kept);
    assert.deepEqual(names(b.state), kept);
    assert.equal(server.history.length, 1);
    assert.deepEqual(names(server.history[0].state), other);
    assert.equal(server.history[0].reason, 'first-sync');
  }
});

test('sign-in with identical pantries on both sides: no question', async () => {
  const server = fakeServer();
  const clock = { t: 1000 };
  await phone(server, clock, 'A', pantry('Milk')).sync();
  const b = phone(server, clock, 'B', pantry('Milk'));
  assert.deepEqual(await b.sync(), { action: 'same' });
  assert.equal(b.meta.baseRev, 1);
  assert.deepEqual(await b.sync(), { action: 'none' });
});

test('later changes: uploaded from one phone, pulled by the other', async () => {
  const server = fakeServer();
  const clock = { t: 1000 };
  const a = phone(server, clock, 'A', pantry('Milk'));
  const b = phone(server, clock, 'B', pantry());
  await a.sync();
  await b.sync();
  clock.t = 2000;
  a.change(d => d.products.push({ id: 'Tea', name: 'Tea' }));
  assert.deepEqual(await a.sync(), { action: 'uploaded' });
  assert.equal(server.row.changedAt, 2000);
  assert.deepEqual(await b.sync(), { action: 'pulled' });
  assert.deepEqual(names(b.state), ['Milk', 'Tea']);
});

test('only this phone\'s own fields changed: nothing is uploaded', async () => {
  const server = fakeServer();
  const clock = { t: 1000 };
  const a = phone(server, clock, 'A', pantry('Milk'));
  await a.sync();
  a.change(d => {
    d.meta.siteId = 'another-site';
  });
  assert.equal(a.engine.isDirty(), true);
  assert.deepEqual(await a.sync(), { action: 'none' });
  assert.equal(server.saves, 1);
  assert.equal(a.engine.isDirty(), false);
});

test('both phones changed: the newer change wins, the other copy goes into the history', async () => {
  for (const newer of ['A', 'B']) {
    const server = fakeServer();
    const clock = { t: 1000 };
    const a = phone(server, clock, 'A', pantry('Milk'));
    const b = phone(server, clock, 'B', pantry());
    await a.sync();
    await b.sync();
    // A changes while offline; B changes and uploads; then A comes back.
    clock.t = newer === 'A' ? 3000 : 2000;
    a.change(d => d.products.push({ id: 'Bread', name: 'Bread' }));
    clock.t = newer === 'A' ? 2000 : 3000;
    b.change(d => d.products.push({ id: 'Jam', name: 'Jam' }));
    assert.deepEqual(await b.sync(), { action: 'uploaded' });
    clock.t = 4000;
    const r = await a.sync();
    assert.equal(r.action, newer === 'A' ? 'kept-local' : 'kept-remote');
    assert.equal(r.conflict, true);
    const winner = newer === 'A' ? ['Bread', 'Milk'] : ['Jam', 'Milk'];
    const loser = newer === 'A' ? ['Jam', 'Milk'] : ['Bread', 'Milk'];
    assert.deepEqual(names(server.row.state), winner);
    assert.deepEqual(names(a.state), winner);
    // Nothing is lost: the other copy is in the history, marked as a conflict.
    const conflict = server.history.find(h => h.reason === 'conflict');
    assert.deepEqual(names(conflict.state), loser);
    assert.deepEqual(await b.sync(), newer === 'A' ? { action: 'pulled' } : { action: 'none' });
    assert.deepEqual(names(b.state), winner);
  }
});

test('another phone saves in between: compare-and-swap catches it, nothing is overwritten blindly', async () => {
  const server = fakeServer();
  const clock = { t: 1000 };
  let b = null;
  let interfere = false;
  const a = phone(server, clock, 'A', pantry('Milk'), api => ({
    ...api,
    async head() {
      const seen = await api.head();
      if (interfere) {
        // B's upload lands right after A looked at the online copy.
        interfere = false;
        clock.t = 2500;
        b.change(d => d.products.push({ id: 'Jam', name: 'Jam' }));
        await b.sync();
      }
      return seen;
    },
  }));
  b = phone(server, clock, 'B', pantry());
  await a.sync();
  await b.sync();
  clock.t = 2000;
  a.change(d => d.products.push({ id: 'Bread', name: 'Bread' }));
  interfere = true;
  clock.t = 3000;
  const r = await a.sync();
  // A's save named an old revision and was refused; then it was settled as a conflict: B's change
  // (2500) is newer than A's (2000), and A's version went into the history.
  assert.equal(r.action, 'kept-remote');
  assert.deepEqual(names(a.state), ['Jam', 'Milk']);
  assert.ok(server.history.some(h => h.reason === 'conflict' && names(h.state).includes('Bread')));
});

test('a change made while the online copy downloads is not overwritten', async () => {
  const server = fakeServer();
  const clock = { t: 1000 };
  let duringDownload = null;
  const a = phone(server, clock, 'A', pantry('Milk'), api => ({
    ...api,
    async fetch() {
      const copy = await api.fetch();
      if (duringDownload) duringDownload();
      duringDownload = null;
      return copy;
    },
  }));
  const b = phone(server, clock, 'B', pantry());
  await a.sync();
  await b.sync();
  clock.t = 2000;
  b.change(d => d.products.push({ id: 'Jam', name: 'Jam' }));
  await b.sync();
  // A pulls B's change, and A's user adds Bread just then.
  clock.t = 3000;
  duringDownload = () => a.change(d => d.products.push({ id: 'Bread', name: 'Bread' }));
  const r = await a.sync();
  // The download didn't replace the new change; it was settled as a conflict: A's change is newer.
  assert.equal(r.action, 'kept-local');
  assert.deepEqual(names(a.state), ['Bread', 'Milk']);
  assert.deepEqual(names(server.row.state), ['Bread', 'Milk']);
  assert.ok(server.history.some(h => h.reason === 'conflict' && names(h.state).includes('Jam')));
});

test('the online copy was deleted from another device: this phone is told, nothing is re-uploaded', async () => {
  const server = fakeServer();
  const clock = { t: 1000 };
  const a = phone(server, clock, 'A', pantry('Milk'));
  await a.sync();
  server.row = null;
  a.change(d => d.products.push({ id: 'Tea', name: 'Tea' }));
  assert.deepEqual(await a.sync(), { action: 'gone' });
  assert.equal(server.row, null);
});

// ---------- store ----------

test('store.replaceState: a whole new state, completed and announced, without an undo step', () => {
  store.resetStore(store.initialState(1000));
  const cat = store.getState().categories[0].id;
  store.deleteCategory(cat);
  assert.equal(store.canUndo(), true);
  const rev = store.getState().meta.rev;
  let told = 0;
  const off = store.subscribe(() => told++);
  const now = store.replaceState({ products: [{ id: 'p1', name: 'Tea' }], batches: [], meta: { createdAt: 5 } });
  off();
  assert.equal(told, 1);
  assert.equal(now, store.getState());
  assert.equal(store.canUndo(), false);
  assert.equal(now.meta.rev, rev + 1);
  assert.equal(now.products[0].unit, 'pcs'); // filled in like an imported backup
  assert.throws(() => store.replaceState({ hello: 1 }), /not a Pantri backup/);
});

// ---------- Web Push ----------

const RFC = {
  plaintext: 'When I grow up, I want to be a watermelon',
  asPublic: 'BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8',
  asPrivate: 'yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw',
  uaPublic: 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4',
  auth: 'BTBZMqHH6r4Tts7J_aSIgg',
  salt: 'DGv6ra1nlYgDCS1FRnbzlw',
  body: 'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN',
};

test('web push: encryption matches the example in RFC 8291', async () => {
  const pub = fromBase64Url(RFC.asPublic);
  const ecdh = { name: 'ECDH', namedCurve: 'P-256' };
  const keys = {
    publicKey: await crypto.subtle.importKey('raw', pub, ecdh, true, []),
    privateKey: await crypto.subtle.importKey('jwk', {
      kty: 'EC', crv: 'P-256', x: toBase64Url(pub.subarray(1, 33)), y: toBase64Url(pub.subarray(33)), d: RFC.asPrivate,
    }, ecdh, false, ['deriveBits']),
  };
  const body = await encryptPayload(RFC.plaintext, { p256dh: RFC.uaPublic, auth: RFC.auth }, { keys, salt: fromBase64Url(RFC.salt) });
  assert.equal(toBase64Url(body), RFC.body);
});

test('web push: a browser can decrypt our messages (fresh keys each time)', async () => {
  const sub = subscriptionKeys();
  const message = JSON.stringify({ title: 'Milk expires tomorrow', body: 'Kitchen › Fridge', url: './#/', tag: 'expiry' });
  const one = await encryptPayload(message, sub);
  const two = await encryptPayload(message, sub);
  assert.notEqual(toBase64Url(one), toBase64Url(two));
  assert.deepEqual(decryptPush(one, sub), { text: message, recordSize: 4096 });
  await assert.rejects(encryptPayload('x'.repeat(4000), sub), /too long/);
});

/** A key pair from tools/vapid.mjs. */
function vapidPair() {
  const out = execFileSync(process.execPath, [fileURLToPath(new URL('../tools/vapid.mjs', import.meta.url))], { encoding: 'utf8' });
  return { publicKey: /VAPID_PUBLIC_KEY=(\S+)/.exec(out)[1], privateKey: /VAPID_PRIVATE_KEY=(\S+)/.exec(out)[1] };
}

test('web push: VAPID keys from tools/vapid.mjs sign a valid header for the push service', async () => {
  const pair = vapidPair();
  const vapid = await importVapidKeys(pair.publicKey, pair.privateKey);
  const now = Date.UTC(2026, 9, 8, 12);
  const header = await vapidAuthorization(vapid, 'https://push.example.net/send/abc', 'mailto:admin@example.com', { now });
  const { valid, claims, publicKey } = checkVapid(header);
  assert.equal(valid, true);
  assert.equal(publicKey, pair.publicKey);
  assert.deepEqual(claims, { aud: 'https://push.example.net', exp: now / 1000 + 12 * 3600, sub: 'mailto:admin@example.com' });
  // A private key that isn't the public key's partner is caught at start-up.
  await assert.rejects(importVapidKeys(pair.publicKey, vapidPair().privateKey), /not a (valid key )?pair/);
  await assert.rejects(importVapidKeys('abc', pair.privateKey), /VAPID_PUBLIC_KEY/);
});

test('web push: sendPush posts an encrypted message and reports gone subscriptions', async () => {
  const pair = vapidPair();
  const vapid = await importVapidKeys(pair.publicKey, pair.privateKey);
  const sub = subscriptionKeys();
  const subscription = { endpoint: 'https://push.example.net/send/abc', p256dh: sub.p256dh, auth: sub.auth };
  const seen = [];
  const fetchFn = status => async (url, init) => {
    seen.push({ url, init });
    return new Response(status === 201 ? '' : 'nope', { status });
  };
  const ok = await sendPush(subscription, '{"title":"Hi"}', { vapid, subject: 'mailto:admin@example.com', fetchFn: fetchFn(201) });
  assert.deepEqual(ok, { status: 201, ok: true, gone: false, detail: '' });
  const { init } = seen[0];
  assert.equal(init.method, 'POST');
  assert.equal(init.headers['Content-Encoding'], 'aes128gcm');
  assert.equal(init.headers.TTL, '21600');
  assert.equal(checkVapid(init.headers.Authorization).valid, true);
  assert.equal(decryptPush(init.body, sub).text, '{"title":"Hi"}');
  for (const status of [404, 410]) {
    assert.equal((await sendPush(subscription, 'x', { vapid, subject: 'mailto:a@b.c', fetchFn: fetchFn(status) })).gone, true);
  }
  const failed = await sendPush(subscription, 'x', { vapid, subject: 'mailto:a@b.c', fetchFn: fetchFn(400) });
  assert.deepEqual(failed, { status: 400, ok: false, gone: false, detail: 'nope' });
});
