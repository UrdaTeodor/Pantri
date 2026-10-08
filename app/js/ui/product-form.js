// New / edit product form. With a scanned code it looks the product up online and fills in the blanks.

import { html, useState, useEffect, useRef } from './lib.js';
import { ask, goBack, navigate, promptSheet, showToast } from './nav.js';
import { useApp, Header, Icon, Stepper, ExpiryPicker, LocationSelect, CategorySelect, Thumb, focusOnMount, siteContext } from './kit.js';
import { createProduct, updateProduct, addBarcode, addCategory, requestPersistenceOnce } from '../store.js';
import { lookupProduct, guessCategory } from '../lookup.js';
import { findAllByCode, siteOf } from '../model.js';
import { plural, PER_LABEL, parseNum } from '../format.js';

const UNITS = ['pcs', 'bottle', 'can', 'bag', 'box', 'pack', 'carton', 'jar', 'roll', 'cup', 'pod', 'kg', 'L'];

function fromProduct(p) {
  return {
    ...p,
    barcodes: p.barcodes.map(b => ({ ...b })),
    rateOn: !!(p.rate && p.rate.qty > 0),
    rateQty: (p.rate && p.rate.qty) || 1,
    ratePer: (p.rate && p.rate.per) || 'day',
    orderQty: p.orderQty || '',
  };
}

function blank(code, locationId) {
  return {
    name: '', brand: '', size: '', imageUrl: '', categoryId: null, unit: 'pcs',
    barcodes: code ? [{ code, units: 1 }] : [], rateOn: false, rateQty: 1, ratePer: 'day',
    minStock: 0, orderQty: '', reorder: true, locationId, notes: '',
  };
}

/** Pick an existing product (with search) — used to link a new barcode to it. */
function ProductPicker({ close }) {
  const { state } = useApp();
  const [q, setQ] = useState('');
  const t = q.trim().toLowerCase();
  const list = state.products
    .filter(p => !t || p.name.toLowerCase().includes(t) || (p.brand || '').toLowerCase().includes(t))
    .sort((a, b) => a.name.localeCompare(b.name))
    .slice(0, 50);
  return html`
    <div class="sheet-pad">
      <h2>Which product is it?</h2>
      <label class="search"><${Icon} name="search" size=${18} />
        <input type="search" placeholder="Search" value=${q} onInput=${e => setQ(e.target.value)} ref=${focusOnMount} />
      </label>
      <div class="menu">
        ${list.map(p => html`
          <button class="menu-item with-thumb" onClick=${() => close(p)}>
            <${Thumb} p=${p} size=${32} /><span>${p.name}</span>${p.brand && html`<small>${p.brand}</small>`}
          </button>`)}
        ${!list.length && html`<p class="muted">No products match.</p>`}
      </div>
    </div>`;
}

/**
 * Props: product (edit) | code + scanExpiry (new from scan) | nothing (new by hand);
 * onSaved(id, addedQty), onLinked(id, units), onCancel(), submitLabel.
 */
