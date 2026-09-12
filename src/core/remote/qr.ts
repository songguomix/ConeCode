// Compact, dependency-free QR Code generator (byte mode, EC level M), used by
// the desktop "connect" panel to render a scannable link to the phone. Ported
// from Kazuhiko Arase's qrcode-generator algorithm (MIT). Supports versions
// 1–10, which comfortably fit a LAN/tunnel URL (~60–120 bytes).

// --- GF(256) arithmetic -----------------------------------------------------
const EXP: number[] = new Array(256);
const LOG: number[] = new Array(256);
(function initTables() {
  for (let i = 0; i < 8; i++) EXP[i] = 1 << i;
  for (let i = 8; i < 256; i++) EXP[i] = EXP[i - 4] ^ EXP[i - 5] ^ EXP[i - 6] ^ EXP[i - 8];
  for (let i = 0; i < 255; i++) LOG[EXP[i]] = i;
})();
const glog = (n: number) => LOG[n];
const gexp = (n: number) => {
  while (n < 0) n += 255;
  while (n >= 256) n -= 255;
  return EXP[n];
};

// --- polynomial (for Reed–Solomon) ------------------------------------------
class Poly {
  num: number[];
  constructor(num: number[], shift = 0) {
    let offset = 0;
    while (offset < num.length && num[offset] === 0) offset++;
    this.num = new Array(num.length - offset + shift);
    for (let i = 0; i < num.length - offset; i++) this.num[i] = num[i + offset];
  }
  get(i: number) { return this.num[i]; }
  get length() { return this.num.length; }
  multiply(e: Poly): Poly {
    const num = new Array(this.length + e.length - 1).fill(0);
    for (let i = 0; i < this.length; i++)
      for (let j = 0; j < e.length; j++)
        num[i + j] ^= gexp(glog(this.get(i)) + glog(e.get(j)));
    return new Poly(num);
  }
  mod(e: Poly): Poly {
    if (this.length - e.length < 0) return this;
    const ratio = glog(this.get(0)) - glog(e.get(0));
    const num = this.num.slice();
    for (let i = 0; i < e.length; i++) num[i] ^= gexp(glog(e.get(i)) + ratio);
    return new Poly(num).mod(e);
  }
}

function ecPolynomial(ecLength: number): Poly {
  let a = new Poly([1]);
  for (let i = 0; i < ecLength; i++) a = a.multiply(new Poly([1, gexp(i)]));
  return a;
}

// Test-only: the EC generator polynomial in exponent (α^k) form, for validating
// the GF(256)/Reed–Solomon core against the QR spec's published values.
export function __genPolyExponents(ecLength: number): number[] {
  return ecPolynomial(ecLength).num.map((c) => glog(c));
}

// --- bit buffer -------------------------------------------------------------
class BitBuffer {
  buffer: number[] = [];
  length = 0;
  put(num: number, len: number) {
    for (let i = 0; i < len; i++) this.putBit(((num >>> (len - i - 1)) & 1) === 1);
  }
  putBit(bit: boolean) {
    const idx = Math.floor(this.length / 8);
    if (this.buffer.length <= idx) this.buffer.push(0);
    if (bit) this.buffer[idx] |= 0x80 >>> (this.length % 8);
    this.length++;
  }
}

// --- spec tables (versions 1–10) --------------------------------------------
// Each row, per version, is [L, M, Q, H]; each entry is groups of
// [count, totalBytes, dataBytes].
const RS_BLOCK_TABLE: number[][] = [
  [1, 26, 19], [1, 26, 16], [1, 26, 13], [1, 26, 9],
  [1, 44, 34], [1, 44, 28], [1, 44, 22], [1, 44, 16],
  [1, 70, 55], [1, 70, 44], [2, 35, 17], [2, 35, 13],
  [1, 100, 80], [2, 50, 32], [2, 50, 24], [4, 25, 9],
  [1, 134, 108], [2, 67, 43], [2, 33, 15, 2, 34, 16], [2, 33, 11, 2, 34, 12],
  [2, 86, 68], [4, 43, 27], [4, 43, 19], [4, 43, 15],
  [2, 98, 78], [4, 49, 31], [2, 32, 14, 4, 33, 15], [4, 39, 13, 1, 40, 14],
  [2, 121, 97], [2, 60, 38, 2, 61, 39], [4, 40, 18, 2, 41, 19], [4, 40, 14, 2, 41, 15],
  [2, 146, 116], [3, 58, 36, 2, 59, 37], [4, 36, 16, 4, 37, 17], [4, 36, 12, 4, 37, 13],
  [2, 86, 68, 2, 87, 69], [4, 69, 43, 1, 70, 44], [6, 43, 19, 2, 44, 20], [6, 43, 15, 2, 44, 16],
];
// EC level M is index 1.
const EC_M = 1;

