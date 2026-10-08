// Pure pantry logic — no DOM, no storage. Every function takes `now` (ms) so it can be tested.
//
// Stock model: a product has batches (qty + expiry + location). Quantities on batches are what was
// recorded at `product.anchorAt`; usage since then is estimated from the product's rate, counted only
// during office hours, and taken from the earliest-expiring batch first (FIFO).

import { codeKey } from './codes.js';

export const DAY = 86400000;
/** An estimate below this counts as "none left". */
export const PRESENT = 0.5;

export function defaultSettings() {
  return {
    workdays: [1, 2, 3, 4, 5], // Date#getDay(): 0 = Sunday
    dayStart: '09:00',
    dayEnd: '18:00',
    closed: [], // office closed: [{ from: 'YYYY-MM-DD', to: 'YYYY-MM-DD', note }]
    warnDays: 7, // "use soon" window before the printed date
    orderEveryDays: 7, // reorder list looks this far ahead
    staleDays: 30, // nudge to re-check items untouched this long (0 = off)
    lookup: true, // look up unknown barcodes online
    scanSound: true,
  };
}

// ---------- dates ----------

const pad = n => String(n).padStart(2, '0');
export function ymd(t) {
  const d = new Date(t);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
export function parseYmd(s) {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, m - 1, d).getTime();
}
export function startOfDay(t) {
  const d = new Date(t);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}
export function addDays(t, n) {
  const d = new Date(t);
  d.setDate(d.getDate() + n);
  return d.getTime();
}
/** Whole calendar days from `now` to `t` (negative when in the past). */
export function daysUntil(t, now) {
  return Math.round((startOfDay(t) - startOfDay(now)) / DAY);
}
/** First moment an item is past its printed date: midnight after that day. */
export function expiresAt(expiry) {
  return addDays(parseYmd(expiry), 1);
}

// ---------- office time ----------

function minutesOf(hm) {
  const [h, m] = String(hm || '').split(':').map(Number);
  return (h || 0) * 60 + (m || 0);
}
function officeHours(s) {
  const a = minutesOf(s.dayStart);
  const b = minutesOf(s.dayEnd);
  return b > a ? [a, b] : [0, 24 * 60];
}
function isOfficeDay(d, s) {
  if (!s.workdays.includes(d.getDay())) return false;
  if (!s.closed || !s.closed.length) return true;
  const key = ymd(d);
  return !(s.closed || []).some(c => c.from <= key && key <= (c.to || c.from));
}
function windowOf(day, [a, b]) {
  const ws = new Date(day);
  ws.setMinutes(a);
  const we = new Date(day);
  we.setMinutes(b);
  return [ws.getTime(), we.getTime()];
}

/** Office days (fractional) elapsed between two instants. A full office day counts as 1. */
export function officeTime(from, to, s) {
  if (!(to > from)) return 0;
  const hours = officeHours(s);
  let total = 0;
  const d = new Date(from);
  d.setHours(0, 0, 0, 0);
  while (d.getTime() < to) {
    if (isOfficeDay(d, s)) {
      const [ws, we] = windowOf(d, hours);
      const lo = Math.max(ws, from);
      const hi = Math.min(we, to);
      if (hi > lo) total += (hi - lo) / (we - ws);
    }
    d.setDate(d.getDate() + 1);
  }
  return total;
}

/** The instant when `days` office days will have elapsed after `from` (Infinity if never). */
export function addOfficeTime(from, days, s) {
  if (!(days > 0)) return from;
  const hours = officeHours(s);
  let left = days;
  const d = new Date(from);
  d.setHours(0, 0, 0, 0);
  for (let i = 0; i < 4000; i++) {
    if (isOfficeDay(d, s)) {
      const [ws, we] = windowOf(d, hours);
      const lo = Math.max(ws, from);
      if (we > lo) {
        const avail = (we - lo) / (we - ws);
        if (left <= avail + 1e-12) return lo + left * (we - ws);
        left -= avail;
      }
    }
    d.setDate(d.getDate() + 1);
  }
  return Infinity;
}

export function isOfficeOpen(now, s) {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  if (!isOfficeDay(d, s)) return false;
  const [ws, we] = windowOf(d, officeHours(s));
  return now >= ws && now < we;
}

// ---------- rates ----------

