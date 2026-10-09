// Finding the expiry date in text read off a package (OCR): "EXP 12.05.2027", "BB 05/27",
// "12 MAY 2027", "A SE CONSUMA INAINTE DE: 12.05.2027 L2304"… Pure functions, no browser needed.

// Month names and their usual abbreviations: English, Romanian, German, French, Spanish, Italian, Dutch.
const MONTH_NAMES = [
  'JAN JANUARY IAN IANUARIE JANUAR JANV JANVIER ENE ENERO GEN GENNAIO JANUARI',
  'FEB FEBRUARY FEBRUARIE FEBRUAR FEV FEVR FEVRIER FEBRERO FEBBRAIO FEBRUARI',
  'MAR MARCH MARTIE MARZ MRZ MARS MARZO MAART',
  'APR APRIL APRILIE AVR AVRIL ABR ABRIL APRILE',
  'MAY MAI MAYO MAG MAGGIO MEI',
  'JUN JUNE IUN IUNIE JUNI JUIN JUNIO GIU GIUGNO',
  'JUL JULY IUL IULIE JULI JUIL JUILLET JULIO LUG LUGLIO',
  'AUG AUGUST AOU AOUT AGO AGOSTO AUGUSTUS',
  'SEP SEPT SEPTEMBER SEPTEMBRIE SEPTEMBRE SEPTIEMBRE SET SETT SETTEMBRE',
  'OCT OCTOBER OCTOMBRIE OKT OKTOBER OCTOBRE OCTUBRE OTT OTTOBRE',
  'NOV NOVEMBER NOI NOIEMBRIE NOVEMBRE NOVIEMBRE',
  'DEC DECEMBER DECEMBRIE DEZ DEZEMBER DECEMBRE DIC DICIEMBRE DICEMBRE',
];
const MONTHS = new Map(MONTH_NAMES.flatMap((names, k) => names.split(' ').map(n => [n, k + 1])));
const MONTH_WORD = '([A-Z]{3,10})';

// Words printed before an expiry date, and before a production date (which is not the one wanted).
const EXPIRY_WORDS = /\b(EXP|EXPIRY|EXPIRES|EXPIRATION|EXPIRA|BB|BBE|BBD|BEST\s*BEFORE|BEST\s*BY|BEST\s*IF\s*USED\s*BY|USE\s*BY|USE\s*BEFORE|SELL\s*BY|MHD|MINDESTENS|HALTBAR|VERBRAUCHEN|CONSUMA|INAINTE|VALABIL|VALABILITATE|EXPIRARE|DLC|DLUO|DDM|CONSOMMER|CONSUMIR|CADUCIDAD|CAD|SCAD|SCADENZA|CONSUMARSI|THT|TGT|HOUDBAAR)\b/g;
const MADE_WORDS = /\b(PROD|PRODUCED|PRODUCTION|PRODUCTIE|PRODUCTIEI|FABRICATIE|FABRICATIEI|FABRICAT|FAB|MFG|MFD|MANUFACTURED|PACKED|PKD|PACK|AMBALAT|AMBALARE|HERGESTELLT|ABGEPACKT|FABRIQUE|ELABORADO|ENVASADO|PRODOTTO|CONFEZIONATO)\b/g;

// Letters OCR mistakes for digits inside numbers.
const DIGIT_LOOKALIKE = { O: '0', Q: '0', D: '0', U: '0', I: '1', L: '1', '|': '1', '!': '1', Z: '2', S: '5', B: '8', G: '6' };

const pad = n => String(n).padStart(2, '0');
const daysIn = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate();
const yearOf = y => (y.length === 4 ? Number(y) : y.length === 2 ? 2000 + Number(y) : NaN);

// Dot-matrix print often reads 0 as 8, 6 or 9: "12.85.2827" is 12.05.2027. Only numbers that can't be
// right are changed: a year 2100–2939 (→ 20xx), a day or month over 31 starting with 6, 8 or 9 (→ 0x).
const repairYear = y => (/^2[1-9][0-3]\d$/.test(y) ? `20${y.slice(2)}` : y);
const repairPart = t => (t.length === 2 && Number(t) > 31 && '689'.includes(t[0]) ? `0${t[1]}` : t);