const ALIGN_POS: number[][] = [
  [], [6, 18], [6, 22], [6, 26], [6, 30], [6, 34],
  [6, 22, 38], [6, 24, 42], [6, 26, 46], [6, 28, 50],
];

interface RsBlock { total: number; data: number; }
function rsBlocks(version: number): RsBlock[] {
  const row = RS_BLOCK_TABLE[(version - 1) * 4 + EC_M];
  const list: RsBlock[] = [];
  for (let i = 0; i < row.length; i += 3) {
    const count = row[i], total = row[i + 1], data = row[i + 2];
    for (let j = 0; j < count; j++) list.push({ total, data });
  }
  return list;
}

// --- BCH codes for format / version info ------------------------------------
const G15 = 0b101_0011_0111;
const G18 = 0b1_1111_0010_0101;
const G15_MASK = 0b101_0100_0001_0010;
function bchDigit(data: number) { let d = 0; while (data !== 0) { d++; data >>>= 1; } return d; }
function bchTypeInfo(data: number) {
  let d = data << 10;
  while (bchDigit(d) - bchDigit(G15) >= 0) d ^= G15 << (bchDigit(d) - bchDigit(G15));
  return ((data << 10) | d) ^ G15_MASK;
}
function bchTypeNumber(data: number) {
  let d = data << 12;
  while (bchDigit(d) - bchDigit(G18) >= 0) d ^= G18 << (bchDigit(d) - bchDigit(G18));
  return (data << 12) | d;
}

// --- mask functions ---------------------------------------------------------
const MASK = [
  (i: number, j: number) => (i + j) % 2 === 0,
  (i: number) => i % 2 === 0,
  (_i: number, j: number) => j % 3 === 0,
  (i: number, j: number) => (i + j) % 3 === 0,
  (i: number, j: number) => (Math.floor(i / 2) + Math.floor(j / 3)) % 2 === 0,
  (i: number, j: number) => ((i * j) % 2) + ((i * j) % 3) === 0,
  (i: number, j: number) => (((i * j) % 2) + ((i * j) % 3)) % 2 === 0,
  (i: number, j: number) => (((i * j) % 3) + ((i + j) % 2)) % 2 === 0,
];

