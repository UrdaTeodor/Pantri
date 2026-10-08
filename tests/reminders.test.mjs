// Reminder notifications: the daily digest schedule (pure logic), the push helpers, and the upload
// sync against a test double of the cloud module (tests/fixtures/cloud-stub.js).
// Reminder times are local: this file pins a European time zone, so the daylight-saving week is the
// same everywhere (it must be set before the app modules load, hence the dynamic imports).
process.env.TZ = 'Europe/Berlin';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';

// The app modules import ./cloud.js; load the test double instead of the real (Supabase) module.
const STUB = new URL('./fixtures/cloud-stub.js', import.meta.url).href;
registerHooks({
  resolve(specifier, context, nextResolve) {
    const resolved = nextResolve(specifier, context);
    return resolved.url.endsWith('/app/js/cloud.js') ? { ...resolved, url: STUB, shortCircuit: true } : resolved;
  },
});

globalThis.__PANTRI_STUB__ = { configured: true, signedIn: false };
const { defaultSettings, analyze, todayLists, ymd, DAY } = await import('../app/js/model.js');
const { buildSchedule, listsAt, reminderTimes, digestText, startReminderSync, syncReminders, reminderStatus } = await import('../app/js/reminders.js');
const { keyBytes, deviceLabel } = await import('../app/js/push.js');
const store = await import('../app/js/store.js');

const at = (month, day, h = 9, m = 0) => new Date(2026, month - 1, day, h, m).getTime();
const MON = at(10, 12, 8); // Monday 12 October 2026, 08:00

function pantry({ settings = {}, products = [], batches = [], locations = [] } = {}) {
  return { settings: { ...defaultSettings(), ...settings }, locations, products, batches, events: [], shopping: [], meta: {} };
}
const product = (id, over = {}) => ({
  id, name: id, unit: 'pcs', barcodes: [], rate: null, minStock: 0, locationId: null, anchorAt: MON, countedAt: MON,
  countedQty: 0, addedAt: null, touchedAt: MON, createdAt: MON, snoozeUntil: null, orderedAt: null, ...over,
});
const batch = (id, productId, qty, expiry = null, over = {}) => ({ id, productId, qty, expiry, locationId: null, addedAt: MON, ...over });
const days = items => items.map(x => [new Date(x.sendAt).getDate(), x.body]);

test('one digest a day at the reminder time; quiet days are left out', () => {
  // Water runs low on Friday and out on Saturday; the yogurt is "use soon" from Friday, expired from the 24th.
  const state = pantry({
    products: [product('Water', { rate: { qty: 5, per: 'day' }, minStock: 6, countedQty: 24 }), product('Yogurt')],
    batches: [batch('w', 'Water', 24), batch('y', 'Yogurt', 3, '2026-10-23')],
  });
  const items = buildSchedule(state, { now: MON });
  assert.deepEqual(items[0], {
    sendAt: '2026-10-16T07:00:00.000Z', title: 'Pantri', body: '1 to check: Water · 1 to use soon: Yogurt', url: './#/', tag: 'pantri-daily',
  });
  assert.deepEqual(days(items), [
    ...[16, 17, 18, 19, 20, 21, 22, 23].map(d => [d, '1 to check: Water · 1 to use soon: Yogurt']),
    [24, '1 to check: Water · 1 expired: Yogurt'],
    [25, '1 to check: Water · 1 expired: Yogurt'], // the daylight-saving change: still 09:00 local
  ]);
  assert.equal(items.at(-1).sendAt, '2026-10-25T08:00:00.000Z');
  // Every digest is what the Today screen lists at that moment.
  for (const x of items) {
    const t = Date.parse(x.sendAt);
    const l = todayLists(analyze(state, t), state.settings, t);
    assert.equal(x.body, digestText(l));
  }
});

