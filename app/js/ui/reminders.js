// Settings → Notifications: a daily reminder on this device (Web Push, sent by the server), with
// guidance for each case where that can't work yet, and the popup that offers it on the Today screen.
// Only shown when the cloud features are set up.

import { html, useState, useEffect, useReducer } from './lib.js';
import { navigate, showToast, ask, currentRoute, currentSheets } from './nav.js';
import { useApp, Icon } from './kit.js';
import { updateSettings, getState } from '../store.js';
import { cloudConfigured, isSignedIn, onAuth } from '../cloud.js';
import {
  pushSupport, permission, isIOS, enablePush, disablePush, currentSubscription, showTestNotification,
} from '../push.js';
import { reminderStatus, onReminderStatus, syncReminders } from '../reminders.js';
import { dayText, timeText } from '../format.js';

/** The signed-in account ('me' until the session says who), or null. */
function useAccount() {
  const [account, setAccount] = useState(() => (isSignedIn() ? 'me' : null));
  useEffect(() => onAuth(session => setAccount(session ? (session.user && session.user.id) || 'me' : null)), []);
  return account;
}

function useReminderStatus() {
  const [, force] = useReducer(x => x + 1, 0);
  useEffect(() => onReminderStatus(() => force()), []);
  return reminderStatus();
}

function unblockHelp() {
  if (isIOS()) return 'On iPhone or iPad: open Settings → Notifications → Pantri and turn on Allow Notifications.';
  if (/Android/.test(navigator.userAgent)) {
    return 'On Android: long-press the Pantri icon → App info → Notifications, and allow them. In a Chrome tab: ⋮ → Settings → Site settings → Notifications.';
  }
  return 'Allow notifications for this site in the browser: click the icon next to the address, then the notifications setting.';
}

function problemText(err) {
  const code = err && err.code;
  if (code === 'denied') return `Notifications are blocked. ${unblockHelp()}`;
  if (code === 'dismissed') return "Notifications weren't allowed. Tap the switch again and choose Allow.";
  if (code === 'no-worker') return "The app isn't ready for notifications yet. Reload it and try again.";
  if (code === 'subscribe') {
    const why = err.cause && err.cause.message ? ` (${err.cause.message})` : '';
    return `This browser couldn't set up notifications${why}. Try again later. On Android, use Chrome; on iPhone or iPad, the app on the Home Screen.`;
  }
  if (code === 'server') {
    // The cloud module marks errors where the server answered (offline === false) — say what it said.
    if (err.cause && err.cause.offline === false && err.cause.message) {
      return `The server didn't accept this device (${err.cause.message}). Try again later.`;
    }
    return "Couldn't reach the server to register this device. Check the connection and try again.";
  }
  return `Something went wrong: ${(err && err.message) || err}`;
}

const whenText = (item, now) => {
  const t = Date.parse(item.sendAt);
  return `${dayText(t, now)} at ${timeText(t)}`;
};
/** A setting like '09:00' in the phone's own time format (as the time field shows it). */
const clockText = hm => {
  const [h, m] = String(hm).split(':').map(Number);
  return timeText(new Date(2000, 0, 1, h || 0, m || 0));
};

function Preview({ schedule, now }) {
  if (!schedule) return html`<p class="reminder-preview">Working out the next reminder…</p>`;
  const next = schedule.find(x => Date.parse(x.sendAt) > now);
  return html`<p class="reminder-preview">${next
    ? html`Next: ${whenText(next, now)} — <q>${next.body}</q>`
    : 'Nothing needs attention in the next two weeks, so no reminder is planned yet.'}</p>`;
}