// --- core builder -----------------------------------------------------------
class QR {
  version: number;
  modules: (boolean | null)[][] = [];
  size: number;
  constructor(version: number) {
    this.version = version;
    this.size = version * 4 + 17;
  }
  make(dataBits: number[]) {
    let bestPattern = 0;
    let bestScore = Infinity;
    for (let pattern = 0; pattern < 8; pattern++) {
      this.build(dataBits, pattern, true);
      const score = this.lostPoint();
      if (score < bestScore) { bestScore = score; bestPattern = pattern; }
    }
    this.build(dataBits, bestPattern, false);
  }
  private build(dataBits: number[], maskPattern: number, test: boolean) {
    const n = this.size;
    this.modules = Array.from({ length: n }, () => new Array(n).fill(null));
    this.setupProbe(0, 0); this.setupProbe(n - 7, 0); this.setupProbe(0, n - 7);
    this.setupAlign();
    this.setupTiming();
    this.setupTypeInfo(test, maskPattern);
    if (this.version >= 7) this.setupVersion(test);
    this.mapData(dataBits, maskPattern);
  }
  private setupProbe(row: number, col: number) {
    for (let r = -1; r <= 7; r++) {
      if (row + r < 0 || this.size <= row + r) continue;
      for (let c = -1; c <= 7; c++) {
        if (col + c < 0 || this.size <= col + c) continue;
        const on = (0 <= r && r <= 6 && (c === 0 || c === 6))
          || (0 <= c && c <= 6 && (r === 0 || r === 6))
          || (2 <= r && r <= 4 && 2 <= c && c <= 4);
        this.modules[row + r][col + c] = on;
      }
    }
  }
  private setupTiming() {
    for (let i = 8; i < this.size - 8; i++) {
      if (this.modules[i][6] === null) this.modules[i][6] = i % 2 === 0;
      if (this.modules[6][i] === null) this.modules[6][i] = i % 2 === 0;
    }
  }
  private setupAlign() {
    const pos = ALIGN_POS[this.version - 1];
    for (let i = 0; i < pos.length; i++) {
      for (let j = 0; j < pos.length; j++) {
        const row = pos[i], col = pos[j];
        if (this.modules[row][col] !== null) continue;
        for (let r = -2; r <= 2; r++)
          for (let c = -2; c <= 2; c++)
            this.modules[row + r][col + c] =
              r === -2 || r === 2 || c === -2 || c === 2 || (r === 0 && c === 0);
      }
    }
  }
  private setupTypeInfo(test: boolean, maskPattern: number) {
    // EC level M (0b00) << 3 | maskPattern.
    const data = (0 << 3) | maskPattern;
    const bits = bchTypeInfo(data);
    for (let i = 0; i < 15; i++) {
      const mod = !test && ((bits >> i) & 1) === 1;
      if (i < 6) this.modules[i][8] = mod;
      else if (i < 8) this.modules[i + 1][8] = mod;
      else this.modules[this.size - 15 + i][8] = mod;
    }
    for (let i = 0; i < 15; i++) {
      const mod = !test && ((bits >> i) & 1) === 1;
      if (i < 8) this.modules[8][this.size - i - 1] = mod;
      else if (i < 9) this.modules[8][15 - i - 1 + 1] = mod;
      else this.modules[8][15 - i - 1] = mod;
    }
    this.modules[this.size - 8][8] = !test;
  }
  private setupVersion(test: boolean) {
    const bits = bchTypeNumber(this.version);
    for (let i = 0; i < 18; i++) {
      const mod = !test && ((bits >> i) & 1) === 1;
      this.modules[Math.floor(i / 3)][i % 3 + this.size - 8 - 3] = mod;
      this.modules[i % 3 + this.size - 8 - 3][Math.floor(i / 3)] = mod;
    }
  }
  private mapData(data: number[], maskPattern: number) {
    let inc = -1, row = this.size - 1, bitIndex = 7, byteIndex = 0;
    const maskFn = MASK[maskPattern];
    for (let col = this.size - 1; col > 0; col -= 2) {
      if (col === 6) col--;
      while (true) {
        for (let c = 0; c < 2; c++) {
          if (this.modules[row][col - c] === null) {
            let dark = false;
            if (byteIndex < data.length) dark = ((data[byteIndex] >>> bitIndex) & 1) === 1;
            if (maskFn(row, col - c)) dark = !dark;
            this.modules[row][col - c] = dark;
            bitIndex--;
            if (bitIndex === -1) { byteIndex++; bitIndex = 7; }
          }
        }
        row += inc;
        if (row < 0 || this.size <= row) { row -= inc; inc = -inc; break; }
      }
    }
  }
  private lostPoint(): number {
    const n = this.size;
    const m = this.modules as boolean[][];
    let lost = 0;
    for (let row = 0; row < n; row++) {
      for (let col = 0; col < n; col++) {
        let same = 0;
        const dark = m[row][col];
        for (let r = -1; r <= 1; r++) {
          if (row + r < 0 || n <= row + r) continue;
          for (let c = -1; c <= 1; c++) {
            if (col + c < 0 || n <= col + c) continue;
            if (r === 0 && c === 0) continue;
            if (dark === m[row + r][col + c]) same++;
          }
        }
        if (same > 5) lost += 3 + same - 5;
      }
    }
    for (let row = 0; row < n - 1; row++)
      for (let col = 0; col < n - 1; col++) {
        let count = 0;
        if (m[row][col]) count++;
        if (m[row + 1][col]) count++;
        if (m[row][col + 1]) count++;
        if (m[row + 1][col + 1]) count++;
        if (count === 0 || count === 4) lost += 3;
      }
    for (let row = 0; row < n; row++)
      for (let col = 0; col < n - 6; col++) {
        if (m[row][col] && !m[row][col + 1] && m[row][col + 2] && m[row][col + 3] && m[row][col + 4] && !m[row][col + 5] && m[row][col + 6]) lost += 40;
      }
    for (let col = 0; col < n; col++)
      for (let row = 0; row < n - 6; row++) {
        if (m[row][col] && !m[row + 1][col] && m[row + 2][col] && m[row + 3][col] && m[row + 4][col] && !m[row + 5][col] && m[row + 6][col]) lost += 40;
      }
    let dark = 0;
    for (let row = 0; row < n; row++) for (let col = 0; col < n; col++) if (m[row][col]) dark++;
    const ratio = Math.abs((100 * dark) / (n * n) - 50) / 5;
    lost += ratio * 10;
    return lost;
  }
}

