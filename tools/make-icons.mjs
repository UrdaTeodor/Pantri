#!/usr/bin/env node
// Generates the PWA icons from one SVG design, rasterised by headless Microsoft Edge
// (playwright-core) and PNG-encoded here (no image libraries).
//
//   node tools/make-icons.mjs [--preview <file.png>]
//
// Writes app/icons/:
//   favicon.svg            rounded-square icon (vector)
//   icon-192.png           purpose "any": rounded square, transparent corners
//   icon-512.png           purpose "any"
//   maskable-512.png       purpose "maskable": full-bleed, motif inside the central 80% safe circle
//   apple-touch-icon.png   180x180, opaque full-bleed (iOS rounds the corners itself)
// --preview writes a contact sheet (icons at several sizes + mask shapes) for eyeballing.
// Env: BROWSER_CHANNEL (default msedge) or BROWSER_PATH.

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';
import { chromium } from 'playwright-core';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = path.join(ROOT, 'app', 'icons');

const TEAL = '#0f766e';
const TEAL_RGB = [0x0f, 0x76, 0x6e];
const WHITE = '#ffffff';

// ---- design (512 x 512 grid) ---------------------------------------------------------------
// Scanner corner brackets around five barcode bars of varying width, with a shelf line beneath.
const BARS = [
  [152, 30],
  [200, 16],
  [236, 40],
  [294, 18],
  [332, 28],
]; // [x, width]; spans x 152..360
const BAR_TOP = 158;
const BAR_HEIGHT = 140;

function motif(scale = 1) {
  const transform = scale === 1 ? '' : ` transform="translate(256 256) scale(${scale}) translate(-256 -256)"`;
  return [
    `<g${transform}>`,
    `<path d="M104 176V104h72M336 104h72v72M408 336v72h-72M176 408h-72v-72" fill="none" stroke="${WHITE}" stroke-width="28" stroke-linecap="round" stroke-linejoin="round"/>`,
    `<g fill="${WHITE}">${BARS.map(([x, w]) => `<rect x="${x}" y="${BAR_TOP}" width="${w}" height="${BAR_HEIGHT}" rx="3"/>`).join('')}</g>`,
    `<path d="M152 336h208" stroke="${WHITE}" stroke-width="24" stroke-linecap="round"/>`,
    '</g>',
  ].join('');
}

const VARIANTS = {
  any: { background: `<rect width="512" height="512" rx="104" fill="${TEAL}"/>`, scale: 1 },
  maskable: { background: `<rect width="512" height="512" fill="${TEAL}"/>`, scale: 0.84 },
  apple: { background: `<rect width="512" height="512" fill="${TEAL}"/>`, scale: 0.9 },
};

function svg(variant, size) {
  const { background, scale } = VARIANTS[variant];
  const dims = size ? ` width="${size}" height="${size}"` : '';
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"${dims}>${background}${motif(scale)}</svg>`;
}

const TARGETS = [
  { file: 'icon-192.png', size: 192, variant: 'any', opaque: false },
  { file: 'icon-512.png', size: 512, variant: 'any', opaque: false },
  { file: 'maskable-512.png', size: 512, variant: 'maskable', opaque: true },
  { file: 'apple-touch-icon.png', size: 180, variant: 'apple', opaque: true },
];

// ---- minimal PNG encoder ---------------------------------------------------------------------
const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, crc]);
}
/** rgba: Uint8Array of width*height*4. alpha=false writes an RGB (colour type 2) PNG. */
function encodePng(rgba, width, height, { alpha }) {
  const channels = alpha ? 4 : 3;
  const stride = width * channels;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    const row = y * (stride + 1);
    raw[row] = 0; // filter: none
    for (let x = 0; x < width; x++) {
      const s = (y * width + x) * 4;
      const d = row + 1 + x * channels;
      raw[d] = rgba[s];
      raw[d + 1] = rgba[s + 1];
      raw[d + 2] = rgba[s + 2];
      if (alpha) raw[d + 3] = rgba[s + 3];
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = alpha ? 6 : 2; // RGBA : RGB
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---- checks -----------------------------------------------------------------------------------
function verify(target, rgba) {
  const { size, variant, opaque, file } = target;
  const px = (x, y) => rgba.subarray((y * size + x) * 4, (y * size + x) * 4 + 4);
  const problems = [];
  if (opaque) {
    for (let i = 3; i < rgba.length; i += 4) {
      if (rgba[i] !== 255) {
        problems.push('has non-opaque pixels');
        break;
      }
    }
  } else if (px(0, 0)[3] !== 0) {
    problems.push('corner should be transparent (rounded square)');
  }
  const mid = px(Math.round(size * 0.12), Math.round(size / 2)); // background area, left middle
  if (Math.max(...TEAL_RGB.map((v, i) => Math.abs(v - mid[i]))) > 2) problems.push(`background is rgb(${[...mid].slice(0, 3)}) not ${TEAL}`);
  if (variant === 'maskable') {
    // Everything outside the safe circle (radius 40% of the size) must be plain background.
    const c = (size - 1) / 2;
    const r = size * 0.4;
    let outside = 0;
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        if (Math.hypot(x - c, y - c) <= r) continue;
        const p = px(x, y);
        if (Math.max(...TEAL_RGB.map((v, i) => Math.abs(v - p[i]))) > 2) outside++;
      }
    }
    if (outside) problems.push(`${outside} motif pixels outside the 80% safe zone`);
  }
  if (problems.length) throw new Error(`${file}: ${problems.join('; ')}`);
}

