// Reminders end to end with the REAL cloud module against the LOCAL Supabase stack (Edge headless):
// the Settings switch registers this device and uploads the daily digests the phone computed, the server
// stores them at the right local times, a new reminder time replaces them, and switching off clears them.
// The push service itself is faked in the page (headless Edge can't create real subscriptions).
// Needs what tests/cloud.e2e.mjs needs; skips with a message (exit 0) when the stack isn't running.
// Usage: node tests/reminders-cloud.e2e.mjs [outputDir]
import { chromium } from 'playwright-core';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer } from '../tools/serve.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TZ = 'Europe/Bucharest';
const log = msg => console.log(`✔ ${msg}`);
const skip = msg => {
  console.log(`SKIPPED reminder/cloud checks: ${msg}`);
  process.exit(0);
};

let stack;
try {
  stack = JSON.parse(execSync('npx --yes supabase status -o json', { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 60000 }));
} catch {
  skip('the local Supabase stack is not running (start it with `npx supabase start`).');
}
const API = stack.API_URL;
const KEY = stack.PUBLISHABLE_KEY || stack.ANON_KEY;
const SERVICE = stack.SERVICE_ROLE_KEY;
if (!API || !KEY || !SERVICE) skip('`supabase status` did not list the API URL and keys.');
const envFile = path.join(ROOT, 'supabase', 'functions', '.env');
if (!fs.existsSync(envFile)) skip('supabase/functions/.env is missing (see tests/cloud.e2e.mjs).');
const env = Object.fromEntries(fs.readFileSync(envFile, 'utf8').split('\n').filter(l => /^\w+=/.test(l)).map(l => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1).trim()]));

/** PostgREST with the service role (bypasses RLS), to see what is really stored. */
async function admin(query) {
  const res = await fetch(`${API}/rest/v1/${query}`, { headers: { apikey: SERVICE, Authorization: `Bearer ${SERVICE}` } });
  if (!res.ok) throw new Error(`GET ${query}: ${res.status} ${await res.text()}`);
  return res.json();
}
async function waitFor(fn, what, timeout = 20000) {
  const end = Date.now() + timeout;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`Timed out waiting for ${what}`);
    await new Promise(r => setTimeout(r, 250));
  }
}
const localTime = iso => new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: '2-digit', minute: '2-digit' }).format(new Date(iso));
const ymdIn = (t, days) => new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(new Date(t + days * 86400000));

// Keys in the format a real push subscription has (the server checks it): a P-256 point and 16 random bytes.
const { publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const jwk = publicKey.export({ format: 'jwk' });
const P256DH = Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x, 'base64url'), Buffer.from(jwk.y, 'base64url')]).toString('base64url');
const AUTH = crypto.randomBytes(16).toString('base64url');

