#!/usr/bin/env node
// End-to-end check of app/js/barcode.js in a real browser (headless Microsoft Edge):
//   1. serves app/ under /office-pantry/ with tools/serve.mjs (same sub-path shape as GitHub Pages)
//   2. aborts every request that is not to localhost - proves nothing is fetched from a CDN
//      (a probe fetch to jsDelivr confirms the block is really active)
//   3. opens a fixture page on that origin (not index.html), imports ./js/barcode.js and decodes
//      a synthesized EAN-13 (5449000000996) and a QR code from canvas, ImageData, Blob,
//      ImageBitmap and a <video> fed by canvas.captureStream(); a blank image must give [].
// If the browser has a native BarcodeDetector, the run is repeated with it removed so the
// vendored ZXing/WASM path is always exercised.
//
//   node tools/check-barcode.mjs          (exit code 0 = pass)
// Env: BROWSER_CHANNEL (default msedge), BROWSER_PATH (explicit executable), HEADED=1.

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { startServer } from './serve.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FIXTURES = path.join(ROOT, 'tools', 'fixtures');
const BASE = '/office-pantry/';
const FIXTURE_DIR = '__check__/';
const EAN = '5449000000996';
const QR_TEXT = 'https://urdateodor.github.io/office-pantry/#/scan?code=5449000000996';
const PROBE_URL = 'https://cdn.jsdelivr.net/npm/zxing-wasm@3.1.3/package.json';
const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);

const PAGE_HTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>barcode check</title></head>
<body><p>tools/check-barcode.mjs fixture page</p></body></html>`;

function withTimeout(promise, ms, what) {
  let timer;
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${what} timed out after ${ms} ms`)), ms);
    }),
  ]);
}

// Runs inside the page.
async function runInPage({ ean, qrText, probeUrl }) {
  const out = { probe: null, cases: [], errors: [] };
  try {
    await fetch(probeUrl, { cache: 'no-store' });
    out.probe = 'NOT BLOCKED';
  } catch {
    out.probe = 'blocked';
  }

  out.nativeApi = typeof window.BarcodeDetector === 'function';
  const { ean13Modules } = await import('./ean13.js');
  const { qrMatrix } = await import('./qr.js');
  const { drawLinear, drawMatrix, blankCanvas, videoFromCanvas } = await import('./draw.js');

  const t0 = performance.now();
  const barcode = await import('../js/barcode.js'); // must not throw
  const p1 = barcode.createDetector();
  const p2 = barcode.createDetector();
  const detector = await p1;
  out.readyMs = Math.round(performance.now() - t0);
  out.samePromise = p1 === p2 && p1 === barcode.createDetector();
  out.kind = detector.kind;
  out.formats = [...detector.formats];

  const run = async (name, expect, getSource) => {
    const row = { name, expect };
    try {
      const source = await getSource();
      if (source === null) {
        row.skipped = true;
      } else {
        const t = performance.now();
        const hits = await detector.detect(source);
        row.ms = Math.round(performance.now() - t);
        row.hits = hits.map((h) => ({ rawValue: h.rawValue, format: h.format }));
      }
    } catch (err) {
      row.error = `${err?.name}: ${err?.message}`;
    }
    out.cases.push(row);
  };

  const eanCanvas = drawLinear(ean13Modules(ean));
  const qrCanvas = drawMatrix(qrMatrix(qrText));
  const eanBlob = await new Promise((resolve) => eanCanvas.toBlob(resolve, 'image/png'));
  const eanExpect = { rawValue: ean, format: 'ean_13' };
  const qrExpect = { rawValue: qrText, format: 'qr_code' };

  await run('EAN-13 / HTMLCanvasElement', eanExpect, () => eanCanvas);
  await run('EAN-13 / ImageData', eanExpect, () => eanCanvas.getContext('2d').getImageData(0, 0, eanCanvas.width, eanCanvas.height));
  await run('EAN-13 / Blob (PNG)', eanExpect, () => eanBlob);
  await run('EAN-13 / ImageBitmap', eanExpect, () => createImageBitmap(eanCanvas));
  let feed = null;
  await run('EAN-13 / HTMLVideoElement', eanExpect, async () => {
    feed = await videoFromCanvas(eanCanvas);
    return feed ? feed.video : null;
  });
  feed?.stop();
  await run('QR / HTMLCanvasElement', qrExpect, () => qrCanvas);
  await run('QR / ImageBitmap', qrExpect, () => createImageBitmap(qrCanvas));
  await run('blank canvas', null, () => blankCanvas());
  await run('<video> without a frame', null, () => document.createElement('video'));
  return out;
}