// ---- main -------------------------------------------------------------------------------------
async function rasterize(page, svgText, size) {
  const b64 = await page.evaluate(
    async ({ svgText, size }) => {
      const img = new Image();
      img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svgText)}`;
      await img.decode();
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = size;
      const ctx = canvas.getContext('2d', { colorSpace: 'srgb' });
      ctx.drawImage(img, 0, 0, size, size);
      const bytes = ctx.getImageData(0, 0, size, size).data;
      let bin = '';
      for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
      return btoa(bin);
    },
    { svgText, size },
  );
  return new Uint8Array(Buffer.from(b64, 'base64'));
}

async function writePreview(page, file) {
  const dataUrl = async (name) => `data:image/png;base64,${(await fs.readFile(path.join(OUT_DIR, name))).toString('base64')}`;
  const any = await dataUrl('icon-512.png');
  const mask = await dataUrl('maskable-512.png');
  const apple = await dataUrl('apple-touch-icon.png');
  const fav = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(await fs.readFile(path.join(OUT_DIR, 'favicon.svg'), 'utf8'))}`;
  const html = `<!doctype html><style>
    body{margin:0;padding:16px;font:12px system-ui;background:#fff;color:#333}
    .row{display:flex;gap:18px;align-items:flex-end;margin-bottom:14px;padding:10px;border-radius:8px}
    .dark{background:#202124;color:#ddd}.grey{background:#e8eaed}
    figure{margin:0;text-align:center}img{display:block;margin:0 auto 4px}
  </style>
  <div class="row grey">
    <figure><img src="${any}" width="192" height="192"><figcaption>any 192</figcaption></figure>
    <figure><img src="${mask}" width="192" height="192"><figcaption>maskable (raw)</figcaption></figure>
    <figure><img src="${mask}" width="192" height="192" style="border-radius:50%"><figcaption>maskable circle</figcaption></figure>
    <figure><img src="${mask}" width="192" height="192" style="clip-path:inset(10% round 22%)"><figcaption>maskable 80% squircle</figcaption></figure>
    <figure><img src="${apple}" width="180" height="180" style="border-radius:22.5%"><figcaption>apple (iOS mask)</figcaption></figure>
  </div>
  <div class="row">
    ${[96, 72, 48, 32].map((s) => `<figure><img src="${any}" width="${s}" height="${s}"><figcaption>${s}px</figcaption></figure>`).join('')}
    ${[32, 16].map((s) => `<figure><img src="${fav}" width="${s}" height="${s}"><figcaption>favicon ${s}</figcaption></figure>`).join('')}
  </div>
  <div class="row dark">
    ${[96, 48, 32].map((s) => `<figure><img src="${any}" width="${s}" height="${s}"><figcaption>${s}px</figcaption></figure>`).join('')}
    ${[48].map((s) => `<figure><img src="${mask}" width="${s}" height="${s}" style="border-radius:50%"><figcaption>mask ${s}</figcaption></figure>`).join('')}
    ${[32, 16].map((s) => `<figure><img src="${fav}" width="${s}" height="${s}"><figcaption>favicon ${s}</figcaption></figure>`).join('')}
  </div>`;
  await page.setViewportSize({ width: 1100, height: 600 });
  await page.setContent(html);
  await page.evaluate(() => Promise.all([...document.images].map((i) => i.decode())));
  const height = await page.evaluate(() => document.documentElement.scrollHeight);
  await page.screenshot({ path: file, clip: { x: 0, y: 0, width: 1100, height } });
}

async function main() {
  const args = process.argv.slice(2);
  const previewIdx = args.indexOf('--preview');
  const previewFile = previewIdx >= 0 ? path.resolve(args[previewIdx + 1] ?? 'icons-preview.png') : null;

  await fs.mkdir(OUT_DIR, { recursive: true });
  await fs.writeFile(path.join(OUT_DIR, 'favicon.svg'), `${svg('any')}\n`);

  const launch = { headless: true };
  if (process.env.BROWSER_PATH) launch.executablePath = process.env.BROWSER_PATH;
  else launch.channel = process.env.BROWSER_CHANNEL || 'msedge';
  const browser = await chromium.launch(launch);
  try {
    const page = await browser.newPage({ deviceScaleFactor: 1 });
    await page.setContent('<!doctype html><title>icons</title>');
    for (const target of TARGETS) {
      const rgba = await rasterize(page, svg(target.variant, target.size), target.size);
      verify(target, rgba);
      const png = encodePng(rgba, target.size, target.size, { alpha: !target.opaque });
      await fs.writeFile(path.join(OUT_DIR, target.file), png);
      console.log(`  app/icons/${target.file.padEnd(22)} ${target.size}x${target.size} ${target.opaque ? 'RGB (opaque)' : 'RGBA'}  ${png.length} B`);
    }
    console.log('  app/icons/favicon.svg');
    if (previewFile) {
      await writePreview(page, previewFile);
      console.log(`preview: ${previewFile}`);
    }
  } finally {
    await browser.close();
  }
}

main().catch((err) => {
  console.error(`make-icons failed: ${err?.message ?? err}`);
  process.exit(1);
});
