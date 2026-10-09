// App state: one plain object, persisted to IndexedDB, changed only through the actions below.

import * as db from './db.js';
import { codeKey } from './codes.js';
import {
  defaultSettings, estimate, fifo, rateSuggestion, descendants, parseYmd, startOfDay, DAY, productSettings, siteOf,
  PRESENT,
} from './model.js';

const subs = new Set();
let state = null;
let undoState = null;
let saving = null;
let dirty = false;
let persistFn = db.save;

export const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
export const getState = () => state;
export function subscribe(fn) {
  subs.add(fn);
  return () => subs.delete(fn);
}

export function initialState(now) {
  const main = uid();
  const kitchen = uid();
  return {
    version: 1,
    settings: defaultSettings(),
    // Top-level locations are sites; add more (another building, a flat…) to track each one separately.
    locations: [
      { id: main, name: 'Main site', parentId: null, order: 0 },
      { id: kitchen, name: 'Kitchen', parentId: main, order: 0 },
      { id: uid(), name: 'Fridge', parentId: kitchen, order: 0 },
      { id: uid(), name: 'Cupboards', parentId: kitchen, order: 1 },
      { id: uid(), name: 'Storage room', parentId: main, order: 1 },
    ],
    categories: ['Drinks', 'Coffee & tea', 'Snacks', 'Fridge & dairy', 'Fruit', 'Cleaning', 'Paper & disposables', 'Other']
      .map((name, order) => ({ id: uid(), name, order })),
    products: [],
    batches: [],
    events: [],
    shopping: [],
    meta: { createdAt: now, lastBackupAt: null, siteId: null },
  };
}

export function newProduct(now) {
  return {
    id: '', name: '', brand: '', size: '', imageUrl: '', categoryId: null, unit: 'pcs', barcodes: [],
    rate: null, minStock: 0, orderQty: null, reorder: true, locationId: null, shelfLifeDays: null, notes: '',
    noExpiry: false, // has no expiry date: the scanner doesn't ask for one
    createdAt: now, anchorAt: now, countedAt: now, countedQty: 0, addedAt: null, touchedAt: now,
    snoozeUntil: null, orderedAt: null, rateHintAt: null,
  };
}

/** Fill in anything missing (older backups, partial imports). Throws if it isn't pantry data at all. */
export function migrate(s) {
  if (!s || typeof s !== 'object' || !Array.isArray(s.products) || !Array.isArray(s.batches)) {
    throw new Error('This file is not a Pantri backup.');
  }
  const now = Date.now();
  return {
    version: 1,
    // Data from before opening hours were optional always used them: keep that behaviour.
    settings: { ...defaultSettings(), ...(s.settings && s.settings.hoursOn === undefined ? { hoursOn: true } : {}), ...(s.settings || {}) },
    locations: s.locations || [],
    categories: s.categories || [],
    products: s.products.map(p => ({ ...newProduct(now), ...p })),
    batches: s.batches,
    events: s.events || [],
    shopping: s.shopping || [],
    meta: { createdAt: now, lastBackupAt: null, ...(s.meta || {}) },
  };
}

// ---------- persistence ----------

// The installed app and a browser tab share storage: tell each other about saves.
// (Opened in initStore, i.e. only in the app — an open channel would keep a test process alive.)
let channel = null;
const rev = () => (state && state.meta && state.meta.rev) || 0;

export async function initStore() {
  let loaded = null;
  try {
    loaded = await db.load();
  } catch (e) {
    console.error('Could not load saved data', e);
  }
  state = loaded ? migrate(loaded) : initialState(Date.now());
  if (!loaded) schedule();
  addEventListener('pagehide', flush);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flush();
    else syncFromDisk();
  });
  if (typeof BroadcastChannel === 'function') {
    channel = new BroadcastChannel('pantri');
    channel.onmessage = e => e.data && e.data.rev > rev() && syncFromDisk();
  }
}

/** Another window saved newer data: take it instead of later overwriting it with our stale copy. */
async function syncFromDisk() {
  if (saving) return;
  let loaded = null;
  try {
    loaded = await db.load();
  } catch {
    return;
  }
  if (loaded && ((loaded.meta && loaded.meta.rev) || 0) > rev()) {
    state = migrate(loaded);
    undoState = null;
    for (const f of subs) f();
  }
}

/** For tests: start from a given state and choose where saves go. */
export function resetStore(s, persist = () => {}) {
  state = s;
  undoState = null;
  persistFn = persist;
}