async function checkOnce({ browser, url, forceZxing }) {
  const context = await browser.newContext({ serviceWorkers: 'block' });
  const blocked = [];
  const local = [];
  const fixturePrefix = new URL(FIXTURE_DIR, url).pathname;

  await context.route('**/*', async (route) => {
    const reqUrl = new URL(route.request().url());
    if (!LOCAL_HOSTS.has(reqUrl.hostname)) {
      blocked.push(reqUrl.href);
      return route.abort('blockedbyclient');
    }
    if (reqUrl.pathname.startsWith(fixturePrefix)) {
      const name = reqUrl.pathname.slice(fixturePrefix.length) || 'index.html';
      if (name === 'index.html') return route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: PAGE_HTML });
      if (/^[\w-]+\.js$/.test(name)) {
        const body = await fs.readFile(path.join(FIXTURES, name), 'utf8').catch(() => null);
        if (body !== null) return route.fulfill({ status: 200, contentType: 'text/javascript', body });
      }
      return route.fulfill({ status: 404, contentType: 'text/plain', body: 'no such fixture' });
    }
    local.push(reqUrl.pathname);
    return route.continue();
  });
  if (forceZxing) await context.addInitScript(() => delete window.BarcodeDetector);

  const page = await context.newPage();
  const consoleErrors = [];
  const contentTypes = {};
  page.on('pageerror', (err) => consoleErrors.push(`pageerror: ${err.message}`));
  page.on('console', (msg) => {
    // Blocked requests are already listed (and checked) via `blocked`; don't repeat them here.
    if (msg.type() === 'error' && !msg.text().includes('ERR_BLOCKED_BY_CLIENT')) consoleErrors.push(`console: ${msg.text()}`);
  });
  page.on('response', (res) => {
    const u = new URL(res.url());
    if (LOCAL_HOSTS.has(u.hostname)) contentTypes[u.pathname] = res.headers()['content-type'];
  });

  try {
    await page.goto(new URL(`${FIXTURE_DIR}index.html`, url).href);
    const result = await withTimeout(page.evaluate(runInPage, { ean: EAN, qrText: QR_TEXT, probeUrl: PROBE_URL }), 90_000, 'in-page check');
    return { ...result, blocked, local, contentTypes, consoleErrors };
  } finally {
    await context.close();
  }
}

function evaluate(result) {
  const failures = [];
  if (result.probe !== 'blocked') failures.push('the CDN probe request was NOT blocked - the network block is not working');
  const unexpectedBlocked = result.blocked.filter((u) => u !== PROBE_URL);
  if (unexpectedBlocked.length) failures.push(`non-localhost requests attempted: ${unexpectedBlocked.join(', ')}`);
  if (!result.samePromise) failures.push('createDetector() did not return the same promise on repeated calls');
  for (const c of result.cases) {
    if (c.error) failures.push(`${c.name}: threw ${c.error}`);
    else if (c.skipped) continue;
    else if (c.expect === null && c.hits.length) failures.push(`${c.name}: expected no result, got ${JSON.stringify(c.hits)}`);
    else if (c.expect && !c.hits.some((h) => h.rawValue === c.expect.rawValue && h.format === c.expect.format)) {
      failures.push(`${c.name}: expected ${c.expect.format} ${JSON.stringify(c.expect.rawValue)}, got ${JSON.stringify(c.hits)}`);
    }
  }
  if (result.kind === 'zxing') {
    const wasm = Object.keys(result.contentTypes).find((p) => p.endsWith('/vendor/zxing_reader.wasm'));
    if (!wasm) failures.push('zxing path used but vendor/zxing_reader.wasm was not loaded from the local server');
    else if (!String(result.contentTypes[wasm]).startsWith('application/wasm')) failures.push(`wasm served as ${result.contentTypes[wasm]}`);
  }
  return failures;
}

