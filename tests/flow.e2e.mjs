// End-to-end scenario in Edge headless (phone viewport) with a controlled clock.
// Usage: node tests/flow.e2e.mjs [outputDir]
import { chromium } from 'playwright-core';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startServer } from '../tools/serve.mjs';
import { ean13Modules } from '../tools/fixtures/ean13.js';

const outDir = path.resolve(process.argv[2] || 'test-output');
fs.mkdirSync(outDir, { recursive: true });
const server = await startServer({ port: 0 });
const problems = [];
let step = 0;
const log = msg => console.log(`✔ ${msg}`);

const COLA = {
  code: '5449000000996',
  status: 1,
  product: {
    product_name: 'Coca-Cola Original', brands: 'Coca-Cola', quantity: '330 ml',
    image_front_small_url: '', categories_tags: ['en:beverages', 'en:sodas'],
  },
};

async function newPage(browser, opts = {}) {
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true,
    colorScheme: opts.dark ? 'dark' : 'light', acceptDownloads: true, ...opts.context,
  });
  await context.grantPermissions(['camera'], { origin: server.url.replace(/\/$/, '') });
  // Open Food Facts stub: Coca-Cola is known, everything else is not.
  await context.route(/open(food|products|beauty)facts\.org\/api/, route => {
    const known = route.request().url().includes('openfoodfacts.org') && route.request().url().includes(COLA.code);
    route.fulfill({ status: known ? 200 : 404, contentType: 'application/json', body: JSON.stringify(known ? COLA : { status: 0 }) });
  });
  await context.addInitScript(() => {
    window.__shared = null;
    navigator.share = async data => { window.__shared = data; };
  });
  const page = await context.newPage();
  page.on('console', m => {
    // The lookup stub answers 404 ("not found") on purpose; browsers log those as errors.
    if (m.type() === 'error' && !/facts\.org\/api/.test(m.location().url || '')) problems.push(`[console] ${m.text()} ${m.location().url || ''}`);
  });
  page.on('pageerror', e => problems.push(`[pageerror] ${e.message}\n${e.stack}`));
  return page;
}

const shot = (page, name) => page.screenshot({ path: path.join(outDir, `${String(++step).padStart(2, '0')}-${name}.png`), animations: 'disabled' });
const text = async loc => (await loc.textContent()).replace(/\s+/g, ' ').trim();