let persistAsked = false;
/** Ask once (on first real data) that the browser keeps our storage even under pressure. */
export function requestPersistenceOnce() {
  if (persistAsked) return;
  persistAsked = true;
  db.requestPersistence();
}

/** Save right away (the IndexedDB write starts in the same task as the change); bursts coalesce. */
function schedule() {
  dirty = true;
  saving ||= (async () => {
    while (dirty) {
      dirty = false;
      try {
        await persistFn(state);
        if (channel) channel.postMessage({ rev: rev() });
      } catch (e) {
        console.error('Saving failed', e);
        if (typeof dispatchEvent === 'function') dispatchEvent(new CustomEvent('pantri:save-failed', { detail: e }));
      }
    }
    saving = null;
  })();
}
/** Resolves once everything changed so far is written. */
export function flush() {
  return saving || Promise.resolve();
}

function set(next) {
  next.meta = { ...next.meta, rev: rev() + 1 };
  state = next;
  for (const f of subs) f();
  schedule();
}

/**
 * Apply a change to a copy of the state. With `undo`, the previous state can be restored by undo();
 * `keepUndo` leaves an earlier undo available (for view-only changes like the chosen site).
 */
export function mutate(fn, { undo = false, keepUndo = false } = {}) {
  const draft = structuredClone(state);
  const result = fn(draft, Date.now());
  if (!keepUndo) undoState = undo ? state : null;
  set(draft);
  return result;
}

export function canUndo() {
  return !!undoState;
}
export function undo() {
  if (!undoState) return false;
  const prev = undoState;
  undoState = null;
  set(prev);
  return true;
}

// ---------- helpers on a draft ----------

const productOf = (d, id) => d.products.find(p => p.id === id);
const batchesOf = (d, id) => d.batches.filter(b => b.productId === id);
const log = (d, e) => d.events.push({ id: uid(), ...e });
const shelfLife = (expiry, now) => Math.max(0, Math.round((parseYmd(expiry) - startOfDay(now)) / DAY));

/**
 * Bake estimated usage into the recorded batch quantities, so later changes start from "now".
 * With `keepPending`, a product the estimate says is used up — but nobody confirmed — is left alone,
 * so its "is it gone?" check stays for a person to answer.
 */
function materialize(d, p, now, { keepPending = false } = {}) {
  const est = estimate(p, batchesOf(d, p.id), productSettings(d, p), now);
  if (keepPending && est.rate > 0 && est.total < PRESENT && est.recorded >= PRESENT) return;
  if (est.rate > 0) {
    for (const { batch, qty } of est.per) batch.qty = qty;
    d.batches = d.batches.filter(b => b.productId !== p.id || b.qty > 1e-6);
  }
  p.anchorAt = now;
}

const scheduleKey = s => JSON.stringify([s.hoursOn, s.workdays, s.dayStart, s.dayEnd, s.closed]);

/**
 * Apply a change that may alter products' opening hours (settings, site hours, moving locations).
 * Estimates of the affected products are settled first, so new hours apply from now on.
 */
function changeSchedules(d, now, apply) {
  const before = new Map(d.products.map(p => [p.id, scheduleKey(productSettings(d, p))]));
  const trial = structuredClone(d);
  apply(trial);
  for (const p of d.products) {
    const after = trial.products.find(x => x.id === p.id);
    if (!after || scheduleKey(productSettings(trial, after)) !== before.get(p.id)) materialize(d, p, now, { keepPending: true });
  }
  apply(d);
}

// ---------- products ----------

/** Create a product; `initial` = { qty, expiry, locationId } is the stock on the shelf right now. */
export function createProduct(data, initial) {
  return mutate((d, now) => {
    const p = { ...newProduct(now), ...data, id: uid() };
    d.products.push(p);
    const qty = initial && initial.qty > 0 ? initial.qty : 0;
    if (qty) {
      const loc = initial.locationId !== undefined ? initial.locationId : p.locationId;
      d.batches.push({ id: uid(), productId: p.id, locationId: loc || null, qty, expiry: initial.expiry || null, addedAt: now });
      log(d, { type: 'add', productId: p.id, qty, expiry: initial.expiry || null, at: now, initial: true });
      if (initial.expiry) p.shelfLifeDays = shelfLife(initial.expiry, now);
    }
    log(d, { type: 'count', productId: p.id, qty, at: now, initial: true });
    p.countedQty = qty;
    return p.id;
  });
}