/** Upper case, without accents (Ș → S), with unusual dashes and dots made plain. */
function normalize(text) {
  return String(text || '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toUpperCase()
    .replace(/[‐-―−]/g, '-')
    .replace(/[·•,]/g, '.')
    .replace(/[^\S\n]+/g, ' ');
}

/** In runs that are mostly digits ("12.O5.2O27"), letters that look like digits become digits. */
function fixDigits(text) {
  return text.replace(/[0-9OQDUILZSBG|!./-]{4,}/g, run => {
    const digits = (run.match(/\d/g) || []).length;
    const letters = run.replace(/[0-9./-]/g, '').length;
    if (digits < 3 || letters > digits / 2) return run;
    return run.replace(/[OQDUILZSBG|!]/g, ch => DIGIT_LOOKALIKE[ch]);
  });
}

/** Where the expiry and production keywords are: [{ at, end, kind: 'exp' | 'made' }], in order. */
function keywords(text) {
  const out = [];
  for (const m of text.matchAll(EXPIRY_WORDS)) out.push({ at: m.index, end: m.index + m[0].length, kind: 'exp' });
  for (const m of text.matchAll(MADE_WORDS)) out.push({ at: m.index, end: m.index + m[0].length, kind: 'made' });
  return out.sort((a, b) => a.at - b.at);
}

/**
 * The kind of the keyword just before position `at`, if any: at most 30 characters before it, on the
 * same line, with no other number in between (that number is the one the keyword is about).
 */
function keywordBefore(text, words, at) {
  let hit = null;
  for (const w of words) {
    if (w.end > at) break;
    const between = text.slice(w.end, at);
    if (between.length <= 30 && !/[\n\d]/.test(between)) hit = w;
  }
  return hit && hit.kind;
}

/**
 * Dates in OCR text, best first: [{ date: 'YYYY-MM-DD', score, raw }]. `now` (ms) sets which years make
 * sense; `monthFirst` reads 05/12/2027 as May 12 (US) instead of 5 December. A date with only a month
 * and year ("05/2027", "MAY 27") means the last day of that month.
 */
export function findDates(text, { now = Date.now(), monthFirst = false } = {}) {
  const plain = normalize(text);
  const fixed = fixDigits(plain);
  const words = keywords(plain);
  const today = new Date(now);
  const nowYear = today.getFullYear();
  const todayYmd = `${nowYear}-${pad(today.getMonth() + 1)}-${pad(today.getDate())}`;
  const taken = []; // [start, end) of the matches so far: a shorter pattern can't reuse their digits
  const found = [];

  function add(y, m, d, { at, end, base, raw, monthEnd = false }) {
    if (!(m >= 1 && m <= 12) || !(y >= nowYear - 3 && y <= nowYear + 12)) return false;
    const day = monthEnd ? daysIn(y, m) : d;
    if (!(day >= 1 && day <= daysIn(y, m))) return false;
    if (taken.some(([x, z]) => at < z && end > x)) return false;
    taken.push([at, end]);
    const date = `${y}-${pad(m)}-${pad(day)}`;
    const kind = keywordBefore(plain, words, at);
    let score = base;
    if (kind === 'exp') score += 40;
    if (kind === 'made') score -= 45;
    if (date >= todayYmd) score += 15;
    else if (Date.parse(date) < now - 30 * 864e5) score -= 10;
    if (y > nowYear + 6) score -= 10;
    found.push({ date, score, raw: raw.trim(), kind });
    return true;
  }
  const span = m => ({ at: m.index, end: m.index + m[0].length, raw: m[0] });

  // 12.05.2027, 12/05/27, 12-5-2027, 12 05 2027: day first, or month first in the US. 27.05.12: year first.
  for (const m of fixed.matchAll(/(?<!\d)(\d{1,2}) ?([./ -]) ?(\d{1,2}) ?\2 ?(\d{4}|\d{2})(?!\d)/g)) {
    const [a, b, y] = [repairPart(m[1]), repairPart(m[3]), repairYear(m[4])];
    const repaired = a !== m[1] || b !== m[3] || y !== m[4];
    let [day, month] = [Number(a), Number(b)];
    let ambiguous = day <= 12 && month <= 12 && day !== month;
    if (day > 12 && month <= 12) ambiguous = false;
    else if (month > 12 && day <= 12) [day, month] = [month, day];
    else if (monthFirst && m[2] !== '.') [day, month] = [month, day]; // dotted dates are day first everywhere
    const base = (y.length === 4 ? 50 : 40) - (m[2] === ' ' ? 10 : 0) - (ambiguous ? 5 : 0) - (repaired ? 15 : 0);
    if (!add(yearOf(y), month, day, { ...span(m), base }) && y.length === 2) {
      add(yearOf(a.padStart(2, '0')), Number(b), Number(y), { ...span(m), base: base - 10 });
    }
  }
  // 2027-05-12, 2027.05.12
  for (const m of fixed.matchAll(/(?<!\d)(\d{4}) ?([./-]) ?(\d{1,2}) ?\2 ?(\d{1,2})(?!\d)/g)) {
    const [y, mo, d] = [repairYear(m[1]), repairPart(m[3]), repairPart(m[4])];
    const repaired = y !== m[1] || mo !== m[3] || d !== m[4];
    add(Number(y), Number(mo), Number(d), { ...span(m), base: repaired ? 35 : 50 });
  }
  // 12 MAY 2027, 12-MAI-27, 12MAY27
  for (const m of plain.matchAll(new RegExp(`(?<!\\d)(\\d{1,2}) ?[./ -]? ?${MONTH_WORD}\\.? ?[./ -]? ?(\\d{4}|\\d{2})(?!\\d)`, 'g'))) {
    const month = MONTHS.get(m[2]);
    if (month) add(yearOf(m[3]), month, Number(m[1]), { ...span(m), base: 60 });
  }
  // MAY 12, 2027 (US)
  for (const m of plain.matchAll(new RegExp(`(?<![A-Z])${MONTH_WORD}\\.? (\\d{1,2})[ .]{0,2}(\\d{4})(?!\\d)`, 'g'))) {
    const month = MONTHS.get(m[1]);
    if (month) add(Number(m[3]), month, Number(m[2]), { ...span(m), base: 55 });
  }
  // MAY 2027, MAI 27: the end of that month
  for (const m of plain.matchAll(new RegExp(`(?<![A-Z])${MONTH_WORD}\\.? ?[./ -]? ?(\\d{4}|\\d{2})(?!\\d)`, 'g'))) {
    const month = MONTHS.get(m[1]);
    if (month) add(yearOf(m[2]), month, 0, { ...span(m), base: 45, monthEnd: true });
  }
  // 05/2027, 05.27 (and 05 2027 after an expiry word): the end of that month
  for (const m of fixed.matchAll(/(?<![\d./-])(\d{1,2}) ?([./ -]) ?(\d{4}|\d{2})(?!\d|[./-]\d)/g)) {
    if (m[2] === ' ' && keywordBefore(plain, words, m.index) !== 'exp') continue;
    const [mo, y] = [repairPart(m[1]), repairYear(m[3])];
    add(yearOf(y), Number(mo), 0, { ...span(m), base: mo !== m[1] || y !== m[3] ? 25 : 35, monthEnd: true });
  }
  // 120527 or 12052027 right after an expiry word (common in dot-matrix prints)
  for (const m of fixed.matchAll(/(?<!\d)(\d{2})(\d{2})(\d{4}|\d{2})(?!\d)/g)) {
    if (keywordBefore(plain, words, m.index) === 'exp') add(yearOf(m[3]), Number(m[2]), Number(m[1]), { ...span(m), base: 20 });
  }

  // Several dates without a word to tell them apart: the expiry date is the later one.
  const unlabelled = found.filter(f => !f.kind);
  if (unlabelled.length > 1) unlabelled.reduce((a, b) => (b.date > a.date ? b : a)).score += 8;
  return found.sort((a, b) => b.score - a.score).map(({ date, score, raw }) => ({ date, score, raw }));
}

/** The most likely expiry date in OCR text ({ date, score, raw }), or null when none is convincing. */
export function findExpiry(text, opts) {
  const [best] = findDates(text, opts);
  return best && best.score >= 35 ? best : null;
}

/** A reading this good is trusted on its own; others wait until two readings agree. */
export const CONFIDENT = 85;

/** Whether dates are written month first where this phone is set up (the US and a few others). */
export function monthFirstLocale(lang = typeof navigator === 'undefined' ? '' : navigator.language) {
  return /-(US|PH|FM|MH|PW)$/i.test(String(lang || ''));
}