export function RemindersSettings() {
  const { state, now } = useApp();
  const account = useAccount();
  const status = useReminderStatus();
  const [want, setWant] = useState(null); // where the switch is going while it is being switched
  const [problem, setProblem] = useState('');
  const [here, setHere] = useState(null); // does this device have a push subscription? (null = not known yet)
  const s = state.settings;
  const on = s.remindersOn === true;
  const support = pushSupport();
  const perm = permission();

  useEffect(() => {
    let live = true;
    currentSubscription().then(sub => live && setHere(!!sub), () => live && setHere(false));
    return () => { live = false; };
  }, [on, want]);
  useEffect(() => {
    if (on && account && !status.schedule) syncReminders();
  }, [on, account]);

  // Straight from the tap: enablePush() asks for the permission before anything else.
  const turnOn = async () => {
    setProblem('');
    setWant(true);
    try {
      await enablePush(account || 'me');
      updateSettings({ remindersOn: true });
      await syncReminders();
      showToast(`Daily reminder on, at ${clockText(s.reminderTime)}`);
    } catch (err) {
      setProblem(problemText(err));
    } finally {
      setWant(null);
    }
  };
  const turnOff = async () => {
    setProblem('');
    setWant(false);
    updateSettings({ remindersOn: false });
    try {
      await Promise.all([syncReminders(), disablePush().catch(() => {})]);
    } finally {
      setWant(null);
    }
  };
  const setTime = v => {
    updateSettings({ reminderTime: v });
    syncReminders();
  };
  const test = async () => {
    setProblem('');
    const next = status.schedule && status.schedule.find(x => Date.parse(x.sendAt) > Date.now());
    try {
      await showTestNotification(next
        ? `Notifications work. Next reminder ${whenText(next, Date.now())}: ${next.body}`
        : 'Notifications work on this device.');
    } catch (err) {
      setProblem(problemText(err));
    }
  };

  let body;
  if (support === 'ios-browser') {
    body = html`
      <p>To get reminders on iPhone or iPad, add Pantri to the Home Screen first: tap Share → <b>Add to Home Screen</b>, then open Pantri from the new icon.</p>
      <p class="hint">Needs iOS or iPadOS 16.4 or later.</p>`;
  } else if (support === 'unsupported') {
    body = html`
      <p>This browser can't show notifications from Pantri.</p>
      <p class="hint">${isIOS() ? 'iPhone and iPad need iOS or iPadOS 16.4 or later.' : 'On Android, use Chrome. On iPhone or iPad, add Pantri to the Home Screen.'}</p>`;
  } else if (support === 'no-key') {
    body = html`<p class="muted">Notifications aren't set up for this copy of Pantri.</p>`;
  } else if (!account) {
    body = html`
      <p>Get a reminder each day when something needs checking, has expired or should be used soon.</p>
      <p class="hint">Reminders are sent from your account, so sign in first.</p>
      <a class="btn primary block" href="#/account" onClick=${e => { e.preventDefault(); navigate('#/account'); }}>Sign in</a>`;
  } else if (perm === 'denied') {
    body = html`
      <p class="warn-text">Notifications are blocked for Pantri on this device.</p>
      <p class="hint">${unblockHelp()} Then come back here.</p>
      ${on && html`<button class="link-btn" onClick=${turnOff}>Stop the daily reminder</button>`}`;
  } else {
    body = html`
      <label class="switch">
        <input type="checkbox" checked=${want == null ? on : want} disabled=${want != null}
          onChange=${e => (e.target.checked ? turnOn() : turnOff())} />
        <span>Daily reminder</span>
      </label>
      <p class="hint">${on
        ? `Comes at ${clockText(s.reminderTime)} on days when something needs checking, has expired or should be used soon.`
        : 'One notification a day, only when something needs checking, has expired or should be used soon.'}</p>
      ${problem && html`<p class="error" role="alert">${problem}</p>`}
      ${on && html`
        <div class="field reminder-time">
          <label for="reminder-time">Time</label>
          <input id="reminder-time" class="input" type="time" value=${s.reminderTime}
            onChange=${e => e.target.value && setTime(e.target.value)} />
        </div>
        ${here === false && want == null && html`
          <p class="hint">This device doesn't get them yet.
            <button class="link-btn inline" onClick=${turnOn}>Get them here too</button></p>`}
        <${Preview} schedule=${status.schedule} now=${now} />
        ${status.error && html`<p class="hint warn-text">Couldn't update the reminders on the server. Trying again later.</p>`}
        <button class="btn block" onClick=${test}>Send a test notification</button>`}`;
  }

  return html`
    <section class="section">
      <h2 class="section-title">Notifications</h2>
      <div class="card pad reminders">${body}</div>
    </section>`;
}

// ---------- the offer: a popup suggesting the daily reminder ----------
// Browsers only show the permission prompt from a tap (iPhones only in the Home Screen app), so the
// popup explains first and its button asks. Shown on the Today screen at most once per app start, once
// there are products; "Not now" waits a week, "Don't ask again" (or turning it on) ends the offers.

const OFFER_KEY = 'pantri-reminder-offer'; // this device: { until } (wait) or { never: true }
const WEEK = 7 * 864e5;
let offeredThisRun = false;
let offering = false;
let accountId = null;
let resumeAfterSignIn = false; // the popup sent someone to sign in: offer again once they have

function readOffer() {
  try {
    return JSON.parse(localStorage.getItem(OFFER_KEY) || '{}') || {};
  } catch {
    return {};
  }
}
function writeOffer(value) {
  try {
    localStorage.setItem(OFFER_KEY, JSON.stringify(value));
  } catch { /* no storage: the offer simply comes back next time */ }
}

