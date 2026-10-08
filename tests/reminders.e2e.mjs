// Reminder notifications in Edge headless (phone viewport): the Settings section in each state, switching
// reminders on and off, a test notification, the service worker's push handler (through the DevTools
// protocol) and the schedule upload. The cloud module is the development stub: the test sets its state
// with window.__PANTRI_STUB__ and reads what the app sent from window.__cloudStub.
// Usage: node tests/reminders.e2e.mjs [outputDir]
import { chromium } from 'playwright-core';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { startServer } from '../tools/serve.mjs';

const outDir = path.resolve(process.argv[2] || 'test-output');
fs.mkdirSync(outDir, { recursive: true });
const server = await startServer({ port: 0 });
const origin = new URL(server.url).origin;
const problems = [];
const log = msg => console.log(`✔ ${msg}`);
const text = async loc => (await loc.textContent()).replace(/\s+/g, ' ').trim();

// A real-format VAPID public key: an uncompressed P-256 point, base64url-encoded.
const { publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const jwk = publicKey.export({ format: 'jwk' });
const VAPID_PUBLIC_KEY = Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x, 'base64url'), Buffer.from(jwk.y, 'base64url')]).toString('base64url');
const CONFIG = { SUPABASE_URL: 'https://project.example.test', SUPABASE_ANON_KEY: 'public-anon-key', VAPID_PUBLIC_KEY };
// Browser contexts here are like incognito windows, where Edge refuses push subscriptions (and logs this).
const INCOGNITO_PUSH = /does not support the Push API in incognito mode/;
const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.6 Mobile/15E148 Safari/604.1';
const MONDAY_8AM = new Date('2026-10-12T08:00:00+02:00'); // in Europe/Berlin, the browser's time zone below

const browser = await chromium.launch({ channel: 'msedge', headless: true });

/**
 * A phone-sized page in a fresh context. `stub` is window.__PANTRI_STUB__; `fakePush` stands in for the
 * push service (headless Edge can't subscribe); `notifications` grants that permission; `denied` and
 * `noPush` pretend notifications are blocked / Web Push doesn't exist.
 */
async function open({ config = true, stub = { configured: true, signedIn: true }, fakePush = false, notifications = false, denied = false, noPush = false, userAgent } = {}) {
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, timezoneId: 'Europe/Berlin',
    ...(userAgent ? { userAgent } : {}),
  });
  if (notifications) await context.grantPermissions(['notifications'], { origin });
  await context.addInitScript(o => {
    if (o.config) window.__PANTRI_CONFIG__ = o.config;
    if (o.stub) window.__PANTRI_STUB__ = o.stub;
    if (o.denied) Object.defineProperty(Notification, 'permission', { get: () => 'denied' });
    if (o.noPush) delete window.PushManager;
    if (o.fakePush) {
      // One subscription per device, kept across page loads like a real one.
      const KEY = 'test-fake-push';
      const make = () => ({
        endpoint: 'https://push.example.test/send/device-1',
        expirationTime: null,
        options: { userVisibleOnly: true, applicationServerKey: null },
        toJSON() { return { endpoint: this.endpoint, expirationTime: null, keys: { p256dh: 'BFakePublicKey', auth: 'fake-auth' } }; },
        async unsubscribe() { localStorage.removeItem(KEY); return true; },
      });
      PushManager.prototype.getSubscription = async () => (localStorage.getItem(KEY) ? make() : null);
      PushManager.prototype.subscribe = async () => { localStorage.setItem(KEY, '1'); return make(); };
    }
  }, { config: config ? CONFIG : null, stub, fakePush, denied, noPush });
  const page = await context.newPage();
  page.on('console', m => m.type() === 'error' && !INCOGNITO_PUSH.test(m.text()) && problems.push(`[console] ${m.text()}`));
  page.on('pageerror', e => problems.push(`[pageerror] ${e.message}\n${e.stack}`));
  return page;
}