/** Usage rate ({ qty, per: 'day' | 'week' | 'month' }) as units per office day. 'day' means office day. */
export function ratePerOfficeDay(rate, s) {
  const q = Number(rate && rate.qty);
  if (!(q > 0)) return 0;
  const perWeek = s.workdays.length || 5;
  if (rate.per === 'week') return q / perWeek;
  if (rate.per === 'month') return (q * 12) / (52 * perWeek);
  return q;
}
export function fromPerOfficeDay(r, per, s) {
  const perWeek = s.workdays.length || 5;
  if (per === 'week') return r * perWeek;
  if (per === 'month') return (r * 52 * perWeek) / 12;
  return r;
}
export function roundNice(n) {
  if (n >= 10) return Math.round(n);
  if (n >= 1) return Math.round(n * 10) / 10;
  return Math.round(n * 100) / 100;
}

// ---------- sites ----------
// Top-level locations are sites (e.g. Office, Corp House, Vlad's apt). Each product belongs to the site of
// its usual location; a site may override the office days/hours used for usage estimates.

/** Top-level locations (sites), in display order. */
export function sitesOf(locations) {
  return locations.filter(l => !l.parentId).sort((a, b) => a.order - b.order || a.name.localeCompare(b.name));
}

/** Id of the site (top-level location) that contains location `id`, or null. */
export function siteOf(locations, id) {
  if (!id) return null;
  const byId = locations instanceof Map ? locations : new Map(locations.map(l => [l.id, l]));
  let l = byId.get(id);
  for (let guard = 0; l && l.parentId && guard < 50; guard++) l = byId.get(l.parentId);
  return l ? l.id : null;
}

/** Settings with a site's own schedule applied (days, hours, whether office closures apply). */
export function siteSettings(settings, site) {
  const sch = site && site.schedule;
  if (!sch) return settings;
  return {
    ...settings,
    workdays: sch.workdays && sch.workdays.length ? sch.workdays : settings.workdays,
    dayStart: sch.dayStart || settings.dayStart,
    dayEnd: sch.dayEnd || settings.dayEnd,
    closed: sch.holidays === false ? [] : settings.closed,
  };
}

/** The settings that govern a product's usage estimates (its site's schedule). */
export function productSettings(state, p) {
  const locations = state.locations || [];
  const siteId = siteOf(locations, p.locationId);
  return siteSettings(state.settings, siteId && locations.find(l => l.id === siteId));
}

// ---------- stock estimates ----------

/** Batches in the order they get used: earliest expiry first (no date last), then oldest. */
export function fifo(batches) {
  return [...batches].sort(
    (a, b) => (a.expiry || '~').localeCompare(b.expiry || '~') || a.addedAt - b.addedAt,
  );
}

/** Estimated stock now. `per` lists each batch (FIFO order) with its estimated remaining qty. */
export function estimate(p, batches, s, now) {
  const list = fifo(batches);
  const rate = ratePerOfficeDay(p.rate, s);
  const recorded = list.reduce((t, b) => t + b.qty, 0);
  const consumed = rate > 0 ? rate * officeTime(p.anchorAt, now, s) : 0;
  let left = consumed;
  const per = list.map(batch => {
    const used = Math.min(batch.qty, left);
    left -= used;
    return { batch, qty: batch.qty - used };
  });
  return {
    rate,
    recorded,
    total: Math.max(0, recorded - consumed),
    per,
    runOutAt: rate > 0 && recorded > 0 ? addOfficeTime(p.anchorAt, recorded / rate, s) : null,
  };
}

/** Units of a batch still left when it expires, at the current rate (null if usage isn't tracked). */
export function unusedAtExpiry(p, est, batch, s) {
  if (!(est.rate > 0) || !batch.expiry) return null;
  let ahead = 0;
  for (const r of est.per) {
    if (r.batch === batch) break;
    ahead += r.batch.qty;
  }
  const usedBy = est.rate * officeTime(p.anchorAt, expiresAt(batch.expiry), s);
  return Math.min(batch.qty, Math.max(0, batch.qty - Math.max(0, usedBy - ahead)));
}

/** True when the latest stock event was a count, i.e. the recorded stock was verified by a person. */
export function lastWasCount(p) {
  return p.countedAt != null && p.countedAt >= (p.addedAt || 0);
}

const LOOKAHEAD_DAYS = 30; // how far ahead "won't be used in time" warnings reach

