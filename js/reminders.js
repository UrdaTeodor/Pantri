// Daily reminder notifications. buildSchedule() works out what the Today screen will list (to check,
// expired, use soon) at the reminder time on each of the next days and turns it into short notifications;
// startReminderSync() keeps the server's copy of that schedule up to date. The server sends each one as
// a Web Push message at its time (see push.js and sw.js).

import { analyze, todayLists, sitesOf } from './model.js';
import { getState, subscribe } from './store.js';
import { cloudConfigured, hasSession, ensureSession, onAuth, replaceReminders } from './cloud.js';
import { refreshPushSubscription, pushSupport, permission } from './push.js';

export const REMINDER_TAG = 'pantri-daily'; // a new digest replaces the previous one
const TITLE = 'Pantri';
const MAX_BODY = 140; // longer texts get cut off in a notification: then counts only
const MAX_NAME = 28;

// ---------- when ----------

function hoursMinutes(hm) {
  const m = /^(\d{1,2}):(\d{2})/.exec(String(hm || ''));
  return m ? [Math.min(23, Number(m[1])), Math.min(59, Number(m[2]))] : [9, 0];
}

/**
 * The next `days` reminder instants at local time `hm` ('HH:MM'): today's if it hasn't passed yet, then
 * one per calendar day. Built from calendar dates, so a daylight-saving change doesn't shift the time.
 */
export function reminderTimes(hm, now, days = 14) {
  const [h, m] = hoursMinutes(hm);
  const d = new Date(now);
  const out = [];
  for (let k = 0; out.length < days; k++) {
    const t = new Date(d.getFullYear(), d.getMonth(), d.getDate() + k, h, m).getTime();
    if (t > now) out.push(t);
  }
  return out;
}

// ---------- what ----------

const NONE = { check: null, batches: new Map() };

/** Product id → how it is listed: { check: 'gone' | 'low' | null, batches: Map(batch → 'expired' | 'soon') }. */
function listed(lists) {
  const out = new Map();
  const of = i => out.get(i.product.id) || out.set(i.product.id, { check: null, batches: new Map() }).get(i.product.id);
  for (const c of lists.checks) of(c.i).check = c.kind;
  for (const x of lists.expired) of(x.i).batches.set(x.b.batch, 'expired');
  for (const x of lists.soon) of(x.i).batches.set(x.b.batch, 'soon');
  return out;
}

/**
 * What the Today screen lists (all sites) at each of the instants `times` (ascending): the same as
 * todayLists(analyze(state, t), state.settings, t) for every t, but quicker.
 *
 * Over time, products only move one way. Stock goes down, so a product goes from no check to "low" to
 * "gone" (a snooze only hides the start), and a batch goes from not listed to "use soon" to "expired",
 * and off the list once it is used up. So a product listed the same way at the first and the last
 * instant, with no batch used up in between, is listed that way all along. Only the other products are
 * analysed at the instants in between ("low" ones too: they are ordered by how low they are). If such a
 * product has no check at either end, it has none in between: then only its batches matter, and the ones
 * after the last batch that can be listed are left out (batches are used up in order, so that doesn't
 * change the earlier ones), which also skips most of the run-out estimate. 14 days of a few hundred
 * products then take two full analyses plus a few small ones, instead of 14 full ones.
 */
export function listsAt(state, times) {
  if (!times.length) return [];
  const s = state.settings;
  const first = times[0];
  const last = times[times.length - 1];
  const info0 = analyze(state, first);
  const lists0 = todayLists(info0, s, first);
  if (times.length === 1) return [lists0];
  const infoN = analyze(state, last);
  const listsN = todayLists(infoN, s, last);
  const at0 = listed(lists0);
  const atN = listed(listsN);
  const batchesOf = new Map(state.products.map(p => [p.id, []]));
  for (const b of state.batches) batchesOf.get(b.productId)?.push(b);

  const products = [];
  const batches = [];
  for (const p of state.products) {
    const a = at0.get(p.id) || NONE;
    const z = atN.get(p.id) || NONE;
    const rows = info0.get(p.id).batches; // in the order they get used
    const presentAtEnd = new Set(infoN.get(p.id).batches.filter(r => r.present).map(r => r.batch));
    let moves = a.check !== z.check || a.check === 'low';
    let keep = 0;
    rows.forEach((r, k) => {
      const from = a.batches.get(r.batch);
      const to = z.batches.get(r.batch);
      const usedUp = r.present && !presentAtEnd.has(r.batch);
      if (from !== to || (!from && usedUp)) moves = true;
      if (from || to || usedUp) keep = k + 1;
    });
    if (!moves) continue;
    if (a.check || z.check) {
      products.push(p);
      batches.push(...batchesOf.get(p.id));
    } else {
      // Snoozed for good: the smaller stock must not raise checks the real one doesn't have.
      products.push({ ...p, snoozeUntil: Infinity });
      batches.push(...rows.slice(0, keep).map(r => r.batch));
    }
  }

  const out = [lists0];
  const moving = { ...state, products, batches };
  for (const t of times.slice(1, -1)) {
    const infoT = products.length ? analyze(moving, t) : null;
    const info = new Map();
    for (const p of state.products) info.set(p.id, (infoT && infoT.get(p.id)) || info0.get(p.id));
    out.push(todayLists(info, s, t));
  }
  out.push(listsN);
  return out;
}

