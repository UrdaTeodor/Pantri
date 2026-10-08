// Display formatting: quantities, units, dates relative to today.

import { daysUntil, parseYmd } from './model.js';

const num = new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 });
const dShort = new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short' });
const dLong = new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
const dFull = new Intl.DateTimeFormat(undefined, { weekday: 'long', day: 'numeric', month: 'long' });
const wday = new Intl.DateTimeFormat(undefined, { weekday: 'short' });
const time = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' });

export const fmtNum = n => num.format(n);

const NO_PLURAL = /^(kg|g|mg|l|ml|cl|dl|oz|lb|pcs|pc|x)$/i;
export function plural(unit, n) {
  const u = (unit || 'pcs').trim();
  if (n === 1 && u === 'pcs') return 'pc';
  if (n === 1 || NO_PLURAL.test(u) || /[^a-z]$/i.test(u) || /s$/i.test(u)) return u;
  if (/(x|ch|sh)$/i.test(u)) return u + 'es';
  if (/[^aeiou]y$/i.test(u)) return u.slice(0, -1) + 'ies';
  return u + 's';
}

/** "12 bottles", "~3 bags" (approx = estimated from usage). */
export function qtyText(n, unit, approx = false) {
  const r = Math.max(0, Math.round(n));
  return `${approx && r > 0 ? '~' : ''}${r} ${plural(unit, r)}`;
}

export function dateText(t, now) {
  const d = new Date(t);
  return d.getFullYear() === new Date(now).getFullYear() ? dShort.format(d) : dLong.format(d);
}
export const longDate = t => dFull.format(new Date(t));
export const timeText = t => time.format(new Date(t));

/** "today", "tomorrow", "Fri", "in 12 days" / "yesterday", "3 days ago", or a date. */
export function dayText(t, now) {
  const n = daysUntil(t, now);
  if (n === 0) return 'today';
  if (n === 1) return 'tomorrow';
  if (n === -1) return 'yesterday';
  if (n > 1 && n < 7) return wday.format(new Date(t));
  if (n < -1 && n > -7) return `${-n} days ago`;
  return dateText(t, now);
}

/** Phrase for a printed expiry date ('YYYY-MM-DD'). */
export function expiryText(expiry, now) {
  const t = parseYmd(expiry);
  const n = daysUntil(t, now);
  if (n < -1) return `expired ${n > -7 ? `${-n} days ago` : `on ${dateText(t, now)}`}`;
  if (n === -1) return 'expired yesterday';
  if (n === 0) return 'expires today';
  if (n === 1) return 'expires tomorrow';
  if (n < 7) return `expires ${wday.format(new Date(t))} (in ${n} days)`;
  return `expires ${dateText(t, now)}`;
}

/** Short expiry chip text: "Fri", "12 Nov", "expired". */
export function expiryShort(expiry, now) {
  const t = parseYmd(expiry);
  const n = daysUntil(t, now);
  if (n < 0) return 'expired';
  if (n === 0) return 'today';
  if (n === 1) return 'tomorrow';
  if (n < 7) return wday.format(new Date(t));
  return dateText(t, now);
}

export const PER_LABEL = { day: 'office day', week: 'week', month: 'month' };
export function rateText(rate) {
  return rate && rate.qty > 0 ? `${fmtNum(rate.qty)} per ${PER_LABEL[rate.per] || rate.per}` : 'not tracked';
}

export function ago(t, now) {
  const mins = Math.round((now - t) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  const n = daysUntil(t, now);
  if (n === 0) return `today ${timeText(t)}`;
  if (n === -1) return `yesterday ${timeText(t)}`;
  return dayText(t, now);
}
