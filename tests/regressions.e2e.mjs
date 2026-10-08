// Regression checks for issues found in code review (Edge headless, phone viewport).
// Usage: node tests/regressions.e2e.mjs [outputDir]
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

const browser = await chromium.launch({ channel: 'msedge', headless: true });
try {
  const context = await browser.newContext({ viewport: { width: 360, height: 760 }, isMobile: true, hasTouch: true, locale: 'ro-RO' });
  await context.route(/facts\.org\/api/, route => route.fulfill({ status: 404, contentType: 'application/json', body: '{"status":0}' }));
  // The committed config points at the production project: run this test with the online features off.
  await context.addInitScript(() => { globalThis.__PANTRI_CONFIG__ = { SUPABASE_URL: '', SUPABASE_ANON_KEY: '', VAPID_PUBLIC_KEY: '' }; });
  const page = await context.newPage();
  page.on('console', m => m.type() === 'error' && !/facts\.org\/api/.test(m.location().url || '') && problems.push(m.text()));
  page.on('pageerror', e => problems.push(`${e.message}\n${e.stack}`));
  const go = async hash => {
    await page.goto(`${server.url}${hash}`);
    await page.locator('.bar h1').first().waitFor();
  };
  const sheetGone = () => page.locator('.sheet').waitFor({ state: 'detached', timeout: 3000 });
  const addProduct = async p => {
    await go('#/new');
    await page.locator('#pf-name').fill(p.name);
    await page.locator('#pf-unit').fill(p.unit || 'pcs');
    if (p.rate) {
      await page.getByLabel('Track how fast it gets used').check();
      await page.getByLabel('Amount').fill(p.rate[0]);
      await page.getByLabel('Per', { exact: true }).selectOption(p.rate[1]);
    }
    if (p.min) await page.locator('#pf-min').fill(p.min);
    await page.locator('fieldset:has(legend:text("In stock right now")) .stepper input').fill(p.qty);
    await page.getByRole('button', { name: 'Save product' }).click();
    await page.waitForURL(/#\/product\//);
    return page.url().split('#/product/')[1];
  };

  await page.clock.setFixedTime(new Date(2026, 9, 12, 9, 30));
  await go('');

  // ---- 1. sheets keep working after a reload (stale history entry from the previous page load) ----
  await go('#/categories');
  await page.getByRole('button', { name: 'Add category' }).click();
  await page.locator('.sheet').waitFor();
  await page.reload();
  await page.locator('.bar h1').first().waitFor();
  await page.getByRole('button', { name: 'Add category' }).click();
  await page.locator('.sheet input[name=v]').fill('Breakfast');
  await page.locator('.sheet button:text("Save")').click();
  await sheetGone();
  assert.equal(await page.locator('.row-title:text-is("Breakfast")').count(), 1);
  log('after a reload with a sheet open, the next sheet still saves once and closes');

  // ---- 2. decimal commas (ro-RO keyboard): "1,5" means 1.5, not 15 ----
  const coffee = await addProduct({ name: 'Coffee beans', unit: 'kg', qty: '1,5', rate: ['0,5', 'week'] });
  assert.equal(await text(page.locator('.stock-qty')), '~2 kg'); // an estimate is shown in whole units
  const saved = await page.evaluate(async id => {
    const { getState } = await import('./js/store.js');
    const p = getState().products.find(x => x.id === id);
    return { rate: p.rate, qty: getState().batches.filter(b => b.productId === id).reduce((t, b) => t + b.qty, 0) };
  }, coffee);
  assert.deepEqual(saved, { rate: { qty: 0.5, per: 'week' }, qty: 1.5 });
  const sugar = await addProduct({ name: 'Sugar', unit: 'kg', qty: '1' });
  await page.getByRole('button', { name: 'Count' }).click();
  await page.locator('.sheet .stepper input').fill('0,4');
  await page.locator('.sheet button:text("Save count")').click();
  await sheetGone();
  assert.match(await text(page.locator('.stock-qty')), /^0[.,]4 kg$/);
  await go('#/reorder');
  assert.equal(await page.locator(`.row:has-text("Sugar")`).count(), 0); // 0.4 kg is not "out"
  log('decimal commas are understood (1,5 kg; 0,5 per week; count 0,4 kg) and 0.4 kg is not "out"');
  void sugar;

  // ---- 3. stock that lasts for years doesn't break the product page ----
  await addProduct({ name: 'Paper cups', qty: '300', rate: ['1', 'month'] });
  assert.match(await text(page.locator('.stock-card')), /lasts for years at this pace/);
  log('300 pcs at 1 per month: product page shows "lasts for years"');

  // ---- 4. a pending "gone?" check survives an unrelated settings change ----
  await addProduct({ name: 'Still water', qty: '24', rate: ['5', 'day'], min: '6' });
  await page.clock.setFixedTime(new Date(2026, 9, 19, 12, 0));
  await page.reload(); // the app picks up the new date on load (or on its minute tick)
  await go('#/');
  await page.locator('.check-card:has-text("Still water")').waitFor();
  await go('#/settings');
  await page.locator('input[type=date]').first().fill('2026-12-24');
  await page.getByRole('button', { name: 'Add closure' }).click();
  await go('#/');
  await page.locator('.check-card:has-text("Still water")').waitFor();
  log('adding a closure does not silently resolve a pending "gone?" check');

  // ---- 5. a delivery that is counted (not added) clears "on order" ----
  await go('#/reorder');
  await page.locator('button[aria-label="Mark Still water as ordered"]').click();
  await page.locator('.section-title:has-text("On order")').waitFor();
  await page.locator('.nav-item:has-text("Pantry")').click();
  await page.locator('.row:has-text("Still water")').first().click();
  await page.getByRole('button', { name: 'Count' }).click();
  await page.locator('.sheet .stepper input').fill('24');
  await page.locator('.sheet button:text("Save count")').click();
  await sheetGone();
  await go('#/reorder');
  assert.equal(await page.locator('.section-title:has-text("On order")').count(), 0);
  log('counting the delivered stock takes the item off "On order"');
} finally {
  await browser.close();
  await server.close();
}
if (problems.length) {
  console.log(`\nPROBLEMS:\n${problems.join('\n')}`);
  process.exit(1);
}
console.log('\nAll regression checks passed, no console errors.');
