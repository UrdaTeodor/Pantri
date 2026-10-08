// Test double for app/js/cloud.js (accounts, online backup, push subscriptions, reminder schedule).
//
// The reminder tests load it in place of the real module: the Node test through a resolve hook, the
// browser test by serving a copy of app/ with js/cloud.js replaced. Instead of a server it records what
// the app sends in globalThis.__cloudStub, and takes its state from globalThis.__PANTRI_STUB__ =
// { configured, signedIn, fail } (set before the app loads; `fail` makes every call reject like a network
// error). Tests can sign in or out later with __cloudStub.setSignedIn(true | false).

const opts = () => globalThis.__PANTRI_STUB__ || {};
const config = globalThis.__PANTRI_CONFIG__ || {};
const listeners = new Set();
const statusListeners = new Set();
/** What the app sent: subscriptions [{ sub, device }], deleted endpoints, the last reminder upload. */
const sent = (globalThis.__cloudStub ||= { subscriptions: [], deleted: [], reminders: [], uploads: 0 });

export const cloudConfigured = opts().configured ?? Boolean(config.SUPABASE_URL && config.SUPABASE_ANON_KEY);

export function isSignedIn() {
  return cloudConfigured && Boolean(opts().signedIn);
}

const session = () => (isSignedIn() ? { user: { id: 'stub-user', email: 'someone@example.com' } } : null);

/** fn(session | null) now and on every sign-in / sign-out. Returns an unsubscribe function. */
export function onAuth(fn) {
  listeners.add(fn);
  fn(session());
  return () => listeners.delete(fn);
}

sent.setSignedIn = signedIn => {
  globalThis.__PANTRI_STUB__ = { ...opts(), signedIn };
  for (const fn of listeners) fn(session());
  for (const fn of statusListeners) fn();
};

function reachable() {
  if (!isSignedIn()) throw new Error('Not signed in');
  if (opts().fail) throw new Error('Could not reach the server');
}

/** Remember this device's push subscription (PushSubscription.toJSON()) for the signed-in account. */
export async function savePushSubscription(sub, { device } = {}) {
  reachable();
  sent.subscriptions = [...sent.subscriptions.filter(x => x.sub.endpoint !== sub.endpoint), { sub, device }];
}

export async function deletePushSubscription(endpoint) {
  reachable();
  sent.subscriptions = sent.subscriptions.filter(x => x.sub.endpoint !== endpoint);
  sent.deleted.push(endpoint);
}

/** Replace the account's scheduled reminders: [{ sendAt: ISO-8601, title, body, url, tag }]. */
export async function replaceReminders(items) {
  reachable();
  sent.reminders = items;
  sent.uploads++;
  return items.length;
}

// ---------- the rest of the real module, so every screen that imports from it still loads ----------

export const deviceLabel = () => 'Test device';
export function initCloud() {}

export function cloudStatus() {
  return {
    configured: cloudConfigured, signedIn: isSignedIn(), email: isSignedIn() ? 'someone@example.com' : '',
    recovering: false, phase: 'idle', message: '', choice: null, syncedAt: null, pending: false,
  };
}

export function onCloudStatus(fn) {
  statusListeners.add(fn);
  return () => statusListeners.delete(fn);
}

export async function syncNow() {}
export async function listVersions() {
  return [];
}

const unavailable = name => async () => {
  throw new Error(`${name} is not available in the test double`);
};
export const chooseCopy = unavailable('chooseCopy');
export const signUp = unavailable('signUp');
export const signIn = unavailable('signIn');
export const sendPasswordReset = unavailable('sendPasswordReset');
export const setNewPassword = unavailable('setNewPassword');
export const signOut = unavailable('signOut');
export const deleteOnlineData = unavailable('deleteOnlineData');
export const restoreVersion = unavailable('restoreVersion');
