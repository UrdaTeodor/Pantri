// Hash routing, bottom sheets and toasts.
// Sheets push a history entry, so the phone's back gesture closes the sheet instead of leaving the page.

import { html, useReducer, useEffect } from './lib.js';

const listeners = new Set();
const notify = () => listeners.forEach(f => f());

/** Re-render the calling component whenever the route, sheets or toast change. */
export function useNav() {
  const [, force] = useReducer(x => x + 1, 0);
  useEffect(() => {
    listeners.add(force);
    return () => listeners.delete(force);
  }, []);
}

// ---------- routes ----------

export const TABS = ['today', 'pantry', 'reorder', 'more'];

export function parseRoute(hash = location.hash) {
  const [path, qs] = hash.replace(/^#\/?/, '').split('?');
  const parts = path.split('/').filter(Boolean).map(decodeURIComponent);
  return { name: parts[0] || 'today', parts, query: new URLSearchParams(qs || '') };
}

let route = parseRoute();
let pendingHome = false;
const backWaiters = [];
const depth = () => (history.state && history.state.depth) || 0;

export const currentRoute = () => route;

export function navigate(to, { replace = false } = {}) {
  if (replace) history.replaceState({ depth: depth() }, '', to);
  else history.pushState({ depth: depth() + 1 }, '', to);
  route = parseRoute();
  notify();
  scrollTo(0, 0);
}

export function goBack(fallback = '#/') {
  if (depth() > 0) history.back();
  else navigate(fallback, { replace: true });
}

/** Switch bottom-nav tab without piling up history: Today → tab pushes, tab → tab replaces. */
export function goTab(name) {
  if (name === 'today') {
    if (depth() > 0) {
      pendingHome = true;
      history.go(-depth());
    } else navigate('#/', { replace: true });
    return;
  }
  navigate(`#/${name}`, { replace: TABS.includes(route.name) && route.name !== 'today' });
}

// ---------- sheets ----------

let sheets = [];
let seq = 0;
export const currentSheets = () => sheets;

/** Show a bottom sheet. `render(close)` returns its content; close(result) resolves the returned promise. */
export function ask(render, { full = false } = {}) {
  return new Promise(resolve => {
    const id = ++seq;
    sheets = [...sheets, { id, render, full, resolve, result: undefined, closing: false }];
    history.pushState({ depth: depth() + 1, sheet: id }, '', location.hash || '#/');
    notify();
  });
}

/** Close the top sheet with a result. Resolves once the history entry is gone. */
export function closeSheet(result) {
  return new Promise(resolve => {
    const top = sheets[sheets.length - 1];
    if (!top) return resolve();
    backWaiters.push(resolve);
    if (top.closing) return;
    top.closing = true;
    top.result = result;
    history.back();
  });
}

addEventListener('popstate', e => {
  const sheetId = (e.state && e.state.sheet) || 0;
  const closed = [];
  while (sheets.length && sheets[sheets.length - 1].id > sheetId) closed.push(sheets[sheets.length - 1]), (sheets = sheets.slice(0, -1));
  route = parseRoute();
  if (pendingHome) {
    pendingHome = false;
    if (route.name !== 'today') navigate('#/', { replace: true });
  }
  notify();
  for (const s of closed) s.resolve(s.result);
  backWaiters.splice(0).forEach(r => r());
});

if (!history.state) history.replaceState({ depth: 0 }, '', location.href);

// ---------- toasts ----------

let toast = null;
let toastTimer = null;
export const currentToast = () => toast;

export function showToast(text, { action = null, timeout = 4000 } = {}) {
  toast = { id: ++seq, text, action };
  notify();
  clearTimeout(toastTimer);
  if (timeout) toastTimer = setTimeout(hideToast, timeout);
}
export function hideToast() {
  toast = null;
  notify();
}

// ---------- common dialogs ----------

export function confirmSheet({ title, body = '', ok = 'OK', danger = false }) {
  return ask(close => html`
    <div class="sheet-pad">
      <h2>${title}</h2>
      ${body && html`<p class="muted">${body}</p>`}
      <div class="btn-row">
        <button class="btn" onClick=${() => close(false)}>Cancel</button>
        <button class=${`btn ${danger ? 'danger' : 'primary'}`} onClick=${() => close(true)}>${ok}</button>
      </div>
    </div>`).then(Boolean);
}

export function promptSheet({ title, value = '', placeholder = '', ok = 'Save', inputmode = 'text' }) {
  return ask(close => {
    const submit = e => {
      e.preventDefault();
      const v = e.target.elements.v.value.trim();
      close(v || null);
    };
    return html`
      <form class="sheet-pad" onSubmit=${submit}>
        <h2>${title}</h2>
        <input name="v" class="input" value=${value} placeholder=${placeholder} inputmode=${inputmode} autofocus />
        <div class="btn-row">
          <button type="button" class="btn" onClick=${() => close(null)}>Cancel</button>
          <button class="btn primary">${ok}</button>
        </div>
      </form>`;
  });
}

/** Pick one of `options` ([{ label, sub?, value, danger? }]). Resolves to the value or undefined. */
export function pickSheet({ title, options }) {
  return ask(close => html`
    <div class="sheet-pad">
      ${title && html`<h2>${title}</h2>`}
      <div class="menu">
        ${options.map(o => html`
          <button class=${`menu-item${o.danger ? ' danger' : ''}`} onClick=${() => close(o.value)}>
            <span>${o.label}</span>${o.sub && html`<small>${o.sub}</small>`}
          </button>`)}
      </div>
    </div>`);
}
