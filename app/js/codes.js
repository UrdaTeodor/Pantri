// Barcode helpers: canonical keys for matching, lookup variants, GS1 parsing.

const GS = '\u001d';

/** Key used to match barcodes: numeric GTINs (EAN-8, UPC-A, EAN-13, GTIN-14) are padded to 14 digits. */
export function codeKey(code) {
  const c = String(code).trim();
  return /^(\d{8}|\d{12,14})$/.test(c) ? c.padStart(14, '0') : c;
}

/** Spellings of a numeric code worth trying against online product databases. */
export function lookupVariants(code) {
  const c = String(code).trim();
  const out = [c];
  if (/^\d{12}$/.test(c)) out.push('0' + c);
  if (/^0\d{12,13}$/.test(c)) out.push(c.slice(1));
  return [...new Set(out)];
}

function yymmdd(v) {
  if (!/^\d{6}$/.test(v)) return null;
  const y = 2000 + Number(v.slice(0, 2));
  const m = Number(v.slice(2, 4));
  let d = Number(v.slice(4, 6));
  if (m < 1 || m > 12) return null;
  if (d === 0) d = new Date(y, m, 0).getDate(); // GS1: day 00 = last day of month
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

function assign(out, ai, value) {
  if (ai === '01') out.gtin = value;
  else if (ai === '17') out.expiry = yymmdd(value) || out.expiry; // expiration date wins
  else if (ai === '15' || ai === '16') out.expiry = out.expiry || yymmdd(value); // best before / sell by
  else if (ai === '10') out.batch = value;
}

const FIXED = { '01': 14, '02': 14, '11': 6, '12': 6, '13': 6, '15': 6, '16': 6, '17': 6 };

/** Parse a GS1 element string (DataMatrix / GS1-128 / GS1 QR). Returns { gtin, expiry?, batch? } or null. */
export function parseGs1(raw) {
  let s = String(raw).replace(/^\][A-Za-z]\d/, '');
  if (s.startsWith(GS)) s = s.slice(1);
  const out = {};
  if (s.startsWith('(')) {
    for (const m of s.matchAll(/\((\d{2,4})\)([^(]*)/g)) assign(out, m[1], m[2].trim());
    return out.gtin ? out : null;
  }
  if (!/^01\d{14}/.test(s)) return null;
  let i = 0;
  while (i < s.length) {
    if (s[i] === GS) { i++; continue; }
    const ai = s.slice(i, i + 2);
    if (FIXED[ai]) {
      assign(out, ai, s.slice(i + 2, i + 2 + FIXED[ai]));
      i += 2 + FIXED[ai];
    } else if (ai === '10' || ai === '21') {
      let j = s.indexOf(GS, i + 2);
      if (j < 0) j = s.length;
      assign(out, ai, s.slice(i + 2, j));
      i = j;
    } else break; // unknown AI: keep what we have
  }
  return out.gtin ? out : null;
}

/** Turn a raw scan into { code, expiry? }. GS1 codes yield their GTIN (as EAN-13 when possible) and expiry. */
export function interpretScan(raw) {
  const text = String(raw).trim();
  const gs1 = parseGs1(text);
  if (gs1) {
    const code = gs1.gtin.startsWith('0') ? gs1.gtin.slice(1) : gs1.gtin;
    return { code, expiry: gs1.expiry || null };
  }
  return { code: text, expiry: null };
}