export function ProductForm({ product = null, code = null, scanExpiry = null, onSaved, onLinked, onCancel, submitLabel = '' }) {
  const { state, now } = useApp();
  const editing = !!product;
  const [f, setF] = useState(() => (editing ? fromProduct(product) : blank(code, lastLocation(state))));
  const [initial, setInitial] = useState({ qty: 1, expiry: scanExpiry, touched: false });
  const [lookup, setLookup] = useState(code && !editing && state.settings.lookup ? { status: 'loading' } : null);
  const [error, setError] = useState('');
  const touched = useRef(new Set());

  const upd = (k, v) => {
    touched.current.add(k);
    setF(x => ({ ...x, [k]: v }));
  };

  useEffect(() => {
    if (!code || editing || !state.settings.lookup) return undefined;
    let alive = true;
    lookupProduct(code)
      .then(r => {
        if (!alive) return;
        if (!r) return setLookup({ status: 'none' });
        setF(x => {
          const y = { ...x };
          for (const k of ['name', 'brand', 'size', 'imageUrl']) if (!touched.current.has(k) && r[k]) y[k] = r[k];
          if (!touched.current.has('categoryId') && !x.categoryId) y.categoryId = guessCategory(r.categories, state.categories);
          return y;
        });
        setLookup({ status: 'found', source: r.source });
      })
      .catch(() => alive && setLookup({ status: 'error' }));
    return () => { alive = false; };
  }, [code]);

  // The first barcode's pack size is the natural first-stock amount until the user picks one.
  const firstUnits = (f.barcodes[0] && Math.round(parseNum(f.barcodes[0].units))) || 1;
  const initialQty = initial.touched ? initial.qty : firstUnits;

  const setBarcode = (k, patch) => upd('barcodes', f.barcodes.map((b, j) => (j === k ? { ...b, ...patch } : b)));

  const newCategory = async () => {
    const name = await promptSheet({ title: 'New category', placeholder: 'e.g. Breakfast' });
    if (name) upd('categoryId', addCategory(name));
  };

  const linkExisting = async () => {
    const p = await ask(close => html`<${ProductPicker} close=${close} />`);
    if (!p) return;
    const units = await promptSheet({ title: `How many ${plural(p.unit, 2)} does this barcode count as?`, value: '1', inputmode: 'numeric', ok: 'Link' });
    if (units == null) return;
    const n = Math.max(1, Math.round(parseNum(units)) || 1);
    addBarcode(p.id, code, n);
    showToast(`Barcode linked to ${p.name}`);
    onLinked(p.id, n);
  };

  const save = e => {
    e.preventDefault();
    const name = f.name.trim();
    if (!name) {
      setError('Give the product a name.');
      return;
    }
    const rateQty = parseNum(f.rateQty);
    if (f.rateOn && !(rateQty > 0)) {
      setError('Enter how many get used, e.g. 5 or 0.5 — or switch usage tracking off.');
      return;
    }
    const minStock = f.minStock === '' ? 0 : parseNum(f.minStock);
    const orderQty = f.orderQty === '' ? null : parseNum(f.orderQty);
    if (!(minStock >= 0) || (orderQty !== null && !(orderQty > 0))) {
      setError('Minimum and usual order must be numbers (or left empty).');
      return;
    }
    const barcodes = f.barcodes
      .map(b => ({ code: String(b.code).trim(), units: Math.max(1, Math.round(parseNum(b.units)) || 1) }))
      .filter(b => b.code);
    // A barcode belongs to one product per site (several sites can each track the same item).
    const site = siteOf(state.locations, f.locationId);
    for (const b of barcodes) {
      const other = findAllByCode(state.products, b.code)
        .find(m => (!editing || m.product.id !== product.id) && siteOf(state.locations, m.product.locationId) === site);
      if (other) {
        setError(`Barcode ${b.code} already belongs to "${other.product.name}"${site ? ' at this site' : ''}.`);
        return;
      }
    }
    const data = {
      name,
      brand: f.brand.trim(),
      size: f.size.trim(),
      imageUrl: f.imageUrl,
      categoryId: f.categoryId,
      unit: f.unit.trim() || 'pcs',
      barcodes,
      rate: f.rateOn ? { qty: rateQty, per: f.ratePer } : null,
      minStock,
      orderQty,
      reorder: f.reorder,
      locationId: f.locationId,
      notes: f.notes.trim(),
    };
    if (editing) {
      updateProduct(product.id, data);
      onSaved(product.id, 0);
    } else {
      const id = createProduct(data, { qty: initialQty, expiry: initial.expiry, locationId: f.locationId });
      requestPersistenceOnce();
      onSaved(id, initialQty);
    }
  };

  return html`
    <form class="form" onSubmit=${save} novalidate>
      ${code && !editing && html`
        <div class="lookup">
          <div class="mono">${code}</div>
          ${lookup && lookup.status === 'loading' && html`<span class="muted">Looking it up online…</span>`}
          ${lookup && lookup.status === 'found' && html`<span class="ok-text">Found on ${lookup.source} — check the details</span>`}
          ${lookup && lookup.status === 'none' && html`<span class="muted">Not found online — fill in the details</span>`}
          ${lookup && lookup.status === 'error' && html`<span class="warn-text">Couldn't look it up (offline?) — fill in the details</span>`}
          ${state.products.length > 0 && html`
            <button type="button" class="link-btn" onClick=${linkExisting}>Already in your pantry under another barcode? Link it</button>`}
        </div>`}

      <div class="field with-thumb">
        ${f.imageUrl && html`<${Thumb} p=${{ name: f.name, imageUrl: f.imageUrl }} size=${48} />`}
        <div class="grow">
          <label for="pf-name">Name</label>
          <input id="pf-name" class="input" value=${f.name} onInput=${e => upd('name', e.target.value)} placeholder="e.g. Still water 0.5 L" />
        </div>
      </div>
      <div class="two">
        <div class="field"><label for="pf-brand">Brand</label><input id="pf-brand" class="input" value=${f.brand} onInput=${e => upd('brand', e.target.value)} /></div>
        <div class="field"><label for="pf-size">Size</label><input id="pf-size" class="input" value=${f.size} onInput=${e => upd('size', e.target.value)} placeholder="500 ml" /></div>
      </div>
      <div class="two">
        <div class="field">
          <label for="pf-category">Category</label>
          <${CategorySelect} id="pf-category" value=${f.categoryId} onChange=${v => upd('categoryId', v)} categories=${state.categories} />
          <button type="button" class="link-btn" onClick=${newCategory}>+ New category</button>
        </div>
        <div class="field">
          <label for="pf-unit">Counted in</label>
          <input id="pf-unit" class="input" list="units" value=${f.unit} onInput=${e => upd('unit', e.target.value)} />
          <datalist id="units">${UNITS.map(u => html`<option value=${u} />`)}</datalist>
        </div>
      </div>

      <fieldset class="group">
        <legend>Usage</legend>
        <label class="switch">
          <input type="checkbox" checked=${f.rateOn} onChange=${e => upd('rateOn', e.target.checked)} />
          <span>Track how fast it gets used</span>
        </label>
        ${f.rateOn && html`
          <div class="rate-row">
            <input class="input num" type="text" inputmode="decimal" value=${f.rateQty}
              onInput=${e => upd('rateQty', e.target.value)} aria-label="Amount" />
            <span>${plural(f.unit, parseNum(f.rateQty) === 1 ? 1 : 2)} per</span>
            <select class="input" value=${f.ratePer} onChange=${e => upd('ratePer', e.target.value)} aria-label="Per">
              ${Object.entries(PER_LABEL).map(([k, label]) => html`<option value=${k}>${label}</option>`)}
            </select>
          </div>
          <p class="hint">Counted every day — or only during opening hours, if you set them in Settings. When it should be running out, the app asks you to check, and it learns the real pace from your counts.</p>`}
      </fieldset>

      <fieldset class="group">
        <legend>Reordering</legend>
        <div class="two">
          <div class="field">
            <label for="pf-min">Minimum to keep</label>
            <input id="pf-min" class="input" type="text" inputmode="decimal" value=${f.minStock} onInput=${e => upd('minStock', e.target.value)} />
          </div>
          <div class="field">
            <label for="pf-order">Usual order <small>(optional)</small></label>
            <input id="pf-order" class="input" type="text" inputmode="decimal" value=${f.orderQty} placeholder="auto" onInput=${e => upd('orderQty', e.target.value)} />
          </div>
        </div>
        <label class="switch">
          <input type="checkbox" checked=${f.reorder} onChange=${e => upd('reorder', e.target.checked)} />
          <span>Put it on the reorder list when it's low or out</span>
        </label>
      </fieldset>

      <fieldset class="group">
        <legend>Barcodes</legend>
        ${f.barcodes.map((b, k) => html`
          <div class="barcode-row" key=${k}>
            <input class="input mono" value=${b.code} inputmode="numeric" placeholder="Barcode" aria-label="Barcode"
              onInput=${e => setBarcode(k, { code: e.target.value })} />
            <input class="input num" type="text" inputmode="numeric" value=${b.units} aria-label="Units per scan"
              onInput=${e => setBarcode(k, { units: e.target.value })} />
            <button type="button" class="icon-btn" aria-label="Remove barcode" onClick=${() => upd('barcodes', f.barcodes.filter((_, j) => j !== k))}>
              <${Icon} name="x" size=${18} />
            </button>
          </div>`)}
        ${f.barcodes.length > 0 && html`<p class="hint">The number is how many ${plural(f.unit, 2)} one scan adds (e.g. 6 for a six-pack).</p>`}
        <button type="button" class="link-btn" onClick=${() => upd('barcodes', [...f.barcodes, { code: '', units: 1 }])}>+ Add a barcode</button>
      </fieldset>

      <div class="field">
        <label for="pf-location">Usual location</label>
        <${LocationSelect} id="pf-location" value=${f.locationId} onChange=${v => upd('locationId', v)} locations=${state.locations} />
      </div>

      ${!editing && html`
        <fieldset class="group">
          <legend>In stock right now</legend>
          <div class="field">
            <label>How many ${plural(f.unit, 2)}?</label>
            <${Stepper} value=${initialQty} min=${0} onChange=${v => setInitial(x => ({ ...x, qty: v, touched: true }))} />
          </div>
          ${initialQty > 0 && html`
            <${ExpiryPicker} value=${initial.expiry} onChange=${v => setInitial(x => ({ ...x, expiry: v }))} now=${now}
              note=${scanExpiry && initial.expiry === scanExpiry ? 'read from barcode' : ''} />`}
        </fieldset>`}

      <div class="field">
        <label for="pf-notes">Notes</label>
        <textarea id="pf-notes" class="input" rows="2" value=${f.notes} onInput=${e => upd('notes', e.target.value)} placeholder="Supplier, who likes it, …"></textarea>
      </div>

      ${error && html`<p class="error">${error}</p>`}
      <div class="form-actions">
        ${onCancel && html`<button type="button" class="btn" onClick=${onCancel}>Cancel</button>`}
        <button class="btn primary grow">${submitLabel || (editing ? 'Save changes' : 'Save product')}</button>
      </div>
    </form>`;
}

