// Accounts, online sync and reminder pushes against the LOCAL Supabase stack (Edge headless).
// Needs Docker, `npx supabase start`, and supabase/functions/.env with the function secrets:
//   node tools/vapid.mjs --write supabase/functions/.env --cron-secret local-dev-cron-secret
// (then `npx supabase stop && npx supabase start` so the function sees them).
// Skips with a message (exit 0) when the local stack isn't running.
// Usage: node tests/cloud.e2e.mjs [outputDir]
import { chromium } from 'playwright-core';
import assert from 'node:assert/strict';
import { execSync, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer } from '../tools/serve.mjs';
import { subscriptionKeys, decryptPush, checkVapid } from './push-receiver.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.resolve(process.argv[2] || 'test-output');
fs.mkdirSync(outDir, { recursive: true });
const log = msg => console.log(`✔ ${msg}`);
const skip = msg => {
  console.log(`SKIPPED cloud tests: ${msg}`);
  process.exit(0);
};

// ---------- the local stack ----------

let stack;
try {
  stack = JSON.parse(execSync('npx --yes supabase status -o json', { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 60000 }));
} catch {
  skip('the local Supabase stack is not running (start it with `npx supabase start`).');
}
const API = stack.API_URL;
const KEY = stack.PUBLISHABLE_KEY || stack.ANON_KEY; // what goes into config.js
const SERVICE = stack.SERVICE_ROLE_KEY;
const MAIL = stack.MAILPIT_URL || stack.INBUCKET_URL;
if (!API || !KEY || !SERVICE) skip('`supabase status` did not list the API URL and keys.');
try {
  const health = await fetch(`${API}/auth/v1/health`, { headers: { apikey: KEY } });
  if (!health.ok) skip(`the local auth service answered ${health.status}.`);
} catch {
  skip(`nothing answers at ${API}.`);
}
const envFile = path.join(ROOT, 'supabase', 'functions', '.env');
if (!fs.existsSync(envFile)) skip('supabase/functions/.env is missing (see the top of this file).');
const env = Object.fromEntries(fs.readFileSync(envFile, 'utf8').split('\n').filter(l => /^\w+=/.test(l)).map(l => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1).trim()]));

