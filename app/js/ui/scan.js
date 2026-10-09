// Scanner: live camera → barcode → the expiry date, read off the package (unless switched off) → add /
// count / remove (known product) or create (new barcode). Restock mode (#/scan?mode=restock) keeps
// scanning after each item, for unpacking a delivery.

import { html, useState, useEffect, useRef } from './lib.js';
import { ask, goBack, navigate, promptSheet, pickSheet, showToast } from './nav.js';
import { useApp, Icon, Thumb, placeText, siteContext, siteName } from './kit.js';
import { AddStockForm, CountForm, UseForm, chooseAndWaste, undoToast } from './sheets.js';
import { ProductForm } from './product-form.js';
import { useCamera, useBarcodeReader } from './camera.js';
import { watchForDate } from '../datescan.js';
import { interpretScan } from '../codes.js';
import { findAllByCode, siteOf } from '../model.js';
import { qtyText, dateText } from '../format.js';
import { getState, copyProductToSite, setCurrentSite, updateProduct } from '../store.js';

const READ_FROM_PACKAGE = 'read from the package — check it';

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

/** Sheet for a barcode we already know. */
function KnownSheet({ productId, units, expiry, expiryNote, restock, close }) {
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
        <${AddStockForm} p=${p} units=${units} expiry=${expiry} expiryNote=${expiryNote}
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
function NewSheet({ code, expiry, expiryNote, noExpiry, restock, close }) {
  return html`
    <div class="sheet-full-inner">
      <header class="bar">
        <button class="icon-btn" aria-label="Cancel" onClick=${() => close()}><${Icon} name="x" /></button>
        <div class="bar-title"><h1>New product</h1></div>
      </header>
      <div class="page">
        <${ProductForm} code=${code} scanExpiry=${expiry} scanExpiryNote=${expiryNote} noExpiry=${noExpiry}
          submitLabel=${restock ? 'Save & scan next' : ''}
          onSaved=${(id, qty) => {
            const p = getState().products.find(x => x.id === id);
            showToast(`Saved ${p.name}`);
            close({ added: { name: p.name, qty, unit: p.unit }, id });
          }}
          onLinked=${(id, units) => close({ linked: { id, units } })} />
      </div>
    </div>`;
}

/** What the date step says at the bottom of the screen, with its buttons. */
function DateControls({ reading, slow, onSkip, onNever }) {
  let text = 'Hold the printed date inside the frame.';
  if (reading.phase === 'loading') {
    text = `Getting the date reader ready… ${Math.round((reading.progress || 0) * 100)}%`;
  } else if (reading.phase === 'error') {
    text = "The date reader didn't load (offline?). Skip, and pick the date on the next screen.";
  } else if (reading.seen) {
    text = `Reading… ${dateText(new Date(`${reading.seen}T00:00`).getTime(), Date.now())}?`;
  } else if (slow) {
    text = "Can't read it? Move closer, use the light, or skip.";
  }
  return html`
    <div class="date-controls">
      <p class="scan-hint" role="status">${text}</p>
      <div class="date-actions">
        <button class="btn" onClick=${onSkip}>Skip</button>
        <button class="link-btn on-dark" onClick=${onNever}>This product has no date</button>
      </div>
    </div>`;
}

export function ScanScreen({ route }) {
  const { state } = useApp();
  const restock = route.query.get('mode') === 'restock';
  const video = useRef(null);
  const frame = useRef(null);
  const paused = useRef(false);
  const last = useRef({ code: '', at: 0 });
  const cam = useCamera(video);
  const live = useRef(false);
  live.current = cam.phase === 'live';
  const [tally, setTally] = useState([]);
  const [dateStep, setDateStep] = useState(null); // { name, finish } while reading the expiry date
  const [reading, setReading] = useState({ phase: 'loading', progress: 0 });
  const [slow, setSlow] = useState(false);

  const resume = () => {
    last.current.at = Date.now(); // ignore the code still in view for a moment
    paused.current = false;
  };

  const leave = () => goBack('#/');

  useEffect(() => {
    try {
      audio = audio || new AudioContext();
      audio.resume();
    } catch { audio = null; }
  }, []);

  // The date step: read the video until a date can be trusted, or the user skips.
  useEffect(() => {
    if (!dateStep) return undefined;
    setReading({ phase: 'loading', progress: 0 });
    return watchForDate({
      video: video.current,
      frame: () => frame.current,
      onState: setReading,
      onDate: date => {
        beep(getState().settings.scanSound);
        dateStep.finish({ expiry: date });
      },
    });
  }, [dateStep]);
  const readingNow = !!dateStep && reading.phase === 'reading';
  useEffect(() => {
    setSlow(false);
    if (!readingNow) return undefined;
    const timer = setTimeout(() => setSlow(true), 10000);
    return () => clearTimeout(timer);
  }, [readingNow]);

  /** Resolves to { expiry } (read), { skip: true } or { never: true } (this product has no date). */
  const readDate = name => new Promise(resolve => {
    setDateStep({
      name,
      finish: result => {
        setDateStep(null);
        resolve(result);
      },
    });
  });

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
    const { code, expiry: printed } = interpretScan(raw);
    if (!code) return resume();
    const found = await resolveProduct(code);
    if (found === 'cancel') return resume();
    let expiry = printed;
    let expiryNote = printed ? 'read from barcode' : '';
    let noExpiry = false;
    if (!expiry && live.current && getState().settings.scanExpiry !== false && !(found && found.product.noExpiry)) {
      const r = await readDate(found ? found.product.name : '');
      if (r.expiry) {
        expiry = r.expiry;
        expiryNote = READ_FROM_PACKAGE;
      } else if (r.never && found) {
        updateProduct(found.product.id, { noExpiry: true });
        showToast(`No date step for ${found.product.name} from now on. Edit the product to change that.`, { timeout: 6000 });
      } else if (r.never) {
        noExpiry = true;
      }
    }
    let result;
    if (found) {
      result = await ask(close => html`<${KnownSheet} productId=${found.product.id} units=${found.units} expiry=${expiry} expiryNote=${expiryNote} restock=${restock} close=${close} />`);
    } else {
      result = await ask(close => html`<${NewSheet} code=${code} expiry=${expiry} expiryNote=${expiryNote} noExpiry=${noExpiry} restock=${restock} close=${close} />`, { full: true });
      if (result && result.linked) {
        result = await ask(close => html`<${KnownSheet} productId=${result.linked.id} units=${result.linked.units} expiry=${expiry} expiryNote=${expiryNote} restock=${restock} close=${close} />`);
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

  useBarcodeReader(video, cam.phase === 'live', {
    active: () => !paused.current,
    onCode: onDetected,
    onError: e => cam.fail(`Couldn't start the scanner: ${e.message}`),
  });

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

  let bottom = null;
  if (dateStep) {
    bottom = html`<${DateControls} reading=${reading} slow=${slow}
      onSkip=${() => dateStep.finish({ skip: true })} onNever=${() => dateStep.finish({ never: true })} />`;
  } else if (tally.length > 0) {
    bottom = html`
      <div class="tally">
        <b>${tally.length} scanned · ${added} units added</b>
        <span>${tally.slice(-3).reverse().map(x => `${x.qty} × ${x.name}`).join(' · ')}</span>
      </div>
      <button class="btn primary" onClick=${leave}>Done</button>`;
  } else if (cam.phase === 'live') {
    bottom = html`<p class="scan-hint">Hold the barcode inside the frame. No barcode? <button class="link-btn on-dark inline" onClick=${() => navigate('#/new', { replace: true })}>Add it by hand</button></p>`;
  }

  return html`
    <div class="scanner">
      <video ref=${video} playsinline muted autoplay></video>
      ${cam.phase === 'live' && (dateStep
        ? html`<div class="scan-frame date" ref=${frame} aria-hidden="true"></div>`
        : html`<div class="scan-frame" aria-hidden="true"><span class="scan-line"></span></div>`)}
      <div class="scan-top">
        <button class="icon-btn on-dark" aria-label="Close scanner" onClick=${leave}><${Icon} name="x" /></button>
        <div class="scan-title">
          ${dateStep
            ? html`Now the expiry date${dateStep.name && html`<small>${dateStep.name}</small>`}`
            : restock ? 'Restock — scan each item' : 'Scan a barcode'}
          ${!dateStep && ctx.multi && html`<button class="site-pill" onClick=${chooseSite}><${Icon} name="pin" size=${14} /> ${ctx.site ? ctx.site.name : 'All sites'}</button>`}
        </div>
        ${cam.torch !== null && html`
          <button class=${`icon-btn on-dark${cam.torch ? ' lit' : ''}`} aria-label="Torch" aria-pressed=${cam.torch} onClick=${cam.toggleTorch}>
            <${Icon} name="bolt" />
          </button>`}
        ${!dateStep && html`<button class="icon-btn on-dark" aria-label="Type a barcode" onClick=${typeCode}><${Icon} name="keyboard" /></button>`}
      </div>
      ${cam.phase === 'starting' && html`<div class="scan-msg">Starting camera…</div>`}
      ${cam.phase === 'error' && html`
        <div class="scan-error">
          <p>${cam.error}</p>
          <button class="btn primary" onClick=${typeCode}><${Icon} name="keyboard" size=${18} /> Type a barcode</button>
          <button class="btn" onClick=${() => navigate('#/new', { replace: true })}>Add without barcode</button>
        </div>`}
      <div class=${`scan-bottom${dateStep ? ' date' : ''}`}>${bottom}</div>
    </div>`;
}
