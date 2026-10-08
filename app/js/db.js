// Persistence: the whole state is one IndexedDB record (falls back to localStorage if IndexedDB fails).

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

export async function load() {
  try {
    const value = await run('readonly', s => s.get(KEY));
    if (value) return value;
  } catch (e) {
    console.warn('IndexedDB unavailable, using localStorage', e);
  }
  const raw = localStorage.getItem(LS_KEY);
  return raw ? JSON.parse(raw) : null;
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