const server = await startServer({ port: 0 });
const origin = new URL(server.url).origin;
const problems = [];
const browser = await chromium.launch({ channel: 'msedge', headless: true });
try {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, timezoneId: TZ });
  await context.grantPermissions(['notifications'], { origin });
  await context.addInitScript(({ cfg, keys }) => {
    globalThis.__PANTRI_CONFIG__ = cfg;
    // A stand-in push service: one subscription per device, kept across page loads like a real one.
    const KEY = 'test-fake-push';
    const make = () => ({
      endpoint: 'https://push.example.test/send/integration-device',
      expirationTime: null,
      options: { userVisibleOnly: true, applicationServerKey: null },
      toJSON() { return { endpoint: this.endpoint, expirationTime: null, keys }; },
      async unsubscribe() { localStorage.removeItem(KEY); return true; },
    });
    PushManager.prototype.getSubscription = async () => (localStorage.getItem(KEY) ? make() : null);
    PushManager.prototype.subscribe = async () => { localStorage.setItem(KEY, '1'); return make(); };
  }, { cfg: { SUPABASE_URL: API, SUPABASE_ANON_KEY: KEY, VAPID_PUBLIC_KEY: env.VAPID_PUBLIC_KEY || '' }, keys: { p256dh: P256DH, auth: AUTH } });
  const page = await context.newPage();
  page.on('pageerror', e => problems.push(`${e.message}\n${e.stack}`));
  page.on('console', m => m.type() === 'error' && !/Failed to load resource|net::ERR_/.test(m.text()) && problems.push(m.text()));
  const go = async hash => {
    await page.goto(`${server.url}${hash}`);
    await page.locator('.bar h1').first().waitFor();
  };

  // ---- an account, and a product that expires in two days ----
  await go('');
  await go('#/account');
  await page.getByRole('tab', { name: 'Create account' }).click();
  await page.getByLabel('Email').fill(`reminders-${Date.now()}@example.com`);
  await page.getByLabel('Password', { exact: true }).fill('reminder-test-8');
  await page.getByRole('button', { name: 'Create account', exact: true }).click();
  await waitFor(() => page.evaluate(async () => (await import('./js/cloud.js')).isSignedIn()), 'the sign-up');
  const uid = await page.evaluate(() => JSON.parse(localStorage.getItem('pantri-auth')).user.id);
  await go('#/new');
  await page.locator('#pf-name').fill('Milk');
  const stock = page.locator('fieldset:has(legend:text("In stock right now"))');
  await stock.locator('.stepper input').fill('2');
  await stock.locator('input[type=date]').fill(ymdIn(Date.now(), 2));
  await page.getByRole('button', { name: 'Save product' }).click();
  await page.waitForURL(/#\/product\//);
  log('signed up against the local server and added milk that expires in two days');

  // ---- switching reminders on registers this device and uploads the digests ----
  await go('#/settings');
  const card = page.locator('.section:has(> .section-title:text-is("Notifications")) .card');
  await card.getByLabel('Daily reminder').click();
  await page.locator('.toast:has-text("Daily reminder on")').waitFor();
  const subs = await waitFor(async () => {
    const rows = await admin(`push_subscriptions?user_id=eq.${uid}&select=endpoint,p256dh,auth,device`);
    return rows.length && rows;
  }, 'the push subscription row');
  assert.deepEqual(subs.map(s => [s.endpoint, s.p256dh, s.auth]), [['https://push.example.test/send/integration-device', P256DH, AUTH]]);
  const waiting = async () => admin(`reminders?user_id=eq.${uid}&sent_at=is.null&select=send_at,title,body,url,tag&order=send_at`);
  let rows = await waitFor(async () => {
    const r = await waiting();
    return r.length && r;
  }, 'the uploaded reminders');
  assert.ok(rows.every(r => r.title === 'Pantri' && r.url === './#/' && r.tag === 'pantri-daily'), JSON.stringify(rows[0]));
  assert.ok(rows.every(r => localTime(r.send_at) === '09:00'), rows.map(r => localTime(r.send_at)).join(','));
  assert.ok(rows.some(r => /Milk/.test(r.body)), rows.map(r => r.body).join(' | '));
  assert.ok(rows.every(r => new Date(r.send_at) > Date.now()));
  log(`switched on: subscription stored, ${rows.length} digests waiting on the server at 09:00 local (e.g. "${rows[0].body}")`);

  // ---- a new reminder time replaces the waiting ones ----
  await card.locator('#reminder-time').fill('18:30');
  await card.locator('#reminder-time').press('Tab');
  rows = await waitFor(async () => {
    const r = await waiting();
    return r.length && r.every(x => localTime(x.send_at) === '18:30') && r;
  }, 'the schedule at 18:30');
  log(`reminder time 18:30: the server now has ${rows.length} digests at 18:30 local, none left at 09:00`);

  // ---- switching off clears the schedule and forgets this device ----
  await card.getByLabel('Daily reminder').click();
  await waitFor(async () => (await waiting()).length === 0 && (await admin(`push_subscriptions?user_id=eq.${uid}&select=id`)).length === 0,
    'the schedule and subscription to be removed');
  log('switched off: no reminders waiting and no subscription left for this account');
  await context.close();
} finally {
  await browser.close();
  await server.close();
}
if (problems.length) {
  console.log(`\nPROBLEMS:\n${problems.join('\n')}`);
  process.exit(1);
}
console.log('\nAll reminder/cloud checks passed, no console errors.');