const KINDS = [['checks', 'to check'], ['expired', 'expired'], ['soon', 'to use soon']];

const clip = name => {
  const n = String(name || '').trim() || 'Unnamed item';
  return n.length > MAX_NAME ? `${n.slice(0, MAX_NAME - 1).trimEnd()}…` : n;
};

/** "2 to check", "1 expired", … — with the names when a kind has at most two different products. */
function parts(lists, names) {
  return KINDS.filter(([k]) => lists[k].length).map(([k, label]) => {
    const head = `${lists[k].length} ${label}`;
    const all = [...new Set(lists[k].map(x => clip(x.i.product.name)))];
    return names && all.length <= 2 ? `${head}: ${all.join(', ')}` : head;
  });
}

/** Lists split per site in site order, then "Not at a site" — like Today with All sites. */
function perSite(lists, sites) {
  const groups = [...sites.map(x => ({ id: x.id, name: x.name })), { id: '', name: 'Not at a site' }]
    .map(g => ({ ...g, lists: { checks: [], expired: [], soon: [] } }));
  const of = id => groups.find(g => g.id === (id || '')) || groups[groups.length - 1];
  for (const c of lists.checks) of(c.i.siteId).lists.checks.push(c);
  for (const x of lists.expired) of(x.b.siteId).lists.expired.push(x);
  for (const x of lists.soon) of(x.b.siteId).lists.soon.push(x);
  return groups.filter(g => KINDS.some(([k]) => g.lists[k].length));
}

/**
 * Notification text for one day's lists ('' = nothing to report). One site: "2 to check: Water, Milk ·
 * 1 expired: Yogurt"; several: "Warehouse: 2 to check · Apartment: 1 expired".
 */
export function digestText(lists, sites = []) {
  if (!KINDS.some(([k]) => lists[k].length)) return '';
  if (sites.length < 2) {
    const named = parts(lists, true).join(' · ');
    return named.length <= MAX_BODY ? named : parts(lists, false).join(' · ');
  }
  const groups = perSite(lists, sites);
  const text = groups.map(g => `${g.name}: ${parts(g.lists, false).join(', ')}`).join(' · ');
  return text.length <= MAX_BODY ? text : `At ${groups.length} sites: ${parts(lists, false).join(' · ')}`;
}

/**
 * The reminders for the next `days` days: [{ sendAt, title, body, url, tag }], one a day at
 * settings.reminderTime with what needs attention then. Days with nothing to report are left out.
 */
export function buildSchedule(state, { now = Date.now(), days = 14 } = {}) {
  if (!state.products.length) return [];
  const times = reminderTimes(state.settings.reminderTime, now, days);
  const sites = sitesOf(state.locations || []);
  const lists = listsAt(state, times);
  const out = [];
  times.forEach((t, k) => {
    const body = digestText(lists[k], sites);
    if (body) out.push({ sendAt: new Date(t).toISOString(), title: TITLE, body, url: './#/', tag: REMINDER_TAG });
  });
  return out;
}

// ---------- keeping the server up to date ----------

const SENT_KEY = 'pantri-reminders-sent'; // what this device last uploaded: { account, items (JSON) }
const RETRY = [30e3, 2 * 60e3, 10 * 60e3, 30 * 60e3]; // waits after failed uploads

let status = { schedule: null, error: '', uploadedAt: 0 };
const watchers = new Set();
function setStatus(patch) {
  status = { ...status, ...patch };
  for (const fn of watchers) fn(status);
}

