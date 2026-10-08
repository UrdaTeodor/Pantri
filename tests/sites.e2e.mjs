// Several sites (Main site, Warehouse, Apartment): per-site reminders, hours, scanning, reorder grouping.
// Usage: node tests/sites.e2e.mjs [outputDir]
import { chromium } from 'playwright-core';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startServer } from '../tools/serve.mjs';

const outDir = path.resolve(process.argv[2] || 'test-output');
fs.mkdirSync(outDir, { recursive: true });
const server = await startServer({ port: 0 });
const problems = [];
const log = msg => console.log(`✔ ${msg}`);
const text = async loc => (await loc.textContent()).replace(/\s+/g, ' ').trim();
const CODE = '5449000000996';

const browser = await chromium.launch({ channel: 'msedge', headless: true, args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] });
try {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  await context.grantPermissions(['camera'], { origin: server.url.replace(/\/$/, '') });
  await context.route(/facts\.org\/api/, route => route.fulfill({ status: 404, contentType: 'application/json', body: '{"status":0}' }));
  await context.addInitScript(() => { navigator.share = async d => { window.__shared = d; }; });
  const page = await context.newPage();
  page.on('console', m => m.type() === 'error' && !/facts\.org\/api/.test(m.location().url || '') && problems.push(m.text()));
  page.on('pageerror', e => problems.push(`${e.message}\n${e.stack}`));
  const shot = name => page.screenshot({ path: path.join(outDir, `sites-${name}.png`), animations: 'disabled' });
  const go = async hash => {
    await page.goto(`${server.url}${hash}`);
    await page.locator('.bar h1').first().waitFor();
  };

  await page.clock.setFixedTime(new Date(2026, 9, 12, 9, 30));
  await go('');
  assert.equal(await page.locator('.site-bar').count(), 0); // one site → no site switcher

  // ---- add two more sites; the warehouse is only in use on weekdays ----
  await go('#/locations');
  for (const name of ['Warehouse', 'Apartment']) {
    await page.getByRole('button', { name: 'Add a site' }).click();
    await page.locator('.sheet input[name=v]').fill(name);
    await page.locator('.sheet button:text("Save")').click();
    await page.locator('.sheet').waitFor({ state: 'detached' });
  }
  await page.locator('.row-main:has-text("Warehouse")').click();
  await page.locator('.sheet .menu-item:has-text("Opening days & hours")').click();
  await page.getByLabel(/Same as the default \(every day, all day\)/).uncheck();
  for (const day of ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']) {
    const chip = page.locator(`.sheet .chip-btn:text-is("${day}")`);
    const on = (await chip.getAttribute('aria-pressed')) === 'true';
    if (on !== !['Sat', 'Sun'].includes(day)) await chip.click();
  }
  await page.locator('.sheet button:text("Save")').click();
  await page.locator('.row:has-text("Warehouse") .row-sub:has-text("Mon–Fri 09:00–18:00")').waitFor();
  log('added sites Warehouse and Apartment; the warehouse has its own hours (Mon–Fri 09:00–18:00)');
  await shot('locations');

  // ---- products at each site ----
  const addProduct = async p => {
    await go('#/new');
    await page.locator('#pf-name').fill(p.name);
    if (p.code) {
      await page.getByRole('button', { name: '+ Add a barcode' }).click();
      await page.locator('input[aria-label="Barcode"]').fill(p.code);
    }
    if (p.rate) {
      await page.getByLabel('Track how fast it gets used').check();
      await page.getByLabel('Amount').fill(String(p.rate));
    }
    await page.locator('#pf-location').selectOption({ label: p.place });
    const stock = page.locator('fieldset:has(legend:text("In stock right now"))');
    await stock.locator('.stepper input').fill(String(p.qty));
    if (p.expiry) await stock.locator('input[type=date]').fill(p.expiry);
    await page.getByRole('button', { name: 'Save product' }).click();
    await page.waitForURL(/#\/product\//);
  };
  await addProduct({ name: 'Still water 0.5 L', code: CODE, rate: 5, qty: 24, place: 'Main site › Kitchen › Fridge' });
  await addProduct({ name: 'Milk 1.5%', qty: 2, expiry: '2026-10-13', place: 'Warehouse' });
  await addProduct({ name: 'Yogurt', qty: 3, expiry: '2026-10-13', place: 'Apartment' });
  log('created water at the main site, milk at the warehouse, yogurt at the apartment');

  // ---- scanning the main-site water at the apartment → track it there too ----
  await go('#/');
  await page.locator('.site-bar button:text("Apartment")').click();
  await page.locator('button[aria-label="Scan a barcode"]').click();
  assert.match(await text(page.locator('.scan-title')), /Apartment/);
  await page.locator('.scan-top button[aria-label="Type a barcode"]').click();
  await page.locator('.sheet input[name=v]').fill(CODE);
  await page.locator('.sheet button:text("Continue")').click();
  await page.locator(".sheet h2:text(\"Still water 0.5 L isn't tracked at Apartment yet\")").waitFor();
  await page.locator('.sheet .menu-item:has-text("Track it at Apartment")').click();
  await page.locator('.sheet h2:text("Still water 0.5 L")').waitFor();
  assert.match(await text(page.locator('.sheet .field:has-text("Where is it going?") select')), /^Apartment$/);
  await page.locator('.sheet .stepper input').first().fill('6');
  await page.locator('.sheet button:text("Add 6 pcs")').click();
  await page.waitForFunction(() => !location.hash.startsWith('#/scan'));
  log('scanned the main-site water at the apartment → tracked separately there with 6 in stock');

  // ---- per-site reminders ----
  await page.locator('.site-bar button:text("All sites")').click();
  const blocks = await page.locator('.site-block .site-title').allTextContents();
  assert.deepEqual(blocks.map(t => t.trim()), ['Warehouse', 'Apartment']);
  assert.match(await text(page.locator('.site-block:has-text("Warehouse")')), /Milk 1\.5%.*expires tomorrow/);
  assert.doesNotMatch(await text(page.locator('.site-block:has-text("Warehouse")')), /Yogurt/);
  assert.match(await text(page.locator('.site-block:has-text("Apartment")')), /Yogurt.*expires tomorrow/);
  log('Today (all sites): expiring items are listed per site');
  await shot('today-all');
  await page.locator('.site-bar button:text("Warehouse")').click();
  assert.equal(await page.locator('.site-block').count(), 0);
  assert.match(await text(page.locator('main')), /Milk 1\.5%/);
  assert.doesNotMatch(await text(page.locator('main')), /Yogurt/);
  log('picking Warehouse shows only the warehouse');

  // ---- a week later: checks + expiry per site ----
  await page.clock.setFixedTime(new Date(2026, 9, 19, 12, 0));
  await page.reload();
  await page.locator('.site-bar button:text("All sites")').click();
  const main = await text(page.locator('.site-block:has-text("Main site")'));
  const flat = await text(page.locator('.site-block:has-text("Apartment")'));
  assert.match(main, /Check these.*Still water 0\.5 L/);
  assert.match(flat, /Check these.*Still water 0\.5 L/);
  assert.match(flat, /Expired.*Yogurt/);
  assert.match(await text(page.locator('.site-block:has-text("Warehouse")')), /Expired.*Milk 1\.5%/);
  log('a week later: water checks at both sites that have it; expired milk/yogurt under their own sites');
  await shot('today-week-later');

  // ---- reorder grouped by site, shared with site headings ----
  await page.locator('.nav-item:has-text("Reorder")').click();
  await page.locator('.group-title').first().waitFor();
  assert.deepEqual((await page.locator('.group-title').allTextContents()).map(t => t.trim()), ['Main site', 'Warehouse', 'Apartment']);
  await page.locator('button[aria-label="Share list"]').click();
  const shared = await page.evaluate(() => window.__shared.text);
  assert.match(shared, /Main site:\n• Still water 0\.5 L/);
  assert.match(shared, /Warehouse:\n• Milk 1\.5%/);
  assert.match(shared, /Apartment:\n(• .*\n)*• Still water 0\.5 L/);
  log('reorder list and shared text are grouped by site (expired-only milk included)');
  await shot('reorder');

  // ---- pantry filtered to the apartment ----
  await page.locator('.nav-item:has-text("Pantry")').click();
  await page.locator('.site-bar button:text("Apartment")').click();
  const rows = await page.locator('.list .row-title').allTextContents();
  assert.deepEqual(rows.sort(), ['Still water 0.5 L', 'Yogurt']);
  log('pantry shows only what is at the apartment');
} finally {
  await browser.close();
  await server.close();
}
if (problems.length) {
  console.log(`\nPROBLEMS:\n${problems.join('\n')}`);
  process.exit(1);
}
console.log('\nAll site checks passed, no console errors.');
