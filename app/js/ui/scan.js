// Scanner: live camera → barcode → add / count / remove (known product) or create (new barcode).
// Restock mode (#/scan?mode=restock) keeps scanning after each item, for unpacking a delivery.

import { html, useState, useEffect, useRef } from './lib.js';
import { ask, goBack, navigate, promptSheet, pickSheet, showToast } from './nav.js';
import { useApp, Icon, Thumb, placeText, siteContext, siteName } from './kit.js';
import { AddStockForm, CountForm, UseForm, chooseAndWaste, undoToast } from './sheets.js';
import { ProductForm } from './product-form.js';
import { createDetector } from '../barcode.js';
import { interpretScan } from '../codes.js';
import { findAllByCode, siteOf } from '../model.js';
import { qtyText } from '../format.js';
import { getState, copyProductToSite, setCurrentSite } from '../store.js';

let audio = null;
function beep(on) {
  if (navigator.vibrate) navigator.vibrate(40);
  if (!on || !audio) return;
  try {
    const o = audio.createOscillator();
    const g = audio.createGain();
    o.frequency.value = 1150;
    g.gain.value = 0.08;
    o.connect(g).connect(audio.destination);
    o.start();
    o.stop(audio.currentTime + 0.09);
  } catch { /* no sound, no problem */ }
}

