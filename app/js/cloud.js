// Optional accounts, online backup and the server side of reminders, on Supabase.
// All of it is off unless config.js has a Supabase URL and key: then cloudConfigured is false, nothing
// is loaded or fetched, and the functions below reject. The Supabase client (vendor/supabase.js) is
// only loaded when needed: when someone signs in, or at start-up when this phone is signed in.

import { SUPABASE_URL, SUPABASE_ANON_KEY } from './config.js';
import { getState, subscribe, replaceState, eraseAll } from './store.js';
import { createSync } from './sync.js';

export const cloudConfigured = !!(SUPABASE_URL && SUPABASE_ANON_KEY);

const AUTH_KEY = 'pantri-auth'; // the session, written by supabase-js
const SYNC_KEY = 'pantri-sync'; // this phone's sync bookkeeping (sync.js)
const DEVICE_KEY = 'pantri-device'; // a random id for this browser or installed app
const DEBOUNCE = 2000;

/** Set by initCloud(): show a message; open the account screen. */
const hooks = { notify: () => {}, openAccount: () => {} };

// ---------- helpers ----------

function readJson(key) {
  try {
    return JSON.parse(localStorage.getItem(key) || 'null');
  } catch {
    return null;
  }
}

function writeJson(key, value) {
  try {
    if (value == null) localStorage.removeItem(key);
    else localStorage.setItem(key, JSON.stringify(value));
  } catch { /* storage unavailable */ }
}

const call = (fn, ...args) => {
  try {
    fn(...args);
  } catch (e) {
    console.error(e);
  }
};
const iso = t => new Date(t || Date.now()).toISOString();
const notConfigured = () => new Error('Online features are not set up in this version of the app.');
const notSignedIn = () => new Error('Not signed in.');
const offline = () => typeof navigator !== 'undefined' && navigator.onLine === false;

/** An Error for a failed Supabase call; `offline` is set when the server couldn't be reached. */
function failure(error, status) {
  const e = new Error(error.message || String(error));
  e.code = error.code || '';
  e.offline = status === 0 || error.name === 'AuthRetryableFetchError' || offline();
  return e;
}

/** The data of a supabase-js result, or its error thrown. */
function check(res) {
  if (res.error) throw failure(res.error, res.status);
  return res.data;
}

/** A random id for this browser or installed app (on phones they keep separate data). */
function deviceId() {
  let id = null;
  try {
    id = localStorage.getItem(DEVICE_KEY);
  } catch { /* no storage */ }
  if (!id) {
    id = crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2);
    try {
      localStorage.setItem(DEVICE_KEY, id);
    } catch { /* no storage */ }
  }
  return id;
}

/** "iPhone · app", "Android · Chrome", "Windows · Edge"…: which device saved something. */
export function deviceLabel() {
  const ua = navigator.userAgent;
  const os = /iPhone/.test(ua) ? 'iPhone' : /iPad/.test(ua) ? 'iPad' : /Android/.test(ua) ? 'Android'
    : /Macintosh/.test(ua) ? (navigator.maxTouchPoints > 1 ? 'iPad' : 'Mac')
      : /Windows/.test(ua) ? 'Windows' : /Linux|CrOS/.test(ua) ? 'Linux' : 'Device';
  const installed = navigator.standalone === true || matchMedia('(display-mode: standalone)').matches;
  const browser = /Edg(A|iOS)?\//.test(ua) ? 'Edge' : /SamsungBrowser/.test(ua) ? 'Samsung Internet'
    : /Firefox|FxiOS/.test(ua) ? 'Firefox' : /Chrome|CriOS/.test(ua) ? 'Chrome' : /Safari/.test(ua) ? 'Safari' : 'browser';
  return `${os} · ${installed ? 'app' : browser}`;
}

// ---------- session ----------

/** The session supabase-js saved last time: read directly, so isSignedIn() is right from the start. */
function storedSession() {
  const s = readJson(AUTH_KEY);
  return s && s.refresh_token && s.user && s.user.id ? s : null;
}

let session = cloudConfigured ? storedSession() : null;
let recovering = false; // opened from a password-reset link: offer to set a new password
let clientPromise = null;
const authListeners = new Set();

function client() {
  if (!cloudConfigured) return Promise.reject(notConfigured());
  if (!clientPromise) {
    clientPromise = import('../vendor/supabase.js').then(({ createClient }) => {
      const c = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
        auth: { storageKey: AUTH_KEY, persistSession: true, autoRefreshToken: true, detectSessionInUrl: true, flowType: 'implicit' },
      });
      c.auth.onAuthStateChange((event, s) => {
        // Act afterwards, not from inside supabase-js's own callback.
        setTimeout(() => {
          if (event === 'PASSWORD_RECOVERY') {
            recovering = true;
            hooks.openAccount();
          }
          setSession(s);
        }, 0);
      });
      return c;
    });
    clientPromise.catch(() => (clientPromise = null)); // e.g. offline before the file was cached: retry later
  }
  return clientPromise;
}

