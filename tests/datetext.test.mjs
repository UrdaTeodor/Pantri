// Reading the expiry date out of OCR text (app/js/datetext.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findExpiry, findDates, monthFirstLocale, CONFIDENT } from '../app/js/datetext.js';

const NOW = new Date(2026, 9, 12, 10, 0).getTime(); // Monday 12 October 2026
const read = (text, opts = {}) => {
  const hit = findExpiry(text, { now: NOW, ...opts });
  return hit && hit.date;
};

test('common printed formats', () => {
  assert.equal(read('EXP 12.05.2027'), '2027-05-12');
  assert.equal(read('12/05/27'), '2027-05-12');
  assert.equal(read('12-5-2027'), '2027-05-12');
  assert.equal(read('2027-05-12'), '2027-05-12');
  assert.equal(read('12 05 2027'), '2027-05-12');
  assert.equal(read('BB 05/27'), '2027-05-31'); // month and year: the end of the month
  assert.equal(read('BEST BEFORE END 11 2026'), '2026-11-30');
  assert.equal(read('EXP 120527'), '2027-05-12'); // dot-matrix without separators, after a keyword
  assert.equal(read('27.05.12'), '2027-05-12'); // year first, when day first can't be right
  assert.equal(read('12.05.2027 14:32 L2304'), '2027-05-12');
});

test('month names, in several languages', () => {
  assert.equal(read('12 MAY 2027'), '2027-05-12');
  assert.equal(read('BBE 31 DEC 2026'), '2026-12-31');
  assert.equal(read('12MAY27'), '2027-05-12');
  assert.equal(read('15 MARTIE 2027'), '2027-03-15');
  assert.equal(read('A consommer de préférence avant fin: juin 2027'), '2027-06-30');
  assert.equal(read('MAI 2027'), '2027-05-31');
  assert.equal(read('Best by May 12, 2027'), '2027-05-12');
  assert.equal(read('JUNGLE 25'), null); // not a month
  assert.equal(read('MARGARINE 50'), null);
});

test('keywords pick the expiry date over the production date', () => {
  assert.equal(read('PROD 01.03.2026 EXP 01.03.2027'), '2027-03-01');
  assert.equal(read('EXP 01.03.2027 PROD 01.03.2026'), '2027-03-01');
  assert.equal(read('PROD: 01.03.2026 01.03.2027'), '2027-03-01');
  assert.equal(read('Data fabricației: 02.10.2026\nA se consuma de preferință înainte de: 02.04.2027'), '2027-04-02');
  assert.equal(read('12.03.2026 12.03.2027'), '2027-03-12'); // no words: the later one
  assert.equal(read('MINDESTENS HALTBAR BIS: 30.06.2027'), '2027-06-30');
  assert.equal(read('EXPIRA LA: 15.11.2026'), '2026-11-15');
  assert.ok(findExpiry('EXP 12.05.2027', { now: NOW }).score >= CONFIDENT);
  assert.ok(findExpiry('A SE CONSUMA INAINTE DE: 12.05.2027 L2304', { now: NOW }).score >= CONFIDENT);
  assert.ok(findExpiry('12.05.2027', { now: NOW }).score < CONFIDENT); // no keyword: wait for a second reading
});

test('OCR mistakes and noise', () => {
  assert.equal(read('12.O5.2O27'), '2027-05-12');
  assert.equal(read('I2/05/2027'), '2027-05-12');
  assert.equal(read('EXP: 12.05.2027'.replace(/\./g, '·')), '2027-05-12');
  assert.equal(read('LOT 12345 NET WT 500G'), null);
  assert.equal(read(''), null);
  assert.equal(read('12.05.1999'), null); // years that make no sense for an expiry date
  assert.equal(read('31.02.2027'), null); // no such day
});

test('day or month first', () => {
  assert.equal(read('05/12/2027'), '2027-12-05');
  assert.equal(read('05/12/2027', { monthFirst: true }), '2027-05-12');
  assert.equal(read('12.05.2027', { monthFirst: true }), '2027-05-12'); // dots: day first, even in the US
  assert.equal(read('05/13/2027'), '2027-05-13'); // 13 can only be the day
  assert.equal(read('13/05/2027', { monthFirst: true }), '2027-05-13');
  assert.equal(monthFirstLocale('en-US'), true);
  assert.equal(monthFirstLocale('en-GB'), false);
  assert.equal(monthFirstLocale('ro-RO'), false);
  assert.equal(monthFirstLocale('en'), false);
});

test('all dates are listed, best first', () => {
  const all = findDates('PROD 01.03.2026 EXP 01.03.2027', { now: NOW });
  assert.deepEqual(all.map(d => d.date), ['2027-03-01', '2026-03-01']);
  assert.equal(all[0].raw, '01.03.2027');
});
