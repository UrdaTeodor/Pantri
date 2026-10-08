// Product detail: stock & estimate, batches, rate suggestion, settings summary, history.

import { html } from './lib.js';
import { navigate, goBack, pickSheet, confirmSheet, showToast } from './nav.js';
import { useApp, Header, Icon, Thumb, Empty, placeText } from './kit.js';
import { openAddStock, openCount, openUse, chooseAndWaste, openBatch, undoToast } from './sheets.js';
import { rateSuggestion, observedRate, unusedAtExpiry, wasteSummary, fromPerOfficeDay, roundNice } from '../model.js';
import { qtyText, rateText, dayText, ago, expiryText, fmtNum, PER_LABEL, plural } from '../format.js';
import {
  applyRate, dismissRateHint, deleteProduct, setReorder, setOrdered,
} from '../store.js';

const EVENT_TEXT = {
  add: (e, u) => `Added ${qtyText(e.qty, u)}${e.initial ? ' (first stock)' : ''}`,
  count: (e, u) => (e.qty === 0 ? 'Counted: none left' : `Counted ${qtyText(e.qty, u)}`),
  used: (e, u) => `Used ${qtyText(e.qty, u)}`,
  waste: (e, u) => `Threw away ${qtyText(e.qty, u)} (${e.reason || 'expired'})`,
  adjust: (e, u) => `Corrected stock ${e.qty > 0 ? '+' : '−'}${qtyText(Math.abs(e.qty), u)}`,
};

function Suggestion({ p, sug }) {
  return html`
    <div class="card suggestion">
      <${Icon} name="bulb" />
      <div class="row-main">
        <b>${sug.faster ? 'Going faster than expected' : sug.faster === false ? 'Going slower than expected' : 'Usage measured'}</b>
        <span class="row-sub">
          Your counts over ${fmtNum(roundNice(sug.days))} office days suggest ~${fmtNum(sug.qty)} per ${PER_LABEL[sug.per]}${p.rate ? ` (set: ${fmtNum(p.rate.qty)})` : ''}.
        </span>
        <div class="btn-row">
          <button class="btn primary small" onClick=${() => { applyRate(p.id, { qty: sug.qty, per: sug.per }); showToast('Usage rate updated'); }}>
            Use ${fmtNum(sug.qty)} per ${PER_LABEL[sug.per]}
          </button>
          <button class="btn small" onClick=${() => dismissRateHint(p.id)}>Keep mine</button>
        </div>
      </div>
    </div>`;
}