/** Per-product view of the pantry at `now`: Map(productId → info). */
export function analyze(state, now) {
  const g = state.settings;
  const locs = new Map((state.locations || []).map(l => [l.id, l]));
  const siteCache = new Map();
  const siteIdOf = id => {
    if (!id) return null;
    if (!siteCache.has(id)) siteCache.set(id, siteOf(locs, id));
    return siteCache.get(id);
  };
  const byProduct = new Map(state.products.map(p => [p.id, []]));
  for (const b of state.batches) byProduct.get(b.productId)?.push(b);
  const out = new Map();
  for (const p of state.products) {
    const siteId = siteIdOf(p.locationId);
    const s = siteSettings(g, siteId && locs.get(siteId));
    const est = estimate(p, byProduct.get(p.id), s, now);
    const batches = est.per.map(({ batch, qty }) => {
      const row = {
        batch, qty, present: qty >= PRESENT, expiresAt: null, expired: false, unused: null,
        siteId: siteIdOf(batch.locationId) || siteId,
      };
      if (batch.expiry) {
        row.expiresAt = expiresAt(batch.expiry);
        row.expired = now >= row.expiresAt;
        if (!row.expired && row.present && row.expiresAt - now <= LOOKAHEAD_DAYS * DAY) {
          row.unused = unusedAtExpiry(p, est, batch, s);
        }
      }
      return row;
    });
    const present = batches.filter(b => b.present);
    const firstDated = present.find(b => b.expiresAt);
    out.set(p.id, {
      product: p,
      siteId,
      settings: s,
      est,
      batches,
      out: est.total < PRESENT,
      low: est.total >= PRESENT && p.minStock > 0 && est.total <= p.minStock,
      expired: present.some(b => b.expired),
      soon: present.some(b => !b.expired && b.expiresAt && b.expiresAt - now <= s.warnDays * DAY),
      nextExpiry: firstDated ? firstDated.batch.expiry : null,
    });
  }
  return out;
}

/** Does this product belong to (or have stock at) the given site? null = any site. */
export function atSite(i, site) {
  return site == null || inSite(i.siteId, site) || i.batches.some(b => b.present && inSite(b.siteId, site));
}

/** Quantity of a product estimated to be in one location (all batches there). */
export function qtyIn(info, locationId) {
  return info.batches
    .filter(b => (b.batch.locationId || null) === (locationId || null))
    .reduce((t, b) => t + b.qty, 0);
}

// ---------- what to look at today ----------

/** Site filter: null/undefined = every site, '' = products without a site, otherwise a site id. */
const inSite = (siteId, want) => want == null || (siteId || '') === want;

export function todayLists(info, s, now, site = null) {
  const checks = [];
  const expired = [];
  const soon = [];
  const stale = [];
  for (const i of info.values()) {
    const p = i.product;
    const e = i.est;
    const snoozed = p.snoozeUntil && p.snoozeUntil > now;
    const verified = lastWasCount(p);
    const mine = inSite(i.siteId, site);
    let checking = false;
    if (mine && !snoozed && e.rate > 0) {
      // "Gone?" only when stock was recorded but the estimate used it all up — never after a
      // person counted zero, used it up or threw it away (then recorded stock is zero already).
      if (e.total < PRESENT && e.recorded >= PRESENT) {
        checks.push({ kind: 'gone', i, since: e.runOutAt });
        checking = true;
      } else if (i.low && !(verified && p.countedQty <= p.minStock)) {
        checks.push({ kind: 'low', i, since: null });
        checking = true;
      }
    }
    for (const b of i.batches) {
      if (!b.present || !b.expiresAt || !inSite(b.siteId, site)) continue;
      if (b.expired) expired.push({ i, b });
      else if (b.expiresAt - now <= s.warnDays * DAY || b.unused >= PRESENT) soon.push({ i, b });
    }
    if (
      mine && !checking && !snoozed && s.staleDays > 0 && !i.out &&
      now - (p.touchedAt || p.createdAt) > s.staleDays * DAY
    ) stale.push({ i });
  }
  const lowRatio = c => c.i.est.total / c.i.product.minStock;
  checks.sort((a, b) =>
    a.kind !== b.kind ? (a.kind === 'gone' ? -1 : 1)
      : a.kind === 'gone' ? a.since - b.since : lowRatio(a) - lowRatio(b));
  expired.sort((a, b) => a.b.expiresAt - b.b.expiresAt);
  soon.sort((a, b) => a.b.expiresAt - b.b.expiresAt);
  stale.sort((a, b) => (a.i.product.touchedAt || 0) - (b.i.product.touchedAt || 0));
  return { checks, expired, soon, stale };
}