/** PostgREST with the service role (bypasses RLS), for checking what is really stored. */
async function admin(query, { method = 'GET', body } = {}) {
  const res = await fetch(`${API}/rest/v1/${query}`, {
    method,
    headers: { apikey: SERVICE, Authorization: `Bearer ${SERVICE}`, 'Content-Type': 'application/json', Prefer: 'return=representation' },
    body: body && JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${query}: ${res.status} ${text}`);
  return text ? JSON.parse(text) : null;
}

/** An auth user as the admin API sees it, or null once deleted. */
async function authUser(id) {
  const res = await fetch(`${API}/auth/v1/admin/users/${id}`, { headers: { apikey: SERVICE, Authorization: `Bearer ${SERVICE}` } });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`admin user ${id}: ${res.status} ${await res.text()}`);
  return res.json();
}

/** SQL as postgres in the local database container. */
const sql = q => execFileSync('docker', ['exec', 'supabase_db_pantri', 'psql', '-U', 'postgres', '-At', '-c', q], { encoding: 'utf8' }).trim();

/** PostgREST as someone else: a signed-in user's token, or only the public key. */
const asUser = (token, query, init = {}) => fetch(`${API}/rest/v1/${query}`, {
  ...init,
  headers: { apikey: KEY, ...(token ? { Authorization: `Bearer ${token}` } : {}), 'Content-Type': 'application/json', ...init.headers },
});

async function waitFor(fn, what, timeout = 20000) {
  const end = Date.now() + timeout;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`Timed out waiting for ${what}`);
    await new Promise(r => setTimeout(r, 250));
  }
}

// ---------- a pretend push service ----------

const pushes = [];
const pushService = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', c => chunks.push(c));
  req.on('end', () => {
    pushes.push({ path: req.url, headers: req.headers, body: Buffer.concat(chunks) });
    res.writeHead(req.url.includes('/gone') ? 410 : 201).end();
  });
});
await new Promise(r => pushService.listen(0, '127.0.0.1', r));
// The function runs in Docker; host.docker.internal is this machine.
const PUSH_BASE = `http://host.docker.internal:${pushService.address().port}`;

// ---------- the app ----------

const server = await startServer({ port: 0 });
const problems = [];
const run = Date.now().toString(36);
const emailA = `a-${run}@example.com`;
const emailB = `b-${run}@example.com`;
const PASSWORD = 'correct-horse-7';

const browser = await chromium.launch({ channel: 'msedge', headless: true });
const contexts = [];

/** A phone: its own browser storage, the app configured for the local stack (unless `config` is false). */
async function device(name, { config = true } = {}) {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  contexts.push(context);
  // The committed config.js points at the production project: always override it (empty = not set up).
  await context.addInitScript(cfg => {
    globalThis.__PANTRI_CONFIG__ = cfg;
    localStorage.setItem('pantri-reminder-offer', JSON.stringify({ never: true })); // not testing the popup here
  }, config
    ? { SUPABASE_URL: API, SUPABASE_ANON_KEY: KEY, VAPID_PUBLIC_KEY: env.VAPID_PUBLIC_KEY || '' }
    : { SUPABASE_URL: '', SUPABASE_ANON_KEY: '', VAPID_PUBLIC_KEY: '' });
  const page = await context.newPage();
  page.requests = [];
  page.on('request', r => page.requests.push(r.url()));
  page.on('pageerror', e => problems.push(`[${name}] ${e.message}\n${e.stack}`));
  page.on('console', m => {
    // Failed requests while a phone is offline (or a refused sign-in) are expected.
    if (m.type() === 'error' && !/Failed to load resource|ERR_INTERNET_DISCONNECTED|net::ERR_/.test(m.text())) problems.push(`[${name}] ${m.text()}`);
  });
  page.ctx = context;
  await page.goto(server.url);
  await page.locator('.bar h1').first().waitFor();
  return page;
}

const go = async (page, hash) => {
  await page.goto(`${server.url}${hash}`);
  await page.locator('.bar h1').first().waitFor();
};
const status = page => page.evaluate(async () => (await import('./js/cloud.js')).cloudStatus());
const synced = page => waitFor(async () => {
  const s = await status(page);
  return s.signedIn && s.phase === 'synced' && !s.pending && s;
}, 'the phone to be synced');
const productNames = page => page.evaluate(async () => (await import('./js/store.js')).getState().products.map(p => p.name).sort());
const userId = page => page.evaluate(() => JSON.parse(localStorage.getItem('pantri-auth')).user.id);
const toast = page => page.locator('.toast').textContent();

async function addProduct(page, name, qty = '3') {
  await go(page, '#/new');
  await page.locator('#pf-name').fill(name);
  await page.locator('#pf-unit').fill('pcs');
  await page.locator('fieldset:has(legend:text("In stock right now")) .stepper input').fill(qty);
  await page.getByRole('button', { name: 'Save product' }).click();
  await page.waitForURL(/#\/product\//);
}

async function openAccount(page) {
  await go(page, '#/more');
  await page.locator('.row:has-text("Account & online backup")').click();
  await page.locator('.bar h1:text("Account & online backup")').waitFor();
}

async function signInForm(page, email, password, { create = false } = {}) {
  await openAccount(page);
  if (create) await page.getByRole('tab', { name: 'Create account' }).click();
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: create ? 'Create account' : 'Sign in', exact: true }).click();
}

try {
  // ---- 0. without cloud settings nothing changes and nothing is fetched ----
  const plain = await device('plain', { config: false });
  await go(plain, '#/more');
  assert.equal(await plain.locator('.row:has-text("Account")').count(), 0);
  await go(plain, '#/account'); // not a screen in this case
  assert.equal(await plain.locator('.bar h1').first().textContent(), 'Today');
  assert.ok(!plain.requests.some(u => u.includes('supabase') || u.startsWith(API)), 'no Supabase requests without settings');
  await plain.ctx.close();
  log('without Supabase settings: no account entry, no account screen, no Supabase requests');

  // ---- 1. sign up on phone A1; the client library is only loaded when needed ----
  const a1 = await device('A1');
  await go(a1, '#/more');
  assert.match(await a1.locator('.row:has-text("Account & online backup") .row-sub').textContent(), /Not signed in/);
  assert.ok(!a1.requests.some(u => u.endsWith('/vendor/supabase.js')), 'supabase.js is not part of the normal page load');
  await openAccount(a1);
  await a1.screenshot({ path: path.join(outDir, 'cloud-signin.png') });
  assert.ok(!a1.requests.some(u => u.endsWith('/vendor/supabase.js')), '…nor of the signed-out account screen');
  await signInForm(a1, emailA, PASSWORD, { create: true });
  await synced(a1);
  await a1.locator('.sync-line:has-text("Synced")').waitFor();
  assert.equal(await a1.locator('.account-email').textContent(), emailA);
  const uidA = await userId(a1);
  log('A1: account created (no email confirmation needed), first sync done');

  await addProduct(a1, 'Coffee beans');
  await synced(a1);
  let [row] = await admin(`pantries?user_id=eq.${uidA}&select=rev,state,device,products`);
  assert.deepEqual(row.state.products.map(p => p.name), ['Coffee beans']);
  assert.equal(row.products, 1);
  assert.equal(row.state.meta.rev, undefined); // this phone's own fields stay on the phone
  assert.match(row.device, /· Edge$/);
  await go(a1, '#/more');
  assert.match(await a1.locator('.row:has-text("Account & online backup") .row-sub').textContent(), /^Synced (just now|\d+ min ago)$/);
  await a1.screenshot({ path: path.join(outDir, 'cloud-more.png') });
  log(`A1: a new product is uploaded within seconds (online rev ${row.rev}); More shows "Synced …"`);

  // ---- 2. a second phone signs in to the same account and gets the pantry ----
  const a2 = await device('A2');
  await signInForm(a2, emailA, PASSWORD);
  await synced(a2);
  assert.deepEqual(await productNames(a2), ['Coffee beans']);
  await go(a2, '#/pantry');
  await a2.locator('.row-title:text-is("Coffee beans")').waitFor();
  log('A2: signed in to the same account, took the online pantry (it had none)');

  // A phone with a pantry of its own signs in: it asks which one to keep, and keeps the other one online.
  const a4 = await device('A4');
  await addProduct(a4, 'Only on this phone');
  await signInForm(a4, emailA, PASSWORD);
  await a4.locator('.sheet h2:has-text("Which one do you want to keep?")').waitFor();
  assert.match(await a4.locator('.sheet .menu-item:has-text("Use the online pantry") small').textContent(), /^1 product · last change .+ on \w+ · Edge$/);
  await a4.screenshot({ path: path.join(outDir, 'cloud-choose.png') });
  await a4.locator('.sheet .menu-item:has-text("Use the online pantry")').click();
  await synced(a4);
  assert.deepEqual(await productNames(a4), ['Coffee beans']);
  const firstSync = (await admin(`pantry_history?user_id=eq.${uidA}&select=reason,state`)).find(h => h.reason === 'first-sync');
  assert.deepEqual(firstSync.state.products.map(p => p.name), ['Only on this phone']);
  [row] = await admin(`pantries?user_id=eq.${uidA}&select=state`);
  assert.deepEqual(row.state.products.map(p => p.name), ['Coffee beans']);
  await a4.ctx.close();
  log('A4 had its own pantry: asked which to keep; took the online one, its own went into the online history');

  // ---- 3. both phones change the pantry at once: the newer change wins, nothing is lost ----
  await a1.ctx.setOffline(true);
  await addProduct(a1, 'Offline item');
  await waitFor(async () => (await status(a1)).phase === 'offline', 'A1 to notice it is offline');
  await addProduct(a2, 'Other item');
  await synced(a2);
  await a1.ctx.setOffline(false); // the 'online' event makes A1 sync
  await waitFor(async () => (await productNames(a1)).includes('Other item'), 'A1 to settle the conflict', 30000);
  await synced(a1);
  assert.match(await toast(a1), /Another device made newer changes/);
  assert.deepEqual(await productNames(a1), ['Coffee beans', 'Other item']);
  [row] = await admin(`pantries?user_id=eq.${uidA}&select=state`);
  assert.deepEqual(row.state.products.map(p => p.name).sort(), ['Coffee beans', 'Other item']);
  let history = await admin(`pantry_history?user_id=eq.${uidA}&select=id,reason,state&order=id.desc`);
  const lost = history.find(h => h.reason === 'conflict');
  assert.ok(lost, 'the losing copy is in the history');
  assert.deepEqual(lost.state.products.map(p => p.name).sort(), ['Coffee beans', 'Offline item']);
  log('conflict: A2\'s newer change was kept everywhere; A1\'s offline version is in the online history');

  // ...and it can be restored from the account screen.
  await openAccount(a1);
  await a1.getByRole('button', { name: 'Show earlier versions' }).click();
  await a1.locator('.row:has-text("Kept after a conflict")').first().click();
  await a1.locator('.sheet button:text("Restore")').click();
  await waitFor(async () => (await productNames(a1)).includes('Offline item'), 'the restore');
  assert.deepEqual(await productNames(a1), ['Coffee beans', 'Offline item']);
  [row] = await admin(`pantries?user_id=eq.${uidA}&select=state`);
  assert.deepEqual(row.state.products.map(p => p.name).sort(), ['Coffee beans', 'Offline item']);
  history = await admin(`pantry_history?user_id=eq.${uidA}&select=reason,state`);
  assert.ok(history.some(h => h.reason === 'restore' && h.state.products.some(p => p.name === 'Other item')));
  await openAccount(a2);
  await a2.getByRole('button', { name: 'Sync now' }).click();
  await waitFor(async () => (await productNames(a2)).includes('Offline item'), 'A2 to pull the restored version');
  await a1.screenshot({ path: path.join(outDir, 'cloud-account.png') });
  log('restored the conflict copy on A1 (the replaced one went into the history); A2 pulled it');

  // A phone that starts offline with an expired access token stays signed in, and syncs once online.
  await a2.reload(); // the service worker now controls the page and caches every file (also supabase.js)
  await synced(a2);
  await a2.evaluate(() => {
    const s = JSON.parse(localStorage.getItem('pantri-auth'));
    localStorage.setItem('pantri-auth', JSON.stringify({ ...s, expires_at: Math.floor(Date.now() / 1000) - 60 }));
  });
  await a2.ctx.setOffline(true);
  await a2.reload();
  await a2.locator('.bar h1').first().waitFor();
  await waitFor(async () => (await status(a2)).phase === 'offline', 'A2 to try and find itself offline');
  assert.equal((await status(a2)).signedIn, true);
  await a2.ctx.setOffline(false);
  await synced(a2);
  log('A2 started offline with an expired token: still signed in ("Offline"), synced once back online');

  // ---- 4. row-level security: user B sees none of A's data ----
  const signupB = await (await fetch(`${API}/auth/v1/signup`, {
    method: 'POST', headers: { apikey: KEY, 'Content-Type': 'application/json' }, body: JSON.stringify({ email: emailB, password: PASSWORD }),
  })).json();
  const tokenB = signupB.access_token;
  assert.ok(tokenB, 'user B signed up');
  for (const table of ['pantries', 'pantry_history', 'reminders', 'push_subscriptions']) {
    const res = await asUser(tokenB, `${table}?select=*`);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), [], `B reads nothing from ${table}`);
  }
  assert.ok((await asUser(null, 'pantries?select=*')).status >= 400, 'the public key alone reads nothing');
  const aHistoryId = (await admin(`pantry_history?user_id=eq.${uidA}&select=id&limit=1`))[0].id;
  const steal = await asUser(tokenB, 'rpc/restore_pantry_version', { method: 'POST', body: JSON.stringify({ p_id: aHistoryId }) });
  assert.ok(steal.status >= 400);
  assert.match((await steal.json()).message, /no longer exists/); // A's ids mean nothing to B
  const write = await asUser(tokenB, 'pantries', { method: 'POST', body: JSON.stringify({ user_id: uidA, state: { products: [], batches: [] } }) });
  assert.ok(write.status === 401 || write.status === 403, `B cannot write rows directly (got ${write.status})`);
  const wipe = await asUser(tokenB, `pantries?user_id=eq.${uidA}`, { method: 'DELETE', headers: { Prefer: 'return=representation' } });
  assert.deepEqual(await wipe.json(), []);
  assert.equal((await admin(`pantries?user_id=eq.${uidA}&select=user_id`)).length, 1);
  log('RLS: user B reads nothing of A\'s (4 tables), cannot restore A\'s versions, write or delete A\'s pantry');

  // ---- 5. reminders through cloud.js, push subscriptions, and the send-reminders function ----
  const replace = items => a1.evaluate(async list => {
    const { replaceReminders } = await import('./js/cloud.js');
    try {
      return { ok: await replaceReminders(list) };
    } catch (e) {
      return { error: e.message };
    }
  }, items);
  const now = Date.now();
  const due = { sendAt: new Date(now - 60e3).toISOString(), title: 'Milk expires tomorrow', body: 'Kitchen › Fridge', url: './#/', tag: 'expiry-milk' };
  const later = { sendAt: new Date(now + 2 * 86400e3).toISOString(), title: 'Check the coffee', body: 'Probably running low', url: './#/', tag: 'check-coffee' };
  const tooLate = { sendAt: new Date(now - 7 * 3600e3).toISOString(), title: 'Old news', tag: 'old' };
  assert.deepEqual(await replace([due, later, tooLate]), { ok: 2 });
  assert.match((await replace(Array.from({ length: 61 }, () => later))).error, /at most 60/);
  assert.match((await replace([{ ...later, sendAt: 'tomorrow' }])).error, /ISO-8601/);
  assert.match((await replace([{ ...later, title: '' }])).error, /title is required/);
  let reminders = await admin(`reminders?user_id=eq.${uidA}&select=id,title,sent_at,status&order=send_at`);
  assert.deepEqual(reminders.map(r => r.title), ['Milk expires tomorrow', 'Check the coffee']);
  const unsigned = await device('unsigned');
  const refused = await unsigned.evaluate(async () => {
    const cloud = await import('./js/cloud.js');
    const out = [];
    // Without a session; then savePushSubscription signs in anonymously first, and the server checks the keys.
    for (const call of [() => cloud.replaceReminders([]), () => cloud.deletePushSubscription('https://x'), () => cloud.savePushSubscription({ endpoint: 'https://x', keys: { p256dh: 'a', auth: 'b' } })]) {
      try {
        await call();
        out.push('resolved');
      } catch (e) {
        out.push(e.message);
      }
    }
    return out;
  });
  assert.deepEqual(refused, ['Not signed in.', 'Not signed in.', 'Not valid push subscription keys.']);
  await unsigned.ctx.close();
  log('replaceReminders: stores 2 (drops one 7 h late), rejects >60 items, bad dates, empty titles, and without a session');

  // savePushSubscription / deletePushSubscription (a real browser would give an https push endpoint).
  const fake = subscriptionKeys();
  const httpsEndpoint = `https://push.example.com/send/${run}`;
  await a1.evaluate(async sub => (await import('./js/cloud.js')).savePushSubscription(sub, { device: 'Test phone' }),
    { endpoint: httpsEndpoint, keys: { p256dh: fake.p256dh, auth: fake.auth } });
  let subs = await admin(`push_subscriptions?user_id=eq.${uidA}&select=endpoint,device`);
  assert.deepEqual(subs, [{ endpoint: httpsEndpoint, device: 'Test phone' }]);
  await a1.evaluate(async e => (await import('./js/cloud.js')).deletePushSubscription(e), httpsEndpoint);
  assert.deepEqual(await admin(`push_subscriptions?user_id=eq.${uidA}&select=endpoint`), []);
  log('savePushSubscription / deletePushSubscription store and remove this device\'s subscription');

  // Two devices of A: one healthy, one whose subscription has expired (the push service answers 410).
  const okKeys = subscriptionKeys();
  const goneKeys = subscriptionKeys();
  await admin('push_subscriptions', { method: 'POST', body: [
    { user_id: uidA, endpoint: `${PUSH_BASE}/push/ok-${run}`, p256dh: okKeys.p256dh, auth: okKeys.auth, device: 'healthy' },
    { user_id: uidA, endpoint: `${PUSH_BASE}/push/gone-${run}`, p256dh: goneKeys.p256dh, auth: goneKeys.auth, device: 'expired' },
  ] });
  // A reminder the cron job didn't get to in time (over 6 hours late) is skipped, not sent.
  const [stale] = await admin('reminders', { method: 'POST', body: { user_id: uidA, send_at: new Date(now - 7 * 3600e3).toISOString(), title: 'Too late' } });

  const unauthorized = await fetch(`${API}/functions/v1/send-reminders`, { method: 'POST', headers: { 'x-cron-secret': 'guess' } });
  assert.equal(unauthorized.status, 401);
  const res = await fetch(`${API}/functions/v1/send-reminders`, { method: 'POST', headers: { 'x-cron-secret': env.CRON_SECRET } });
  const result = await res.json();
  assert.equal(res.status, 200, JSON.stringify(result));
  await waitFor(() => pushes.filter(p => p.path.includes(run)).length >= 2, 'the pushes');
  const okPush = pushes.find(p => p.path === `/push/ok-${run}`);
  const vapid = checkVapid(okPush.headers.authorization);
  assert.equal(vapid.valid, true, 'VAPID JWT signature');
  assert.equal(vapid.publicKey, env.VAPID_PUBLIC_KEY);
  assert.equal(vapid.claims.aud, PUSH_BASE);
  assert.equal(vapid.claims.sub, env.VAPID_SUBJECT);
  assert.ok(vapid.claims.exp > now / 1000 && vapid.claims.exp <= now / 1000 + 24 * 3600);
  assert.equal(okPush.headers['content-encoding'], 'aes128gcm');
  assert.equal(okPush.headers.ttl, '21600');
  assert.deepEqual(JSON.parse(decryptPush(okPush.body, okKeys).text), { title: due.title, body: due.body, url: due.url, tag: due.tag });
  // (The cron job may have got there first; then this run found nothing to do.)
  if (result.due) assert.ok(result.sent >= 1 && result.skipped >= 1 && result.removedSubscriptions >= 1, JSON.stringify(result));
  reminders = await admin(`reminders?user_id=eq.${uidA}&select=id,title,sent_at,status&order=send_at`);
  const byTitle = Object.fromEntries(reminders.map(r => [r.title, r]));
  assert.equal(byTitle['Milk expires tomorrow'].status, 'sent');
  assert.ok(byTitle['Milk expires tomorrow'].sent_at);
  assert.equal(byTitle['Check the coffee'].sent_at, null);
  assert.equal(byTitle['Too late'].status, 'skipped');
  assert.equal(byTitle['Too late'].id, stale.id);
  assert.equal(pushes.filter(p => p.path.includes(run)).length, 2, 'only the due reminder was pushed (once per device)');
  subs = await admin(`push_subscriptions?user_id=eq.${uidA}&select=device,last_success_at`);
  assert.deepEqual(subs.map(s => s.device), ['healthy'], 'the subscription answered with 410 was deleted');
  assert.ok(subs[0].last_success_at);
  log('send-reminders: 401 without the secret; pushed the due reminder with a valid VAPID JWT and an aes128gcm body');
  log('send-reminders: marked it sent, skipped the 7 h late one, left the future one, deleted the 410 subscription');

  // Sending the same list again does not notify twice.
  assert.deepEqual(await replace([due, later]), { ok: 1 });
  reminders = await admin(`reminders?user_id=eq.${uidA}&select=title,sent_at&order=send_at`);
  assert.equal(reminders.filter(r => r.title === due.title).length, 1);
  log('replaceReminders again with an already-sent item keeps it sent (no second notification)');

  // ---- 6. the cron job's path: Vault (project_url, cron_secret) → pg_net → the function ----
  try {
    assert.equal(sql("select schedule from cron.job where jobname = 'pantri-send-reminders'"), '*/10 * * * *');
    const id = sql('select private.send_due_reminders()');
    const answer = await waitFor(() => sql(`select status_code || ' ' || content from net._http_response where id = ${id}`), 'the cron request');
    assert.match(answer, /^200 \{"due":/);
    log('cron: the scheduled job reaches send-reminders with the secret from Vault (HTTP 200)');
  } catch (e) {
    if (e.code === 'ENOENT' || /No such container|not found/i.test(e.message)) console.log(`(cron path not checked: ${e.message.split('\n')[0]})`);
    else throw e;
  }

  // ---- 7. delete the online data on A1; A2 is signed out on its next sync; data stays on the phones ----
  await openAccount(a1);
  await a1.getByRole('button', { name: 'Delete my online data' }).click();
  await a1.locator('.sheet button:text("Delete online data")').click();
  await a1.locator('.seg button:text("Sign in")').waitFor();
  for (const table of ['pantries', 'pantry_history', 'reminders', 'push_subscriptions']) {
    assert.deepEqual(await admin(`${table}?user_id=eq.${uidA}&select=user_id`), [], `${table} emptied`);
  }
  assert.deepEqual(await productNames(a1), ['Coffee beans', 'Offline item']);
  assert.equal((await status(a1)).signedIn, false);
  await a2.getByRole('button', { name: 'Sync now' }).click();
  await a2.locator('.seg button:text("Sign in")').waitFor();
  assert.match(await toast(a2), /deleted from another device/);
  assert.deepEqual(await productNames(a2), ['Coffee beans', 'Offline item']);
  log('"Delete my online data": rows gone, A1 signed out, A2 signed out on its next sync; both keep their pantry');

  // ---- 8. forgotten password: email link → new password → sign in with it ----
  await openAccount(a2);
  await a2.getByLabel('Email').fill(emailA);
  await a2.getByRole('button', { name: 'Forgot your password?' }).click();
  await waitFor(async () => /Email sent/.test(await toast(a2)), 'the reset email to be sent');
  const link = await waitFor(async () => {
    const list = await (await fetch(`${MAIL}/api/v1/messages`)).json();
    const msg = list.messages.find(m => m.To.some(t => t.Address === emailA));
    if (!msg) return null;
    const full = await (await fetch(`${MAIL}/api/v1/message/${msg.ID}`)).json();
    const m = /https?:\/\/[^\s"'<>]+\/verify\?[^\s"'<>]+/.exec(full.Text || full.HTML || '');
    return m && m[0].replace(/&amp;/g, '&');
  }, 'the reset email');
  assert.match(decodeURIComponent(link), new RegExp(`redirect_to=${server.url.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
  await a2.goto(link);
  await a2.getByLabel('New password').waitFor();
  assert.equal(await a2.locator('.bar h1').first().textContent(), 'Account & online backup');
  await a2.getByLabel('New password').fill('a-new-password-8');
  await a2.getByRole('button', { name: 'Save password' }).click();
  await waitFor(async () => /Password changed/.test(await toast(a2)), 'the new password to be saved');
  await a2.locator('.sync-line').waitFor();
  const a3 = await device('A3');
  await signInForm(a3, emailA, PASSWORD);
  await a3.locator('.error:has-text("Wrong email or password")').waitFor();
  await a3.getByLabel('Password', { exact: true }).fill('a-new-password-8');
  await a3.getByRole('button', { name: 'Sign in', exact: true }).click();
  await synced(a3);
  log('password reset: the emailed link opened the app at "Choose a new password"; the new one signs in');

  // ---- 9. signing out keeps the pantry; "remove from this phone" empties it ----
  await openAccount(a3);
  await a3.getByRole('button', { name: 'Sign out' }).click();
  await a3.locator('.sheet .menu-item:has-text("Sign out and remove")').click();
  await a3.locator('.seg button:text("Sign in")').waitFor();
  assert.deepEqual(await productNames(a3), []);
  await openAccount(a2);
  await a2.getByRole('button', { name: 'Sign out' }).click();
  await a2.locator('.sheet .menu-item').first().click();
  await a2.locator('.seg button:text("Sign in")').waitFor();
  assert.ok((await productNames(a2)).length > 0);
  log('sign out keeps the pantry on the phone; "sign out and remove" leaves an empty pantry');

  // ---- 10. reminders without an account: an anonymous user that can't keep a pantry online ----
  const p1 = await device('P1');
  await addProduct(p1, 'Milk');
  const keysP1 = subscriptionKeys();
  const endpointP1 = `https://push.example.com/send/p1-${run}`;
  const reg = await p1.evaluate(async sub => {
    const cloud = await import('./js/cloud.js');
    const user = await cloud.savePushSubscription(sub, { device: 'Phone without an account' });
    const waiting = await cloud.replaceReminders([{ sendAt: new Date(Date.now() + 3600e3).toISOString(), title: 'Pantri', body: '1 to use soon: Milk', url: './#/', tag: 'pantri-daily' }]);
    return { user, waiting, signedIn: cloud.isSignedIn(), hasSession: cloud.hasSession(), statusSignedIn: cloud.cloudStatus().signedIn };
  }, { endpoint: endpointP1, keys: { p256dh: keysP1.p256dh, auth: keysP1.auth } });
  assert.deepEqual([reg.signedIn, reg.hasSession, reg.statusSignedIn, reg.waiting], [false, true, false, 1]);
  assert.equal((await authUser(reg.user)).is_anonymous, true);
  assert.deepEqual(await admin(`push_subscriptions?user_id=eq.${reg.user}&select=endpoint,device`), [{ endpoint: endpointP1, device: 'Phone without an account' }]);
  assert.deepEqual((await admin(`reminders?user_id=eq.${reg.user}&select=body`)).map(r => r.body), ['1 to use soon: Milk']);
  await go(p1, '#/more');
  assert.match(await p1.locator('.row:has-text("Account & online backup") .row-sub').textContent(), /Not signed in/);
  await addProduct(p1, 'Bread');
  await p1.waitForTimeout(3000); // longer than the sync's pause after a change
  assert.deepEqual(await admin(`pantries?user_id=eq.${reg.user}&select=user_id`), []);
  const tokenP1 = await p1.evaluate(() => JSON.parse(localStorage.getItem('pantri-auth')).access_token);
  for (const [fn, body] of [['save_pantry', { p_state: { products: [], batches: [] }, p_base_rev: 0 }], ['stash_pantry', { p_state: { products: [], batches: [] } }]]) {
    const r = await asUser(tokenP1, `rpc/${fn}`, { method: 'POST', body: JSON.stringify(body) });
    assert.equal(r.status, 403, fn);
    assert.match((await r.json()).message, /Create an account to keep the pantry online/);
  }
  log('no account: an anonymous user holds the subscription and reminders; the pantry is never uploaded, and the server refuses it');

  const emailC = `c-${run}@example.com`;
  await signInForm(p1, emailC, PASSWORD, { create: true });
  await synced(p1);
  const uidC = await userId(p1);
  assert.notEqual(uidC, reg.user);
  await waitFor(async () => !(await authUser(reg.user)), 'the anonymous user to be deleted');
  assert.deepEqual(await admin(`reminders?user_id=eq.${reg.user}&select=id`), []);
  assert.deepEqual(await admin(`push_subscriptions?endpoint=eq.${encodeURIComponent(endpointP1)}&select=id`), []);
  [row] = await admin(`pantries?user_id=eq.${uidC}&select=state`);
  assert.deepEqual(row.state.products.map(p => p.name).sort(), ['Bread', 'Milk']);
  const tokenC = await p1.evaluate(() => JSON.parse(localStorage.getItem('pantri-auth')).access_token);
  const notAnonymous = await asUser(tokenC, 'rpc/forget_anonymous_device', { method: 'POST', body: '{}' });
  assert.equal(notAnonymous.status, 403);
  assert.ok(await authUser(uidC));
  log('creating an account on that phone deletes its anonymous user (subscription, reminders) and uploads the pantry; accounts can\'t use forget_anonymous_device');

  const p2 = await device('P2');
  const keysP2 = subscriptionKeys();
  const userP2 = await p2.evaluate(async sub => (await import('./js/cloud.js')).savePushSubscription(sub),
    { endpoint: `https://push.example.com/send/p2-${run}`, keys: { p256dh: keysP2.p256dh, auth: keysP2.auth } });
  assert.equal((await authUser(userP2)).is_anonymous, true);
  const forgotten = await p2.evaluate(async () => {
    const cloud = await import('./js/cloud.js');
    await cloud.forgetThisDevice();
    return { hasSession: cloud.hasSession(), stored: localStorage.getItem('pantri-auth') };
  });
  assert.deepEqual(forgotten, { hasSession: false, stored: null });
  assert.equal(await authUser(userP2), null);
  assert.deepEqual(await admin(`push_subscriptions?user_id=eq.${userP2}&select=id`), []);
  log('switching off without an account: forgetThisDevice() deletes the anonymous user and its subscription, and ends the session');

  // The daily clean-up: anonymous users without a device for a week go; ones with a device stay.
  const anonymousSignUp = async () => (await (await fetch(`${API}/auth/v1/signup`, {
    method: 'POST', headers: { apikey: KEY, 'Content-Type': 'application/json' }, body: '{}',
  })).json());
  const idle = await anonymousSignUp();
  const busy = await anonymousSignUp();
  const keysBusy = subscriptionKeys();
  const saved = await asUser(busy.access_token, 'rpc/save_push_subscription', {
    method: 'POST', body: JSON.stringify({ p_endpoint: `https://push.example.com/send/busy-${run}`, p_p256dh: keysBusy.p256dh, p_auth: keysBusy.auth }),
  });
  assert.equal(saved.status, 204, await saved.text());
  sql(`update auth.users set created_at = now() - interval '8 days' where id in ('${idle.user.id}', '${busy.user.id}')`);
  assert.ok(Number(sql('select private.forget_idle_anonymous_users()')) >= 1);
  assert.equal(await authUser(idle.user.id), null);
  assert.ok(await authUser(busy.user.id));
  assert.equal(sql("select schedule from cron.job where jobname = 'pantri-forget-idle-anonymous'"), '17 3 * * *');
  log('daily clean-up (cron 03:17): anonymous users without a device for a week are deleted, ones with a device stay');
} finally {
  await browser.close();
  await server.close();
  pushService.close();
}

if (problems.length) {
  console.log(`\nPROBLEMS:\n${problems.join('\n')}`);
  process.exit(1);
}
console.log('\nAll cloud checks passed, no console errors.');