export function updateProduct(id, patch) {
  mutate((d, now) => {
    const p = productOf(d, id);
    if (!p) return;
    const rateChanged = 'rate' in patch && JSON.stringify(patch.rate || null) !== JSON.stringify(p.rate || null);
    const siteChanged = 'locationId' in patch && siteOf(d.locations, patch.locationId) !== siteOf(d.locations, p.locationId);
    // A new rate or site hours apply from now on, not retroactively.
    if (rateChanged || siteChanged) materialize(d, p, now, { keepPending: true });
    Object.assign(p, patch);
  });
}

export function deleteProduct(id) {
  mutate(d => {
    d.products = d.products.filter(p => p.id !== id);
    d.batches = d.batches.filter(b => b.productId !== id);
    d.events = d.events.filter(e => e.productId !== id || e.type === 'waste'); // keep the waste history
  }, { undo: true });
}

export function addBarcode(id, code, units = 1) {
  mutate(d => {
    const p = productOf(d, id);
    if (!p) return;
    const k = codeKey(code);
    const existing = p.barcodes.find(b => codeKey(b.code) === k);
    if (existing) existing.units = units;
    else p.barcodes.push({ code: String(code).trim(), units });
  });
}

// ---------- stock ----------

export function addStock(id, { qty, expiry = null, locationId }) {
  mutate((d, now) => {
    const p = productOf(d, id);
    if (!p || !(qty > 0)) return;
    materialize(d, p, now);
    const loc = (locationId !== undefined ? locationId : p.locationId) || null;
    const same = d.batches.find(b =>
      b.productId === id && (b.expiry || null) === (expiry || null) && (b.locationId || null) === loc);
    if (same) same.qty += qty;
    else d.batches.push({ id: uid(), productId: id, locationId: loc, qty, expiry: expiry || null, addedAt: now });
    log(d, { type: 'add', productId: id, qty, expiry: expiry || null, at: now });
    Object.assign(p, { addedAt: now, touchedAt: now, orderedAt: null, snoozeUntil: null });
    if (loc) p.locationId = loc;
    if (expiry) p.shelfLifeDays = shelfLife(expiry, now);
  }, { undo: true });
}

/**
 * Someone counted what's actually there. Remaining units are assumed to be the latest-expiring ones
 * (older stock gets used first). Returns a usage-rate suggestion if the count reveals a different pace.
 */
export function count(id, qty) {
  return mutate((d, now) => {
    const p = productOf(d, id);
    if (!p) return null;
    const bs = fifo(batchesOf(d, id));
    const estimated = estimate(p, bs, productSettings(d, p), now).total;
    if (qty > estimated + 0.5) p.orderedAt = null; // more than expected: the order has arrived
    let left = qty;
    for (let k = bs.length - 1; k >= 0; k--) {
      const keep = Math.min(Math.ceil(bs[k].qty - 1e-9), left);
      bs[k].qty = keep;
      left -= keep;
    }
    if (left > 0) {
      const newest = bs.reduce((a, b) => (!a || b.addedAt > a.addedAt ? b : a), null);
      if (newest) newest.qty += left;
      else d.batches.push({ id: uid(), productId: id, locationId: p.locationId || null, qty: left, expiry: null, addedAt: now });
    }
    d.batches = d.batches.filter(b => b.productId !== id || b.qty > 0);
    log(d, { type: 'count', productId: id, qty, at: now });
    Object.assign(p, { anchorAt: now, countedAt: now, countedQty: qty, touchedAt: now, snoozeUntil: null });
    return rateSuggestion(p, d.events, productSettings(d, p));
  }, { undo: true });
}

/** Took some out by hand (for products without a usage rate). */
export function useStock(id, qty) {
  mutate((d, now) => {
    const p = productOf(d, id);
    if (!p || !(qty > 0)) return;
    materialize(d, p, now);
    let left = qty;
    for (const b of fifo(batchesOf(d, id))) {
      const t = Math.min(b.qty, left);
      b.qty -= t;
      left -= t;
    }
    d.batches = d.batches.filter(b => b.productId !== id || b.qty > 1e-6);
    log(d, { type: 'used', productId: id, qty, at: now });
    p.touchedAt = now;
  }, { undo: true });
}