function cameraError(e) {
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

/** Sheet for a barcode we already know. */
function KnownSheet({ productId, units, expiry, restock, close }) {
  const { state, info } = useApp();
  const [tab, setTab] = useState('add');
  const i = info.get(productId);
  if (!i) return null;
  const p = i.product;
  const tracked = i.est.rate > 0;
  return html`
    <div class="sheet-pad">
      <div class="sheet-product">
        <${Thumb} p=${p} size=${48} />
        <div>
          <h2>${p.name}</h2>
          <p class="muted">${qtyText(i.est.total, p.unit, tracked)} in stock · ${placeText(state, p.locationId)}</p>
        </div>
      </div>
      <div class="seg full" role="tablist">
        ${[['add', 'Add'], ['count', 'Count'], ['remove', tracked ? 'Thrown away' : 'Remove']].map(([k, label]) => html`
          <button role="tab" aria-selected=${tab === k} class=${tab === k ? 'on' : ''} onClick=${() => setTab(k)}>${label}</button>`)}
      </div>
      ${tab === 'add' && html`
        <${AddStockForm} p=${p} units=${units} expiry=${expiry} expiryNote=${expiry ? 'read from barcode' : ''}
          submitLabel=${restock ? 'Add & scan next' : ''}
          onDone=${({ qty }) => {
            undoToast(`Added ${qtyText(qty, p.unit)} · ${p.name}`);
            close({ added: { name: p.name, qty, unit: p.unit } });
          }} />`}
      ${tab === 'count' && html`<${CountForm} p=${p} i=${i} onDone=${() => close({ done: true })} />`}
      ${tab === 'remove' && html`
        ${!tracked && html`<${UseForm} p=${p} onDone=${() => close({ done: true })} />`}
        <button class="btn danger-soft block" disabled=${!i.batches.some(b => b.present)}
          onClick=${() => chooseAndWaste(i, Date.now()).then(done => done && close({ done: true }))}>
          <${Icon} name="trash" size=${18} /> Log thrown away…
        </button>`}
      <button class="link-btn center" onClick=${() => close({ open: p.id })}>Open product page</button>
    </div>`;
}

/** Full-screen sheet for a new barcode. */
function NewSheet({ code, expiry, restock, close }) {
  return html`
    <div class="sheet-full-inner">
      <header class="bar">
        <button class="icon-btn" aria-label="Cancel" onClick=${() => close()}><${Icon} name="x" /></button>
        <div class="bar-title"><h1>New product</h1></div>
      </header>
      <div class="page">
        <${ProductForm} code=${code} scanExpiry=${expiry} submitLabel=${restock ? 'Save & scan next' : ''}
          onSaved=${(id, qty) => {
            const p = getState().products.find(x => x.id === id);
            showToast(`Saved ${p.name}`);
            close({ added: { name: p.name, qty, unit: p.unit }, id });
          }}
          onLinked=${(id, units) => close({ linked: { id, units } })} />
      </div>
    </div>`;
}

export function ScanScreen({ route }) {
  const { state } = useApp();
  const restock = route.query.get('mode') === 'restock';
  const video = useRef(null);
  const track = useRef(null);
  const paused = useRef(false);
  const last = useRef({ code: '', at: 0 });
  const [phase, setPhase] = useState('starting'); // starting | live | error
  const [error, setError] = useState('');
  const [torch, setTorch] = useState(null); // null = not supported
  const [tally, setTally] = useState([]);

  const resume = () => {
    last.current.at = Date.now(); // ignore the code still in view for a moment
    paused.current = false;
  };

  const leave = () => goBack('#/');

  /** Which product a scanned code means here. With several sites, products are per site. */
  async function resolveProduct(code) {
    const state = getState();
    const { multi, siteId, site } = siteContext(state);
    const matches = findAllByCode(state.products, code);
    if (!multi || !matches.length) return matches[0] || null;
    const siteOfP = p => siteOf(state.locations, p.locationId);
    const here = siteId ? matches.filter(m => siteOfP(m.product) === siteId) : matches;
    if (here.length === 1) return here[0];
    if (here.length > 1) {
      return (await pickSheet({
        title: 'Which site is this for?',
        options: here.map(m => ({ label: siteName(state, siteOfP(m.product)), sub: m.product.name, value: m })),
      })) || 'cancel';
    }
    const other = matches[0];
    const choice = await pickSheet({
      title: `${other.product.name} isn't tracked at ${site.name} yet`,
      options: [
        { label: `Track it at ${site.name}`, sub: 'Separate stock, usage and reorder list for this site', value: 'copy' },
        { label: `Use the ${siteName(state, siteOfP(other.product))} one`, sub: 'Shared with that site', value: 'other' },
      ],
    });
    if (choice === 'copy') {
      const id = copyProductToSite(other.product.id, siteId);
      return { product: getState().products.find(p => p.id === id), units: other.units };
    }
    return choice === 'other' ? other : 'cancel';
  }

  async function handleCode(raw) {
    const { code, expiry } = interpretScan(raw);
    if (!code) return resume();
    const found = await resolveProduct(code);
    if (found === 'cancel') return resume();
    let result;
    if (found) {
      result = await ask(close => html`<${KnownSheet} productId=${found.product.id} units=${found.units} expiry=${expiry} restock=${restock} close=${close} />`);
    } else {
      result = await ask(close => html`<${NewSheet} code=${code} expiry=${expiry} restock=${restock} close=${close} />`, { full: true });
      if (result && result.linked) {
        result = await ask(close => html`<${KnownSheet} productId=${result.linked.id} units=${result.linked.units} expiry=${expiry} restock=${restock} close=${close} />`);
      }
    }
    if (result && result.open) return navigate(`#/product/${result.open}`, { replace: true });
    if (result && result.added) setTally(t => [...t, result.added]);
    if (result && !restock && (result.added || result.done)) return leave();
    resume();
  }

  const onDetected = raw => {
    const { code } = interpretScan(raw);
    const t = Date.now();
    if (paused.current || (code === last.current.code && t - last.current.at < 2500)) return;
    last.current = { code, at: t };
    paused.current = true;
    beep(getState().settings.scanSound);
    handleCode(raw);
  };

  useEffect(() => {
    let stopped = false;
    let timer = 0;
    let stream = null;
    try {
      audio = audio || new AudioContext();
      audio.resume();
    } catch { audio = null; }
    (async () => {
      try {
        if (!window.isSecureContext || !navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
          throw Object.assign(new Error('insecure'), { name: 'Insecure' });
        }
        stream = await navigator.mediaDevices.getUserMedia({
          audio: false,
          video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } },
        });
        if (stopped) return;
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
        let detector;
        try {
          detector = await createDetector();
        } catch (e) {
          throw new Error(`the barcode reader didn't load (${e.message})`);
        }
        if (stopped) return;
        setPhase('live');
        const loop = async () => {
          if (stopped) return;
          if (!paused.current && v.readyState >= 2) {
            try {
              const codes = await detector.detect(v);
              if (codes.length && !stopped) onDetected(codes[0].rawValue);
            } catch { /* frame not ready */ }
          }
          timer = setTimeout(loop, 120);
        };
        loop();
      } catch (e) {
        if (stopped) return;
        setError(cameraError(e));
        setPhase('error');
      }
    })();
    return () => {
      stopped = true;
      clearTimeout(timer);
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

  const typeCode = async () => {
    paused.current = true;
    const code = await promptSheet({ title: 'Type the barcode', placeholder: 'e.g. 5449000000996', inputmode: 'numeric', ok: 'Continue' });
    if (code) {
      last.current = { code, at: Date.now() };
      handleCode(code);
    } else resume();
  };

  const added = tally.reduce((t, x) => t + x.qty, 0);
  const ctx = siteContext(state);
  const chooseSite = async () => {
    paused.current = true;
    const v = await pickSheet({
      title: 'Where are you scanning?',
      options: [...ctx.sites.map(x => ({ label: x.name, value: x.id })), { label: 'All sites', sub: 'Ask when a barcode exists at several sites', value: '__all' }],
    });
    if (v) setCurrentSite(v === '__all' ? null : v);
    resume();
  };

  return html`
    <div class="scanner">
      <video ref=${video} playsinline muted autoplay></video>
      ${phase === 'live' && html`<div class="scan-frame" aria-hidden="true"><span class="scan-line"></span></div>`}
      <div class="scan-top">
        <button class="icon-btn on-dark" aria-label="Close scanner" onClick=${leave}><${Icon} name="x" /></button>
        <div class="scan-title">
          ${restock ? 'Restock — scan each item' : 'Scan a barcode'}
          ${ctx.multi && html`<button class="site-pill" onClick=${chooseSite}><${Icon} name="pin" size=${14} /> ${ctx.site ? ctx.site.name : 'All sites'}</button>`}
        </div>
        ${torch !== null && html`
          <button class=${`icon-btn on-dark${torch ? ' lit' : ''}`} aria-label="Torch" aria-pressed=${torch} onClick=${toggleTorch}>
            <${Icon} name="bolt" />
          </button>`}
        <button class="icon-btn on-dark" aria-label="Type a barcode" onClick=${typeCode}><${Icon} name="keyboard" /></button>
      </div>
      ${phase === 'starting' && html`<div class="scan-msg">Starting camera…</div>`}
      ${phase === 'error' && html`
        <div class="scan-error">
          <p>${error}</p>
          <button class="btn primary" onClick=${typeCode}><${Icon} name="keyboard" size=${18} /> Type a barcode</button>
          <button class="btn" onClick=${() => navigate('#/new', { replace: true })}>Add without barcode</button>
        </div>`}
      <div class="scan-bottom">
        ${tally.length > 0
          ? html`
            <div class="tally">
              <b>${tally.length} scanned · ${added} units added</b>
              <span>${tally.slice(-3).reverse().map(x => `${x.qty} × ${x.name}`).join(' · ')}</span>
            </div>
            <button class="btn primary" onClick=${leave}>Done</button>`
          : phase === 'live' && html`<p class="scan-hint">Hold the barcode inside the frame. No barcode? <button class="link-btn on-dark inline" onClick=${() => navigate('#/new', { replace: true })}>Add it by hand</button></p>`}
      </div>
    </div>`;
}