/** Where new products go by default: the most recently used place (within the site being shown). */
function lastLocation(state) {
  const { siteId } = siteContext(state);
  const recent = state.products
    .filter(p => !siteId || siteOf(state.locations, p.locationId) === siteId)
    .sort((a, b) => (b.addedAt || b.createdAt) - (a.addedAt || a.createdAt))[0];
  return recent ? recent.locationId : siteId;
}

/** Routes #/new and #/edit/:id. */
export function ProductFormPage({ route }) {
  const { state } = useApp();
  const editId = route.name === 'edit' ? route.parts[1] : null;
  const product = editId ? state.products.find(p => p.id === editId) : null;
  if (editId && !product) return html`<${Header} title="Edit product" back /><main class="page"><p class="muted">Not found.</p></main>`;
  return html`
    <${Header} title=${product ? 'Edit product' : 'New product'} back=${product ? `#/product/${editId}` : '#/pantry'} />
    <main class="page">
      <${ProductForm} key=${editId || 'new'} product=${product}
        onSaved=${id => {
          if (product) {
            showToast('Saved');
            goBack(`#/product/${id}`);
          } else {
            showToast('Product added');
            navigate(`#/product/${id}`, { replace: true });
          }
        }}
        onCancel=${() => goBack('#/pantry')} />
    </main>`;
}

