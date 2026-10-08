// Reorder list: what's out, low or running out before the next order — plus your own items. Shareable as text.

import { html, useState, useMemo } from './lib.js';
import { navigate, showToast, pickSheet } from './nav.js';
import { useApp, Header, Icon, Thumb, Empty, SiteBar, siteContext } from './kit.js';
import { openAddStock, undoToast } from './sheets.js';
import { reorderList } from '../model.js';
import { qtyText, dayText, fmtNum, longDate } from '../format.js';
import { setOrdered, setReorder, addShopping, toggleShopping, removeShopping, clearDoneShopping } from '../store.js';

function reasonText(x, now) {
  const p = x.i.product;
  const e = x.i.est;
  switch (x.reason) {
    case 'out': return 'Out of stock';
    case 'probably-out': return 'Probably out (not checked yet)';
    case 'expired': return 'Only expired stock left';
    case 'low': return `Low: ~${fmtNum(Math.round(e.total))} left, minimum ${fmtNum(p.minStock)}`;
    case 'soon': return `Runs out ~${dayText(e.runOutAt, now)}`;
    default: return '';
  }
}

function amountText(x) {
  const { units, pack, packs } = x.qty;
  const unit = x.i.product.unit;
  return `${qtyText(units, unit)}${packs ? ` (${packs} × ${pack}-pack)` : ''}`;
}

/** Split items by site, in site order (only used when showing all of several sites). */
function bySite(items, sites) {
  const groups = [...sites.map(x => ({ id: x.id, name: x.name, items: [] })), { id: '', name: 'Not at a site', items: [] }];
  for (const x of items) (groups.find(g => g.id === (x.i.siteId || '')) || groups[groups.length - 1]).items.push(x);
  return groups.filter(g => g.items.length);
}

export function shareText(groups, shopping, now, title = 'Office reorder') {
  const lines = [`${title} — ${longDate(now)}`];
  for (const g of groups) {
    if (g.name) lines.push('', `${g.name}:`);
    for (const x of g.items) lines.push(`• ${x.i.product.name}${x.i.product.brand ? ` (${x.i.product.brand})` : ''} — ${amountText(x)}`);
  }
  const extra = shopping.filter(s => !s.done);
  if (extra.length && groups.some(g => g.name)) lines.push('', 'Also:');
  for (const s of extra) lines.push(`• ${s.text}`);
  return lines.join('\n');
}

