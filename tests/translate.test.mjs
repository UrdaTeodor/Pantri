// Putting ingredients into English (app/js/translate.js): the on-device translator first, then MyMemory.
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { chunks, toEnglish, languageName } from '../app/js/translate.js';

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
  delete globalThis.Translator;
});

/** A fake MyMemory: translates by looking each piece up in `table`; records the requests. */
function fakeMyMemory(table, { status = 200, warning = false } = {}) {
  const calls = [];
  globalThis.fetch = async url => {
    const u = new URL(url);
    calls.push({ q: u.searchParams.get('q'), langpair: u.searchParams.get('langpair') });
    const q = u.searchParams.get('q');
    const translatedText = warning ? 'MYMEMORY WARNING: YOU USED ALL AVAILABLE FREE TRANSLATIONS FOR TODAY' : table[q] ?? `[${q}]`;
    return new Response(JSON.stringify({ responseStatus: status, responseData: { translatedText } }), { status: 200 });
  };
  return calls;
}

test('long texts are split into pieces of at most 480 bytes, at sentence or comma breaks', () => {
  const ru = 'вода, сахар, соль, '.repeat(40).trim(); // Cyrillic: 2 bytes a letter
  const parts = chunks(ru);
  assert.ok(parts.length > 1);
  for (const part of parts) assert.ok(new TextEncoder().encode(part).length <= 480, part.length);
  assert.ok(parts.slice(0, -1).every(part => part.endsWith(',')));
  assert.equal(parts.join(' '), ru);
  assert.deepEqual(chunks('Short.'), ['Short.']);
  assert.deepEqual(chunks(''), []);
});

test('MyMemory: the source language, entities decoded, pieces put back together', async () => {
  const calls = fakeMyMemory({ 'вода, сахар': 'water, sugar &amp; salt &#39;x&#39;' });
  assert.equal(await toEnglish('вода, сахар', 'ru'), "water, sugar & salt 'x'");
  assert.deepEqual(calls, [{ q: 'вода, сахар', langpair: 'ru|en' }]);

  const unknownLanguage = fakeMyMemory({});
  await toEnglish('agua', undefined);
  assert.equal(unknownLanguage[0].langpair, 'Autodetect|en');
});

test('no translation: daily limit, errors, offline, online lookups off, already English', async () => {
  fakeMyMemory({}, { warning: true });
  assert.equal(await toEnglish('вода', 'ru'), null);
  fakeMyMemory({}, { status: 403 });
  assert.equal(await toEnglish('вода', 'ru'), null);
  globalThis.fetch = async () => { throw new TypeError('Failed to fetch'); };
  assert.equal(await toEnglish('вода', 'ru'), null);
  const calls = fakeMyMemory({ 'вода': 'water' });
  assert.equal(await toEnglish('вода', 'ru', { online: false }), null);
  assert.equal(calls.length, 0);
  assert.equal(await toEnglish('Water, salt.', 'en'), 'Water, salt.');
});

test("the browser's own translator comes first, and nothing is sent", async () => {
  const calls = fakeMyMemory({});
  const made = [];
  globalThis.Translator = {
    availability: async () => 'available',
    create: async options => {
      made.push(options);
      return { translate: async text => `EN(${text})`, destroy() {} };
    },
  };
  assert.equal(await toEnglish('вода', 'ru', { online: false }), 'EN(вода)');
  assert.deepEqual(made, [{ sourceLanguage: 'ru', targetLanguage: 'en' }]);
  assert.equal(calls.length, 0);

  globalThis.Translator = { availability: async () => 'unavailable', create: async () => { throw new Error('no'); } };
  fakeMyMemory({ 'вода': 'water' });
  assert.equal(await toEnglish('вода', 'ru'), 'water'); // falls back to MyMemory
});

test('language names', () => {
  assert.equal(languageName('ru'), 'Russian');
  assert.equal(languageName('ro'), 'Romanian');
});
