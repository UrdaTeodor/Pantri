// Shared UI pieces: icons, thumbnails, steppers, pickers, headers, product rows.

import { html, useState, createContext, useContext, focusOnMount } from './lib.js';
import { goBack } from './nav.js';
import { addDays, startOfDay, ymd, locationTree, locationPath, sitesOf, siteOf, siteSettings } from '../model.js';
import { expiryText, qtyText, expiryShort, parseNum, fmtInput } from '../format.js';
import { setCurrentSite } from '../store.js';

export const AppCtx = createContext(null);
/** { state, info, now } — the store state, per-product analysis and the current time. */
export const useApp = () => useContext(AppCtx);

const ICONS = {
  home: '<path d="M3 11 12 4l9 7"/><path d="M5 10v10h5v-6h4v6h5V10"/>',
  box: '<path d="M3 7.5 12 3l9 4.5v9L12 21l-9-4.5z"/><path d="M3 7.5 12 12l9-4.5M12 12v9"/>',
  scan: '<path d="M4 8V5a1 1 0 0 1 1-1h3M16 4h3a1 1 0 0 1 1 1v3M20 16v3a1 1 0 0 1-1 1h-3M8 20H5a1 1 0 0 1-1-1v-3"/><path d="M8 8v8M10.5 8v8M13.5 8v8M16 8v8"/>',
  cart: '<path d="M3 4h2.5l2.2 10.5a1 1 0 0 0 1 .8h8.6a1 1 0 0 0 1-.8L20 7.5H6.2"/><circle cx="9.5" cy="19.5" r="1.3"/><circle cx="17" cy="19.5" r="1.3"/>',
  menu: '<path d="M4 6h16M4 12h16M4 18h16"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  minus: '<path d="M5 12h14"/>',
  check: '<path d="m5 12.5 4.5 4.5L19 7"/>',
  x: '<path d="M6 6l12 12M18 6 6 18"/>',
  chevron: '<path d="m9 6 6 6-6 6"/>',
  back: '<path d="m15 6-6 6 6 6"/>',
  up: '<path d="m7 14 5-5 5 5"/>',
  down: '<path d="m7 10 5 5 5-5"/>',
  trash: '<path d="M4 7h16M10 11v6M14 11v6M9 7V4h6v3M6 7l1 13h10l1-13"/>',
  edit: '<path d="M4 20h4L19 9l-4-4L4 16v4z"/><path d="m13.5 6.5 4 4"/>',
  alert: '<path d="M12 4 2.5 20h19z"/><path d="M12 10v4.5M12 17.5v.01"/>',
  clock: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>',
  bolt: '<path d="M13 3 5 13.5h6L10 21l8-10.5h-6z"/>',
  keyboard: '<rect x="3" y="6" width="18" height="12" rx="2"/><path d="M7 10h.01M10 10h.01M13 10h.01M16 10h.01M7.5 14h9"/>',
  share: '<path d="M12 3v12M7.5 7.5 12 3l4.5 4.5"/><path d="M5 12v7a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-7"/>',
  download: '<path d="M12 4v11M7.5 10.5 12 15l4.5-4.5"/><path d="M5 19h14"/>',
  upload: '<path d="M12 15V4M7.5 8.5 12 4l4.5 4.5"/><path d="M5 19h14"/>',
  pin: '<path d="M12 21s-6.5-5.6-6.5-11a6.5 6.5 0 0 1 13 0c0 5.4-6.5 11-6.5 11z"/><circle cx="12" cy="10" r="2.3"/>',
  tag: '<path d="M3.5 12.5v-8a1 1 0 0 1 1-1h8l8 8-9 9z"/><circle cx="8" cy="8" r="1.4"/>',
  sliders: '<path d="M4 7h9M17 7h3M4 17h3M11 17h9"/><circle cx="15" cy="7" r="2"/><circle cx="9" cy="17" r="2"/>',
  help: '<circle cx="12" cy="12" r="8.5"/><path d="M9.6 9.5a2.5 2.5 0 0 1 4.8.9c0 1.7-2.4 2.1-2.4 3.6M12 17v.01"/>',
  search: '<circle cx="11" cy="11" r="6.5"/><path d="m16 16 4 4"/>',
  dots: '<circle cx="12" cy="5.5" r="1.3" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1.3" fill="currentColor" stroke="none"/><circle cx="12" cy="18.5" r="1.3" fill="currentColor" stroke="none"/>',
  truck: '<path d="M3 6h11v10H3zM14 9.5h4l3 3.5v3h-7"/><circle cx="7" cy="17.5" r="1.6"/><circle cx="17.5" cy="17.5" r="1.6"/>',
  bulb: '<path d="M9 18h6M10 21h4M12 3a6 6 0 0 0-3.5 10.9c.6.4 1 1.1 1 1.8V16h5v-.3c0-.7.4-1.4 1-1.8A6 6 0 0 0 12 3z"/>',
  moon: '<path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z"/>',
  shield: '<path d="M12 3 4.5 6v5.5c0 4.5 3.2 8 7.5 9.5 4.3-1.5 7.5-5 7.5-9.5V6z"/><path d="m9 12 2 2 4-4"/>',
  bell: '<path d="M6 9a6 6 0 0 1 12 0c0 6.5 2.5 8.5 2.5 8.5h-17S6 15.5 6 9z"/><path d="M10.3 21a1.9 1.9 0 0 0 3.4 0"/>',
  calendar: '<rect x="3.5" y="5" width="17" height="15.5" rx="2"/><path d="M3.5 10h17M8 3v4M16 3v4M8 14h.01M12 14h.01M16 14h.01M8 17.5h.01M12 17.5h.01"/>',
};

