// The camera for scanning: the back camera in a <video> (with the torch and continuous focus where the
// phone has them), a loop that reads barcodes from it, and a sheet that scans a single barcode.

import { html, useState, useEffect, useRef } from './lib.js';
import { Icon } from './kit.js';
import { createDetector } from '../barcode.js';
import { interpretScan } from '../codes.js';

export function cameraError(e) {
  switch (e && e.name) {
    case 'NotAllowedError':
    case 'SecurityError':
      return 'Camera access is blocked. Allow the camera for this app in the browser\'s site settings — or type the barcode.';
    case 'NotFoundError':
    case 'OverconstrainedError':
      return 'No camera found. You can type barcodes instead.';
    case 'NotReadableError':
      return 'The camera is busy in another app. Close that app and try again.';
    case 'Insecure':
      return 'The camera only works when the app is opened over HTTPS (or on localhost).';
    default:
      return `Couldn't start the scanner: ${(e && (e.message || e.name)) || 'unknown error'}`;
  }
}

/**
 * Runs the back camera in `video` (a ref to a <video>) while mounted. Returns { phase: 'starting' |
 * 'live' | 'error', error, torch (null when the phone has none, else on/off), toggleTorch, fail(text) }.
 */
export function useCamera(video) {
  const [phase, setPhase] = useState('starting');
  const [error, setError] = useState('');
  const [torch, setTorch] = useState(null);
  const track = useRef(null);

  useEffect(() => {
    let stopped = false;
    let stream = null;
    (async () => {
      try {
        if (!window.isSecureContext || !navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
          throw Object.assign(new Error('insecure'), { name: 'Insecure' });
        }
        const open = () => navigator.mediaDevices.getUserMedia({
          audio: false,
          video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } },
        });
        try {
          stream = await open();
        } catch (e) {
          // Right after the scanner closed, the camera may still be letting go ("busy", "not found"):
          // try once more a moment later.
          if (!['NotReadableError', 'NotFoundError', 'AbortError'].includes(e && e.name)) throw e;
          await new Promise(r => setTimeout(r, 600));
          if (stopped) return;
          stream = await open();
        }
        if (stopped) {
          stream.getTracks().forEach(t => t.stop()); // closed while the camera was starting
          return;
        }
        const v = video.current;
        v.srcObject = stream;
        await v.play();
        const t = stream.getVideoTracks()[0];
        track.current = t;
        const caps = (t.getCapabilities && t.getCapabilities()) || {};
        if (caps.torch) setTorch(false);
        if (caps.focusMode && caps.focusMode.includes('continuous')) {
          t.applyConstraints({ advanced: [{ focusMode: 'continuous' }] }).catch(() => {});
        }
        if (!stopped) setPhase('live');
      } catch (e) {
        if (stopped) return;
        setError(cameraError(e));
        setPhase('error');
      }
    })();
    return () => {
      stopped = true;
      if (stream) stream.getTracks().forEach(t => t.stop());
    };
  }, []);

  const toggleTorch = async () => {
    try {
      await track.current.applyConstraints({ advanced: [{ torch: !torch }] });
      setTorch(!torch);
    } catch {
      setTorch(null);
    }
  };
  const fail = text => {
    setError(text);
    setPhase('error');
  };
  return { phase, error, torch, toggleTorch, fail };
}

/**
 * While the camera is `live`, reads barcodes from `video` and calls onCode(rawValue) for each one seen
 * while active() is true. onError(error) if the barcode reader can't be loaded.
 */
export function useBarcodeReader(video, live, { active, onCode, onError }) {
  const handlers = useRef(null);
  handlers.current = { active, onCode, onError };
  useEffect(() => {
    if (!live) return undefined;
    let stopped = false;
    let timer = 0;
    (async () => {
      let detector;
      try {
        detector = await createDetector();
      } catch (e) {
        if (!stopped) handlers.current.onError(new Error(`the barcode reader didn't load (${e.message})`));
        return;
      }
      const loop = async () => {
        if (stopped) return;
        const v = video.current;
        if (handlers.current.active() && v && v.readyState >= 2) {
          try {
            const codes = await detector.detect(v);
            if (codes.length && !stopped && handlers.current.active()) handlers.current.onCode(codes[0].rawValue);
          } catch { /* frame not ready */ }
        }
        timer = setTimeout(loop, 120);
      };
      loop();
    })();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [live]);
}

/** A full-screen sheet that scans one barcode: closes with its code (GS1 codes give their GTIN), or nothing. */
export function BarcodeSheet({ close }) {
  const video = useRef(null);
  const cam = useCamera(video);
  const done = useRef(false);
  useBarcodeReader(video, cam.phase === 'live', {
    active: () => !done.current,
    onCode: raw => {
      const { code } = interpretScan(raw);
      if (!code) return;
      done.current = true;
      if (navigator.vibrate) navigator.vibrate(40);
      close(code);
    },
    onError: e => cam.fail(`Couldn't start the scanner: ${e.message}`),
  });
  return html`
    <div class="scanner">
      <video ref=${video} playsinline muted autoplay></video>
      ${cam.phase === 'live' && html`<div class="scan-frame" aria-hidden="true"><span class="scan-line"></span></div>`}
      <div class="scan-top">
        <button class="icon-btn on-dark" aria-label="Close scanner" onClick=${() => close()}><${Icon} name="x" /></button>
        <div class="scan-title">Scan the barcode</div>
        ${cam.torch !== null && html`
          <button class=${`icon-btn on-dark${cam.torch ? ' lit' : ''}`} aria-label="Torch" aria-pressed=${cam.torch} onClick=${cam.toggleTorch}>
            <${Icon} name="bolt" />
          </button>`}
      </div>
      ${cam.phase === 'starting' && html`<div class="scan-msg">Starting camera…</div>`}
      ${cam.phase === 'error' && html`
        <div class="scan-error">
          <p>${cam.error}</p>
          <button class="btn primary" onClick=${() => close()}>Back</button>
        </div>`}
      ${cam.phase === 'live' && html`<div class="scan-bottom"><p class="scan-hint">Hold the barcode inside the frame.</p></div>`}
    </div>`;
}
