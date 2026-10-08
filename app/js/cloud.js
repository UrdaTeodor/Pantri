// STUB for development — replaced by the real cloud module when branches are merged.
//
// Same exports as the real module (accounts, push subscriptions, reminder schedule). Instead of a
// server it records what the app sends in globalThis.__cloudStub, and takes its state from
// globalThis.__PANTRI_STUB__ = { configured, signedIn, fail } (set before the app loads; `fail`
// makes every call reject like a network error). Tests can sign in or out later with
// __cloudStub.setSignedIn(true | false).

import { SUPABASE_URL, SUPABASE_ANON_KEY } from './config.js';

const opts = () => globalThis.__PANTRI_STUB__ || {};
const listeners = new Set();
/** What the app sent: subscriptions [{ sub, device }], deleted endpoints, the last reminder upload. */
const sent = (globalThis.__cloudStub ||= { subscriptions: [], deleted: [], reminders: [], uploads: 0 });

export const cloudConfigured = opts().configured ?? Boolean(SUPABASE_URL && SUPABASE_ANON_KEY);

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
}
