// Smoke test: every screen renders without console errors (Edge headless, phone viewport).
// Usage: node tests/smoke.e2e.mjs [screenshotDir]
import { chromium } from 'playwright-core';
import fs from 'node:fs';
import path from 'node:path';
import { startServer } from '../tools/serve.mjs';

const outDir = process.argv[2] || path.join(process.cwd(), 'test-output');
fs.mkdirSync(outDir, { recursive: true });

const server = await startServer({ port: 0 });
const browser = await chromium.launch({ channel: 'msedge', headless: true });
const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
const page = await context.newPage();
const problems = [];
page.on('console', m => { if (m.type() === 'error' || m.type() === 'warning') problems.push(`[${m.type()}] ${m.text()}`); });
page.on('pageerror', e => problems.push(`[pageerror] ${e.message}\n${e.stack}`));

await page.goto(server.url);
await page.waitForSelector('.bar h1', { timeout: 10000 });
for (const route of ['', 'pantry', 'reorder', 'more', 'settings', 'locations', 'categories', 'waste', 'backup', 'help', 'new']) {
  await page.evaluate(r => { location.hash = `#/${r}`; dispatchEvent(new PopStateEvent('popstate', { state: history.state })); }, route);
  await page.waitForTimeout(250);
  const title = await page.locator('.bar h1').first().textContent().catch(() => '(no title)');
  console.log(`#/${route.padEnd(12)} → ${title}`);
  await page.screenshot({ path: path.join(outDir, `smoke-${route || 'today'}.png`) });
}
console.log(problems.length ? `PROBLEMS:\n${problems.join('\n')}` : 'No console errors.');
await browser.close();
await server.close();
process.exit(problems.some(p => p.startsWith('[pageerror]') || p.startsWith('[error]')) ? 1 : 0);