function NeedRow({ x, now, options }) {
  const p = x.i.product;
  return html`
    <div class="row">
      <button class="tick" aria-label=${`Mark ${p.name} as ordered`} onClick=${() => {
        setOrdered(p.id, true);
        showToast(`${p.name} marked as ordered`, { action: { label: 'Undo', fn: () => setOrdered(p.id, false) } });
      }}></button>
      <span class="row-main" onClick=${() => navigate(`#/product/${p.id}`)}>
        <span class="row-title">${p.name}</span>
        <span class=${`row-sub${x.reason === 'out' || x.reason === 'expired' ? ' danger-text' : ''}`}>${reasonText(x, now)}</span>
        <span class="row-sub strong">Order ~${amountText(x)}</span>
      </span>
      <button class="icon-btn" aria-label="Options" onClick=${() => options(x)}><${Icon} name="dots" /></button>
    </div>`;
}

export function Reorder() {
  const { state, info, now } = useApp();
  const { sites, multi, siteId, site } = siteContext(state);
  const r = useMemo(() => reorderList(info, state.settings, now, siteId), [info, now, siteId]);
  const grouped = multi && !siteId;
  const needGroups = grouped ? bySite(r.need, sites) : [{ id: siteId || 'all', name: null, items: r.need }];
  const [text, setText] = useState('');
  const open = state.shopping.filter(s => !s.done);
  const done = state.shopping.filter(s => s.done);
  const nothing = !r.need.length && !r.ordered.length && !state.shopping.length;

  const share = async () => {
    const body = shareText(needGroups, state.shopping, now, site ? `${site.name} reorder` : 'Office reorder');
    try {
      if (navigator.share) await navigator.share({ title: 'Office reorder', text: body });
      else {
        await navigator.clipboard.writeText(body);
        showToast('List copied — paste it into an email or chat');
      }
    } catch (e) {
      if (e && e.name === 'AbortError') return;
      try {
        await navigator.clipboard.writeText(body);
        showToast('List copied');
      } catch {
        showToast('Sharing is not available here');
      }
    }
  };

  const options = async x => {
    const p = x.i.product;
    const v = await pickSheet({
      title: p.name,
      options: [
        { label: 'Open product', value: 'open' },
        { label: "Don't reorder this product", sub: 'For one-off items', value: 'off' },
      ],
    });
    if (v === 'open') navigate(`#/product/${p.id}`);
    if (v === 'off') {
      setReorder(p.id, false);
      undoToast(`${p.name} won't be suggested again`);
    }
  };

  const addItem = e => {
    e.preventDefault();
    const t = text.trim();
    if (!t) return;
    addShopping(t);
    setText('');
  };

  const can = typeof navigator !== 'undefined' && (navigator.share || navigator.clipboard);

  return html`
    <${Header} title="Reorder" sub=${`Covers the next ${state.settings.orderEveryDays} days`}
      actions=${can && (r.need.length || open.length) ? html`
        <button class="icon-btn" aria-label="Share list" onClick=${share}><${Icon} name="share" /></button>` : null} />
    <main class="page">
      <${SiteBar} />
      ${nothing && html`<${Empty} icon="cart" title="Nothing to order">Items appear here when they run out, drop below their minimum, or will run out before your next order.<//>`}

      ${r.need.length > 0 && html`
        <section class="section">
          <h2 class="section-title">To order <span class="count">${r.need.length}</span></h2>
          <p class="section-hint">Tick an item once you've ordered it.</p>
          ${needGroups.map(g => html`
            ${g.name && html`<h3 class="group-title"><${Icon} name="pin" size=${15} /> ${g.name}</h3>`}
            <div class="card list" key=${g.id}>
              ${g.items.map(x => html`<${NeedRow} key=${x.i.product.id} x=${x} now=${now} options=${options} />`)}
            </div>`)}
        </section>`}

      ${r.ordered.length > 0 && html`
        <section class="section">
          <h2 class="section-title">On order <span class="count">${r.ordered.length}</span></h2>
          <div class="card list">
            ${r.ordered.map(x => html`
              <div class="row" key=${x.i.product.id}>
                <${Thumb} p=${x.i.product} size=${36} />
                <span class="row-main">
                  <span class="row-title">${x.i.product.name}</span>
                  <span class="row-sub">Ordered ${dayText(x.i.product.orderedAt, now)}${grouped ? ` · ${(sites.find(t => t.id === x.i.siteId) || { name: 'no site' }).name}` : ''}</span>
                </span>
                <button class="btn small primary" onClick=${() => openAddStock(x.i.product)}>Received</button>
                <button class="icon-btn" aria-label="Not ordered" onClick=${() => setOrdered(x.i.product.id, false)}><${Icon} name="x" size=${18} /></button>
              </div>`)}
          </div>
        </section>`}

      <section class="section">
        <h2 class="section-title">Also buy</h2>
        <div class="card list">
          ${open.map(s => html`
            <div class="row" key=${s.id}>
              <button class="tick" aria-label=${`Done: ${s.text}`} onClick=${() => toggleShopping(s.id)}></button>
              <span class="row-main"><span>${s.text}</span></span>
              <button class="icon-btn" aria-label="Remove" onClick=${() => removeShopping(s.id)}><${Icon} name="x" size=${18} /></button>
            </div>`)}
          <form class="row add-row" onSubmit=${addItem}>
            <${Icon} name="plus" size=${18} />
            <input class="bare" placeholder="Add an item (e.g. birthday cake Friday)" value=${text} onInput=${e => setText(e.target.value)} />
            ${text.trim() && html`<button class="btn small primary">Add</button>`}
          </form>
          ${done.map(s => html`
            <div class="row done" key=${s.id}>
              <button class="tick on" aria-label=${`Not done: ${s.text}`} onClick=${() => toggleShopping(s.id)}><${Icon} name="check" size=${16} /></button>
              <span class="row-main"><span>${s.text}</span></span>
            </div>`)}
        </div>
        ${done.length > 0 && html`<button class="link-btn" onClick=${clearDoneShopping}>Clear ticked items</button>`}
      </section>

      <button class="btn block" onClick=${() => navigate('#/scan?mode=restock')}>
        <${Icon} name="truck" size=${18} /> Delivery arrived? Scan it in
      </button>
    </main>`;
}
