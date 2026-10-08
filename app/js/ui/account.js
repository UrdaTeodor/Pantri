// Account & online backup: sign in or create an account, sync status, choosing between two pantries,
// earlier versions, signing out and deleting the online data. Only shown when cloud.js is configured.

import { html, useState, useEffect, useReducer, focusOnMount } from './lib.js';
import { ask, showToast, pickSheet, confirmSheet } from './nav.js';
import { useApp, Header, Icon } from './kit.js';
import { ago, dateText, timeText } from '../format.js';
import {
  cloudStatus, onCloudStatus, signIn, signUp, signOut, sendPasswordReset, setNewPassword, syncNow, chooseCopy,
  listVersions, restoreVersion, deleteOnlineData,
} from '../cloud.js';

/** Re-render whenever the account or sync status changes. */
export function useCloudStatus() {
  const [, force] = useReducer(x => x + 1, 0);
  useEffect(() => onCloudStatus(force), []);
  return cloudStatus();
}

const products = n => `${n} product${n === 1 ? '' : 's'}`;
const when = (t, now) => (t ? ago(t, now) : 'unknown');

/** "Synced 2 min ago", "Not signed in", … */
export function statusText(st, now) {
  if (!st.signedIn) return 'Not signed in';
  if (st.phase === 'syncing') return 'Syncing…';
  if (st.phase === 'choose') return 'Choose which pantry to keep';
  if (st.phase === 'offline') return 'Offline: changes upload when you are back online';
  if (st.phase === 'error') return `Couldn't sync: ${st.message}`;
  if (st.pending) return 'Changes waiting to upload…';
  return st.syncedAt ? `Synced ${ago(st.syncedAt, now)}` : 'Signed in';
}

/** The status line in the More menu. */
export function CloudStatusText() {
  const { now } = useApp();
  return statusText(useCloudStatus(), now);
}

function StatusLine({ st, now }) {
  const tone = st.phase === 'syncing' || (st.pending && st.phase === 'synced') ? 'busy'
    : ['offline', 'error', 'choose'].includes(st.phase) ? 'warn' : 'ok';
  return html`<p class="sync-line" role="status"><span class=${`sync-dot ${tone}`}></span><span>${statusText(st, now)}</span></p>`;
}

// ---------- choosing between this phone's pantry and the online one ----------

function ChoiceButtons({ choice, now, onDone }) {
  const pick = async which => {
    try {
      await chooseCopy(which);
      showToast(which === 'local' ? "Kept this phone's pantry" : 'Your pantry was taken from your account');
      onDone();
    } catch (e) {
      showToast(e.message);
    }
  };
  const { local, remote } = choice;
  return html`
    <div class="menu">
      <button class="menu-item" onClick=${() => pick('local')}>
        <span>Keep this phone's pantry</span>
        <small>${products(local.products)} · last change ${when(local.changedAt, now)}</small>
      </button>
      <button class="menu-item" onClick=${() => pick('remote')}>
        <span>Use the online pantry</span>
        <small>${products(remote.products)} · last change ${when(remote.changedAt, now)}${remote.device ? ` on ${remote.device}` : ''}</small>
      </button>
    </div>
    <p class="hint">The other one isn't lost: it is kept under Earlier versions.</p>`;
}

const CHOICE_TITLE = 'This phone and your account both have a pantry. Which one do you want to keep?';

function openChoice(choice) {
  return ask(close => html`
    <div class="sheet-pad">
      <h2>${CHOICE_TITLE}</h2>
      <${ChoiceButtons} choice=${choice} now=${Date.now()} onDone=${() => close(true)} />
    </div>`);
}

/** After signing in: sync, and ask right away if both sides have a pantry. */
async function afterSignIn() {
  await syncNow();
  const st = cloudStatus();
  if (st.phase === 'choose') openChoice(st.choice);
}

// ---------- signed out ----------

