// Web Push on this device: can it get notifications, the permission, and this device's push
// subscription, which is registered with the server (cloud.js) so that the server can send reminders.
// iPhone/iPad only get Web Push in the app opened from the Home Screen (iOS/iPadOS 16.4 or later).

import { VAPID_PUBLIC_KEY } from './config.js';
import { savePushSubscription, deletePushSubscription } from './cloud.js';

const nav = typeof navigator === 'undefined' ? {} : navigator;
const agent = () => nav.userAgent || '';

/** Why enabling failed: 'denied', 'dismissed', 'no-worker', 'subscribe' (the browser refused) or 'server'. */
export class PushError extends Error {
  constructor(code, cause = null) {
    super(cause && cause.message ? `${code}: ${cause.message}` : code);
    this.code = code;
    this.cause = cause;
  }
}

/** iPhone, iPad (iPadOS says it is a Mac, but has a touch screen) or iPod. */
export function isIOS() {
  return /iPhone|iPad|iPod/.test(agent()) || (/Macintosh/.test(agent()) && nav.maxTouchPoints > 1);
}

/** Opened as an installed app (e.g. from the Home Screen icon) rather than in a browser tab. */
export function isStandalone() {
  if (nav.standalone === true) return true;
  return typeof matchMedia === 'function' && ['standalone', 'fullscreen', 'minimal-ui'].some(m => matchMedia(`(display-mode: ${m})`).matches);
}

/**
 * Can this device get reminders? 'ok'; 'ios-browser' (iPhone/iPad in a browser tab: needs the Home
 * Screen app); 'unsupported' (no Web Push here); 'no-key' (this copy of the app has no push key set up).
 */
export function pushSupport() {
  if (isIOS() && !isStandalone()) return 'ios-browser';
  const ok = typeof window !== 'undefined' && 'serviceWorker' in nav && 'PushManager' in window && 'Notification' in window;
  if (!ok) return 'unsupported';
  return VAPID_PUBLIC_KEY ? 'ok' : 'no-key';
}

/** 'default' (not asked yet), 'granted', 'denied', or 'unsupported'. */
export function permission() {
  return typeof Notification === 'undefined' ? 'unsupported' : Notification.permission;
}

/** A short name for this device in the account's device list, e.g. "Android · Chrome". */
export function deviceLabel(ua = agent()) {
  const os = /iPhone|iPod/.test(ua) ? 'iPhone'
    : /iPad/.test(ua) || (/Macintosh/.test(ua) && nav.maxTouchPoints > 1) ? 'iPad'
      : /Android/.test(ua) ? 'Android'
        : /Windows/.test(ua) ? 'Windows'
          : /CrOS/.test(ua) ? 'ChromeOS'
            : /Macintosh|Mac OS X/.test(ua) ? 'Mac'
              : /Linux/.test(ua) ? 'Linux' : 'Unknown device';
  const browser = /Edg(A|iOS)?\//.test(ua) ? 'Edge'
    : /SamsungBrowser/.test(ua) ? 'Samsung Internet'
      : /Firefox|FxiOS/.test(ua) ? 'Firefox'
        : /OPR\//.test(ua) ? 'Opera'
          : /CriOS|Chrome\//.test(ua) ? 'Chrome'
            : /Safari\//.test(ua) ? 'Safari' : '';
  return [os, browser].filter(Boolean).join(' · ');
}

/** A base64url key (how VAPID keys are written) as bytes, for applicationServerKey. */
export function keyBytes(base64url) {
  const b64 = String(base64url).replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4));
  return Uint8Array.from(bin, c => c.charCodeAt(0));
}

function usesOurKey(sub) {
  const key = sub.options && sub.options.applicationServerKey;
  if (!key) return true; // the browser doesn't say: keep it
  const a = new Uint8Array(key);
  const b = keyBytes(VAPID_PUBLIC_KEY);
  return a.length === b.length && a.every((x, i) => x === b[i]);
}

/** The service worker registration (main.js registers it at startup). */
async function registration(timeout = 10000) {
  if (!('serviceWorker' in nav)) throw new PushError('no-worker');
  let timer = 0;
  try {
    return await Promise.race([
      nav.serviceWorker.ready,
      new Promise((resolve, reject) => { timer = setTimeout(() => reject(new PushError('no-worker')), timeout); }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** This device's current push subscription, or null. */
export async function currentSubscription() {
  if (!('serviceWorker' in nav)) return null;
  const reg = await nav.serviceWorker.getRegistration();
  return reg && reg.pushManager ? reg.pushManager.getSubscription() : null;
}

/** A push subscription for our server key: the existing one, or a new one. Needs the permission. */
export async function subscribe() {
  const reg = await registration();
  const existing = await reg.pushManager.getSubscription();
  if (existing && usesOurKey(existing)) return existing;
  if (existing) await existing.unsubscribe().catch(() => false); // made for another key: start over
  try {
    return await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(VAPID_PUBLIC_KEY) });
  } catch (e) {
    throw new PushError('subscribe', e);
  }
}

/** Drop this device's subscription. Resolves to its endpoint (null if there was none). */
export async function unsubscribe() {
  const sub = await currentSubscription();
  if (!sub) return null;
  await sub.unsubscribe().catch(() => false);
  return sub.endpoint;
}

let savedFor = null; // the account this device's subscription was last sent to (this session)

async function save(sub, account) {
  try {
    await savePushSubscription(sub.toJSON(), { device: deviceLabel() });
  } catch (e) {
    throw new PushError('server', e);
  }
  savedFor = account;
}

/**
 * Switch this device on: ask for the permission, subscribe, and register the subscription with the
 * server. Call it straight from a tap, before anything else is awaited: the permission prompt needs
 * the tap (iPhone/iPad refuse it otherwise).
 */
export async function enablePush(account = 'me') {
  if (permission() !== 'granted') {
    const answer = await Notification.requestPermission();
    if (answer !== 'granted') throw new PushError(answer === 'denied' ? 'denied' : 'dismissed');
  }
  const sub = await subscribe();
  await save(sub, account);
  return sub;
}

/** Switch this device off: forget its subscription on the server (best effort) and here. */
export async function disablePush() {
  const sub = await currentSubscription();
  savedFor = null;
  if (!sub) return;
  try {
    await deletePushSubscription(sub.endpoint);
  } catch {
    // Signed out or offline: the endpoint stops working anyway once it is unsubscribed below.
  }
  await sub.unsubscribe().catch(() => false);
}

/**
 * Register this device's subscription again (push services may replace it), or recreate it if the
 * browser dropped it. Once per session and account; never asks for the permission.
 */
export async function refreshPushSubscription(account = 'me') {
  if (savedFor === account || pushSupport() !== 'ok' || permission() !== 'granted') return false;
  await save(await subscribe(), account);
  return true;
}

/** Show a notification right away from this device (no server involved). Call it from a tap. */
export async function showTestNotification(body) {
  if (permission() === 'default' && (await Notification.requestPermission()) !== 'granted') throw new PushError('dismissed');
  if (permission() !== 'granted') throw new PushError('denied');
  const reg = await registration();
  await reg.showNotification('Pantri', { body, icon: './icons/icon-192.png', tag: 'pantri-test' });
}
