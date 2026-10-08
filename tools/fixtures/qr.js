// Minimal, dependency-free QR Code encoder used by tools/check-barcode.mjs.
// Byte mode, error-correction level L, versions 1-5 (all single Reed-Solomon block),
// fixed mask pattern 0. Plenty for test payloads up to 106 bytes.
//
//   qrMatrix('hello') -> boolean[][] (row-major, true = dark), no quiet zone
//
// Follows ISO/IEC 18004 (function patterns, zigzag placement, BCH format info);
// structure modelled on Project Nayuki's reference implementation.

// [data codewords, EC codewords] for level L.
const LEVEL_L = { 1: [19, 7], 2: [34, 10], 3: [55, 15], 4: [80, 20], 5: [108, 26] };
const FORMAT_BITS_L = 0b01;

function gfMultiply(x, y) {
  // GF(2^8) with the QR polynomial x^8 + x^4 + x^3 + x^2 + 1 (0x11D).
  let z = 0;
  for (let i = 7; i >= 0; i--) {
    z = (z << 1) ^ ((z >>> 7) * 0x11d);
    z ^= ((y >>> i) & 1) * x;
  }
  return z;
}

function rsDivisor(degree) {
  const poly = new Array(degree).fill(0);
  poly[degree - 1] = 1;
  let root = 1;
  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < poly.length; j++) {
      poly[j] = gfMultiply(poly[j], root);
      if (j + 1 < poly.length) poly[j] ^= poly[j + 1];
    }
    root = gfMultiply(root, 0x02);
  }
  return poly;
}

function rsRemainder(data, divisor) {
  const rem = divisor.map(() => 0);
  for (const byte of data) {
    const factor = byte ^ rem.shift();
    rem.push(0);
    divisor.forEach((coef, i) => {
      rem[i] ^= gfMultiply(coef, factor);
    });
  }
  return rem;
}

export function qrMatrix(text) {
  const bytes = [...new TextEncoder().encode(String(text))];
  let version = 1;
  while (version <= 5 && bytes.length > LEVEL_L[version][0] - 2) version++;
  if (version > 5) throw new RangeError(`qrMatrix: ${bytes.length} bytes is too long (max 106)`);
  const [dataCount, ecCount] = LEVEL_L[version];
  const size = version * 4 + 17;

  // 1. Bit stream: mode 0100 (byte), 8-bit count, data, terminator, byte padding, pad codewords.
  const bits = [];
  const push = (value, length) => {
    for (let i = length - 1; i >= 0; i--) bits.push((value >>> i) & 1);
  };
  push(0b0100, 4);
  push(bytes.length, 8);
  for (const b of bytes) push(b, 8);
  const capacity = dataCount * 8;
  push(0, Math.min(4, capacity - bits.length));
  push(0, (8 - (bits.length % 8)) % 8);
  for (let pad = 0xec; bits.length < capacity; pad ^= 0xec ^ 0x11) push(pad, 8);
  const data = [];
  for (let i = 0; i < bits.length; i += 8) data.push(bits.slice(i, i + 8).reduce((acc, b) => (acc << 1) | b, 0));
  const codewords = [...data, ...rsRemainder(data, rsDivisor(ecCount))];

  // 2. Function patterns.
  const modules = Array.from({ length: size }, () => new Array(size).fill(false));
  const reserved = Array.from({ length: size }, () => new Array(size).fill(false));
  const set = (x, y, dark) => {
    modules[y][x] = dark;
    reserved[y][x] = true;
  };
  for (let i = 0; i < size; i++) {
    set(6, i, i % 2 === 0); // vertical timing
    set(i, 6, i % 2 === 0); // horizontal timing
  }
  const finder = (cx, cy) => {
    for (let dy = -4; dy <= 4; dy++) {
      for (let dx = -4; dx <= 4; dx++) {
        const x = cx + dx;
        const y = cy + dy;
        if (x < 0 || y < 0 || x >= size || y >= size) continue;
        const d = Math.max(Math.abs(dx), Math.abs(dy)); // includes the light separator ring (d = 4)
        set(x, y, d !== 2 && d !== 4);
      }
    }
  };
  finder(3, 3);
  finder(size - 4, 3);
  finder(3, size - 4);
  if (version >= 2) {
    // Versions 2-6 have a single alignment pattern, centred at (size-7, size-7).
    const c = size - 7;
    for (let dy = -2; dy <= 2; dy++) {
      for (let dx = -2; dx <= 2; dx++) set(c + dx, c + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
    }
  }
  const drawFormat = (mask) => {
    const value = (FORMAT_BITS_L << 3) | mask;
    let rem = value;
    for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
    const format = ((value << 10) | rem) ^ 0x5412; // 15 bits
    const bit = (i) => ((format >>> i) & 1) === 1;
    for (let i = 0; i <= 5; i++) set(8, i, bit(i));
    set(8, 7, bit(6));
    set(8, 8, bit(7));
    set(7, 8, bit(8));
    for (let i = 9; i < 15; i++) set(14 - i, 8, bit(i));
    for (let i = 0; i < 8; i++) set(size - 1 - i, 8, bit(i));
    for (let i = 8; i < 15; i++) set(8, size - 15 + i, bit(i));
    set(8, size - 8, true); // the always-dark module
  };
  drawFormat(0); // reserve the format areas before placing data

  // 3. Data codewords in the two-column zigzag, skipping the vertical timing column.
  let bitIndex = 0;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vert = 0; vert < size; vert++) {
      for (let j = 0; j < 2; j++) {
        const x = right - j;
        const upward = ((right + 1) & 2) === 0;
        const y = upward ? size - 1 - vert : vert;
        if (!reserved[y][x] && bitIndex < codewords.length * 8) {
          modules[y][x] = ((codewords[bitIndex >>> 3] >>> (7 - (bitIndex & 7))) & 1) === 1;
          bitIndex++;
        }
      }
    }
  }

  // 4. Mask 0: invert data modules where (x + y) is even; then write the real format info.
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (!reserved[y][x] && (x + y) % 2 === 0) modules[y][x] = !modules[y][x];
    }
  }
  drawFormat(0);
  return modules;
}