/** { schedule: the latest one worked out (while reminders are on), error: why the last upload failed, uploadedAt }. */
export const reminderStatus = () => status;
export function onReminderStatus(fn) {
  watchers.add(fn);
  return () => watchers.delete(fn);
}

let remembered = null; // used when localStorage is unavailable
function lastSent() {
  try {
    const raw = localStorage.getItem(SENT_KEY);
    return raw ? JSON.parse(raw) : remembered;
  } catch {
    return remembered;
  }
}
function rememberSent(value) {
  remembered = value;
  try {
    localStorage.setItem(SENT_KEY, JSON.stringify(value));
  } catch { /* private mode: kept in memory only */ }
}

let sync = null;

/** Upload right away instead of after the usual pause (e.g. reminders were just switched on). Never rejects. */
export function syncReminders() {
  return sync ? sync.run() : Promise.resolve();
}

/**
 * While reminders are on, keep the server's schedule in step with the pantry: at startup and sign-in,
 * when the app comes back to the foreground, and `delay` ms after changes. It goes to the account, or
 * on a phone without one to its anonymous session (created again if it is gone, e.g. after signing out
 * of the account, as long as this phone may show notifications). An unchanged schedule isn't sent
 * again; a failed upload is retried later. Switching reminders off clears the schedule this device
 * uploaded. Returns a function that stops it.
 */
export function startReminderSync({ delay = 5000 } = {}) {
  if (sync) return sync.stop;
  if (!cloudConfigured) return () => {};
  let timer = 0;
  let queue = Promise.resolve();
  let failures = 0;
  let account = null;
  let cache = { state: null, first: 0, items: [] };
  let offAuth = () => {};

  // Working out a schedule takes a moment for a big pantry: do it while the phone is idle, where possible.
  const whenIdle = typeof requestIdleCallback === 'function' ? fn => requestIdleCallback(() => fn(), { timeout: 3000 }) : fn => fn();
  const later = ms => {
    clearTimeout(timer);
    timer = setTimeout(() => whenIdle(run), ms);
  };

  const scheduleOf = state => {
    const now = Date.now();
    const first = reminderTimes(state.settings.reminderTime, now, 1)[0];
    if (cache.state !== state || cache.first !== first) cache = { state, first, items: buildSchedule(state, { now }) };
    return cache.items;
  };

  async function upload() {
    const state = getState();
    if (!state) return;
    const on = state.settings.remindersOn === true;
    const items = on ? scheduleOf(state) : [];
    if (on && status.schedule !== items) setStatus({ schedule: items });
    if (!hasSession()) {
      // onAuth() below registers the subscription and schedules the upload once there is a session.
      if (on && pushSupport() === 'ok' && permission() === 'granted') await ensureSession();
      return;
    }
    if (!account) return;
    const json = JSON.stringify(items);
    const last = lastSent();
    const ours = !!last && last.account === account;
    if (ours ? last.items === json : !on) return; // the server has it already, or has nothing of ours to clear
    await replaceReminders(items);
    rememberSent({ account, items: json });
    setStatus({ uploadedAt: Date.now() });
  }

  async function attempt() {
    try {
      await upload();
      failures = 0;
      if (status.error) setStatus({ error: '' });
    } catch (e) {
      setStatus({ error: (e && e.message) || String(e) });
      later(RETRY[Math.min(failures++, RETRY.length - 1)]);
    }
  }

  function run() {
    clearTimeout(timer);
    queue = queue.then(attempt); // one upload at a time, each with the latest state
    return queue;
  }

  const onVisible = () => document.visibilityState === 'visible' && later(0);
  const hasDocument = typeof document !== 'undefined';
  if (hasDocument) document.addEventListener('visibilitychange', onVisible);
  const offStore = subscribe(() => later(delay));
  sync = {
    run,
    stop() {
      clearTimeout(timer);
      offStore();
      offAuth();
      if (hasDocument) document.removeEventListener('visibilitychange', onVisible);
      sync = null;
    },
  };
  // Last: onAuth reports the current session right away.
  offAuth = onAuth(session => {
    account = session ? (session.user && session.user.id) || 'me' : null;
    later(session ? 0 : delay);
    if (!session) return;
    const state = getState();
    if (state && state.settings.remindersOn) refreshPushSubscription(account).catch(() => {});
  });
  return sync.stop;
}