export function ProductPage({ route }) {
  const { state, info, now } = useApp();
  const id = route.parts[1];
  const i = info.get(id);
  if (!i) {
    return html`<${Header} title="Product" back="#/pantry" />
      <main class="page"><${Empty} title="This product no longer exists" /></main>`;
  }
  const p = i.product;
  const e = i.est;
  const s = state.settings;
  const tracked = e.rate > 0;
  const sug = rateSuggestion(p, state.events, s);
  const obs = observedRate(state.events, id, s);
  const waste = wasteSummary({ ...state, events: state.events.filter(x => x.productId === id) }, now).rows[0];
  const category = state.categories.find(c => c.id === p.categoryId);
  const events = state.events.filter(x => x.productId === id && !(x.type === 'count' && x.initial)).slice(-15).reverse();
  const present = i.batches.filter(b => b.present);

  let paceLine = 'Usage not tracked — stock changes only when you count, use or add.';
  if (tracked) {
    paceLine = `Uses ${rateText(p.rate)} · ${i.out ? 'probably used up' : `runs out ~${dayText(e.runOutAt, now)}`}`;
  }

  const more = async () => {
    const choice = await pickSheet({
      title: p.name,
      options: [
        p.orderedAt
          ? { label: 'Not ordered after all', value: 'unorder' }
          : { label: 'Mark as ordered', sub: 'Moves it to "On order" until stock is added', value: 'order' },
        p.reorder === false
          ? { label: 'Show on the reorder list again', value: 'reorder-on' }
          : { label: "Don't reorder this product", sub: 'For one-off items', value: 'reorder-off' },
        { label: 'Delete product', sub: 'Removes it and its stock', value: 'delete', danger: true },
      ],
    });
    if (choice === 'order' || choice === 'unorder') setOrdered(id, choice === 'order');
    if (choice === 'reorder-on' || choice === 'reorder-off') {
      setReorder(id, choice === 'reorder-on');
      undoToast(choice === 'reorder-on' ? 'Back on the reorder list' : 'Won\'t be suggested for reorder');
    }
    if (choice === 'delete' && await confirmSheet({ title: `Delete ${p.name}?`, body: 'Its stock and history are removed. Waste already logged stays in the waste report.', ok: 'Delete', danger: true })) {
      goBack('#/pantry');
      deleteProduct(id);
      undoToast(`Deleted ${p.name}`);
    }
  };

  return html`
    <${Header} title=${p.name} back="#/pantry" actions=${html`
      <button class="icon-btn" aria-label="Edit" onClick=${() => navigate(`#/edit/${id}`)}><${Icon} name="edit" /></button>
      <button class="icon-btn" aria-label="More" onClick=${more}><${Icon} name="dots" /></button>`} />
    <main class="page">
      <div class="product-hero">
        <${Thumb} p=${p} size=${64} />
        <div>
          <div class="muted">${[p.brand, p.size, category && category.name].filter(Boolean).join(' · ') || 'No details'}</div>
          ${p.orderedAt && html`<span class="chip info">ordered ${dayText(p.orderedAt, now)}</span>`}
          ${p.reorder === false && html`<span class="chip muted">not reordered</span>`}
        </div>
      </div>

      <div class="card stock-card">
        <div class="stock-qty">${qtyText(e.total, p.unit, tracked)}</div>
        <div class="row-sub">${paceLine}</div>
        <div class="row-sub">Last counted ${ago(p.countedAt, now)}${p.minStock > 0 ? ` · minimum ${fmtNum(p.minStock)}` : ''}</div>
        <div class="action-grid">
          <button class="btn primary" onClick=${() => openAddStock(p)}><${Icon} name="plus" size=${18} /> Add</button>
          <button class="btn" onClick=${() => openCount(p)}><${Icon} name="check" size=${18} /> Count</button>
          ${!tracked && html`<button class="btn" onClick=${() => openUse(p)} disabled=${i.out}><${Icon} name="minus" size=${18} /> Used</button>`}
          <button class="btn danger-soft" onClick=${() => chooseAndWaste(i, now)} disabled=${!present.length}>
            <${Icon} name="trash" size=${18} /> Thrown away
          </button>
        </div>
      </div>

      ${sug && html`<${Suggestion} p=${p} sug=${sug} />`}

      <section class="section">
        <h2 class="section-title">Batches <span class="count">${present.length}</span></h2>
        ${present.length ? html`
          <div class="card list">
            ${present.map(b => {
              const unused = tracked && b.batch.expiry && !b.expired ? unusedAtExpiry(p, e, b.batch, s) : null;
              return html`
                <button class="row" key=${b.batch.id} onClick=${() => openBatch(p, b)}>
                  <span class="row-main">
                    <span class="row-title">${qtyText(b.qty, p.unit, tracked)}</span>
                    <span class=${`row-sub${b.expired ? ' danger-text' : ''}`}>
                      ${b.batch.expiry ? expiryText(b.batch.expiry, now) : 'No expiry date'} · ${placeText(state, b.batch.locationId)}
                    </span>
                    ${unused >= 0.5 && html`<span class="row-sub warn-text"><${Icon} name="alert" size=${13} /> ~${fmtNum(Math.round(unused))} won't be used before it expires</span>`}
                  </span>
                  <${Icon} name="edit" size=${18} />
                </button>`;
            })}
          </div>` : html`<p class="muted pad">None in stock.</p>`}
      </section>

      <section class="section">
        <h2 class="section-title">Details</h2>
        <div class="card">
          <dl class="details">
            <dt>Usage</dt><dd>${rateText(p.rate)}</dd>
            ${obs && html`<dt>Measured</dt><dd>~${fmtNum(roundNice(fromPerOfficeDay(obs.perOfficeDay, (p.rate && p.rate.per) || 'week', s)))} per ${PER_LABEL[(p.rate && p.rate.per) || 'week']} (from your counts)</dd>`}
            <dt>Reorder</dt><dd>${p.reorder === false ? 'off' : `when ${p.minStock > 0 ? `≤ ${fmtNum(p.minStock)}` : 'out'}${tracked ? ' or running out soon' : ''}`}${p.orderQty ? ` · usually ${qtyText(p.orderQty, p.unit)}` : ''}</dd>
            <dt>Location</dt><dd>${placeText(state, p.locationId)}</dd>
            <dt>Barcodes</dt><dd>${p.barcodes.length ? p.barcodes.map(b => html`<div>${b.code}${b.units > 1 ? ` · ${b.units} ${plural(p.unit, b.units)}` : ''}</div>`) : 'none'}</dd>
            ${p.shelfLifeDays != null && html`<dt>Shelf life</dt><dd>${p.shelfLifeDays} days last time</dd>`}
            ${waste && html`<dt>Waste (90 days)</dt><dd>${qtyText(waste.wasted, p.unit)}${waste.share != null ? ` · ${Math.round(waste.share * 100)}% of what was added` : ''}</dd>`}
            ${p.notes && html`<dt>Notes</dt><dd class="pre">${p.notes}</dd>`}
          </dl>
        </div>
      </section>

      <section class="section">
        <h2 class="section-title">History</h2>
        ${events.length ? html`
          <div class="card list">
            ${events.map(ev => html`
              <div class="row static" key=${ev.id}>
                <span class="row-main">
                  <span>${(EVENT_TEXT[ev.type] || (() => ev.type))(ev, p.unit)}</span>
                  <span class="row-sub">${ago(ev.at, now)}${ev.expiry ? ` · exp ${ev.expiry}` : ''}</span>
                </span>
              </div>`)}
          </div>` : html`<p class="muted pad">No history yet.</p>`}
      </section>
    </main>`;
}
