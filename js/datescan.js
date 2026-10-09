// Reading an expiry date with the camera. The part of the video inside the on-screen frame is cleaned
// up (grey, more contrast, the dots of dot-matrix print joined, dark text on light) and read by
// Tesseract (OCR) in a worker; datetext.js finds the date in the text. Tesseract and its English model
// are vendored in vendor/ocr/ (about 6 MB): downloaded the first time, then kept by the service worker.

import { findExpiry, monthFirstLocale, CONFIDENT } from './datetext.js';

const OCR = new URL('../vendor/ocr/', import.meta.url).href;
// The smallest WebAssembly module that uses SIMD (from wasm-feature-detect): most phones since 2021.
const SIMD_TEST = new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0, 10, 10, 1, 8, 0, 65, 0, 253, 15, 253, 98, 11]);
const IDLE = 90e3; // the worker (tens of MB) is ended this long after it was last needed
const STEPS = { 'loading tesseract core': 0, 'loading language traineddata': 1, 'initializing api': 2 };

let engine = null; // Promise of the Tesseract worker
let idleTimer = 0;
let progress = 0;
const progressFns = new Set();

function report(m) {
  const step = STEPS[m.status];
  if (step === undefined) return;
  progress = Math.max(progress, (step + (Number(m.progress) || 0)) / 3);
  for (const fn of [...progressFns]) fn(progress);
}

/** The OCR worker, started if needed. `onProgress(0…1)` hears how loading goes. */
export function loadDateReader(onProgress) {
  clearTimeout(idleTimer);
  if (!engine) {
    progress = 0;
    engine = (async () => {
      const { default: Tesseract } = await import(`${OCR}tesseract.esm.min.js`);
      let simd = false;
      try {
        simd = WebAssembly.validate(SIMD_TEST);
      } catch { /* no WebAssembly SIMD: the plain core */ }
      const worker = await Tesseract.createWorker('eng', 1 /* LSTM only */, {
        workerPath: `${OCR}worker.min.js`,
        corePath: `${OCR}tesseract-core-${simd ? 'simd-' : ''}lstm.js`,
        langPath: OCR,
        gzip: true,
        cacheMethod: 'none', // the service worker keeps the files
        workerBlobURL: false, // a real worker URL: the core finds its .wasm next to it
        logger: report,
      });
      await worker.setParameters({
        tessedit_pageseg_mode: '6', // one block of text
        tessedit_char_whitelist: '0123456789./-: ABCDEFGHIJKLMNOPQRSTUVWXYZ',
      });
      return worker;
    })();
    engine.catch(() => {
      engine = null;
    });
  }
  if (onProgress) {
    progressFns.add(onProgress);
    onProgress(progress);
    const done = () => progressFns.delete(onProgress);
    engine.then(done, done);
  }
  return engine;
}

/** Not needed for now: the worker is ended after a while, unless it is needed again by then. */
export function releaseDateReader() {
  clearTimeout(idleTimer);
  const current = engine;
  if (!current) return;
  idleTimer = setTimeout(() => {
    if (engine !== current) return;
    engine = null;
    current.then(w => w.terminate()).catch(() => {});
  }, IDLE);
}

// ---------- the picture ----------

function boxBlur(src, w, h, r) {
  const tmp = new Float32Array(src.length);
  const out = new Float32Array(src.length);
  const size = 2 * r + 1;
  for (let y = 0; y < h; y++) {
    let sum = 0;
    for (let x = -r; x <= r; x++) sum += src[y * w + Math.min(w - 1, Math.max(0, x))];
    for (let x = 0; x < w; x++) {
      tmp[y * w + x] = sum / size;
      sum += src[y * w + Math.min(w - 1, x + r + 1)] - src[y * w + Math.max(0, x - r)];
    }
  }
  for (let x = 0; x < w; x++) {
    let sum = 0;
    for (let y = -r; y <= r; y++) sum += tmp[Math.min(h - 1, Math.max(0, y)) * w + x];
    for (let y = 0; y < h; y++) {
      out[y * w + x] = sum / size;
      sum += tmp[Math.min(h - 1, y + r + 1) * w + x] - tmp[Math.max(0, y - r) * w + x];
    }
  }
  return out;
}

function histogram(values) {
  const hist = new Uint32Array(256);
  for (let i = 0; i < values.length; i++) hist[Math.min(255, Math.max(0, values[i] | 0))]++;
  return hist;
}

function percentile(hist, n, q) {
  let seen = 0;
  for (let v = 0; v < 256; v++) {
    seen += hist[v];
    if (seen >= n * q) return v;
  }
  return 255;
}

/** Otsu's threshold: the grey level that best splits the picture into two groups. */
function otsu(hist, n) {
  let sum = 0;
  for (let v = 0; v < 256; v++) sum += v * hist[v];
  let sumB = 0;
  let wB = 0;
  let best = 0;
  let threshold = 127;
  for (let v = 0; v < 256; v++) {
    wB += hist[v];
    if (!wB) continue;
    const wF = n - wB;
    if (!wF) break;
    sumB += v * hist[v];
    const between = wB * wF * (sumB / wB - (sum - sumB) / wF) ** 2;
    if (between > best) {
      best = between;
      threshold = v;
    }
  }
  return threshold;
}