const shot = (page, name) => page.screenshot({ path: path.join(outDir, `reminders-${name}.png`), animations: 'disabled' });

/** Opens Settings and returns the Notifications card. */
async function notificationsCard(page) {
  await page.goto(`${server.url}#/settings`);
  await page.locator('.bar h1').first().waitFor();
  return page.locator('.section:has(> .section-title:text-is("Notifications")) .card');
}

/** A pantry where Milk (dated Wed 14) and Water (5 a day, keep 6) need attention on the coming days. */
async function seed(page) {
  await page.evaluate(async () => {
    const store = await import('./js/store.js');
    const fridge = store.getState().locations.find(l => l.name === 'Fridge').id;
    store.createProduct({ name: 'Milk', locationId: fridge }, { qty: 2, expiry: '2026-10-14' });
    store.createProduct({ name: 'Water', rate: { qty: 5, per: 'day' }, minStock: 6, locationId: fridge }, { qty: 24 });
    await store.flush();
  });
}

const cloud = page => page.evaluate(() => JSON.parse(JSON.stringify(window.__cloudStub)));
const setting = (page, key) => page.evaluate(async k => (await import('./js/store.js')).getState().settings[k], key);

/** Notifications currently shown by the app's service worker (waits a little for one to appear). */
async function shown(page, tag, want = list => list.length > 0) {
  let list = [];
  for (let k = 0; k < 50; k++) {
    list = await page.evaluate(async t => {
      const reg = await navigator.serviceWorker.ready;
      return (await reg.getNotifications({ tag: t })).map(n => ({ title: n.title, body: n.body, tag: n.tag, icon: n.icon, data: n.data }));
    }, tag);
    if (want(list)) return list;
    await page.waitForTimeout(100);
  }
  throw new Error(`no notification with tag ${tag} as expected; shown: ${JSON.stringify(list)}`);
}