function report(label, result) {
  console.log(`\n[${label}] native BarcodeDetector API present: ${result.nativeApi ? 'yes' : 'no'}`);
  console.log(`[${label}] detector.kind = ${result.kind}; createDetector() ready in ${result.readyMs} ms; memoized (same promise): ${result.samePromise ? 'yes' : 'NO'}`);
  console.log(`[${label}] formats: ${result.formats.join(', ')}`);
  const width = Math.max(...result.cases.map((c) => c.name.length));
  for (const c of result.cases) {
    let text;
    if (c.error) text = `ERROR ${c.error}`;
    else if (c.skipped) text = 'skipped (browser produced no video frame)';
    else if (!c.hits.length) text = '[] (nothing found)';
    else text = c.hits.map((h) => `${h.format} ${JSON.stringify(h.rawValue)}`).join(' + ');
    console.log(`  ${c.name.padEnd(width)}  ->  ${text}${c.ms !== undefined ? `  (${c.ms} ms)` : ''}`);
  }
  const shown = [...new Set(result.local)].filter((p) => !p.includes(FIXTURE_DIR));
  console.log(`[${label}] app files fetched from localhost:`);
  for (const p of shown) console.log(`  ${p}  [${result.contentTypes[p] ?? '?'}]`);
  console.log(`[${label}] non-localhost requests blocked: ${result.blocked.length} (${result.blocked.join(', ') || 'none'}; the jsDelivr one is the deliberate probe)`);
  if (result.consoleErrors.length) console.log(`[${label}] browser console errors:\n  ${result.consoleErrors.join('\n  ')}`);
}

async function main() {
  const server = await startServer({ root: 'app', base: BASE });
  let browser;
  let failures = [];
  try {
    const launch = { headless: process.env.HEADED !== '1' };
    if (process.env.BROWSER_PATH) launch.executablePath = process.env.BROWSER_PATH;
    else launch.channel = process.env.BROWSER_CHANNEL || 'msedge';
    browser = await chromium.launch(launch);
    console.log(`check-barcode: ${launch.channel ?? launch.executablePath} ${browser.version()} (${launch.headless ? 'headless' : 'headed'})`);
    console.log(`app served at ${server.url} (fixture page: ${server.url}${FIXTURE_DIR}index.html)`);

    const first = await checkOnce({ browser, url: server.url, forceZxing: false });
    report('default', first);
    failures = evaluate(first).map((f) => `[default] ${f}`);

    if (first.kind !== 'zxing') {
      const forced = await checkOnce({ browser, url: server.url, forceZxing: true });
      report('native removed', forced);
      failures.push(...evaluate(forced).map((f) => `[native removed] ${f}`));
      if (forced.kind !== 'zxing') failures.push('[native removed] expected kind "zxing"');
    }
  } finally {
    await browser?.close();
    await server.close();
  }

  if (failures.length) {
    console.log(`\nFAIL (${failures.length}):\n  ${failures.join('\n  ')}`);
    process.exitCode = 1;
  } else {
    console.log('\nPASS: barcode.js decodes EAN-13 and QR offline via the vendored ZXing/WASM ponyfill.');
  }
}

main().catch((err) => {
  console.error(`check-barcode failed: ${err?.stack ?? err}`);
  process.exit(1);
});