test('a snoozed check comes back after the snooze; nothing at all means no reminders', () => {
  const state = pantry({
    products: [product('Milk', { rate: { qty: 1, per: 'day' }, countedQty: 1, snoozeUntil: at(10, 14, 0) })],
    batches: [batch('m', 'Milk', 1)],
  });
  assert.deepEqual(days(buildSchedule(state, { now: MON, days: 4 })), [[14, '1 to check: Milk'], [15, '1 to check: Milk']]);
  assert.deepEqual(buildSchedule(pantry({ products: [product('Rice')], batches: [batch('r', 'Rice', 2)] }), { now: MON }), []);
  assert.deepEqual(buildSchedule(pantry(), { now: MON }), []);
});

test('with several sites the digest is grouped per site, in site order', () => {
  const locations = [
    { id: 'wh', name: 'Warehouse', parentId: null, order: 0 },
    { id: 'ap', name: 'Apartment', parentId: null, order: 1 },
    { id: 'fr', name: 'Fridge', parentId: 'ap', order: 0 },
  ];
  const gone = { rate: { qty: 2, per: 'day' }, countedQty: 1, anchorAt: MON - DAY, locationId: 'wh' };
  const state = pantry({
    locations,
    products: [product('Water', gone), product('Juice', gone), product('Milk', { locationId: 'fr' })],
    batches: [batch('w', 'Water', 1), batch('j', 'Juice', 1), batch('m', 'Milk', 1, '2026-10-11', { locationId: 'fr' })],
  });
  assert.equal(buildSchedule(state, { now: MON })[0].body, 'Warehouse: 2 to check · Apartment: 1 expired');

  // A batch is counted where it is; products without a site come last.
  state.products.push(product('Rice', { locationId: 'wh' }), product('Salt'));
  state.batches.push(batch('r', 'Rice', 1, '2026-10-10', { locationId: 'ap' }), batch('s', 'Salt', 1, '2026-10-13'));
  assert.equal(buildSchedule(state, { now: MON })[0].body,
    'Warehouse: 2 to check · Apartment: 2 expired · Not at a site: 1 to use soon');
});

test('respects the settings: expiry warnings off, opening hours, reminder time', () => {
  const state = pantry({
    settings: { warnDays: 0 },
    products: [product('Milk'), product('Eggs', { rate: { qty: 1, per: 'day' }, countedQty: 10 })],
    batches: [batch('m', 'Milk', 1, '2026-10-14'), batch('e', 'Eggs', 10, '2026-10-16')], // ~5 eggs won't be used in time
  });
  // No "use soon" at all (not even "won't be used in time"); expired items still are reported.
  assert.deepEqual(days(buildSchedule(state, { now: MON, days: 5 })), [[15, '1 expired: Milk'], [16, '1 expired: Milk']]);
  state.settings.warnDays = 7;
  assert.deepEqual(days(buildSchedule(state, { now: MON, days: 2 })), [[12, '2 to use soon: Milk, Eggs'], [13, '2 to use soon: Milk, Eggs']]);

  // 6 coffee packs at 1 a day: gone by Sunday morning, or — with opening hours Mon–Fri 09:00–18:00 —
  // not before Tuesday (the weekend doesn't count, and on Monday at 08:30 the day hasn't started yet).
  const coffee = settings => pantry({
    settings: { reminderTime: '08:30', ...settings },
    products: [product('Coffee', { rate: { qty: 1, per: 'day' }, countedQty: 6, anchorAt: at(10, 12, 9) })],
    batches: [batch('c', 'Coffee', 6)],
  });
  assert.deepEqual(days(buildSchedule(coffee({}), { now: MON, days: 9 })).map(([d]) => d), [18, 19, 20]);
  const office = buildSchedule(coffee({ hoursOn: true }), { now: MON, days: 9 });
  assert.deepEqual(days(office), [[20, '1 to check: Coffee']]);
  assert.equal(office[0].sendAt, '2026-10-20T06:30:00.000Z');
});

