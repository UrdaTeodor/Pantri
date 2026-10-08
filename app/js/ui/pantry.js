// Pantry: everything in stock, grouped by location (your own tree), by category, or A–Z.

import { html, useState } from './lib.js';
import { navigate } from './nav.js';
import { useApp, Header, Icon, ProductRow, Empty } from './kit.js';
import { locationTree } from '../model.js';

function usePref(key, initial) {
  const [v, setV] = useState(() => {
    try {
      return localStorage.getItem(key) || initial;
    } catch {
      return initial;
    }
  });
  const set = x => {
    setV(x);
    try {
      localStorage.setItem(key, x);
    } catch { /* private mode: not remembered */ }
  };
  return [v, set];
}

const byName = (a, b) => a.i.product.name.localeCompare(b.i.product.name);
const inStockFirst = (a, b) => (a.i.out - b.i.out) || byName(a, b);

function groupByPlace(items, locations) {
  const rows = new Map();
  const push = (key, row) => {
    if (!rows.has(key)) rows.set(key, []);
    rows.get(key).push(row);
  };
  for (const i of items) {
    const present = i.batches.filter(b => b.present);
    if (!present.length) {
      push(i.product.locationId || '', { i, qty: null });
      continue;
    }
    const per = new Map();
    for (const b of present) per.set(b.batch.locationId || '', (per.get(b.batch.locationId || '') || 0) + b.qty);
    for (const [loc, qty] of per) push(loc, { i, qty });
  }
  const groups = [];
  for (const t of locationTree(locations)) {
    if (rows.has(t.loc.id)) groups.push({ key: t.loc.id, title: t.path, depth: t.depth, rows: rows.get(t.loc.id) });
    rows.delete(t.loc.id);
  }
  const rest = [...rows.values()].flat();
  if (rest.length) groups.push({ key: 'none', title: 'No location', depth: 0, rows: rest });
  return groups;
}

function groupByCategory(items, categories) {
  const groups = [...categories].sort((a, b) => a.order - b.order)
    .map(c => ({ key: c.id, title: c.name, rows: items.filter(i => i.product.categoryId === c.id).map(i => ({ i, qty: null })) }));
  const known = new Set(categories.map(c => c.id));
  const rest = items.filter(i => !known.has(i.product.categoryId)).map(i => ({ i, qty: null }));
  groups.push({ key: 'none', title: 'No category', rows: rest });
  return groups.filter(g => g.rows.length);
}

export function Pantry() {
  const { state, info, now } = useApp();
  const [q, setQ] = useState('');
  const [mode, setMode] = usePref('pantry.group', 'place');
  const [attention, setAttention] = useState(false);

  const needle = q.trim().toLowerCase();
  const items = [...info.values()].filter(i => {
    const p = i.product;
    if (attention && !(i.expired || i.soon || i.low || i.out)) return false;
    if (!needle) return true;
    return p.name.toLowerCase().includes(needle) || (p.brand || '').toLowerCase().includes(needle) ||
      p.barcodes.some(b => b.code.includes(needle));
  });

  let groups;
  if (mode === 'category') groups = groupByCategory(items, state.categories);
  else if (mode === 'az') groups = [{ key: 'all', title: '', rows: items.map(i => ({ i, qty: null })) }];
  else groups = groupByPlace(items, state.locations);
  for (const g of groups) g.rows.sort(mode === 'az' ? byName : inStockFirst);

  const add = html`<button class="icon-btn" aria-label="New product" onClick=${() => navigate('#/new')}><${Icon} name="plus" /></button>`;

  if (!state.products.length) {
    return html`
      <${Header} title="Pantry" actions=${add} />
      <main class="page">
        <${Empty} title="Your pantry is empty">
          Scan a barcode with the round button below, or add a product without a barcode (fruit, bulk items) with +.
        <//>
        <button class="btn block" onClick=${() => navigate('#/locations')}><${Icon} name="pin" size=${18} /> Set up locations</button>
      </main>`;
  }

  return html`
    <${Header} title="Pantry" sub=${`${state.products.length} products`} actions=${add} />
    <main class="page">
      <label class="search">
        <${Icon} name="search" size=${18} />
        <input type="search" placeholder="Search name, brand or barcode" value=${q} onInput=${e => setQ(e.target.value)} />
      </label>
      <div class="toolbar">
        <div class="seg" role="tablist">
          ${[['place', 'Locations'], ['category', 'Categories'], ['az', 'A–Z']].map(([k, label]) => html`
            <button role="tab" aria-selected=${mode === k} class=${mode === k ? 'on' : ''} onClick=${() => setMode(k)}>${label}</button>`)}
        </div>
        <button class=${`chip-btn${attention ? ' on' : ''}`} onClick=${() => setAttention(!attention)}>Needs attention</button>
      </div>
      ${!groups.length && html`<${Empty} icon="search" title="Nothing matches" />`}
      ${groups.map(g => html`
        <section class="section" key=${g.key}>
          ${g.title && html`<h2 class="section-title">${g.title} <span class="count">${g.rows.length}</span></h2>`}
          <div class="card list">
            ${g.rows.map(r => html`
              <${ProductRow} key=${r.i.product.id} i=${r.i} now=${now} qty=${r.qty}
                onClick=${() => navigate(`#/product/${r.i.product.id}`)} />`)}
          </div>
        </section>`)}
      ${mode === 'place' && html`
        <button class="link-btn center" onClick=${() => navigate('#/locations')}><${Icon} name="pin" size=${16} /> Edit locations</button>`}
    </main>`;
}