// ---------- reorder ----------

/** How much to order: enough to last until the next order cycle plus the minimum stock. */
export function suggestOrder(p, e, s, now) {
  let units;
  if (p.orderQty > 0) units = p.orderQty;
  else if (e.rate > 0) units = e.rate * officeTime(now, addDays(now, s.orderEveryDays), s) + (p.minStock || 0) - e.total;
  else units = (p.minStock || 0) + 1 - e.total;
  units = Math.max(1, Math.ceil(units - 1e-9));
  const pack = Math.max(1, ...(p.barcodes || []).map(b => b.units || 1));
  return { units, pack, packs: pack > 1 ? Math.ceil(units / pack) : null };
}

export function reorderList(info, s, now, site = null) {
  const horizon = addDays(now, s.orderEveryDays);
  const need = [];
  const ordered = [];
  for (const i of info.values()) {
    if (!inSite(i.siteId, site)) continue;
    const p = i.product;
    const e = i.est;
    const ps = i.settings || s;
    if (p.orderedAt) {
      ordered.push({ i, reason: null, qty: suggestOrder(p, e, ps, now) });
      continue;
    }
    if (p.reorder === false) continue;
    // Expired stock is still on the shelf (until thrown away) but can't be used: don't count it.
    const expired = i.batches.reduce((t, b) => t + (b.present && b.expired ? b.qty : 0), 0);
    const usable = Math.max(0, e.total - expired);
    let reason = null;
    if (i.out) reason = e.recorded >= PRESENT ? 'probably-out' : 'out';
    else if (usable < PRESENT) reason = 'expired';
    else if (p.minStock > 0 && usable <= p.minStock) reason = 'low';
    else if (e.runOutAt != null && e.runOutAt <= horizon) reason = 'soon';
    if (reason) need.push({ i, reason, qty: suggestOrder(p, { ...e, total: usable }, ps, now) });
  }
  const rank = { out: 0, 'probably-out': 1, expired: 2, low: 3, soon: 4 };
  need.sort((a, b) => rank[a.reason] - rank[b.reason] || a.i.product.name.localeCompare(b.i.product.name));
  ordered.sort((a, b) => a.i.product.orderedAt - b.i.product.orderedAt);
  return { need, ordered };
}

// ---------- learning usage rates from counts ----------

/**
 * Usage observed between the last few counts: (previous count + added − wasted ± adjusted − this count)
 * divided by office days in between. `ranOut` means the latest count was 0, so usage may have been higher.
 */
export function observedRate(events, productId, s) {
  const evs = events.filter(e => e.productId === productId).sort((a, b) => a.at - b.at);
  const spans = [];
  let cp = null;
  let delta = 0;
  for (const e of evs) {
    if (e.type === 'count') {
      if (cp) spans.push({ used: cp.qty + delta - e.qty, days: officeTime(cp.at, e.at, s), endQty: e.qty });
      cp = { at: e.at, qty: e.qty };
      delta = 0;
    } else if (e.type === 'add' && !e.initial) delta += e.qty;
    else if (e.type === 'waste') delta -= e.qty;
    else if (e.type === 'adjust') delta += e.qty;
  }
  const recent = spans.filter(x => x.days >= 0.25 && x.used >= 0).slice(-3);
  const days = recent.reduce((t, x) => t + x.days, 0);
  if (days < 1) return null;
  const used = recent.reduce((t, x) => t + x.used, 0);
  return { perOfficeDay: used / days, days, ranOut: recent[recent.length - 1].endQty === 0 };
}