function setSession(next) {
  const before = session ? session.user.id : null;
  session = next && next.user ? next : null;
  const after = session ? session.user.id : null;
  if (before !== after) {
    clearTimeout(timer);
    status = { phase: 'idle', message: '', choice: null };
    if (!after) recovering = false;
    for (const fn of [...authListeners]) call(fn, session);
    if (after) schedule(0);
  }
  emit();
}

/** The Supabase client, once the signed-in session is confirmed (refreshed if needed). */
async function authed() {
  if (!cloudConfigured) throw notConfigured();
  if (!session) throw notSignedIn();
  const c = await client();
  const { data, error } = await c.auth.getSession();
  if (error) throw failure(error, error.status);
  if (!data.session) throw notSignedIn();
  return c;
}

/** Whether this phone is signed in (synchronous). */
export function isSignedIn() {
  return !!session;
}

/** Calls fn(session | null) now and whenever the signed-in account changes. Returns an unsubscribe function. */
export function onAuth(fn) {
  authListeners.add(fn);
  call(fn, session);
  return () => {
    authListeners.delete(fn);
  };
}

// ---------- status (for the account screen) ----------

let status = { phase: 'idle', message: '', choice: null };
const statusListeners = new Set();

function setStatus(patch) {
  status = { ...status, ...patch };
  emit();
}

function emit() {
  for (const fn of [...statusListeners]) call(fn);
}

/**
 * What the account screen shows. phase: 'idle' | 'syncing' | 'synced' | 'offline' | 'error' |
 * 'choose' (both this phone and the account have a pantry: `choice` holds { local, remote } summaries).
 */
export function cloudStatus() {
  const m = session ? meta.load() : null;
  return {
    configured: cloudConfigured,
    signedIn: !!session,
    email: session ? session.user.email || '' : '',
    recovering,
    ...status,
    syncedAt: m ? m.syncedAt : null,
    pending: !!session && engine.isDirty(),
  };
}

export function onCloudStatus(fn) {
  statusListeners.add(fn);
  return () => {
    statusListeners.delete(fn);
  };
}

// ---------- sync ----------

const blankMeta = userId => ({ userId, baseRev: 0, syncedRev: null, hash: null, changedAt: null, syncedAt: null });
const meta = {
  load() {
    const userId = session ? session.user.id : null;
    const m = readJson(SYNC_KEY);
    return m && m.userId === userId ? m : blankMeta(userId);
  },
  save(m) {
    writeJson(SYNC_KEY, m);
  },
};

const engine = createSync({
  api: {
    async head() {
      const c = await authed();
      const row = check(await c.from('pantries').select('rev, changed_at, device, products').maybeSingle());
      return row && { rev: Number(row.rev), changedAt: Date.parse(row.changed_at), device: row.device, products: row.products };
    },
    async fetch() {
      const c = await authed();
      const row = check(await c.from('pantries').select('state, rev, changed_at, device').maybeSingle());
      return row && { state: row.state, rev: Number(row.rev), changedAt: Date.parse(row.changed_at), device: row.device };
    },
    async save({ state, baseRev, changedAt, reason }) {
      const c = await authed();
      const r = check(await c.rpc('save_pantry', {
        p_state: state, p_base_rev: baseRev, p_changed_at: iso(changedAt), p_device: deviceLabel(), p_device_id: deviceId(),
        p_reason: reason,
      }));
      return { ...r, rev: Number(r.rev) };
    },
    async stash({ state, changedAt, reason }) {
      const c = await authed();
      check(await c.rpc('stash_pantry', { p_state: state, p_changed_at: iso(changedAt), p_device: deviceLabel(), p_reason: reason }));
    },
  },
  store: { getState, replaceState },
  meta,
});

let timer = null;
let running = null;
let again = false;
let paused = false; // while signing out, deleting the online data or restoring a version
let retryDelay = 0;

function schedule(delay = DEBOUNCE) {
  clearTimeout(timer);
  timer = setTimeout(() => {
    timer = null;
    syncNow();
  }, delay);
}

async function runOnce(opts) {
  setStatus({ phase: 'syncing', message: '' });
  try {
    const r = await engine.syncOnce(opts);
    retryDelay = 0;
    if (r.action === 'ask') return setStatus({ phase: 'choose', choice: { local: r.local, remote: r.remote } });
    if (r.action === 'gone') return onlineCopyGone();
    setStatus({ phase: 'synced', choice: null });
    if (r.conflict) {
      hooks.notify(r.action === 'kept-local'
        ? 'Another device changed the pantry at the same time. The newer changes from this phone were kept; the other version is under Account → Earlier versions.'
        : "Another device made newer changes, so they replaced this phone's. This phone's version is under Account → Earlier versions.");
    }
  } catch (e) {
    const away = e.offline || offline() || /fetch|network/i.test(e.message);
    setStatus({ phase: away ? 'offline' : 'error', message: away ? '' : e.message, choice: null });
    retryDelay = Math.min(retryDelay ? retryDelay * 2 : 30000, 10 * 60000);
    schedule(retryDelay);
  }
}