test('reminder times: today only if not passed yet, then one per calendar day across DST changes', () => {
  const iso = ts => ts.map(t => new Date(t).toISOString());
  assert.deepEqual(iso(reminderTimes('09:00', at(10, 12, 8, 59), 2)), ['2026-10-12T07:00:00.000Z', '2026-10-13T07:00:00.000Z']);
  assert.deepEqual(iso(reminderTimes('09:00', at(10, 12, 9, 0), 2)), ['2026-10-13T07:00:00.000Z', '2026-10-14T07:00:00.000Z']);
  assert.deepEqual(iso(reminderTimes('18:30', at(10, 12, 19), 1)), ['2026-10-13T16:30:00.000Z']);
  // Clocks go back on Sunday 25 October: still 09:00 local, so 25 hours apart once.
  const autumn = reminderTimes('09:00', at(10, 23, 10), 4);
  assert.deepEqual(iso(autumn), ['2026-10-24T07:00:00.000Z', '2026-10-25T08:00:00.000Z', '2026-10-26T08:00:00.000Z', '2026-10-27T08:00:00.000Z']);
  assert.deepEqual(autumn.map(t => new Date(t).getHours()), [9, 9, 9, 9]);
  // …and forward on Sunday 28 March 2027.
  assert.deepEqual(iso(reminderTimes('09:00', new Date(2027, 2, 27, 12).getTime(), 2)), ['2027-03-28T07:00:00.000Z', '2027-03-29T07:00:00.000Z']);
  assert.deepEqual(iso(reminderTimes('nonsense', at(10, 12, 8), 1)), ['2026-10-12T07:00:00.000Z']); // falls back to 09:00
  assert.equal(reminderTimes('09:00', MON, 14).length, 14);
});

test('digest text stays short: names only for one or two items per kind, counts otherwise', () => {
  const names = ['Still water 0.5 L', 'Paprika chips', 'Oat milk', 'A very long product name that goes on and on'];
  const item = name => ({ i: { product: { name }, siteId: null }, b: { siteId: null } });
  const lists = (checks, expired, soon) => ({ checks: checks.map(item), expired: expired.map(item), soon: soon.map(item), stale: [] });
  assert.equal(digestText(lists([], [], [])), '');
  assert.equal(digestText(lists(names.slice(0, 2), [names[3]], names.slice(0, 3))),
    '2 to check: Still water 0.5 L, Paprika chips · 1 expired: A very long product name th… · 3 to use soon');
  assert.equal(digestText(lists(['Yogurt', 'Yogurt'], [], [])), '2 to check: Yogurt'); // two batches of one product
  const long = Array.from({ length: 2 }, (_, k) => `${k} ${'Long name '.repeat(5)}`);
  assert.equal(digestText(lists(long, long, long)), '2 to check · 2 expired · 2 to use soon');
});

// ---------- the quick computation lists exactly what the Today screen would ----------

function random(seed) {
  return () => ((seed = (seed * 16807) % 2147483647) - 1) / 2147483646;
}

function randomPantry(rnd, n) {
  const pick = list => list[Math.floor(rnd() * list.length)];
  const sites = rnd() < 0.5 ? 1 : 3;
  const locations = [];
  for (let k = 0; k < sites; k++) {
    const schedule = rnd() < 0.3 ? { workdays: [1, 2, 3, 4, 5], dayStart: '08:00', dayEnd: '17:00', holidays: rnd() < 0.5 } : undefined;
    locations.push({ id: `s${k}`, name: `Site ${k}`, parentId: null, order: k, ...(schedule ? { schedule } : {}) });
    locations.push({ id: `s${k}-f`, name: 'Fridge', parentId: `s${k}`, order: 0 });
  }
  const places = [null, ...locations.map(l => l.id)];
  const settings = {
    hoursOn: rnd() < 0.4, warnDays: pick([0, 3, 7, 14]), staleDays: pick([0, 30]), reminderTime: pick(['07:15', '09:00', '18:00']),
    closed: rnd() < 0.3 ? [{ from: ymd(MON + 3 * DAY), to: ymd(MON + 5 * DAY), note: '' }] : [],
  };
  const products = [];
  const batches = [];
  for (let k = 0; k < n; k++) {
    const id = `p${k}`;
    const counted = MON - Math.floor(rnd() * 40) * DAY - Math.floor(rnd() * DAY);
    const minStock = pick([0, 0, 1, 3, 6]);
    products.push(product(id, {
      rate: rnd() < 0.7 ? { qty: pick([0.2, 0.5, 1, 2, 5, 3.5]), per: pick(['day', 'day', 'week', 'month']) } : null,
      minStock, anchorAt: counted, countedAt: counted, countedQty: rnd() < 0.2 ? minStock : 10, touchedAt: counted,
      addedAt: rnd() < 0.3 ? counted + DAY : null, locationId: pick(places),
      snoozeUntil: rnd() < 0.15 ? MON + Math.floor(rnd() * 10) * DAY : null,
    }));
    for (let j = Math.floor(rnd() * 4); j > 0; j--) {
      const expiry = rnd() < 0.75 ? ymd(MON + Math.floor(rnd() * 70 - 10) * DAY) : null;
      batches.push(batch(`${id}-${j}`, id, pick([1, 2, 3, 6, 12, 24, 0.5]), expiry, { locationId: rnd() < 0.8 ? null : pick(places), addedAt: counted - j }));
    }
  }
  return pantry({ settings, locations, products, batches });
}