try {
  // ---- not set up: no section at all ----
  {
    const page = await open({ config: false, stub: null });
    await notificationsCard(page);
    assert.equal(await page.locator('.section-title:text-is("Notifications")').count(), 0);
    log('without the cloud settings, Settings has no Notifications section');
    await page.context().close();
  }

  // ---- states that need something else first ----
  {
    const page = await open({ stub: { configured: true, signedIn: false } });
    const card = await notificationsCard(page);
    assert.match(await text(card), /Reminders are sent from your account, so sign in first\./);
    await shot(page, 'signed-out');
    await card.getByRole('link', { name: 'Sign in' }).click();
    await page.waitForFunction(() => location.hash === '#/account');
    log('signed out: says reminders need an account, with a link to #/account');
    await page.context().close();
  }
  {
    const page = await open({ userAgent: IPHONE });
    const card = await notificationsCard(page);
    assert.match(await text(card), /add Pantri to the Home Screen first: tap Share → Add to Home Screen, then open Pantri from the new icon\..*16\.4/);
    await shot(page, 'iphone-browser');
    log('iPhone in a browser tab: explains Share → Add to Home Screen, then open it from the icon');
    await page.context().close();
  }
  {
    const page = await open({ noPush: true });
    const card = await notificationsCard(page);
    assert.match(await text(card), /This browser can't show notifications from Pantri\./);
    log('no Web Push in the browser: says so, and what works instead');
    await page.context().close();
  }
  {
    const page = await open({ denied: true });
    const card = await notificationsCard(page);
    assert.match(await text(card), /Notifications are blocked for Pantri on this device\..*Allow notifications for this site/);
    assert.equal(await card.getByLabel('Daily reminder').count(), 0);
    await shot(page, 'blocked');
    log('permission blocked: explains how to allow notifications again');
    await page.context().close();
  }

  // ---- a real subscription fails in headless Edge: clear message, nothing changes ----
  {
    const page = await open({ notifications: true });
    const card = await notificationsCard(page);
    await card.getByLabel('Daily reminder').click();
    await card.locator('.error').waitFor();
    assert.match(await text(card.locator('.error')), /This browser couldn't set up notifications \(.+\)\. Try again later\./);
    assert.equal(await card.getByLabel('Daily reminder').isChecked(), false);
    assert.equal(await setting(page, 'remindersOn'), false);
    const sent = await cloud(page);
    assert.deepEqual([sent.subscriptions.length, sent.uploads], [0, 0]);
    await shot(page, 'subscribe-failed');
    const why = (await text(card.locator('.error'))).match(/\((.+?)\)/)[1];
    log(`the browser refuses to subscribe ("${why}"): a clear message, reminders stay off`);
    await page.context().close();
  }

  // ---- switching on, test notification, pushes, time, switching off (fake push service) ----
  {
    const page = await open({ notifications: true, fakePush: true });
    await page.clock.setFixedTime(MONDAY_8AM);
    await page.goto(server.url);
    await page.locator('.bar h1').first().waitFor();
    await seed(page);
    const card = await notificationsCard(page);
    const toggle = card.getByLabel('Daily reminder');
    assert.match(await text(card), /One notification a day, only when something needs checking/);

    await page.evaluate(() => { window.__PANTRI_STUB__.fail = true; });
    await toggle.click();
    await card.locator('.error').waitFor();
    assert.match(await text(card.locator('.error')), /Couldn't reach the server to register this device/);
    assert.equal(await setting(page, 'remindersOn'), false);
    await page.evaluate(() => { window.__PANTRI_STUB__.fail = false; });
    log('server unreachable while switching on: clear message, reminders stay off');

    await toggle.click();
    await page.waitForFunction(() => window.__cloudStub.uploads === 1);
    let sent = await cloud(page);
    assert.equal(sent.subscriptions.length, 1);
    assert.deepEqual(sent.subscriptions[0].sub, {
      endpoint: 'https://push.example.test/send/device-1', expirationTime: null, keys: { p256dh: 'BFakePublicKey', auth: 'fake-auth' },
    });
    assert.match(sent.subscriptions[0].device, /^Windows · Edge$/);
    assert.equal(sent.reminders.length, 14);
    assert.deepEqual(sent.reminders[0], {
      sendAt: '2026-10-12T07:00:00.000Z', title: 'Pantri', body: '1 to use soon: Milk', url: './#/', tag: 'pantri-daily',
    });
    assert.deepEqual(sent.reminders.slice(2, 5).map(x => x.body), ['1 to use soon: Milk', '1 expired: Milk', '1 to check: Water · 1 expired: Milk']);
    assert.equal(sent.reminders[13].sendAt, '2026-10-25T08:00:00.000Z'); // winter time by then: still 09:00 local
    assert.equal(await setting(page, 'remindersOn'), true);
    assert.equal(await toggle.isChecked(), true);
    assert.match(await text(page.locator('.toast')), /Daily reminder on, at 09:00/);
    await card.locator('.reminder-preview:has-text("Next:")').waitFor();
    assert.match(await text(card.locator('.reminder-preview')), /^Next: today at 0?9:00.* — 1 to use soon: Milk$/);
    await shot(page, 'on');
    log(`switched on: permission → subscription saved (${sent.subscriptions[0].device}) → 14 daily digests uploaded`);

    await card.getByRole('button', { name: 'Send a test notification' }).click();
    const [testNote] = await shown(page, 'pantri-test');
    assert.equal(testNote.title, 'Pantri');
    assert.match(testNote.body, /^Notifications work\. Next reminder today at .+: 1 to use soon: Milk$/);
    assert.match(testNote.icon, /\/icons\/icon-192\.png$/);
    log(`test notification shown on the device: "${testNote.body}"`);

    // The service worker's push handler, fed through the DevTools protocol like a push service would.
    const cdp = await page.context().newCDPSession(page);
    const registrations = [];
    cdp.on('ServiceWorker.workerRegistrationUpdated', e => registrations.push(...e.registrations));
    await cdp.send('ServiceWorker.enable');
    for (let k = 0; k < 50 && !registrations.some(r => !r.isDeleted && r.scopeURL === server.url); k++) await page.waitForTimeout(100);
    const { registrationId } = registrations.find(r => !r.isDeleted && r.scopeURL === server.url);
    const push = data => cdp.send('ServiceWorker.deliverPushMessage', { origin, registrationId, data });
    await push(JSON.stringify(sent.reminders[3]));
    let [note] = await shown(page, 'pantri-daily');
    assert.deepEqual({ title: note.title, body: note.body, data: note.data }, { title: 'Pantri', body: '1 expired: Milk', data: { url: './#/' } });
    assert.match(note.icon, /\/icons\/icon-192\.png$/);
    await push(JSON.stringify(sent.reminders[4]));
    const daily = await shown(page, 'pantri-daily', list => list.length === 1 && list[0].body !== '1 expired: Milk');
    assert.equal(daily[0].body, '1 to check: Water · 1 expired: Milk'); // replaced the previous digest
    await push('');
    [note] = await shown(page, 'pantri');
    assert.deepEqual([note.title, note.body], ['Pantri', 'Open Pantri to see what needs attention today.']);
    await push('Plain text from the server');
    await shown(page, 'pantri', list => list[0].body === 'Plain text from the server');
    log('push messages become notifications: the digest text, a newer digest replaces the older one, fallbacks for empty and plain-text pushes');

    await card.locator('#reminder-time').fill('18:30');
    await card.locator('#reminder-time').press('Tab');
    await page.waitForFunction(() => window.__cloudStub.reminders[0].sendAt === '2026-10-12T16:30:00.000Z');
    assert.equal(await setting(page, 'reminderTime'), '18:30');
    assert.match(await text(card.locator('.hint').first()), /Comes at (18:30|06:30 PM) /);
    log('a new reminder time is saved and the schedule re-uploaded for 18:30');

    await toggle.click();
    await page.waitForFunction(() => window.__cloudStub.reminders.length === 0 && window.__cloudStub.deleted.length === 1);
    sent = await cloud(page);
    assert.deepEqual([sent.subscriptions.length, sent.deleted], [0, ['https://push.example.test/send/device-1']]);
    assert.equal(await page.evaluate(() => localStorage.getItem('test-fake-push')), null);
    assert.equal(await setting(page, 'remindersOn'), false);
    log('switched off: schedule cleared on the server, this device unsubscribed and removed');
    await page.context().close();
  }

  // ---- signing in later uploads right away ----
  {
    const page = await open({ stub: { configured: true, signedIn: false } });
    await page.clock.setFixedTime(MONDAY_8AM);
    await page.goto(server.url);
    await page.locator('.bar h1').first().waitFor();
    await seed(page);
    await page.evaluate(async () => (await import('./js/store.js')).updateSettings({ remindersOn: true }));
    const card = await notificationsCard(page);
    assert.match(await text(card), /sign in first/);
    assert.equal((await cloud(page)).uploads, 0);
    await page.evaluate(() => window.__cloudStub.setSignedIn(true));
    await page.waitForFunction(() => window.__cloudStub.uploads === 1);
    assert.equal((await cloud(page)).reminders[0].body, '1 to use soon: Milk');
    await card.getByLabel('Daily reminder').waitFor();
    assert.equal(await card.getByLabel('Daily reminder').isChecked(), true);
    await card.locator('button:text("Get them here too")').waitFor();
    await shot(page, 'signed-in-later');
    log('signing in uploads the schedule straight away; this device is offered to join');
    await page.context().close();
  }
} finally {
  await browser.close();
  await server.close();
}
if (problems.length) {
  console.log(`\nPROBLEMS:\n${problems.join('\n')}`);
  process.exit(1);
}
console.log('\nAll reminder checks passed, no console errors.');
