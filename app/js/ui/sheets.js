// Stock action forms (add / count / use / throw away / edit batch) and the sheets that host them.

import { html, useState } from './lib.js';
import { ask, showToast, pickSheet, confirmSheet } from './nav.js';
import { useApp, Stepper, ExpiryPicker, LocationSelect, Thumb, Icon, placeText } from './kit.js';
import {
  addStock, count, useStock, wasteBatch, editBatch, applyRate, undo, getState,
} from '../store.js';
import { qtyText, plural, fmtNum, PER_LABEL, expiryText } from '../format.js';

export const undoAction = { label: 'Undo', fn: () => undo() && showToast('Undone') };
export const undoToast = text => showToast(text, { action: undoAction, timeout: 6000 });

/** Record a count and tell the user what it means (including a better usage rate, if the count reveals one). */
export function doCount(p, qty) {
  const sug = count(p.id, qty);
  const text = qty === 0
    ? `${p.name}: marked as gone${p.reorder !== false ? ' — added to the reorder list' : ''}`
    : `${p.name}: ${qtyText(qty, p.unit)} counted`;
  if (sug) {
    const was = p.rate ? ` (set: ${fmtNum(p.rate.qty)})` : '';
    showToast(`${text}. Your counts suggest ~${fmtNum(sug.qty)} per ${PER_LABEL[sug.per]}${was}.`, {
      action: { label: 'Use rate', fn: () => { applyRate(p.id, { qty: sug.qty, per: sug.per }); showToast('Usage rate updated'); } },
      timeout: 12000,
    });
  } else undoToast(text);
}

function SheetTitle({ p, title, sub = '' }) {
  return html`
    <div class="sheet-product">
      <${Thumb} p=${p} size=${40} />
      <div><h2>${title}</h2>${sub && html`<p class="muted">${sub}</p>`}</div>
    </div>`;
}

// ---------- forms (also embedded in the scanner sheet) ----------

export function AddStockForm({ p, units = 1, expiry = null, expiryNote = '', submitLabel = '', onDone }) {
  const { state, now } = useApp();
  const [qty, setQty] = useState(units);
  const [exp, setExp] = useState(expiry);
  const [loc, setLoc] = useState(p.locationId);
  const submit = () => {
    addStock(p.id, { qty, expiry: exp, locationId: loc });
    onDone({ qty });
  };
  return html`
    <div class="field">
      <label>How many ${plural(p.unit, 2)}?</label>
      <${Stepper} value=${qty} onChange=${setQty} min=${1} step=${units} />
      ${units > 1 && html`<div class="hint">This barcode counts as ${qtyText(units, p.unit)}.</div>`}
    </div>
    <${ExpiryPicker} value=${exp} onChange=${setExp} product=${p} now=${now} note=${expiryNote} />
    <div class="field">
      <label>Where is it going?</label>
      <${LocationSelect} value=${loc} onChange=${setLoc} locations=${state.locations} />
    </div>
    <button class="btn primary block" onClick=${submit}>${submitLabel || `Add ${qtyText(qty, p.unit)}`}</button>`;
}

export function CountForm({ p, i, onDone }) {
  const [n, setN] = useState(Math.round(i.est.total));
  const done = qty => {
    doCount(p, qty);
    onDone();
  };
  return html`
    <p class="muted">
      ${i.est.rate > 0 ? `Estimated from usage: ~${Math.round(i.est.total)}.` : `Recorded: ${Math.round(i.est.total)}.`}
      ${' '}Count what's actually there.
    </p>
    <div class="count-row">
      <${Stepper} value=${n} onChange=${setN} min=${0} label="How many are left" />
      <span class="muted">${plural(p.unit, n)}</span>
    </div>
    <div class="btn-row">
      <button class="btn danger-soft" onClick=${() => done(0)}>None left</button>
      <button class="btn primary" onClick=${() => done(n)}>Save count</button>
    </div>`;
}

const REASONS = [['expired', 'Expired'], ['spoiled', 'Spoiled / damaged'], ['other', 'Other']];

export function WasteForm({ p, row, onDone }) {
  const [n, setN] = useState(Math.max(1, Math.round(row.qty)));
  const [reason, setReason] = useState(row.expired ? 'expired' : 'spoiled');
  const submit = () => {
    wasteBatch(row.batch.id, n, reason);
    undoToast(`Logged waste: ${qtyText(n, p.unit)} of ${p.name}`);
    onDone();
  };
  return html`
    <div class="field">
      <label>How many did you throw away?</label>
      <${Stepper} value=${n} onChange=${setN} min=${1} />
    </div>
    <div class="field">
      <label>Why?</label>
      <div class="chips">
        ${REASONS.map(([k, label]) => html`
          <button type="button" class=${`chip-btn${reason === k ? ' on' : ''}`} onClick=${() => setReason(k)}>${label}</button>`)}
      </div>
    </div>
    <button class="btn danger block" onClick=${submit}>Log as thrown away</button>`;
}

