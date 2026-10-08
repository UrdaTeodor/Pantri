// EAN-13 encoder used by tools/check-barcode.mjs (works in Node and in the browser).
//
//   ean13Modules('5449000000996')  -> '10100010110...' (95 chars: '1' = bar, '0' = space)
//
// Layout: start guard 101 | 6 left digits (L/G codes, parity chosen by the 1st digit)
//         | centre guard 01010 | 6 right digits (R codes) | end guard 101.
// Quiet zones (>= 11 modules left, >= 7 right) are added by the renderer.

const L_CODES = ['0001101', '0011001', '0010011', '0111101', '0100011', '0110001', '0101111', '0111011', '0110111', '0001011'];
const invert = (bits) => [...bits].map((b) => (b === '0' ? '1' : '0')).join('');
const R_CODES = L_CODES.map(invert); // R = complement of L
const G_CODES = R_CODES.map((bits) => [...bits].reverse().join('')); // G = R reversed
const PARITY = ['LLLLLL', 'LLGLGG', 'LLGGLG', 'LLGGGL', 'LGLLGG', 'LGGLLG', 'LGGGLL', 'LGLGLG', 'LGLGGL', 'LGGLGL'];

/** Check digit for the first 12 digits (weights 1,3,1,3,... from the left). */
export function ean13CheckDigit(first12) {
  if (!/^\d{12}$/.test(first12)) throw new TypeError(`EAN-13 needs 12 data digits, got "${first12}"`);
  let sum = 0;
  for (let i = 0; i < 12; i++) sum += Number(first12[i]) * (i % 2 === 0 ? 1 : 3);
  return String((10 - (sum % 10)) % 10);
}

/** 95-module bar pattern for a 12-digit (check digit appended) or 13-digit (verified) code. */
export function ean13Modules(code) {
  let digits = String(code);
  if (/^\d{12}$/.test(digits)) digits += ean13CheckDigit(digits);
  if (!/^\d{13}$/.test(digits)) throw new TypeError(`EAN-13 needs 12 or 13 digits, got "${code}"`);
  const expected = ean13CheckDigit(digits.slice(0, 12));
  if (digits[12] !== expected) throw new RangeError(`Bad EAN-13 check digit in ${digits} (expected ${expected})`);

  const parity = PARITY[Number(digits[0])];
  let bits = '101';
  for (let i = 1; i <= 6; i++) bits += (parity[i - 1] === 'L' ? L_CODES : G_CODES)[Number(digits[i])];
  bits += '01010';
  for (let i = 7; i <= 12; i++) bits += R_CODES[Number(digits[i])];
  bits += '101';
  if (bits.length !== 95) throw new Error(`internal error: ${bits.length} modules`);
  return bits;
}
