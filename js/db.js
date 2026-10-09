// Persistence: the whole state is one IndexedDB record (falls back to localStorage if IndexedDB fails).

// Storage names predate the "Pantri" name; changing them would hide existing data, so they stay.
const DB_NAME = 'office-pantry';
const STORE = 'kv';
const KEY = 'state';
const LS_KEY = 'office-pantry-state';

let dbPromise = null;

function open() {
  dbPromise ||= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

async function run(mode, fn) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, mode);
    const req = fn(tx.objectStore(STORE));
    tx.oncomplete = () => resolve(req.result);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

const revOf = s => (s && s.meta && s.meta.rev) || 0;

export async function load() {
  let idb = null;
  let local = null;
  try {
    idb = (await run('readonly', s => s.get(KEY))) || null;
  } catch (e) {
    console.warn('IndexedDB unavailable, using localStorage', e);
  }
  try {
    const raw = localStorage.getItem(LS_KEY);
    local = raw ? JSON.parse(raw) : null;
  } catch { /* no localStorage */ }
  // A save may have fallen back to localStorage after IndexedDB failed: use the newer copy.
  return revOf(local) > revOf(idb) ? local : idb || local;
}

export async function save(state) {
  try {
    await run('readwrite', s => s.put(state, KEY));
  } catch (e) {
    localStorage.setItem(LS_KEY, JSON.stringify(state));
  }
}

/** Ask the browser not to evict our data under storage pressure. */
export async function requestPersistence() {
  try {
    if (await navigator.storage?.persisted?.()) return true;
    return (await navigator.storage?.persist?.()) || false;
  } catch {
    return false;
  }
}

export async function isPersisted() {
  try {
    return (await navigator.storage?.persisted?.()) || false;
  } catch {
    return false;
  }
}