export function UseForm({ p, onDone }) {
  const [n, setN] = useState(1);
  const submit = () => {
    useStock(p.id, n);
    undoToast(`Took ${qtyText(n, p.unit)} of ${p.name}`);
    onDone();
  };
  return html`
    <div class="field">
      <label>How many were taken out?</label>
      <${Stepper} value=${n} onChange=${setN} min=${1} />
    </div>
    <button class="btn primary block" onClick=${submit}>Save</button>`;
}

function BatchForm({ p, row, onDone }) {
  const { state, now } = useApp();
  const shown = Math.round(row.qty);
  const [qty, setQty] = useState(shown);
  const [exp, setExp] = useState(row.batch.expiry);
  const [loc, setLoc] = useState(row.batch.locationId);
  const save = () => {
    const patch = { expiry: exp, locationId: loc };
    if (qty !== shown) patch.qty = qty;
    editBatch(row.batch.id, patch);
    undoToast('Batch updated');
    onDone();
  };
  const remove = async () => {
    if (await confirmSheet({ title: 'Remove this batch?', body: 'Use this to fix mistakes. If it was thrown away, log it as waste instead.', ok: 'Remove', danger: true })) {
      editBatch(row.batch.id, { qty: 0 });
      undoToast('Batch removed');
      onDone();
    }
  };
  return html`
    <div class="field">
      <label>Quantity in this batch</label>
      <${Stepper} value=${qty} onChange=${setQty} min=${0} />
    </div>
    <${ExpiryPicker} value=${exp} onChange=${setExp} product=${null} now=${now} />
    <div class="field">
      <label>Location</label>
      <${LocationSelect} value=${loc} onChange=${setLoc} locations=${state.locations} />
    </div>
    <button class="btn primary block" onClick=${save}>Save changes</button>
    <div class="btn-row">
      <button class="btn danger-soft" onClick=${() => openWaste(p, row).then(done => done && onDone())}>
        <${Icon} name="trash" size=${18} /> Thrown away…
      </button>
      <button class="btn" onClick=${remove}>Remove batch</button>
    </div>`;
}

// ---------- sheet openers ----------

/** Live product + analysis inside a sheet (the sheet stays open while the store changes). */
function useLive(productId) {
  const { info } = useApp();
  return info.get(productId);
}

function LiveSheet({ productId, children }) {
  const i = useLive(productId);
  if (!i) return html`<div class="sheet-pad"><p class="muted">This product no longer exists.</p></div>`;
  return children(i);
}

export function openAddStock(p, opts = {}) {
  return ask(close => html`
    <div class="sheet-pad">
      <${SheetTitle} p=${p} title=${`Add ${p.name}`} sub=${placeText(getState(), p.locationId)} />
      <${AddStockForm} p=${p} ...${opts} onDone=${({ qty }) => {
        undoToast(`Added ${qtyText(qty, p.unit)} · ${p.name}`);
        close(true);
      }} />
    </div>`);
}

export function openCount(p) {
  return ask(close => html`
    <${LiveSheet} productId=${p.id}>${i => html`
      <div class="sheet-pad">
        <${SheetTitle} p=${i.product} title=${`How many ${plural(p.unit, 2)} are left?`} sub=${p.name} />
        <${CountForm} p=${i.product} i=${i} onDone=${() => close(true)} />
      </div>`}<//>`);
}

export function openUse(p) {
  return ask(close => html`
    <div class="sheet-pad">
      <${SheetTitle} p=${p} title=${`Used some ${p.name}`} />
      <${UseForm} p=${p} onDone=${() => close(true)} />
    </div>`);
}

export function openWaste(p, row) {
  return ask(close => html`
    <div class="sheet-pad">
      <${SheetTitle} p=${p} title="Thrown away" sub=${`${p.name}${row.batch.expiry ? ` · ${expiryText(row.batch.expiry, Date.now())}` : ''}`} />
      <${WasteForm} p=${p} row=${row} onDone=${() => close(true)} />
    </div>`);
}

/** Choose which batch was thrown away (skips the question when there is only one). */
export async function chooseAndWaste(i, now) {
  const rows = i.batches.filter(b => b.present);
  if (!rows.length) return showToast('Nothing left to throw away');
  let row = rows[0];
  if (rows.length > 1) {
    row = await pickSheet({
      title: 'Which batch?',
      options: rows.map(r => ({
        label: `${qtyText(r.qty, i.product.unit, i.est.rate > 0)}${r.batch.expiry ? ` · ${expiryText(r.batch.expiry, now)}` : ' · no date'}`,
        sub: placeText(getState(), r.batch.locationId),
        value: r,
      })),
    });
    if (!row) return;
  }
  return openWaste(i.product, row);
}

export function openBatch(p, row) {
  return ask(close => html`
    <div class="sheet-pad">
      <${SheetTitle} p=${p} title="Edit batch" sub=${p.name} />
      <${BatchForm} p=${p} row=${row} onDone=${() => close(true)} />
    </div>`);
}
