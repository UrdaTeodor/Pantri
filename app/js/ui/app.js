// App shell: picks the screen for the route, renders the bottom nav, sheets and toasts.

import { html, useState, useEffect, useMemo, useReducer } from './lib.js';
import {
  useNav, currentRoute, currentSheets, currentToast, closeSheet, hideToast, goTab, navigate, TABS,
} from './nav.js';
import { AppCtx, Icon, useApp } from './kit.js';
import { Today } from './today.js';
import { Pantry } from './pantry.js';
import { ProductPage } from './product.js';
import { ProductFormPage } from './product-form.js';
import { ScanScreen } from './scan.js';
import { Reorder } from './reorder.js';
import { More, Settings, Locations, Categories, Waste, Backup, Help } from './more.js';
import { getState, subscribe } from '../store.js';
import { analyze, todayLists, reorderList } from '../model.js';

const SCREENS = {
  today: Today, pantry: Pantry, product: ProductPage, new: ProductFormPage, edit: ProductFormPage,
  scan: ScanScreen, reorder: Reorder, more: More, settings: Settings, locations: Locations,
  categories: Categories, waste: Waste, backup: Backup, help: Help,
};
const TAB_OF = { product: 'pantry', new: 'pantry', edit: 'pantry', settings: 'more', locations: 'more', categories: 'more', waste: 'more', backup: 'more', help: 'more' };

function useStoreState() {
  const [, force] = useReducer(x => x + 1, 0);
  useEffect(() => subscribe(force), []);
  return getState();
}

/** Ticks every minute and when the app comes back to the foreground, so estimates stay current. */
function useTick() {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const bump = () => setTick(t => t + 1);
    const timer = setInterval(bump, 60000);
    const vis = () => document.visibilityState === 'visible' && bump();
    document.addEventListener('visibilitychange', vis);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', vis);
    };
  }, []);
  return tick;
}

function Nav({ active }) {
  const { state, info, now } = useApp();
  const badges = useMemo(() => {
    const t = todayLists(info, state.settings, now);
    const r = reorderList(info, state.settings, now);
    return { today: t.checks.length + t.expired.length, reorder: r.need.length + state.shopping.filter(s => !s.done).length };
  }, [info, now]);
  const item = (name, label, icon) => html`
    <a href=${`#/${name === 'today' ? '' : name}`} class=${`nav-item${active === name ? ' active' : ''}`}
      aria-current=${active === name ? 'page' : null}
      onClick=${e => {
        e.preventDefault();
        if (active !== name || currentRoute().name !== name) goTab(name);
      }}>
      <span class="nav-icon"><${Icon} name=${icon} />${badges[name] ? html`<span class="badge">${badges[name]}</span>` : null}</span>
      <span>${label}</span>
    </a>`;
  return html`
    <nav class="nav" aria-label="Main">
      ${item('today', 'Today', 'home')}
      ${item('pantry', 'Pantry', 'box')}
      <button class="nav-scan" aria-label="Scan a barcode" onClick=${() => navigate('#/scan')}><${Icon} name="scan" size=${28} /></button>
      ${item('reorder', 'Reorder', 'cart')}
      ${item('more', 'More', 'menu')}
    </nav>`;
}

function SheetHost() {
  const sheets = currentSheets();
  if (!sheets.length) return null;
  return html`${sheets.map((s, k) => html`
    <div class="sheet-layer" key=${s.id}>
      <div class="backdrop" onClick=${() => k === sheets.length - 1 && closeSheet()}></div>
      <div class=${`sheet${s.full ? ' full' : ''}`} role="dialog" aria-modal="true">
        ${!s.full && html`<div class="handle" aria-hidden="true"></div>`}
        ${s.render(closeSheet)}
      </div>
    </div>`)}`;
}

function ToastHost() {
  const t = currentToast();
  if (!t) return null;
  return html`
    <div class="toast" role="status" key=${t.id}>
      <span>${t.text}</span>
      ${t.action && html`<button onClick=${() => { hideToast(); t.action.fn(); }}>${t.action.label}</button>`}
    </div>`;
}

export function App() {
  useNav();
  const state = useStoreState();
  const tick = useTick();
  const now = useMemo(() => Date.now(), [state, tick]);
  const info = useMemo(() => analyze(state, now), [state, now]);
  const ctx = useMemo(() => ({ state, info, now }), [state, info, now]);
  const route = currentRoute();
  const Screen = SCREENS[route.name] || Today;
  const scanning = route.name === 'scan';
  const active = TABS.includes(route.name) ? route.name : TAB_OF[route.name] || 'today';
  return html`
    <${AppCtx.Provider} value=${ctx}>
      <div class=${`app${scanning ? ' scanning' : ''}`}>
        <${Screen} route=${route} key=${route.name === 'product' || route.name === 'edit' ? route.parts.join('/') : route.name} />
      </div>
      ${!scanning && html`<${Nav} active=${active} />`}
      <${SheetHost} />
      <${ToastHost} />
    </${AppCtx.Provider}>`;
}