async function addProduct(page, p) {
  await page.goto(`${server.url}#/new`);
  await page.locator('#pf-name').fill(p.name);
  await page.locator('input[list="units"]').fill(p.unit);
  if (p.rate) {
    await page.getByLabel('Track how fast it gets used').check();
    await page.getByLabel('Amount').fill(String(p.rate[0]));
    await page.locator('.rate-row select').selectOption(p.rate[1]);
  }
  if (p.min) await page.locator('.field:has-text("Minimum to keep") input').fill(String(p.min));
  await page.locator('.field:has(> label:text-is("Usual location")) select').selectOption({ label: p.place });
  const stock = page.locator('fieldset:has(legend:text("In stock right now"))');
  await stock.locator('.stepper input').fill(String(p.qty));
  if (p.expiry) await stock.locator('input[type=date]').fill(p.expiry);
  await page.getByRole('button', { name: 'Save product' }).click();
  await page.waitForURL(/#\/product\//);
  await page.locator('.stock-qty').waitFor();
}

const MON = new Date(2026, 9, 12, 9, 30);
const NEXT_MON = new Date(2026, 9, 19, 12, 0);

const browser = await chromium.launch({ channel: 'msedge', headless: true, args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] });
try {
  const page = await newPage(browser);
  await page.clock.setFixedTime(MON);
  await page.goto(server.url);
  await page.locator('.welcome').waitFor();
  log('first run shows the welcome card');

  // Optional setting: count usage only during opening hours (Mon–Fri 09:00–18:00 when switched on).
  await page.goto(`${server.url}#/settings`);
  await page.getByLabel('Only count usage during opening hours').check();
  await page.locator('.field:has(> label:text-is("Opening days")) .chip-btn.on').first().waitFor();
  assert.deepEqual(await page.locator('.field:has(> label:text-is("Opening days")) .chip-btn.on').allTextContents(), ['Mon', 'Tue', 'Wed', 'Thu', 'Fri']);
  log('opening hours switched on in Settings (Mon–Fri 09:00–18:00)');

  await addProduct(page, { name: 'Still water 0.5 L', unit: 'bottle', rate: [5, 'day'], min: 6, qty: 24, expiry: '2027-10-01', place: 'Kitchen › Fridge' });
  assert.equal(await text(page.locator('.stock-qty')), '~24 bottles');
  await shot(page, 'product-water');
  await addProduct(page, { name: 'Paprika chips', unit: 'bag', rate: [1, 'week'], min: 1, qty: 2, expiry: '2026-12-01', place: 'Kitchen › Cupboards' });
  await addProduct(page, { name: 'Milk 1.5%', unit: 'carton', rate: [1, 'day'], qty: 5, expiry: '2026-10-14', place: 'Kitchen › Fridge' });
  await addProduct(page, { name: 'Yogurt', unit: 'cup', qty: 3, expiry: '2026-10-16', place: 'Kitchen › Fridge' });
  log('created 4 products through the form');

  await page.goto(`${server.url}#/`);
  const soonMilk = page.locator('.section:has-text("Use soon") .row:has-text("Milk 1.5%")');
  assert.match(await text(soonMilk), /~2 likely won't be used in time/);
  log('Today warns that ~2 milk cartons will expire unused (5 cartons, 1/day, printed Wed)');
  await shot(page, 'today-monday');

  // ---- one week later ----
  await page.clock.setFixedTime(NEXT_MON);
  await page.reload();
  try {
    await page.locator('.section-title:has-text("Check these")').waitFor({ timeout: 8000 });
  } catch (e) {
    console.log('DEBUG now:', await page.evaluate(() => new Date().toString()));
    console.log('DEBUG state:', await page.evaluate(async () => JSON.stringify((await import('./js/store.js')).getState().products.map(p => [p.name, p.anchorAt, p.rate]))));
    console.log('DEBUG main:', (await page.locator('body').innerText()).slice(0, 600));
    await shot(page, 'debug-failure');
    throw e;
  }
  const checks = await page.locator('.check-card .row-title').allTextContents();
  assert.deepEqual(checks.slice(0, 3).sort(), ['Milk 1.5%', 'Paprika chips', 'Still water 0.5 L'].sort());
  assert.match(await text(page.locator('.check-card:has-text("Still water")')), /ran out ~/);
  assert.match(await text(page.locator('.check-card:has-text("Paprika chips")')), /~1 left · you want at least 1/);
  assert.match(await text(page.locator('.section:has-text("Expired") .check-card:has-text("Yogurt")')), /expired 3 days ago/);
  assert.equal(await text(page.locator('.nav-item:has-text("Today") .badge')), '4');
  log('a week later: water/milk probably gone, chips low, yogurt expired (badge 4)');
  await shot(page, 'today-next-monday');

  await page.locator('.check-card:has-text("Still water") button:text("Gone")').click();
  assert.match(await text(page.locator('.toast')), /marked as gone — added to the reorder list/);
  const chips = page.locator('.check-card:has-text("Paprika chips")');
  await chips.locator('.stepper input').fill('1');
  await chips.locator('button[aria-label^="Save:"]').click();
  const milk = page.locator('.check-card:has-text("Milk 1.5%")');
  await milk.locator('.stepper input').fill('1');
  await milk.locator('button[aria-label^="Save:"]').click();
  assert.match(await text(page.locator('.toast')), /Your counts suggest ~0\.76 per day \(set: 1\)/);
  await shot(page, 'rate-suggestion-toast');
  await page.locator('.toast button').click();
  assert.match(await text(page.locator('.toast')), /Usage rate updated/);
  log('counted: water gone, chips 1, milk 1 → rate suggestion 0.76/day accepted');

  // The one milk carton left is from the batch printed Wednesday → now listed as expired.
  assert.deepEqual(await page.locator('.section:has-text("Expired") .row-title').allTextContents(), ['Milk 1.5%', 'Yogurt']);
  await page.locator('.check-card:has-text("Yogurt") button:text("Thrown away")').click();
  await page.locator('.sheet button:text("Log as thrown away")').click();
  await page.locator('.sheet').waitFor({ state: 'detached' });
  await page.locator('.check-card:has-text("Milk 1.5%") button:text("Used up")').click();
  assert.equal(await page.locator('.check-card').count(), 0);
  assert.match(await text(page.locator('.all-clear')), /Nothing to check/);
  log('leftover milk shows as expired; yogurt logged as waste, milk used up; Today is all clear');

  // ---- reorder ----
  await page.locator('.nav-item:has-text("Reorder")').click();
  await page.locator('.section-title:has-text("To order")').waitFor();
  assert.match(await text(page.locator('.row:has-text("Still water")')), /Out of stock.*Order ~31 bottles/);
  assert.match(await text(page.locator('.row:has-text("Paprika chips")')), /Low: ~1 left, minimum 1.*Order ~1 bag/);
  assert.match(await text(page.locator('.row:has-text("Yogurt")')), /Out of stock.*Order ~1 cup/);
  log('reorder: water 31 bottles (5/day × 5 opening days + min 6), chips 1, yogurt 1');
  await page.locator('input[placeholder^="Add an item"]').fill('Birthday cake for Friday');
  await page.locator('input[placeholder^="Add an item"]').press('Enter');
  await page.locator('button[aria-label="Mark Still water 0.5 L as ordered"]').click();
  await page.locator('.section-title:has-text("On order")').waitFor();
  await page.locator('button[aria-label="Share list"]').click();
  const shared = await page.evaluate(() => window.__shared);
  assert.match(shared.text, /• Paprika chips — 1 bag/);
  assert.match(shared.text, /• Birthday cake for Friday/);
  assert.doesNotMatch(shared.text, /Still water/); // already ordered
  log('marked water ordered; shared list text is correct');
  await shot(page, 'reorder');

  // ---- waste report ----
  await page.goto(`${server.url}#/waste`);
  assert.match(await text(page.locator('.section:has-text("Log") .row')), /Yogurt.*3 cups · expired/);
  log('waste report lists the yogurt');

  // ---- back gesture closes sheets, not the page ----
  await page.goto(`${server.url}#/pantry`);
  await page.locator('.row:has-text("Paprika chips")').first().click();
  await page.waitForURL(/#\/product\//);
  await page.getByRole('button', { name: 'Count' }).click();
  await page.locator('.sheet').waitFor();
  await page.goBack();
  await page.locator('.sheet').waitFor({ state: 'detached' });
  assert.match(page.url(), /#\/product\//);
  log('back gesture closes the open sheet and stays on the product page');
  await shot(page, 'product-chips');

  // ---- backup, erase, restore ----
  await page.goto(`${server.url}#/backup`);
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Save backup file' }).click()]);
  const backupPath = path.join(outDir, 'backup.json');
  await download.saveAs(backupPath);
  const backup = JSON.parse(fs.readFileSync(backupPath, 'utf8'));
  assert.equal(backup.state.products.length, 4);
  await page.getByRole('button', { name: 'Erase all data' }).click();
  await page.locator('.sheet button:text("Erase everything")').click();
  await page.goto(`${server.url}#/pantry`);
  await page.locator('.empty:has-text("Your pantry is empty")').waitFor();
  await page.goto(`${server.url}#/backup`);
  await page.locator('input[type=file]').setInputFiles(backupPath);
  await page.locator('.sheet button:text("Restore")').click();
  await page.goto(`${server.url}#/pantry`);
  assert.equal(await page.locator('.list .row').count(), 4);
  log('backup saved, data erased, and restored from the file');

  // ---- manual barcode entry → online lookup → new product, then known product ----
  await page.goto(`${server.url}#/`);
  await page.locator('button[aria-label="Scan a barcode"]').click();
  await page.locator('.scan-top button[aria-label="Type a barcode"]').click();
  await page.locator('.sheet input[name=v]').fill(COLA.code);
  await page.locator('.sheet button:text("Continue")').click();
  await page.locator('.lookup:has-text("Found on Open Food Facts")').waitFor();
  assert.equal(await page.locator('#pf-name').inputValue(), 'Coca-Cola Original');
  assert.equal(await page.locator('.field:has(> label:text-is("Category")) select option:checked').textContent(), 'Drinks');
  await page.locator('input[aria-label="Units per scan"]').fill('6');
  assert.equal(await page.locator('fieldset:has(legend:text("In stock right now")) .stepper input').inputValue(), '6');
  await shot(page, 'new-from-scan');
  await page.getByRole('button', { name: 'Save product' }).click();
  await page.waitForFunction(() => !location.hash.startsWith('#/scan'));
  log('typed barcode → found online → saved with 6 per scan; scanner closed');
  await page.locator('button[aria-label="Scan a barcode"]').click();
  await page.locator('.scan-top button[aria-label="Type a barcode"]').click();
  await page.locator('.sheet input[name=v]').fill(COLA.code);
  await page.locator('.sheet button:text("Continue")').click();
  await page.locator('.sheet h2:text("Coca-Cola Original")').waitFor();
  await shot(page, 'known-scan');
  await page.locator('.sheet button:text("Add 6 pcs")').click();
  await page.waitForFunction(() => !location.hash.startsWith('#/scan'));
  await page.goto(`${server.url}#/pantry`);
  assert.match(await text(page.locator('.row:has-text("Coca-Cola")')), /12 pcs/);
  log('scanning the known barcode adds 6 more (12 in stock)');
  await page.close();

  // ---- dark mode look ----
  const dark = await newPage(browser, { dark: true });
  await dark.clock.setFixedTime(MON);
  await dark.goto(server.url);
  await dark.locator('.bar h1').waitFor(); // app booted (initStore done) before importing
  await dark.evaluate(async json => {
    const { importJson, flush } = await import('./js/store.js');
    importJson(json);
    await flush();
  }, fs.readFileSync(backupPath, 'utf8'));
  await dark.clock.setFixedTime(new Date(2026, 9, 22, 12, 0));
  await dark.reload();
  await dark.locator('.check-card').first().waitFor();
  await shot(dark, 'today-dark');
  await dark.close();
} finally {
  await browser.close();
}

// ---- live camera: a JPEG of the EAN-13 fed to Edge's fake camera, restock mode ----
const mjpeg = path.join(outDir, 'barcode.mjpeg');
{
  const b = await chromium.launch({ channel: 'msedge', headless: true });
  const p = await b.newPage();
  const modules = ean13Modules(COLA.code);
  const dataUrl = await p.evaluate(mods => {
    const c = Object.assign(document.createElement('canvas'), { width: 1280, height: 720 });
    const g = c.getContext('2d');
    g.fillStyle = '#fff';
    g.fillRect(0, 0, c.width, c.height);
    g.fillStyle = '#000';
    const w = 6, x0 = (c.width - mods.length * w) / 2;
    for (let i = 0; i < mods.length; i++) if (mods[i] === '1') g.fillRect(x0 + i * w, 200, w, 320);
    return c.toDataURL('image/jpeg', 0.92);
  }, modules);
  fs.writeFileSync(mjpeg, Buffer.from(dataUrl.split(',')[1], 'base64'));
  await b.close();
}
const cam = await chromium.launch({
  channel: 'msedge', headless: true,
  args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-video-capture=${mjpeg}`],
});
try {
  const page = await newPage(cam);
  await page.goto(`${server.url}#/scan?mode=restock`);
  await page.locator('.lookup .mono').waitFor({ timeout: 20000 });
  assert.equal(await text(page.locator('.lookup .mono')), COLA.code);
  await page.locator('.lookup:has-text("Found on Open Food Facts")').waitFor();
  await page.getByRole('button', { name: 'Save & scan next' }).click();
  await page.locator('.tally').waitFor();
  log('camera read the barcode live; new product saved in restock mode, scanner still open');
  await page.locator('.sheet h2:text("Coca-Cola Original")').waitFor({ timeout: 20000 });
  await page.getByRole('button', { name: 'Add & scan next' }).click();
  await page.locator('.tally b:text("2 scanned")').waitFor();
  await shot(page, 'restock-tally');
  log('same barcode again → known product → added; tally shows 2 scans');
  await page.getByRole('button', { name: 'Done' }).click();
  await page.waitForFunction(() => !location.hash.startsWith('#/scan'));
} finally {
  await cam.close();
  await server.close();
}

if (problems.length) {
  console.log(`\nPROBLEMS:\n${problems.join('\n')}`);
  process.exit(1);
}
console.log('\nAll flow checks passed, no console errors.');
