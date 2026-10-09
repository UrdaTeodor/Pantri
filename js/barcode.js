// Barcode detection for Pantri.
//
//   import { createDetector } from './barcode.js';
//   const detector = await createDetector();       // { kind: 'native' | 'zxing', formats, detect }
//   const hits = await detector.detect(source);    // HTMLVideoElement | HTMLCanvasElement |
//                                                  // ImageBitmap | ImageData | Blob (| img, OffscreenCanvas)
//   // -> [{ rawValue: '5449000000996', format: 'ean_13', boundingBox, cornerPoints }, ...]
//
// Uses the browser's own BarcodeDetector when it exists and supports EAN-13 (Chrome on
// Android / macOS / ChromeOS). Otherwise it lazily loads the vendored ZXing-WASM ponyfill
// (../vendor/barcode-detector.js + ../vendor/zxing_reader.wasm, resolved relative to this
// file - never a CDN), so scanning also works offline and on desktop Edge/Firefox/Safari.
//
// Importing this module has no side effects and cannot throw.

/** Formats requested from the detector (W3C BarcodeDetector names), filtered to what it supports. */
export const FORMATS = Object.freeze([
  'ean_13',
  'ean_8',
  'upc_a',
  'upc_e',
  'code_128',
  'code_39',
  'code_93',
  'itf',
  'codabar',
  'qr_code',
  'data_matrix',
]);

const PONYFILL_URL = new URL('../vendor/barcode-detector.js', import.meta.url).href;

/**
 * @typedef {object} BarcodeHit
 * @property {string} rawValue  decoded text, e.g. '5449000000996'
 * @property {string} format    e.g. 'ean_13', 'qr_code'
 * @property {DOMRectReadOnly} [boundingBox]
 * @property {{x: number, y: number}[]} [cornerPoints]
 *
 * @typedef {object} Detector
 * @property {'native'|'zxing'} kind
 * @property {readonly string[]} formats  the subset of FORMATS actually enabled
 * @property {(source: CanvasImageSource | ImageBitmapSource | ImageData | Blob) => Promise<BarcodeHit[]>} detect
 *   Resolves to [] when nothing is found, or for a <video> that has no frame yet.
 */

/** @type {Promise<Detector> | null} */
let detectorPromise = null;

/**
 * Create the detector once and share it. Every call returns the *same* promise (deliberately
 * not an `async function`, which would wrap it in a new promise each time). If creation fails
 * - e.g. the wasm could not be downloaded while offline before the service worker cached it -
 * the memo is cleared so a later call can retry.
 * @returns {Promise<Detector>}
 */
export function createDetector() {
  if (!detectorPromise) {
    const attempt = (async () => (await createNative()) ?? (await createZxing()))();
    detectorPromise = attempt;
    attempt.catch(() => {
      if (detectorPromise === attempt) detectorPromise = null;
    });
  }
  return detectorPromise;
}

async function createNative() {
  const Native = globalThis.BarcodeDetector;
  if (typeof Native !== 'function' || typeof Native.getSupportedFormats !== 'function') return null;
  try {
    const supported = await Native.getSupportedFormats();
    if (!Array.isArray(supported) || !supported.includes('ean_13')) return null;
    const formats = FORMATS.filter((f) => supported.includes(f));
    const detector = new Native({ formats });
    return makeDetector('native', formats, (source) => detector.detect(source));
  } catch {
    return null; // e.g. platform service missing: use the ponyfill instead
  }
}

async function createZxing() {
  const mod = await import(PONYFILL_URL);
  try {
    // Download + compile the wasm now, so failures surface here and the first detect() is fast.
    await mod.prepareZXingModule({ overrides: mod.LOCAL_ZXING_OVERRIDES, fireImmediately: true });
  } catch (err) {
    // Forget the failed instance so a retry re-fetches. Purging also drops the overrides,
    // so re-register the local wasm location.
    mod.purgeZXingModule();
    mod.prepareZXingModule({ overrides: mod.LOCAL_ZXING_OVERRIDES });
    throw new Error(`Could not load the barcode engine (${mod.ZXING_WASM_URL}): ${err?.message ?? err}`, { cause: err });
  }
  const supported = await mod.BarcodeDetector.getSupportedFormats();
  const formats = FORMATS.filter((f) => supported.includes(f));
  const detector = new mod.BarcodeDetector({ formats });
  return makeDetector('zxing', formats, (source) => detector.detect(source));
}

function makeDetector(kind, formats, rawDetect) {
  return Object.freeze({
    kind,
    formats: Object.freeze([...formats]),
    async detect(source) {
      if (isVideoWithoutFrame(source)) return [];
      const results = await rawDetect(source);
      return Array.from(results ?? [], normalize);
    },
  });
}

function isVideoWithoutFrame(source) {
  return (
    typeof HTMLVideoElement !== 'undefined' &&
    source instanceof HTMLVideoElement &&
    (source.readyState < 2 /* HAVE_CURRENT_DATA */ || !source.videoWidth || !source.videoHeight)
  );
}

/** @returns {BarcodeHit} */
function normalize(result) {
  const hit = { rawValue: String(result?.rawValue ?? ''), format: String(result?.format ?? 'unknown') };
  if (result?.boundingBox) hit.boundingBox = result.boundingBox;
  if (result?.cornerPoints) hit.cornerPoints = result.cornerPoints;
  return hit;
}