const shape = l => JSON.stringify({
  checks: l.checks.map(c => [c.kind, c.i.product.id, c.i.siteId]),
  expired: l.expired.map(x => [x.i.product.id, x.b.batch.id, x.b.siteId]),
  soon: l.soon.map(x => [x.i.product.id, x.b.batch.id, x.b.siteId]),
});

test('the quick per-day lists equal analysing every day in full (random pantries)', () => {
  const rnd = random(20261012);
  let compared = 0;
  for (let k = 0; k < 80; k++) {
    const state = randomPantry(rnd, 25);
    const times = reminderTimes(state.settings.reminderTime, MON + Math.floor(rnd() * 3 * DAY), 14);
    const quick = listsAt(state, times);
    times.forEach((t, j) => {
      assert.equal(shape(quick[j]), shape(todayLists(analyze(state, t), state.settings, t)), `pantry ${k}, day ${j}`);
      compared++;
    });
  }
  assert.equal(compared, 80 * 14);
});

test('14 days of 300 products are worked out quickly', () => {
  const rnd = random(7);
  const products = [];
  const batches = [];
  // A realistic mix: most products tracked, a third of the batches perishable, counted within the last two months.
  for (let k = 0; k < 300; k++) {
    const counted = MON - Math.floor(rnd() * 60) * DAY - Math.floor(rnd() * DAY);
    products.push(product(`p${k}`, {
      rate: rnd() < 0.7 ? { qty: [5, 2, 1, 0.5, 0.2, 0.1][Math.floor(rnd() * 6)], per: 'day' } : null,
      minStock: Math.floor(rnd() * 4), anchorAt: counted, countedAt: counted, countedQty: 10, touchedAt: counted,
    }));
    for (let j = 1 + Math.floor(rnd() * 3); j > 0; j--) {
      const r = rnd();
      const expiry = r < 0.35 ? ymd(MON + Math.floor(2 + rnd() * 38) * DAY) : r < 0.7 ? ymd(MON + Math.floor(60 + rnd() * 600) * DAY) : null;
      batches.push(batch(`b${k}-${j}`, `p${k}`, 1 + Math.floor(rnd() * 24), expiry, { addedAt: counted + j }));
    }
  }
  const state = pantry({ products, batches });
  buildSchedule(state, { now: MON }); // warm up
  const t0 = performance.now();
  const items = buildSchedule(state, { now: MON });
  const ms = performance.now() - t0;
  console.log(`  300 products × 14 days: ${ms.toFixed(0)} ms`);
  assert.equal(items.length, 14);
  assert.ok(ms < 300, `took ${ms.toFixed(0)} ms`);
});

// ---------- push helpers ----------