/** A better usage rate to propose after counting, or null when the current one is close enough. */
export function rateSuggestion(p, events, s) {
  if (p.rateHintAt && p.countedAt && p.rateHintAt >= p.countedAt) return null; // dismissed for this count
  const obs = observedRate(events, p.id, s);
  if (!obs || !(obs.perOfficeDay > 0)) return null;
  const cur = ratePerOfficeDay(p.rate, s);
  if (cur > 0) {
    const ratio = obs.perOfficeDay / cur;
    if (ratio >= 0.8 && ratio <= 1.25) return null;
    if (ratio < 1 && obs.ranOut) return null; // ran out: real usage could be higher still
  }
  const perWeek = s.workdays.length || 5;
  const per = cur > 0 ? p.rate.per
    : obs.perOfficeDay >= 1 ? 'day' : obs.perOfficeDay * perWeek >= 1 ? 'week' : 'month';
  const qty = roundNice(fromPerOfficeDay(obs.perOfficeDay, per, s));
  if (!(qty > 0) || (cur > 0 && qty === Number(p.rate.qty))) return null;
  return { qty, per, days: obs.days, faster: cur > 0 ? obs.perOfficeDay > cur : null };
}

// ---------- waste ----------

export function wasteSummary(state, now, days = 90) {
  const since = now - days * DAY;
  const names = new Map(state.products.map(p => [p.id, p]));
  const rows = new Map();
  for (const e of state.events) {
    if (e.at < since || (e.type !== 'waste' && e.type !== 'add')) continue;
    const key = e.productId || e.name;
    let r = rows.get(key);
    if (!r) rows.set(key, (r = { productId: e.productId, name: e.name, unit: e.unit, wasted: 0, times: 0, added: 0 }));
    if (e.type === 'waste') {
      r.wasted += e.qty;
      r.times++;
      r.name = r.name || e.name;
      r.unit = r.unit || e.unit;
    } else r.added += e.qty;
  }
  const list = [...rows.values()].filter(r => r.wasted > 0);
  for (const r of list) {
    const p = names.get(r.productId);
    if (p) {
      r.name = p.name;
      r.unit = p.unit;
    }
    r.share = r.added > 0 ? Math.min(1, r.wasted / r.added) : null;
    r.buyLess = r.times >= 2 || (r.share != null && r.share >= 0.2);
  }
  list.sort((a, b) => b.wasted - a.wasted);
  return {
    rows: list,
    units: list.reduce((t, r) => t + r.wasted, 0),
    times: list.reduce((t, r) => t + r.times, 0),
  };
}

// ---------- lookups ----------

/** Every product carrying this barcode (one per site, at most, when you track several sites). */
export function findAllByCode(products, code) {
  const k = codeKey(code);
  const out = [];
  for (const p of products) {
    const b = (p.barcodes || []).find(x => codeKey(x.code) === k);
    if (b) out.push({ product: p, units: b.units || 1 });
  }
  return out;
}

export function findByCode(products, code) {
  const k = codeKey(code);
  for (const p of products) {
    for (const b of p.barcodes || []) if (codeKey(b.code) === k) return { product: p, units: b.units || 1 };
  }
  return null;
}

/** Locations in display order (depth-first), each with depth and full path. */
export function locationTree(locations) {
  const kids = new Map();
  for (const l of locations) {
    const k = l.parentId || null;
    if (!kids.has(k)) kids.set(k, []);
    kids.get(k).push(l);
  }
  for (const list of kids.values()) list.sort((a, b) => a.order - b.order || a.name.localeCompare(b.name));
  const out = [];
  const seen = new Set();
  const walk = (parent, depth, prefix) => {
    for (const l of kids.get(parent) || []) {
      if (seen.has(l.id)) continue;
      seen.add(l.id);
      const path = prefix ? `${prefix} › ${l.name}` : l.name;
      out.push({ loc: l, depth, path });
      walk(l.id, depth + 1, path);
    }
  };
  walk(null, 0, '');
  // Anything orphaned (parent deleted elsewhere) still shows up at the root.
  for (const l of locations) if (!seen.has(l.id)) {
    seen.add(l.id);
    out.push({ loc: l, depth: 0, path: l.name });
  }
  return out;
}

export function locationPath(locations, id) {
  if (!id) return '';
  const byId = new Map(locations.map(l => [l.id, l]));
  const parts = [];
  for (let l = byId.get(id), guard = 0; l && guard < 50; l = byId.get(l.parentId), guard++) parts.unshift(l.name);
  return parts.join(' › ');
}

export function descendants(locations, id) {
  const out = new Set();
  const stack = [id];
  while (stack.length) {
    const cur = stack.pop();
    for (const l of locations) if (l.parentId === cur && !out.has(l.id)) {
      out.add(l.id);
      stack.push(l.id);
    }
  }
  return out;
}