/**
 * Cleans up a picture of printed text in place: grey with stretched contrast, dark text on a light
 * background. Variants, since prints differ: 0 stays grey (Tesseract chooses); 1 and 3 join the dots
 * of dot-matrix print (small or big dots) and go black and white; 2 goes black and white without that.
 */
export function cleanUp(img, variant = 0, radius = Math.max(1, Math.round(img.width / 320))) {
  const { data, width: w, height: h } = img;
  const n = w * h;
  let grey = new Float32Array(n);
  for (let i = 0; i < n; i++) grey[i] = 0.299 * data[4 * i] + 0.587 * data[4 * i + 1] + 0.114 * data[4 * i + 2];
  const kind = variant % 4;
  if (kind === 1 || kind === 3) grey = boxBlur(grey, w, h, kind === 3 ? radius * 2 : radius);
  const raw = histogram(grey);
  const lo = percentile(raw, n, 0.02);
  const span = Math.max(1, percentile(raw, n, 0.98) - lo);
  // Text covers less of the picture than its background: a dark middle grey means light text on dark.
  const invert = percentile(raw, n, 0.5) < (lo + span / 2);
  for (let i = 0; i < n; i++) {
    const v = Math.min(255, Math.max(0, ((grey[i] - lo) * 255) / span));
    grey[i] = invert ? 255 - v : v;
  }
  const threshold = kind === 0 ? -1 : otsu(histogram(grey), n);
  for (let i = 0; i < n; i++) {
    const v = threshold < 0 ? grey[i] : grey[i] > threshold ? 255 : 0;
    data[4 * i] = data[4 * i + 1] = data[4 * i + 2] = v;
    data[4 * i + 3] = 255;
  }
  return img;
}

/**
 * Copies what is inside the element `frame` (laid over the video, which is shown with object-fit:
 * cover) from the video into `canvas`, at a good size for OCR, cleaned up. Returns false while the
 * video has no picture yet.
 */
export function grabFrame(video, frame, canvas, variant = 0) {
  const vw = video.videoWidth;
  const vh = video.videoHeight;
  if (!vw || !vh || !frame) return false;
  const v = video.getBoundingClientRect();
  const f = frame.getBoundingClientRect();
  const scale = Math.max(v.width / vw, v.height / vh);
  const sx = Math.max(0, (f.left - v.left - (v.width - vw * scale) / 2) / scale);
  const sy = Math.max(0, (f.top - v.top - (v.height - vh * scale) / 2) / scale);
  const sw = Math.min(vw - sx, f.width / scale);
  const sh = Math.min(vh - sy, f.height / scale);
  if (sw < 16 || sh < 8) return false;
  const k = Math.min(3, 960 / sw);
  canvas.width = Math.round(sw * k);
  canvas.height = Math.round(sh * k);
  const g = canvas.getContext('2d', { willReadFrequently: true });
  g.drawImage(video, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);
  g.putImageData(cleanUp(g.getImageData(0, 0, canvas.width, canvas.height), variant), 0, 0);
  return true;
}

/** The text Tesseract reads in a canvas (or image). */
export async function readText(source) {
  const worker = await loadDateReader();
  const { data } = await worker.recognize(source);
  return (data && data.text) || '';
}

// ---------- watching the camera for a date ----------

/**
 * Reads the video, inside `frame()` (an element), until a date can be trusted: read with high
 * confidence once, or the same date twice in the last eight readings (two rounds of the clean-up
 * variants, as often only one of them suits a print). Then calls onDate(date) once.
 * onState({ phase: 'loading', progress } | { phase: 'reading', seen } | { phase: 'error', error }) tells
 * how it goes (`seen`: a date read once, not trusted yet). Returns a function that stops it.
 */
export function watchForDate({ video, frame, onDate, onState }) {
  let stopped = false;
  const canvas = document.createElement('canvas');
  const recent = [];
  const opts = { monthFirst: monthFirstLocale() };
  (async () => {
    try {
      onState({ phase: 'loading', progress });
      await loadDateReader(p => !stopped && onState({ phase: 'loading', progress: p }));
      if (stopped) return;
      onState({ phase: 'reading', seen: null });
      for (let k = 0; !stopped; k++) {
        const started = Date.now();
        if (video.readyState >= 2 && grabFrame(video, frame(), canvas, k)) {
          const text = await readText(canvas);
          if (stopped) return;
          const hit = findExpiry(text, { now: Date.now(), ...opts });
          recent.push(hit ? hit.date : null);
          if (recent.length > 8) recent.shift();
          if (hit && (hit.score >= CONFIDENT || recent.filter(d => d === hit.date).length >= 2)) {
            stopped = true;
            onDate(hit.date);
            return;
          }
          onState({ phase: 'reading', seen: hit ? hit.date : null });
        }
        await new Promise(r => setTimeout(r, Math.max(60, 300 - (Date.now() - started))));
      }
    } catch (error) {
      if (!stopped) onState({ phase: 'error', error });
    }
  })();
  return () => {
    stopped = true;
    releaseDateReader();
  };
}