onAuth(session => {
  accountId = session ? (session.user && session.user.id) || 'me' : null;
  if (session && resumeAfterSignIn) {
    resumeAfterSignIn = false;
    setTimeout(() => offerReminders({ force: true, delay: 0 }), 800);
  }
});

/**
 * Which popup fits this device now: 'turn-on'; 'sign-in' (reminders come from an account); 'install'
 * (iPhone/iPad in a browser tab) — or null: not set up here, blocked, already on, or asked to wait.
 */
export async function offerKind(state, { now = Date.now(), force = false } = {}) {
  if (!cloudConfigured) return null;
  const pref = readOffer();
  if (!force && (pref.never || (pref.until && pref.until > now))) return null;
  const support = pushSupport();
  if (support === 'ios-browser') return 'install';
  if (support !== 'ok' || permission() === 'denied') return null;
  if (!isSignedIn()) return 'sign-in';
  if (state.settings.remindersOn && permission() === 'granted' && (await currentSubscription().catch(() => null))) return null;
  return 'turn-on';
}

/** Offer the daily reminder in a popup (on the Today screen, at most once per app start). */
export async function offerReminders({ force = false, delay = 1200 } = {}) {
  if (offering || (offeredThisRun && !force)) return;
  offering = true;
  try {
    if (delay) await new Promise(r => setTimeout(r, delay));
    const state = getState();
    if (!force && (currentRoute().name !== 'today' || !state.products.length)) return;
    if (currentRoute().name === 'scan' || currentSheets().length) return;
    const kind = await offerKind(state, { force });
    if (!kind || currentSheets().length) return;
    offeredThisRun = true;
    const answer = await ask(close => html`<${ReminderOffer} kind=${kind} close=${close} />`);
    if (answer === undefined) writeOffer({ until: Date.now() + WEEK }); // swiped away: ask again in a week
  } finally {
    offering = false;
  }
}

function ReminderOffer({ kind, close }) {
  const { state } = useApp();
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState('');
  const time = clockText(state.settings.reminderTime);
  const later = () => {
    writeOffer({ until: Date.now() + WEEK });
    close('later');
  };
  const never = () => {
    writeOffer({ never: true });
    close('never');
    showToast('You can turn the daily reminder on any time in Settings → Notifications.');
  };
  // Straight from the tap: enablePush() asks for the permission before anything else.
  const turnOn = async () => {
    setProblem('');
    setBusy(true);
    try {
      await enablePush(accountId || 'me');
      updateSettings({ remindersOn: true });
      await syncReminders();
      writeOffer({ never: true }); // from now on it's the switch in Settings
      close('on');
      showToast(`Daily reminder on, at ${time}`);
    } catch (err) {
      if (err && err.code === 'denied') writeOffer({ never: true });
      setProblem(problemText(err));
    } finally {
      setBusy(false);
    }
  };
  const signIn = () => {
    resumeAfterSignIn = true;
    close('sign-in').then(() => navigate('#/account'));
  };

  if (kind === 'install') {
    return html`
      <div class="sheet-pad offer">
        <div class="offer-icon"><${Icon} name="bell" size=${28} /></div>
        <h2>Reminders on iPhone or iPad</h2>
        <p>Pantri can send a daily reminder about what to check, what has expired and what to use soon.</p>
        <p>For that, add it to your Home Screen: tap Share → <b>Add to Home Screen</b>, then open Pantri from the new icon.</p>
        <p class="hint">Needs iOS or iPadOS 16.4 or later.</p>
        <button class="btn primary block" onClick=${later}>Got it</button>
        <button class="link-btn center" onClick=${never}>Don't ask again</button>
      </div>`;
  }
  return html`
    <div class="sheet-pad offer">
      <div class="offer-icon"><${Icon} name="bell" size=${28} /></div>
      <h2>${state.settings.remindersOn ? 'Get the daily reminder on this device too?' : 'Get a daily reminder?'}</h2>
      <p>One notification at ${time} on days when something needs checking, has expired or should be used soon. Nothing on quiet days.</p>
      ${kind === 'sign-in'
        ? html`
          <p class="hint">Reminders come from a free Pantri account, which also keeps your pantry backed up online.</p>
          <button class="btn primary block" onClick=${signIn}>Create an account or sign in</button>`
        : html`
          <p class="hint">You can change the time or switch it off in Settings.</p>
          ${problem && html`<p class="error" role="alert">${problem}</p>`}
          <button class="btn primary block" onClick=${turnOn} disabled=${busy}>${busy ? 'Turning on…' : 'Turn on reminders'}</button>`}
      <button class="btn block" onClick=${later}>Not now</button>
      <button class="link-btn center" onClick=${never}>Don't ask again</button>
    </div>`;
}