/** Threw some of a batch away. Logged for the waste report. */
export function wasteBatch(batchId, qty, reason = 'expired') {
  mutate((d, now) => {
    const original = d.batches.find(b => b.id === batchId);
    if (!original || !(qty > 0)) return;
    const p = productOf(d, original.productId);
    materialize(d, p, now);
    const b = d.batches.find(x => x.id === batchId);
    if (b) {
      b.qty -= qty;
      if (b.qty <= 1e-6) d.batches = d.batches.filter(x => x !== b);
    }
    log(d, { type: 'waste', productId: p.id, qty, reason, expiry: original.expiry, name: p.name, unit: p.unit, at: now });
    p.touchedAt = now;
  }, { undo: true });
}

/** A batch turned out to be all used up (e.g. an "expired" item that was actually eaten). */
export function useUpBatch(batchId) {
  mutate((d, now) => {
    const original = d.batches.find(b => b.id === batchId);
    if (!original) return;
    const p = productOf(d, original.productId);
    materialize(d, p, now);
    const b = d.batches.find(x => x.id === batchId);
    if (b) {
      d.batches = d.batches.filter(x => x !== b);
      log(d, { type: 'used', productId: p.id, qty: b.qty, at: now });
    }
    p.touchedAt = now;
  }, { undo: true });
}

export function editBatch(batchId, patch) {
  mutate((d, now) => {
    const original = d.batches.find(b => b.id === batchId);
    if (!original) return;
    const p = productOf(d, original.productId);
    materialize(d, p, now);
    let b = d.batches.find(x => x.id === batchId);
    if (!b) {
      b = { ...original, qty: 0 };
      d.batches.push(b);
    }
    if ('qty' in patch && patch.qty !== b.qty) {
      log(d, { type: 'adjust', productId: p.id, qty: patch.qty - b.qty, at: now });
    }
    Object.assign(b, patch);
    if (!(b.qty > 0)) d.batches = d.batches.filter(x => x !== b);
    p.touchedAt = now;
  }, { undo: true });
}

export function snooze(id, until) {
  mutate(d => {
    const p = productOf(d, id);
    if (p) p.snoozeUntil = until;
  });
}

export function setOrdered(id, on) {
  mutate((d, now) => {
    const p = productOf(d, id);
    if (p) p.orderedAt = on ? now : null;
  });
}

export function setReorder(id, on) {
  mutate(d => {
    const p = productOf(d, id);
    if (p) p.reorder = on;
  }, { undo: true });
}

export function applyRate(id, rate) {
  mutate((d, now) => {
    const p = productOf(d, id);
    if (!p) return;
    materialize(d, p, now);
    p.rate = rate;
    p.rateHintAt = p.countedAt;
  });
}

export function dismissRateHint(id) {
  mutate(d => {
    const p = productOf(d, id);
    if (p) p.rateHintAt = p.countedAt;
  });
}

// ---------- locations & categories ----------

const nextOrder = list => list.reduce((m, x) => Math.max(m, x.order), -1) + 1;

export function addLocation(name, parentId = null) {
  return mutate(d => {
    const id = uid();
    d.locations.push({ id, name, parentId, order: nextOrder(d.locations.filter(l => l.parentId === parentId)) });
    return id;
  });
}

export function renameLocation(id, name) {
  mutate(d => {
    const l = d.locations.find(x => x.id === id);
    if (l) l.name = name;
  });
}

export function moveLocation(id, parentId) {
  mutate((d, now) => {
    const l = d.locations.find(x => x.id === id);
    if (!l || id === parentId || descendants(d.locations, id).has(parentId)) return;
    changeSchedules(d, now, x => {
      const moved = x.locations.find(y => y.id === id);
      moved.parentId = parentId;
      moved.order = nextOrder(x.locations.filter(y => y.parentId === parentId && y.id !== id));
    });
  });
}

export function shiftLocation(id, dir) {
  mutate(d => {
    const l = d.locations.find(x => x.id === id);
    if (!l) return;
    const sibs = d.locations.filter(x => x.parentId === l.parentId).sort((a, b) => a.order - b.order);
    const k = sibs.indexOf(l);
    if (!sibs[k + dir]) return;
    [sibs[k], sibs[k + dir]] = [sibs[k + dir], sibs[k]];
    sibs.forEach((x, i) => (x.order = i));
  });
}