// --- data encoding (byte mode) ----------------------------------------------
function lengthBits(version: number) { return version < 10 ? 8 : 16; }

function pickVersion(byteLen: number): number {
  for (let v = 1; v <= 10; v++) {
    const totalData = rsBlocks(v).reduce((s, b) => s + b.data, 0);
    const need = 4 + lengthBits(v) + byteLen * 8;
    if (need <= totalData * 8) return v;
  }
  return 10;
}

function createDataBits(version: number, bytes: number[]): number[] {
  const buffer = new BitBuffer();
  buffer.put(4, 4); // byte mode
  buffer.put(bytes.length, lengthBits(version));
  for (const b of bytes) buffer.put(b, 8);

  const blocks = rsBlocks(version);
  const totalDataCount = blocks.reduce((s, b) => s + b.data, 0);
  if (buffer.length + 4 <= totalDataCount * 8) buffer.put(0, 4);
  while (buffer.length % 8 !== 0) buffer.putBit(false);
  while (buffer.buffer.length < totalDataCount) {
    buffer.buffer.push(0xec);
    if (buffer.buffer.length >= totalDataCount) break;
    buffer.buffer.push(0x11);
  }
  return interleave(buffer.buffer, blocks);
}

function interleave(data: number[], blocks: RsBlock[]): number[] {
  let offset = 0;
  let maxData = 0, maxEc = 0;
  const dcParts: number[][] = [];
  const ecParts: number[][] = [];
  for (const block of blocks) {
    const dcCount = block.data;
    const ecCount = block.total - block.data;
    maxData = Math.max(maxData, dcCount);
    maxEc = Math.max(maxEc, ecCount);
    const dc = data.slice(offset, offset + dcCount);
    offset += dcCount;
    const rsPoly = ecPolynomial(ecCount);
    const rawPoly = new Poly(dc, rsPoly.length - 1);
    const modPoly = rawPoly.mod(rsPoly);
    const ec: number[] = [];
    for (let i = 0; i < rsPoly.length - 1; i++) {
      const idx = i + modPoly.length - (rsPoly.length - 1);
      ec.push(idx >= 0 ? modPoly.get(idx) : 0);
    }
    dcParts.push(dc);
    ecParts.push(ec);
  }
  const out: number[] = [];
  for (let i = 0; i < maxData; i++) for (const p of dcParts) if (i < p.length) out.push(p[i]);
  for (let i = 0; i < maxEc; i++) for (const p of ecParts) if (i < p.length) out.push(p[i]);
  return out;
}

function toBytes(text: string): number[] {
  // UTF-8 encode (URLs are ASCII in practice, but be safe).
  const out: number[] = [];
  for (const ch of unescape(encodeURIComponent(text))) out.push(ch.charCodeAt(0));
  return out;
}

/** Render `text` as a QR Code SVG string (dark modules on white, 4-module quiet zone). */
export function qrSvg(text: string, opts?: { dark?: string; light?: string }): string {
  const bytes = toBytes(text);
  const version = pickVersion(bytes.length);
  const data = createDataBits(version, bytes);
  const qr = new QR(version);
  qr.make(data);
  const m = qr.modules as boolean[][];
  const n = qr.size;
  const quiet = 4;
  const dim = n + quiet * 2;
  const dark = opts?.dark || '#0d0d0d';
  const light = opts?.light || '#ffffff';
  let rects = '';
  for (let r = 0; r < n; r++)
    for (let c = 0; c < n; c++)
      if (m[r][c]) rects += `<rect x="${c + quiet}" y="${r + quiet}" width="1" height="1"/>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${dim} ${dim}" shape-rendering="crispEdges">`
    + `<rect width="${dim}" height="${dim}" fill="${light}"/>`
    + `<g fill="${dark}">${rects}</g></svg>`;
}