function run(opts) {
  running = (async () => {
    try {
      let o = opts;
      do {
        again = false;
        await runOnce(o);
        o = {};
      } while (again && session && !paused);
    } finally {
      running = null;
    }
  })();
  return running;
}

/** Sync now, or once more after the sync that is running. Never rejects: cloudStatus() tells how it went. */
export function syncNow() {
  if (!cloudConfigured || !session || paused) return Promise.resolve();
  if (running) {
    again = true;
    return running;
  }
  return run({});
}

/** After phase 'choose': keep this phone's pantry ('local') or take the online one ('remote'). */
export async function chooseCopy(which) {
  while (running) await running;
  if (!session) throw notSignedIn();
  await run({ choice: which });
  if (status.phase === 'offline') throw new Error('No connection. Try again when you are online.');
  if (status.phase === 'error') throw new Error(status.message);
}

/** The online copy this phone was synced with was deleted (from another device): sign out here. */
async function onlineCopyGone() {
  await endSession();
  hooks.notify('Your online data was deleted from another device, so this phone was signed out. The pantry is still on this phone.');
}

// ---------- accounts ----------

const appUrl = () => location.href.split('#')[0];

/** A readable Error for a failed sign-in / sign-up / password call. */
function authFailure(error) {
  const code = error.code || '';
  const msg = error.message || '';
  if (error.name === 'AuthRetryableFetchError' || error.status === 0 || offline()) return new Error('No connection. Try again when you are online.');
  if (code === 'invalid_credentials' || /invalid login credentials/i.test(msg)) return new Error('Wrong email or password.');
  if (code === 'user_already_exists' || code === 'email_exists' || /already registered/i.test(msg)) {
    return new Error('There is already an account with this email. Sign in instead.');
  }
  if (code === 'email_not_confirmed') return new Error('Confirm your email address first: open the link in the email you got.');
  if (/rate_limit/.test(code) || /rate limit/i.test(msg)) return new Error('Too many attempts. Wait a while and try again.');
  if (code === 'signup_disabled') return new Error('New accounts are switched off for this app.');
  if (code === 'email_address_invalid') return new Error("That email address doesn't look right.");
  return new Error(msg || 'Something went wrong. Try again.');
}

/** Create an account. Resolves to { needsConfirmation } (true if the project requires confirming the email). */
export async function signUp(email, password) {
  const c = await client();
  const { data, error } = await c.auth.signUp({ email, password, options: { emailRedirectTo: appUrl() } });
  if (error) throw authFailure(error);
  if (!data.session) return { needsConfirmation: true };
  setSession(data.session);
  return { needsConfirmation: false };
}

export async function signIn(email, password) {
  const c = await client();
  const { data, error } = await c.auth.signInWithPassword({ email, password });
  if (error) throw authFailure(error);
  setSession(data.session);
}

/** Email a link that opens the app and lets the user choose a new password. */
export async function sendPasswordReset(email) {
  const c = await client();
  const { error } = await c.auth.resetPasswordForEmail(email, { redirectTo: appUrl() });
  if (error) throw authFailure(error);
}

export async function setNewPassword(password) {
  const c = await authed();
  const { error } = await c.auth.updateUser({ password });
  if (error) throw authFailure(error);
  recovering = false;
  emit();
}

/** Forget this phone's push subscription online, so the account's reminders stop arriving here. */
async function removeThisDevicesPush() {
  try {
    const reg = navigator.serviceWorker && (await navigator.serviceWorker.getRegistration());
    const sub = reg && reg.pushManager && (await reg.pushManager.getSubscription());
    if (sub) await deletePushSubscription(sub.endpoint);
  } catch { /* offline or no push: nothing to remove */ }
}

/** Sign this phone out and forget its sync bookkeeping. The pantry stays on the phone. */
async function endSession() {
  clearTimeout(timer);
  await removeThisDevicesPush();
  try {
    const c = await client();
    await c.auth.signOut({ scope: 'local' }); // forgets the session here even when offline
  } catch {
    writeJson(AUTH_KEY, null);
  }
  writeJson(SYNC_KEY, null);
  setSession(null);
}

/** Sign out on this phone. The pantry stays here unless `removeData`; the online copy stays in the account. */
export async function signOut({ removeData = false } = {}) {
  if (!session) return;
  if (!removeData) await syncNow(); // a last upload of recent changes (if online)
  paused = true;
  try {
    while (running) await running;
    await endSession();
    if (removeData) eraseAll();
  } finally {
    paused = false;
  }
}