/** Delete a location; its sub-locations, stock and products move up to its parent. */
export function deleteLocation(id) {
  mutate((d, now) => {
    const l = d.locations.find(x => x.id === id);
    if (!l) return;
    const parent = l.parentId || null;
    changeSchedules(d, now, x => {
      for (const y of x.locations) if (y.parentId === id) y.parentId = parent;
      for (const b of x.batches) if (b.locationId === id) b.locationId = parent;
      for (const p of x.products) if (p.locationId === id) p.locationId = parent;
      x.locations = x.locations.filter(y => y.id !== id);
    });
  }, { undo: true });
}

/** A site's own opening days/hours for usage estimates (null = same as Settings). */
export function setSiteSchedule(siteId, schedule) {
  mutate((d, now) => {
    if (!d.locations.some(l => l.id === siteId && !l.parentId)) return;
    changeSchedules(d, now, x => {
      const site = x.locations.find(l => l.id === siteId);
      if (schedule) site.schedule = schedule;
      else delete site.schedule;
    });
  });
}

/** Which site the app is showing (null = all sites). */
export function setCurrentSite(siteId) {
  mutate(d => {
    d.meta.siteId = siteId || null;
  }, { keepUndo: true });
}

/** Start tracking a product at another site: a copy with its own stock, usage and reorder settings. */
export function copyProductToSite(id, locationId) {
  const src = getState().products.find(p => p.id === id);
  if (!src) return null;
  const keep = ['name', 'brand', 'size', 'imageUrl', 'categoryId', 'unit', 'rate', 'minStock', 'orderQty', 'reorder', 'notes', 'noExpiry', 'nutrition'];
  const data = Object.fromEntries(keep.filter(k => src[k] !== undefined).map(k => [k, structuredClone(src[k])]));
  return createProduct({ ...data, barcodes: src.barcodes.map(b => ({ ...b })), locationId }, { qty: 0 });
}

export function addCategory(name) {
  return mutate(d => {
    const id = uid();
    d.categories.push({ id, name, order: nextOrder(d.categories) });
    return id;
  });
}

export function renameCategory(id, name) {
  mutate(d => {
    const c = d.categories.find(x => x.id === id);
    if (c) c.name = name;
  });
}

export function deleteCategory(id) {
  mutate(d => {
    d.categories = d.categories.filter(c => c.id !== id);
    for (const p of d.products) if (p.categoryId === id) p.categoryId = null;
  }, { undo: true });
}

// ---------- shopping (manual reorder items) ----------

export function addShopping(text) {
  mutate((d, now) => {
    d.shopping.push({ id: uid(), text, done: false, at: now });
  });
}
export function toggleShopping(id) {
  mutate(d => {
    const x = d.shopping.find(s => s.id === id);
    if (x) x.done = !x.done;
  });
}
export function removeShopping(id) {
  mutate(d => {
    d.shopping = d.shopping.filter(s => s.id !== id);
  }, { undo: true });
}
export function clearDoneShopping() {
  mutate(d => {
    d.shopping = d.shopping.filter(s => !s.done);
  }, { undo: true });
}

// ---------- settings & data ----------

const TIMING = ['hoursOn', 'workdays', 'dayStart', 'dayEnd', 'closed'];

export function updateSettings(patch) {
  mutate((d, now) => {
    const timing = TIMING.some(k => k in patch && JSON.stringify(patch[k]) !== JSON.stringify(d.settings[k]));
    if (timing) changeSchedules(d, now, x => Object.assign(x.settings, patch)); // new hours apply from now on
    else Object.assign(d.settings, patch);
  });
}

export function deleteWasteEvent(eventId) {
  mutate(d => {
    d.events = d.events.filter(e => e.id !== eventId);
  }, { undo: true });
}

export function exportJson() {
  return JSON.stringify({ app: 'pantri', exportedAt: new Date().toISOString(), state }, null, 1);
}

export function importJson(text) {
  const parsed = JSON.parse(text);
  const next = migrate(parsed && parsed.state ? parsed.state : parsed);
  undoState = state;
  set(next);
}

/**
 * Take a whole state from elsewhere (the online copy): completed like a backup, saved on this phone and
 * announced to subscribers like any change, but without an undo step. Returns the state now in use.
 */
export function replaceState(next) {
  const s = migrate(next);
  undoState = null;
  set(s);
  return state;
}

export function markBackedUp() {
  mutate((d, now) => {
    d.meta.lastBackupAt = now;
  });
}

export function eraseAll() {
  undoState = state;
  set(initialState(Date.now()));
}
