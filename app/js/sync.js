// Online sync of the pantry: the whole state object is stored online, one copy per account, and saved
// with compare-and-swap on a server revision. Pure decisions (plan, resolve) plus a small engine that
// carries them out. No DOM and no network code: cloud.js passes in the server calls, tests pass fakes.

/** Meta fields that only concern this phone: never uploaded, kept when the online copy is taken. */
const LOCAL_META = ['rev', 'siteId', 'lastBackupAt'];

/** What is stored online: the state without this phone's own meta fields. */
export function payloadOf(state) {
  const meta = { ...(state.meta || {}) };
  for (const k of LOCAL_META) delete meta[k];
  return { ...state, meta };
}

/** The online copy with this phone's own meta fields (site being shown, last backup file) kept. */
export function withLocalMeta(remote, local) {
  const meta = { ...(remote.meta || {}) };
  for (const k of LOCAL_META) {
    const mine = k !== 'rev' && local && local.meta ? local.meta[k] : undefined;
    if (mine !== undefined) meta[k] = mine;
    else delete meta[k];
  }
  return { ...remote, meta };
}

/** JSON with object keys sorted, so equal content always gives equal text (Postgres reorders keys). */
export function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(v => (v === undefined ? 'null' : canonicalJson(v))).join(',')}]`;
  const keys = Object.keys(value).filter(k => value[k] !== undefined).sort();
  return `{${keys.map(k => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(',')}}`;
}

/** A 53-bit fingerprint of a string (two multiply-xor lanes, mixed at the end). */
function fingerprint(text) {
  let a = 0xdeadbeef;
  let b = 0x41c6ce57;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    a = Math.imul(a ^ c, 2654435761);
    b = Math.imul(b ^ c, 1597334677);
  }
  a = Math.imul(a ^ (a >>> 16), 2246822507) ^ Math.imul(b ^ (b >>> 13), 3266489909);
  b = Math.imul(b ^ (b >>> 16), 2246822507) ^ Math.imul(a ^ (a >>> 13), 3266489909);
  return (2097151 & b) * 4294967296 + (a >>> 0);
}

/** Fingerprint of what would be stored online: tells whether two copies have the same content. */
export const contentHash = state => fingerprint(canonicalJson(payloadOf(state))).toString(36);

/** Best guess of when a copy was last changed, from its own data (ms, or null). */
export function lastChange(state) {
  let t = (state.meta && state.meta.createdAt) || 0;
  for (const e of state.events || []) if (e.at > t) t = e.at;
  for (const p of state.products || []) t = Math.max(t, p.touchedAt || 0, p.createdAt || 0);
  return t || null;
}

/**
 * The next step, from how the online copy compares with the one this phone last synced with.
 *   baseRev        online revision this phone's copy is based on (0: never synced with this account)
 *   dirty          this phone has changes that aren't online yet
 *   remote         { rev } of the online copy, or null when the account has none
 *   localProducts  how many products this phone has
 * Returns 'none' | 'upload' | 'pull' | 'compare' (fetch the online copy, then resolve()) | 'gone' (the
 * online copy this phone was synced with was deleted, e.g. "Delete my online data" on another device).
 */
export function plan({ baseRev, dirty, remote, localProducts }) {
  if (!remote) return baseRev > 0 ? 'gone' : 'upload';
  if (remote.rev === baseRev) return dirty ? 'upload' : 'none';
  if (baseRev === 0) return localProducts === 0 ? 'pull' : 'compare'; // first sync after signing in
  return dirty ? 'compare' : 'pull';
}

/**
 * Both this phone and the online copy may hold changes: which one stays.
 * On the first sync after signing in, an empty side gives way and otherwise the user is asked;
 * later, the copy changed most recently wins (the other one goes into the online history).
 * Returns 'same' | 'keep-local' | 'keep-remote' | 'ask'.
 */
export function resolve({ firstSync, sameContent, localProducts, remoteProducts, localChangedAt, remoteChangedAt }) {
  if (sameContent) return 'same';
  if (firstSync) {
    if (!remoteProducts) return 'keep-local';
    if (!localProducts) return 'keep-remote';
    return 'ask';
  }
  return (localChangedAt || 0) >= (remoteChangedAt || 0) ? 'keep-local' : 'keep-remote';
}

/**
 * The sync engine.
 *   api    { head(), fetch(), save({ state, baseRev, changedAt, reason }), stash({ state, changedAt, reason }) }
 *          head() → { rev, changedAt, device, products } or null; fetch() → { state, rev, changedAt, device } or
 *          null; save() → { ok, rev, reason }. Errors reject.
 *   store  { getState(), replaceState(next) → the state now in use }
 *   meta   { load(), save(meta) }: this phone's bookkeeping { baseRev, syncedRev, hash, changedAt, syncedAt }
 */
export function createSync({ api, store, meta, now = () => Date.now(), hash = contentHash }) {
  let applying = false;
  const update = patch => meta.save({ ...meta.load(), ...patch });

  /** Take the online copy (no undo step), keeping this phone's own meta fields. */
  function apply(remote) {
    applying = true;
    let applied;
    try {
      applied = store.replaceState(withLocalMeta(remote.state, store.getState()));
    } finally {
      applying = false;
    }
    update({ baseRev: remote.rev, syncedRev: applied.meta.rev || 0, hash: hash(applied), changedAt: null, syncedAt: now() });
    return applied;
  }

  async function upload(local, baseRev, localHash, changedAt, reason = null) {
    const r = await api.save({ state: payloadOf(local), baseRev, changedAt, reason });
    if (r.ok) update({ baseRev: r.rev, syncedRev: local.meta.rev || 0, hash: localHash, syncedAt: now() });
    return r;
  }

  /**
   * One sync: upload, download or settle a conflict. Resolves to { action, ... } where action is
   * 'none' | 'uploaded' | 'pulled' | 'same' | 'kept-local' | 'kept-remote' (with `conflict` / `firstSync`)
   * | 'ask' (with `local` and `remote` summaries; call again with choice 'local' | 'remote') | 'gone'.
   */
  async function syncOnce({ choice = null } = {}) {
    for (let round = 0; round < 4; round++) {
      const m = meta.load();
      const local = store.getState();
      const localRev = local.meta.rev || 0;
      const localHash = hash(local);
      let dirty = localRev !== m.syncedRev;
      if (dirty && m.baseRev > 0 && localHash === m.hash) {
        update({ syncedRev: localRev }); // only this phone's own fields changed
        dirty = false;
      }
      const head = await api.head();
      if (store.getState() !== local) continue; // changed meanwhile: look again
      const step = plan({ baseRev: m.baseRev, dirty, remote: head, localProducts: local.products.length });
      if (step === 'none') {
        update({ syncedAt: now() });
        return { action: 'none' };
      }
      if (step === 'gone') return { action: 'gone' };
      const localChangedAt = m.changedAt || lastChange(local) || now();
      if (step === 'upload') {
        if ((await upload(local, m.baseRev, localHash, localChangedAt)).ok) return { action: 'uploaded' };
        continue; // another device saved first, or the online copy was deleted: look again
      }

      const remote = await api.fetch();
      if (!remote || store.getState() !== local) continue;
      if (step === 'pull') {
        apply(remote);
        return { action: 'pulled' };
      }
      const firstSync = m.baseRev === 0;
      let decision = resolve({
        firstSync,
        sameContent: localHash === hash(remote.state),
        localProducts: local.products.length,
        remoteProducts: remote.state.products.length,
        localChangedAt,
        remoteChangedAt: remote.changedAt,
      });
      if (decision === 'ask' && choice) decision = choice === 'local' ? 'keep-local' : 'keep-remote';
      if (decision === 'same') {
        update({ baseRev: remote.rev, syncedRev: localRev, hash: localHash, syncedAt: now() });
        return { action: 'same' };
      }
      if (decision === 'ask') {
        return {
          action: 'ask',
          local: { products: local.products.length, changedAt: localChangedAt },
          remote: { products: remote.state.products.length, changedAt: remote.changedAt, device: remote.device || '' },
        };
      }
      const reason = firstSync ? 'first-sync' : 'conflict';
      if (decision === 'keep-local') {
        // The server keeps the online copy it replaces in the history (reason given).
        if ((await upload(local, remote.rev, localHash, localChangedAt, reason)).ok) {
          return { action: 'kept-local', conflict: !firstSync, firstSync };
        }
        continue;
      }
      // keep-remote: first put this phone's copy into the online history, then take the online copy.
      if (!firstSync || local.products.length) await api.stash({ state: payloadOf(local), changedAt: localChangedAt, reason });
      if (store.getState() !== local) continue;
      apply(remote);
      return { action: 'kept-remote', conflict: !firstSync, firstSync };
    }
    throw new Error('The online copy kept changing. Try again in a moment.');
  }

  return {
    syncOnce,
    apply,
    /** A change was made on this phone (ignored while the online copy is being applied). */
    noteLocalChange() {
      if (!applying) update({ changedAt: now() });
    },
    /** This phone may have changes that aren't online yet. */
    isDirty() {
      const s = store.getState();
      return !!s && (s.meta.rev || 0) !== meta.load().syncedRev;
    },
  };
}