/** Delete the online pantry, its earlier versions, push subscriptions and reminders; then sign out here. */
export async function deleteOnlineData() {
  const c = await authed();
  paused = true;
  try {
    while (running) await running;
    check(await c.rpc('delete_my_data'));
    await endSession();
  } finally {
    paused = false;
  }
}

// ---------- earlier versions ----------

/** Earlier versions kept online, newest first: [{ id, savedAt, reason, device, changedAt, products }]. */
export async function listVersions() {
  const c = await authed();
  const rows = check(await c.from('pantry_history')
    .select('id, saved_at, reason, device, changed_at, products')
    .order('saved_at', { ascending: false })
    .order('id', { ascending: false }));
  return rows.map(r => ({
    id: r.id, savedAt: Date.parse(r.saved_at), reason: r.reason, device: r.device || '',
    changedAt: r.changed_at ? Date.parse(r.changed_at) : null, products: r.products,
  }));
}

/** Make an earlier version the pantry again, online and on this phone (the current one is kept as a version). */
export async function restoreVersion(id) {
  await syncNow();
  if (engine.isDirty()) throw new Error("This phone's latest changes aren't online yet. Check the connection and try again.");
  const c = await authed();
  paused = true;
  try {
    while (running) await running;
    const r = check(await c.rpc('restore_pantry_version', { p_id: id, p_device: deviceLabel(), p_device_id: deviceId() }));
    engine.apply({ state: r.state, rev: Number(r.rev), changedAt: Date.parse(r.changedAt) });
    setStatus({ phase: 'synced', message: '', choice: null });
  } finally {
    paused = false;
  }
}

// ---------- reminders (used by the device side of notifications) ----------

/**
 * Store this device's push subscription for the signed-in user (updated if the endpoint is known).
 * `sub` is PushSubscription.toJSON(): { endpoint, keys: { p256dh, auth } }.
 */
export async function savePushSubscription(sub, { device } = {}) {
  if (!sub || !sub.endpoint || !sub.keys || !sub.keys.p256dh || !sub.keys.auth) {
    throw new Error('savePushSubscription: expected PushSubscription.toJSON() ({ endpoint, keys: { p256dh, auth } }).');
  }
  const c = await authed();
  check(await c.rpc('save_push_subscription', {
    p_endpoint: sub.endpoint, p_p256dh: sub.keys.p256dh, p_auth: sub.keys.auth, p_device: device || deviceLabel(),
  }));
}

/** Forget a push subscription (by endpoint) of the signed-in user. */
export async function deletePushSubscription(endpoint) {
  const c = await authed();
  check(await c.from('push_subscriptions').delete().eq('endpoint', endpoint));
}

/**
 * Replace the signed-in user's unsent reminders, atomically, with
 * items: [{ sendAt: ISO-8601 string, title, body, url, tag }] (at most 60). Items more than 6 hours late
 * and ones that were already sent (same sendAt, title and tag) are skipped. Resolves to how many wait.
 */
export async function replaceReminders(items) {
  if (!Array.isArray(items)) throw new Error('replaceReminders: items must be an array.');
  const c = await authed();
  return check(await c.rpc('replace_reminders', {
    items: items.map(({ sendAt, title, body, url, tag }) => ({ sendAt, title, body, url, tag })),
  }));
}

// ---------- start-up ----------

let started = false;

/**
 * Start syncing (called once the app is on screen; does nothing when not configured).
 * notify(text) shows a message; openAccount() shows the account screen.
 */
export function initCloud({ notify, openAccount } = {}) {
  if (!cloudConfigured || started) return;
  started = true;
  if (notify) hooks.notify = notify;
  if (openAccount) hooks.openAccount = openAccount;

  // A password-reset link opens the app with a session (or an error) in the URL hash.
  const params = new URLSearchParams(location.hash.replace(/^#\/?/, ''));
  if (params.get('error_description')) {
    hooks.openAccount();
    hooks.notify(params.get('error_code') === 'otp_expired'
      ? 'That link has expired or was used already. Ask for a new one.'
      : params.get('error_description'));
  } else if (params.get('access_token')) {
    client().catch(() => {});
  }
  if (session) client().catch(() => {}); // restores (and refreshes) the session

  subscribe(() => {
    if (!session) return;
    engine.noteLocalChange();
    if (status.phase !== 'choose') schedule();
    emit();
  });
  addEventListener('online', () => {
    if (session && status.phase !== 'choose') schedule(0);
  });
  document.addEventListener('visibilitychange', () => {
    if (!session || status.phase === 'choose') return;
    if (document.visibilityState === 'visible') schedule(0);
    else if (engine.isDirty()) syncNow(); // upload before the app is put away
  });
  if (session) schedule(0);
}