export function Icon({ name, size = 22 }) {
  return html`<svg class="icon" width=${size} height=${size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
    stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"
    dangerouslySetInnerHTML=${{ __html: ICONS[name] || '' }}></svg>`;
}

export { focusOnMount };

const hue = s => [...(s || '?')].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7) % 360;

export function Thumb({ p, size = 44 }) {
  const [broken, setBroken] = useState(false);
  if (p.imageUrl && !broken) {
    // crossorigin: Open Food Facts serves CORS headers, so the service worker caches real (not opaque) responses.
    return html`<img class="thumb" src=${p.imageUrl} alt="" width=${size} height=${size} loading="lazy" crossorigin="anonymous"
      referrerpolicy="no-referrer" onError=${() => setBroken(true)} style=${`width:${size}px;height:${size}px`} />`;
  }
  return html`<div class="thumb letter" style=${`--h:${hue(p.name)};width:${size}px;height:${size}px`}>
    ${(p.name || '?').trim().charAt(0).toUpperCase()}</div>`;
}

export function Header({ title, sub, back = false, actions = null }) {
  return html`
    <header class="bar">
      ${back && html`<button class="icon-btn" onClick=${() => goBack(typeof back === 'string' ? back : '#/')} aria-label="Back"><${Icon} name="back" /></button>`}
      <div class="bar-title">
        <h1>${title}</h1>
        ${sub && html`<p>${sub}</p>`}
      </div>
      ${actions}
    </header>`;
}

export function Stepper({ value, onChange, min = 0, step = 1, label = 'Quantity' }) {
  const set = v => onChange(Math.max(min, Math.round(v * 100) / 100));
  return html`
    <div class="stepper">
      <button type="button" class="step" onClick=${() => set(value - step)} disabled=${value <= min} aria-label="Fewer">
        <${Icon} name="minus" />
      </button>
      <input type="text" inputmode="decimal" value=${fmtInput(value)} aria-label=${label}
        onFocus=${e => e.target.select()}
        onInput=${e => {
          const v = parseNum(e.target.value);
          if (Number.isFinite(v)) set(v);
        }}
        onBlur=${e => {
          if (!Number.isFinite(parseNum(e.target.value))) e.target.value = fmtInput(value);
        }} />
      <button type="button" class="step" onClick=${() => set(value + step)} aria-label="More"><${Icon} name="plus" /></button>
    </div>`;
}

function addMonths(t, n) {
  const d = new Date(t);
  d.setMonth(d.getMonth() + n);
  return d.getTime();
}

export function ExpiryPicker({ value, onChange, product = null, now, note = '' }) {
  const base = startOfDay(now);
  const opts = [];
  if (product && product.shelfLifeDays != null) opts.push(['Like last time', ymd(addDays(base, product.shelfLifeDays))]);
  opts.push(
    ['+1 week', ymd(addDays(base, 7))],
    ['+2 weeks', ymd(addDays(base, 14))],
    ['+1 month', ymd(addMonths(base, 1))],
    ['+3 months', ymd(addMonths(base, 3))],
    ['+6 months', ymd(addMonths(base, 6))],
    ['+1 year', ymd(addMonths(base, 12))],
  );
  return html`
    <div class="field">
      <label>Expiry date</label>
      <div class="chips">
        ${opts.map(([label, v]) => html`
          <button type="button" class=${`chip-btn${value === v ? ' on' : ''}`} onClick=${() => onChange(v)}>${label}</button>`)}
        <button type="button" class=${`chip-btn${!value ? ' on' : ''}`} onClick=${() => onChange(null)}>No date</button>
      </div>
      <input class="input" type="date" value=${value || ''} onInput=${e => onChange(e.target.value || null)} />
      ${value && html`<div class="hint">${expiryText(value, now)}${note ? ` · ${note}` : ''}</div>`}
    </div>`;
}

