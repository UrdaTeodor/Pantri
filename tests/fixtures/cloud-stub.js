// Test double for app/js/cloud.js (accounts, online backup, push subscriptions, reminder schedule).
//
// The reminder tests load it in place of the real module: the Node test through a resolve hook, the
// browser test by serving a copy of app/ with js/cloud.js replaced. Instead of a server it records what
// the app sends in globalThis.__cloudStub, and takes its state from globalThis.__PANTRI_STUB__ =
// { configured, signedIn, anonymous, fail } (set before the app loads; `anonymous`: the phone has the
// anonymous session of a phone without an account; `fail` makes every call reject like a network
// error). Tests can sign in or out later with __cloudStub.setSignedIn(true | false).

const opts = () => globalThis.__PANTRI_STUB__ || {};
const config = globalThis.__PANTRI_CONFIG__ || {};
const listeners = new Set();
const statusListeners = new Set();
/**
 * What the app sent: subscriptions [{ sub, device, user }], deleted endpoints, the last reminder upload,
 * and how often it signed in anonymously and asked to forget this phone.
 */
const sent = (globalThis.__cloudStub ||= { subscriptions: [], deleted: [], reminders: [], uploads: 0, anonymousSignIns: 0, forgotten: 0 });

export const cloudConfigured = opts().configured ?? Boolean(config.SUPABASE_URL && config.SUPABASE_ANON_KEY);

export function isSignedIn() {
  return cloudConfigured && Boolean(opts().signedIn);
}

export function hasSession() {
  return isSignedIn() || (cloudConfigured && Boolean(opts().anonymous));
}

const session = () => (isSignedIn() ? { user: { id: 'stub-user', email: 'someone@example.com' } }
  : hasSession() ? { user: { id: 'stub-anonymous', is_anonymous: true } } : null);

/** fn(session | null) now and on every sign-in / sign-out. Returns an unsubscribe function. */
export function onAuth(fn) {
  listeners.add(fn);
  fn(session());
  return () => listeners.delete(fn);
}

function changed(patch) {
  globalThis.__PANTRI_STUB__ = { ...opts(), ...patch };
  for (const fn of listeners) fn(session());
  for (const fn of statusListeners) fn();
}
sent.setSignedIn = signedIn => changed({ signedIn });

function reachable() {
  if (!hasSession()) throw new Error('Not signed in');
  if (opts().fail) throw new Error('Could not reach the server');
}

/** A session for reminders: the account, or an anonymous one made now. */
export async function ensureSession() {
  if (!cloudConfigured) throw new Error('Online features are not set up in this version of the app.');
  if (hasSession()) return;
  if (opts().fail) throw new Error('Could not reach the server');
  sent.anonymousSignIns++;
  changed({ anonymous: true });
}

/** Remember this device's push subscription (PushSubscription.toJSON()) for this phone's user. */
export async function savePushSubscription(sub, { device } = {}) {
  await ensureSession();
  reachable();
  const user = session().user.id;
  sent.subscriptions = [...sent.subscriptions.filter(x => x.sub.endpoint !== sub.endpoint), { sub, device, user }];
  return user;
}

/** Notifications off on a phone without an account: the server forgets it, the anonymous session ends. */
export async function forgetThisDevice() {
  if (!hasSession() || isSignedIn()) return;
  if (opts().fail) return;
  sent.forgotten++;
  sent.subscriptions = sent.subscriptions.filter(x => x.user !== 'stub-anonymous');
  sent.reminders = [];
  changed({ anonymous: false });
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
