// Putting short texts (a product's ingredients) into English: with the browser's own on-device
// translator where there is one (Chrome's Translator API: nothing leaves the phone), otherwise with the
// free MyMemory service (only when online lookups are allowed; about 5000 characters a day per phone).

const MYMEMORY = 'https://api.mymemory.translated.net/get';
const MAX_BYTES = 480; // MyMemory takes at most 500 bytes per request

const bytes = s => new TextEncoder().encode(s).length;

/** Pieces of `text` of at most `max` UTF-8 bytes, split after sentences, then commas, then spaces. */
export function chunks(text, max = MAX_BYTES) {
  const out = [];
  let rest = String(text || '').trim();
  while (rest) {
    if (bytes(rest) <= max) {
      out.push(rest);
      break;
    }
    // The longest prefix that fits, cut at the last good break inside it.
    let fit = 0;
    for (let i = 1; i <= rest.length && bytes(rest.slice(0, i)) <= max; i++) fit = i;
    const head = rest.slice(0, fit);
    const cut = Math.max(head.lastIndexOf('. '), head.lastIndexOf('; ')) + 1
      || head.lastIndexOf(', ') + 1
      || head.lastIndexOf(' ')
      || fit;
    out.push(rest.slice(0, cut > 0 ? cut : fit).trim());
    rest = rest.slice(cut > 0 ? cut : fit).trim();
  }
  return out;
}

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", '#39': "'" };
const decode = s => String(s).replace(/&(#\d+|#x[0-9a-f]+|[a-z]+);/gi, (m, e) => {
  if (e[0] === '#') return String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : Number(e.slice(1)));
  return ENTITIES[e.toLowerCase()] ?? m;
});

/** With the browser's on-device translator (Chrome 138+ where available), or null. */
async function onDevice(text, from) {
  const T = globalThis.Translator;
  if (!from || !T || typeof T.create !== 'function') return null;
  try {
    const options = { sourceLanguage: from, targetLanguage: 'en' };
    if (typeof T.availability === 'function' && (await T.availability(options)) === 'unavailable') return null;
    const translator = await T.create(options); // may need a tap to download a language: then MyMemory
    try {
      return await translator.translate(text);
    } finally {
      if (typeof translator.destroy === 'function') translator.destroy();
    }
  } catch {
    return null;
  }
}

/** With MyMemory, piece by piece. Throws when it can't (offline, daily limit). */
async function myMemory(text, from) {
  const out = [];
  for (const piece of chunks(text)) {
    const url = `${MYMEMORY}?q=${encodeURIComponent(piece)}&langpair=${encodeURIComponent(from || 'Autodetect')}%7Cen`;
    const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
    if (!res.ok) throw new Error(`Translation failed (HTTP ${res.status})`);
    const j = await res.json();
    const t = j && j.responseData && j.responseData.translatedText;
    if (Number(j.responseStatus) !== 200 || !t || j.quotaFinished || /MYMEMORY WARNING/i.test(t)) {
      throw new Error((j && j.responseDetails) || 'Translation failed');
    }
    out.push(decode(t).trim());
  }
  return out.join(' ');
}

/**
 * `text` in English, or null when it can't be translated now. `from` is the language it is in (ISO
 * 639-1, e.g. 'ru'), if known; `online: false` keeps it on the phone (no MyMemory).
 */
export async function toEnglish(text, from, { online = true } = {}) {
  const t = String(text || '').trim();
  if (!t || from === 'en') return t;
  const local = await onDevice(t, from);
  if (local) return local.trim();
  if (!online) return null;
  try {
    return await myMemory(t, from);
  } catch {
    return null;
  }
}

/** "Russian" for 'ru' (or the code itself when the browser doesn't know it). */
export function languageName(code) {
  try {
    return new Intl.DisplayNames(['en'], { type: 'language' }).of(code) || code;
  } catch {
    return code;
  }
}
