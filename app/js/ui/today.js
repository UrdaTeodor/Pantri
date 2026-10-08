// Today: what to check, what's expired, what to use soon — the screen the app opens on.

import { html, useState, useMemo } from './lib.js';
import { navigate, goTab, showToast } from './nav.js';
import { useApp, Header, Icon, Thumb, Stepper, placeText } from './kit.js';
import { doCount, openWaste, openBatch, openCount, undoToast } from './sheets.js';
import { todayLists, reorderList, isOfficeOpen, addDays, startOfDay, DAY } from '../model.js';
import { longDate, dayText, qtyText, expiryText, fmtNum } from '../format.js';
import { snooze, useUpBatch } from '../store.js';

function placesOf(state, i) {
  const ids = [...new Set(i.batches.filter(b => b.present || i.out).map(b => b.batch.locationId || null))];
  if (!ids.length) ids.push(i.product.locationId || null);
  return ids.map(id => placeText(state, id)).join(', ');
}

function CheckCard({ c }) {
  const { state, now } = useApp();
  const { i, kind } = c;
  const p = i.product;
  const [n, setN] = useState(Math.round(i.est.total));
  const reason = kind === 'gone'
    ? c.since && c.since < now ? `Probably all used — ran out ~${dayText(c.since, now)}` : 'Probably all used by now'
    : `~${fmtNum(Math.round(i.est.total))} left · you want at least ${fmtNum(p.minStock)}`;
  return html`
    <div class="card check-card">
      <button class="card-head" onClick=${() => navigate(`#/product/${p.id}`)}>
        <${Thumb} p=${p} />
        <span class="row-main">
          <span class="row-title">${p.name}</span>
          <span class="row-sub">${reason}</span>
          <span class="row-sub"><${Icon} name="pin" size=${13} /> ${placesOf(state, i)}</span>
        </span>
      </button>
      <div class="check-actions">
        <button class="btn danger-soft" onClick=${() => doCount(p, 0)}>Gone</button>
        <${Stepper} value=${n} onChange=${setN} min=${0} label=${`${p.name} left`} />
        <button class="btn primary square" onClick=${() => doCount(p, n)} aria-label=${`Save: ${n} left`}>
          <${Icon} name="check" />
        </button>
      </div>
      <button class="link-btn" onClick=${() => {
        snooze(p.id, addDays(startOfDay(now), 1));
        showToast(`Will ask about ${p.name} again tomorrow`);
      }}><${Icon} name="moon" size=${15} /> Ask me tomorrow</button>
    </div>`;
}

function ExpiredCard({ x }) {
  const { state, now } = useApp();
  const { i, b } = x;
  const p = i.product;
  return html`
    <div class="card check-card">
      <button class="card-head" onClick=${() => navigate(`#/product/${p.id}`)}>
        <${Thumb} p=${p} />
        <span class="row-main">
          <span class="row-title">${p.name}</span>
          <span class="row-sub danger-text">${expiryText(b.batch.expiry, now)} · ${qtyText(b.qty, p.unit, i.est.rate > 0)}</span>
          <span class="row-sub"><${Icon} name="pin" size=${13} /> ${placeText(state, b.batch.locationId)}</span>
        </span>
      </button>
      <div class="btn-row">
        <button class="btn danger-soft" onClick=${() => openWaste(p, b)}>Thrown away</button>
        <button class="btn" onClick=${() => {
          useUpBatch(b.batch.id);
          undoToast(`${p.name}: marked as used up`);
        }}>Used up</button>
        <button class="btn" onClick=${() => openBatch(p, b)}>Edit</button>
      </div>
    </div>`;
}

function SoonRow({ x }) {
  const { state, now } = useApp();
  const { i, b } = x;
  const p = i.product;
  const risk = b.unused != null && b.unused >= 0.5;
  return html`
    <button class="row" onClick=${() => navigate(`#/product/${p.id}`)}>
      <${Thumb} p=${p} />
      <span class="row-main">
        <span class="row-title">${p.name}</span>
        <span class="row-sub">${expiryText(b.batch.expiry, now)} · ${qtyText(b.qty, p.unit, i.est.rate > 0)} · ${placeText(state, b.batch.locationId)}</span>
        ${risk && html`<span class="row-sub warn-text"><${Icon} name="alert" size=${13} /> ~${fmtNum(Math.round(b.unused))} likely won't be used in time</span>`}
      </span>
      <${Icon} name="chevron" />
    </button>`;
}

function Welcome() {
  return html`
    <div class="card welcome">
      <h2>Welcome to Office Pantry</h2>
      <ol>
        <li>
          <b>Set your office days and hours.</b> Usage is only counted while the office is open, so weekends don't "use up" stock.
          <button class="link-btn inline" onClick=${() => navigate('#/settings')}>Settings</button>
        </li>
        <li>
          <b>Arrange your locations</b> however you like — e.g. Kitchen › Fridge › Door.
          <button class="link-btn inline" onClick=${() => navigate('#/locations')}>Locations</button>
        </li>
        <li>
          <b>Scan your first item</b> with the round button below. Unknown barcodes are looked up online.
          Give it a usage rate ("5 per day") and the app will tell you when to check on it.
        </li>
      </ol>
    </div>`;
}

function BackupNudge() {
  const { state, now } = useApp();
  if (!state.products.length) return null;
  const last = state.meta.lastBackupAt;
  if (now - (last || state.meta.createdAt) < (last ? 14 : 3) * DAY) return null;
  return html`
    <button class="card nudge" onClick=${() => navigate('#/backup')}>
      <${Icon} name="shield" />
      <span>
        <b>${last ? `Last backup ${dayText(last, now)}` : 'No backup yet'}</b>
        <span class="row-sub">Your pantry lives only on this phone. Tap to save a backup file.</span>
      </span>
    </button>`;
}

function StaleRow({ i }) {
  const { now } = useApp();
  const p = i.product;
  return html`
    <div class="row">
      <${Thumb} p=${p} />
      <span class="row-main" onClick=${() => navigate(`#/product/${p.id}`)}>
        <span class="row-title">${p.name}</span>
        <span class="row-sub">Last checked ${dayText(p.touchedAt || p.createdAt, now)} · ${qtyText(i.est.total, p.unit, i.est.rate > 0)}</span>
      </span>
      <button class="btn small" onClick=${() => openCount(p)}>Count</button>
    </div>`;
}

export function Today() {
  const { state, info, now } = useApp();
  const s = state.settings;
  const lists = useMemo(() => todayLists(info, s, now), [info, now]);
  const reorder = useMemo(() => reorderList(info, s, now), [info, now]);
  const [showStale, setShowStale] = useState(false);
  const toOrder = reorder.need.length + state.shopping.filter(x => !x.done).length;
  const quiet = !lists.checks.length && !lists.expired.length && !lists.soon.length;
  const open = isOfficeOpen(now, s);
  return html`
    <${Header} title="Today" sub=${`${longDate(now)} · ${open ? 'office open' : 'office closed, usage paused'}`}
      actions=${html`<button class="icon-btn" aria-label="Restock: scan a delivery" title="Restock"
        onClick=${() => navigate('#/scan?mode=restock')}><${Icon} name="truck" /></button>`} />
    <main class="page">
      ${!state.products.length && html`<${Welcome} />`}
      <${BackupNudge} />

      ${lists.checks.length > 0 && html`
        <section class="section">
          <h2 class="section-title">Check these <span class="count">${lists.checks.length}</span></h2>
          <p class="section-hint">Going by their usage rate, these should be gone or running low. Are they?</p>
          ${lists.checks.map(c => html`<${CheckCard} key=${c.i.product.id} c=${c} />`)}
        </section>`}

      ${lists.expired.length > 0 && html`
        <section class="section">
          <h2 class="section-title danger-text">Expired <span class="count">${lists.expired.length}</span></h2>
          ${lists.expired.map(x => html`<${ExpiredCard} key=${x.b.batch.id} x=${x} />`)}
        </section>`}

      ${lists.soon.length > 0 && html`
        <section class="section">
          <h2 class="section-title">Use soon <span class="count">${lists.soon.length}</span></h2>
          <div class="card list">${lists.soon.map(x => html`<${SoonRow} key=${x.b.batch.id} x=${x} />`)}</div>
        </section>`}

      ${state.products.length > 0 && quiet && html`
        <div class="all-clear"><${Icon} name="check" size=${28} /><span>Nothing to check right now.</span></div>`}

      ${state.products.length > 0 && html`
        <button class="card link-card" onClick=${() => goTab('reorder')}>
          <${Icon} name="cart" />
          <span class="row-main">
            <span class="row-title">Reorder list</span>
            <span class="row-sub">${toOrder ? `${toOrder} to order` : 'Nothing to order'}${reorder.ordered.length ? ` · ${reorder.ordered.length} on order` : ''}</span>
          </span>
          <${Icon} name="chevron" />
        </button>`}

      ${lists.stale.length > 0 && html`
        <section class="section">
          <button class="section-toggle" onClick=${() => setShowStale(!showStale)} aria-expanded=${showStale}>
            <span>Not checked in ${s.staleDays}+ days <span class="count">${lists.stale.length}</span></span>
            <${Icon} name=${showStale ? 'up' : 'down'} />
          </button>
          ${showStale && html`<div class="card list">${lists.stale.map(x => html`<${StaleRow} key=${x.i.product.id} i=${x.i} />`)}</div>`}
        </section>`}
    </main>`;
}