function SignInForm() {
  const [mode, setMode] = useState('in');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const creating = mode === 'up';

  const submit = async e => {
    e.preventDefault();
    setError('');
    if (creating && password.length < 8) return setError('Use at least 8 characters for the password.');
    setBusy(true);
    try {
      if (creating) {
        const { needsConfirmation } = await signUp(email.trim(), password);
        if (needsConfirmation) {
          setMode('in');
          return showToast('Check your email and open the link to confirm the account, then sign in.', { timeout: 10000 });
        }
        showToast('Account created');
      } else {
        await signIn(email.trim(), password);
        showToast('Signed in');
      }
      await afterSignIn();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  const forgot = async () => {
    setError('');
    if (!/^\S+@\S+\.\S+$/.test(email.trim())) return setError('Type your email address first, then tap “Forgot your password?” again.');
    try {
      await sendPasswordReset(email.trim());
      showToast('Email sent. Open the link in it to choose a new password.', { timeout: 10000 });
    } catch (err) {
      setError(err.message);
    }
  };

  return html`
    <form class="card pad" onSubmit=${submit}>
      <div class="seg" role="tablist">
        <button type="button" role="tab" aria-selected=${!creating} class=${creating ? '' : 'on'} onClick=${() => setMode('in')}>Sign in</button>
        <button type="button" role="tab" aria-selected=${creating} class=${creating ? 'on' : ''} onClick=${() => setMode('up')}>Create account</button>
      </div>
      <div class="field account-field">
        <label for="acc-email">Email</label>
        <input id="acc-email" class="input" type="email" autocomplete="email" inputmode="email" required
          value=${email} onInput=${e => setEmail(e.target.value)} />
      </div>
      <div class="field">
        <label for="acc-password">Password</label>
        <input id="acc-password" class="input" type="password" required minlength=${creating ? 8 : null}
          autocomplete=${creating ? 'new-password' : 'current-password'}
          value=${password} onInput=${e => setPassword(e.target.value)} />
        ${creating && html`<p class="hint">At least 8 characters.</p>`}
      </div>
      ${error && html`<p class="error" role="alert">${error}</p>`}
      <button class="btn primary block" disabled=${busy}>${busy ? 'One moment…' : creating ? 'Create account' : 'Sign in'}</button>
      ${!creating && html`<button type="button" class="link-btn center" onClick=${forgot}>Forgot your password?</button>`}
    </form>`;
}

function SignedOut() {
  return html`
    <div class="card pad">
      <p>With an account, a copy of your pantry is kept online: it is backed up, and you can sign in on another phone to use the same pantry there.</p>
      <p class="muted">It's optional. Without an account, everything stays on this phone.</p>
    </div>
    <section class="section"><${SignInForm} /></section>`;
}

// ---------- signed in ----------

function NewPassword() {
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const save = async e => {
    e.preventDefault();
    if (password.length < 8) return setError('Use at least 8 characters.');
    try {
      await setNewPassword(password);
      showToast('Password changed. Use it to sign in on your other devices.', { timeout: 8000 });
    } catch (err) {
      setError(err.message);
    }
  };
  return html`
    <form class="card pad" onSubmit=${save}>
      <h2 class="card-title">Choose a new password</h2>
      <div class="field">
        <label for="acc-new-password">New password</label>
        <input id="acc-new-password" class="input" type="password" autocomplete="new-password" minlength="8" required
          ref=${focusOnMount} value=${password} onInput=${e => setPassword(e.target.value)} />
      </div>
      ${error && html`<p class="error" role="alert">${error}</p>`}
      <button class="btn primary block">Save password</button>
    </form>`;
}

const REASON = {
  checkpoint: 'Automatic copy',
  'other-device': 'Before another device saved',
  shrink: 'Before many products were removed',
  conflict: 'Kept after a conflict',
  'first-sync': 'Replaced when a phone signed in',
  restore: 'Before restoring an earlier version',
};

function Versions({ now }) {
  const [list, setList] = useState(null);
  const [error, setError] = useState('');
  const load = async () => {
    setError('');
    try {
      setList(await listVersions());
    } catch (e) {
      setError(e.offline ? 'No connection. Try again when you are online.' : e.message);
    }
  };
  const restore = async v => {
    const at = `${dateText(v.savedAt, now)} ${timeText(v.savedAt)}`;
    if (!(await confirmSheet({
      title: `Restore the version from ${at}?`,
      body: `It has ${products(v.products)}. It becomes your pantry on every device; the current one is kept as an earlier version.`,
      ok: 'Restore',
    }))) return;
    try {
      await restoreVersion(v.id);
      showToast('Earlier version restored');
      load();
    } catch (e) {
      showToast(e.message);
    }
  };
  return html`
    <section class="section">
      <h2 class="section-title">Earlier versions</h2>
      <p class="section-hint">Copies kept online: now and then, and whenever one copy replaced another. Restoring one makes it your pantry on every device.</p>
      ${list === null ? html`
        <button class="btn block" onClick=${load}><${Icon} name="clock" size=${18} /> Show earlier versions</button>`
      : list.length ? html`
        <div class="card list">
          ${list.map(v => html`
            <button class="row" key=${v.id} onClick=${() => restore(v)}>
              <span class="row-main">
                <span class="row-title">${dateText(v.savedAt, now)} ${timeText(v.savedAt)}</span>
                <span class="row-sub">${products(v.products)} · ${REASON[v.reason] || v.reason}${v.device ? ` · ${v.device}` : ''}</span>
              </span>
              <span class="chip">Restore</span>
            </button>`)}
        </div>`
      : html`<p class="muted small">No earlier versions yet.</p>`}
      ${error && html`<p class="error" role="alert">${error}</p>`}
    </section>`;
}

function SignedIn({ st, now }) {
  const [syncing, setSyncing] = useState(false);
  const sync = async () => {
    setSyncing(true);
    await syncNow();
    setSyncing(false);
    const after = cloudStatus();
    if (after.phase === 'choose') openChoice(after.choice);
  };

  const out = async () => {
    const v = await pickSheet({
      title: 'Sign out',
      options: [
        { label: 'Sign out', sub: 'The pantry stays on this phone', value: 'keep' },
        { label: 'Sign out and remove the pantry from this phone', sub: 'The online copy stays in your account', value: 'remove', danger: true },
      ],
    });
    if (!v) return;
    if (v === 'remove') {
      await syncNow();
      const left = cloudStatus();
      if (left.pending && !(await confirmSheet({
        title: 'Some changes are not online yet',
        body: 'They were made on this phone and could not be uploaded, so removing the pantry from this phone loses them.',
        ok: 'Remove anyway',
        danger: true,
      }))) return;
    }
    try {
      await signOut({ removeData: v === 'remove' });
      showToast(v === 'remove' ? 'Signed out. The pantry was removed from this phone.' : 'Signed out. The pantry stays on this phone.');
    } catch (e) {
      showToast(e.message);
    }
  };

  const remove = async () => {
    if (!(await confirmSheet({
      title: 'Delete your online data?',
      body: 'The online copy of your pantry, its earlier versions and your reminders are deleted, and this phone is signed out. The pantry on this phone stays. Your account itself remains: signing in again starts afresh.',
      ok: 'Delete online data',
      danger: true,
    }))) return;
    try {
      await deleteOnlineData();
      showToast('Online data deleted. The pantry is still on this phone.', { timeout: 8000 });
    } catch (e) {
      showToast(e.offline ? 'No connection. Try again when you are online.' : e.message);
    }
  };

  return html`
    ${st.recovering && html`<${NewPassword} />`}
    <div class="card pad">
      <p class="muted small">Signed in as</p>
      <p class="account-email">${st.email}</p>
      <${StatusLine} st=${st} now=${now} />
      <button class="btn block" disabled=${syncing || st.phase === 'syncing'} onClick=${sync}>
        <${Icon} name="upload" size=${18} /> Sync now
      </button>
    </div>
    ${st.phase === 'choose' && st.choice && html`
      <section class="section">
        <div class="card pad">
          <h2 class="card-title">${CHOICE_TITLE}</h2>
          <${ChoiceButtons} choice=${st.choice} now=${now} onDone=${() => {}} />
        </div>
      </section>`}
    <${Versions} now=${now} />
    <section class="section">
      <button class="btn block" onClick=${out}>Sign out</button>
    </section>
    <section class="section">
      <h2 class="section-title danger-text">Danger zone</h2>
      <button class="btn danger block" onClick=${remove}><${Icon} name="trash" size=${18} /> Delete my online data</button>
    </section>`;
}

export function Account() {
  const { now } = useApp();
  const st = useCloudStatus();
  return html`
    <${Header} title="Account & online backup" back="#/more" />
    <main class="page">
      ${st.signedIn ? html`<${SignedIn} st=${st} now=${now} />` : html`<${SignedOut} />`}
    </main>`;
}