test('push helpers: server key bytes and device names', () => {
  const key = 'BOHGjcrmyN9QKK0fEouSwr3Yd_wHiw4DmctL-IMGkZvlzCIP61NzKAMwDpcOaT_LnbGMqF4lg-yxpW925EvWJS4';
  const bytes = keyBytes(key);
  assert.equal(bytes.length, 65); // an uncompressed P-256 point
  assert.equal(bytes[0], 4);
  assert.equal(Buffer.from(bytes).toString('base64url'), key);
  const ua = {
    android: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Mobile Safari/537.36',
    iphone: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.6 Mobile/15E148 Safari/604.1',
    homeScreen: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148',
    samsung: 'Mozilla/5.0 (Linux; Android 13; SM-S911B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/25.0 Chrome/121.0.0.0 Mobile Safari/537.36',
    edge: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36 Edg/129.0.0.0',
    firefox: 'Mozilla/5.0 (Android 14; Mobile; rv:131.0) Gecko/131.0 Firefox/131.0',
  };
  assert.deepEqual(Object.values(ua).map(u => deviceLabel(u)), [
    'Android · Chrome', 'iPhone · Safari', 'iPhone', 'Android · Samsung Internet', 'Windows · Edge', 'Android · Firefox',
  ]);
});

// ---------- keeping the server up to date (cloud stub) ----------

async function until(check, what, ms = 2000) {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise(r => setTimeout(r, 5));
  }
}

test('sync: uploads after sign-in and changes, skips identical schedules, retries failures, clears when off', async () => {
  const cloud = globalThis.__cloudStub;
  const soon = days => ymd(Date.now() + days * DAY);
  const state = store.initialState(Date.now());
  state.settings.remindersOn = true;
  store.resetStore(state);
  store.createProduct({ name: 'Milk' }, { qty: 2, expiry: soon(2) });
  const stop = startReminderSync({ delay: 20 });
  try {
    await syncReminders();
    assert.equal(cloud.uploads, 0); // not signed in: nothing is sent

    cloud.setSignedIn(true);
    await until(() => cloud.uploads === 1, 'the upload after signing in');
    assert.ok(cloud.reminders.length >= 13 && cloud.reminders.every(x => x.tag === 'pantri-daily'));
    assert.match(cloud.reminders[0].body, /^1 to use soon: Milk$/);
    assert.equal(reminderStatus().schedule, cloud.reminders);

    await syncReminders();
    store.setCurrentSite(null); // a change that doesn't change the schedule
    await new Promise(r => setTimeout(r, 60));
    assert.equal(cloud.uploads, 1); // identical schedule: not sent again

    store.createProduct({ name: 'Bread' }, { qty: 1, expiry: soon(1) });
    await until(() => cloud.uploads === 2, 'the upload after a change');
    assert.match(cloud.reminders[0].body, /^2 to use soon: (Milk, Bread|Bread, Milk)$/);

    globalThis.__PANTRI_STUB__.fail = true; // the server can't be reached
    store.createProduct({ name: 'Cheese' }, { qty: 1, expiry: soon(1) });
    await until(() => reminderStatus().error, 'the failed upload');
    assert.equal(cloud.uploads, 2);
    globalThis.__PANTRI_STUB__.fail = false;
    await syncReminders(); // (the retry would come later on its own)
    assert.equal(cloud.uploads, 3);
    assert.equal(reminderStatus().error, '');
    assert.match(cloud.reminders[0].body, /^3 to use soon/);

    store.updateSettings({ remindersOn: false });
    await until(() => cloud.uploads === 4, 'clearing the schedule');
    assert.deepEqual(cloud.reminders, []);
    store.createProduct({ name: 'Eggs' }, { qty: 1, expiry: soon(1) });
    await new Promise(r => setTimeout(r, 60));
    assert.equal(cloud.uploads, 4); // off, and already cleared

    cloud.setSignedIn(false);
    store.updateSettings({ remindersOn: true });
    await new Promise(r => setTimeout(r, 60));
    assert.equal(cloud.uploads, 4); // signed out
    cloud.setSignedIn(true);
    await until(() => cloud.uploads === 5, 'the upload after signing in again');
    assert.match(cloud.reminders[0].body, /^4 to use soon/);
  } finally {
    stop();
  }
});