/** Location picker. `within` (a site id) limits it to that site's places. */
export function LocationSelect({ id, value, onChange, locations, within = null, none = '— No location —' }) {
  const single = sitesOf(locations).length < 2;
  const tree = locationTree(locations).filter(t => !within || siteOf(locations, t.loc.id) === within);
  return html`
    <select id=${id} class="input" value=${value || ''} onChange=${e => onChange(e.target.value || null)}>
      ${!within && html`<option value="">${none}</option>`}
      ${tree.map(t => html`<option value=${t.loc.id}>${single || within ? stripSite(t.path) : t.path}</option>`)}
    </select>`;
}

const stripSite = path => (path.includes(' › ') ? path.slice(path.indexOf(' › ') + 3) : path);

// ---------- sites ----------

/** Sites (top-level locations) and the one being shown: { sites, multi, siteId, site, settings }. */
export function siteContext(state) {
  const sites = sitesOf(state.locations);
  const multi = sites.length >= 2;
  const site = multi ? sites.find(x => x.id === state.meta.siteId) || null : null;
  return { sites, multi, siteId: site ? site.id : null, site, settings: siteSettings(state.settings, site) };
}

/** "All sites | Site A | Site B | …" — only shown when there are at least two sites. */
export function SiteBar() {
  const { state } = useApp();
  const { sites, multi, siteId } = siteContext(state);
  if (!multi) return null;
  const chip = (id, label) => html`
    <button class=${`chip-btn${siteId === id ? ' on' : ''}`} aria-pressed=${siteId === id} onClick=${() => setCurrentSite(id)}>${label}</button>`;
  return html`<div class="site-bar" role="group" aria-label="Site">${chip(null, 'All sites')}${sites.map(x => chip(x.id, x.name))}</div>`;
}

export function CategorySelect({ id, value, onChange, categories }) {
  const sorted = [...categories].sort((a, b) => a.order - b.order);
  return html`
    <select id=${id} class="input" value=${value || ''} onChange=${e => onChange(e.target.value || null)}>
      <option value="">— No category —</option>
      ${sorted.map(c => html`<option value=${c.id}>${c.name}</option>`)}
    </select>`;
}

export function Empty({ icon = 'box', title, children }) {
  return html`
    <div class="empty">
      <div class="empty-icon"><${Icon} name=${icon} size=${28} /></div>
      <h3>${title}</h3>
      ${children && html`<p>${children}</p>`}
    </div>`;
}

/** Status chips for a product (expired / expiring / low / out). */
export function StatusChips({ i, now }) {
  const chips = [];
  if (i.expired) chips.push(html`<span class="chip danger">expired</span>`);
  else if (i.soon && i.nextExpiry) chips.push(html`<span class="chip warn">${expiryShort(i.nextExpiry, now)}</span>`);
  if (i.out) chips.push(html`<span class="chip muted">${i.est.recorded >= 0.5 ? 'check' : 'out'}</span>`);
  else if (i.low) chips.push(html`<span class="chip warn">low</span>`);
  if (i.product.orderedAt) chips.push(html`<span class="chip info">ordered</span>`);
  return chips.length ? html`<span class="chips-inline">${chips}</span>` : null;
}

export function ProductRow({ i, now, qty = null, onClick, sub = null }) {
  const p = i.product;
  const amount = qty == null ? i.est.total : qty;
  const meta = sub != null ? sub : [p.brand, p.size].filter(Boolean).join(' · ');
  return html`
    <button class=${`row${i.out && qty == null ? ' dim' : ''}`} onClick=${onClick}>
      <${Thumb} p=${p} />
      <span class="row-main">
        <span class="row-title">${p.name}</span>
        ${meta && html`<span class="row-sub">${meta}</span>`}
      </span>
      <span class="row-end">
        <span class="qty">${qtyText(amount, p.unit, i.est.rate > 0)}</span>
        <${StatusChips} i=${i} now=${now} />
      </span>
    </button>`;
}

/** Where something is. With a single site the site name is left out ("Kitchen › Fridge"). */
export function placeText(state, locationId) {
  const path = locationPath(state.locations, locationId);
  if (!path) return 'No location';
  return sitesOf(state.locations).length < 2 ? stripSite(path) : path;
}

export function siteName(state, siteId) {
  const site = siteId && state.locations.find(l => l.id === siteId);
  return site ? site.name : 'No site';
}
