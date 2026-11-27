// png-squeeze: a small lossless PNG re-compressor for make.fun
// png-squeeze-01-run-20261127. Written from the competition RULES spec
// (1280x720 RGBA screenshots, one 60s wall budget for 8 instances).
//
// Idea: the house baseline writes every row as RGBA with the Paeth filter.
// We beat it three ways, all lossless and deterministic:
//   1. colour-type reduction -- palette (<=256 colours), grey, grey+alpha
//      or RGB when the alpha channel carries nothing;
//   2. a per-row adaptive filter -- for every row we try all five PNG
//      filters and keep the one whose bytes look smallest to the
//      compressor (lowest sum of absolute signed byte values);
//   3. zlib level 9 for the single IDAT stream.
// No clock, no randomness, no environment reads affect the output bytes,
// so two runs on the same set produce identical files.
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { deflateSync, inflateSync } from 'node:zlib';

// ---------- CRC-32 (PNG chunk checksums) ----------
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'ascii');
  Buffer.from(data).copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

// ---------- PNG decoding (input is RGBA, 8-bit, stored rows) ----------
function paethPredict(left, up, upLeft) {
  const p = left + up - upLeft;
  const pa = Math.abs(p - left);
  const pb = Math.abs(p - up);
  const pc = Math.abs(p - upLeft);
  if (pa <= pb && pa <= pc) return left;
  if (pb <= pc) return up;
  return upLeft;
}

function decodePng(buf) {
  if (buf[0] !== 0x89 || buf[1] !== 0x50) throw new Error('not a PNG');
  let off = 8;
  let width = 0;
  let height = 0;
  let colorType = 6;
  const idatParts = [];
  while (off + 8 <= buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString('ascii', off + 4, off + 8);
    const data = buf.subarray(off + 8, off + 8 + len);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      colorType = data[9];
    } else if (type === 'IDAT') {
      idatParts.push(Buffer.from(data));
    } else if (type === 'IEND') {
      break;
    }
    off += 12 + len;
  }
  if (colorType !== 6) throw new Error('expected RGBA input, got type ' + colorType);
  const raw = inflateSync(Buffer.concat(idatParts));
  const stride = width * 4;
  const rgba = new Uint8Array(width * height * 4);
  let src = 0;
  for (let y = 0; y < height; y++) {
    const filter = raw[src++];
    const row = rgba.subarray(y * stride, (y + 1) * stride);
    const prev = y > 0 ? rgba.subarray((y - 1) * stride, y * stride) : null;
    for (let x = 0; x < stride; x++) {
      const left = x >= 4 ? row[x - 4] : 0;
      const up = prev ? prev[x] : 0;
      const upLeft = prev && x >= 4 ? prev[x - 4] : 0;
      const v = raw[src++];
      if (filter === 0) row[x] = v;
      else if (filter === 1) row[x] = (v + left) & 0xff;
      else if (filter === 2) row[x] = (v + up) & 0xff;
      else if (filter === 3) row[x] = (v + ((left + up) >> 1)) & 0xff;
      else row[x] = (v + paethPredict(left, up, upLeft)) & 0xff;
    }
  }
  return { rgba, width, height };
}

// ---------- image analysis: what can we drop without losing a pixel? ----------
function analyse(rgba) {
  const seen = new Map();
  let grey = true;
  let opaque = true;
  let count = 0;
  for (let i = 0; i < rgba.length; i += 4) {
    const r = rgba[i];
    const g = rgba[i + 1];
    const b = rgba[i + 2];
    const a = rgba[i + 3];
    if (r !== g || g !== b) grey = false;
    if (a !== 255) opaque = false;
    if (count <= 256) {
      const key = (r << 24) | (g << 16) | (b << 8) | a;
      if (!seen.has(key)) {
        seen.set(key, count);
        count++;
      }
    }
  }
  return { palette: count <= 256 ? seen : null, grey, opaque };
}

// ---------- per-row adaptive filtering ----------
// Score of a filtered row = sum of |signed byte|; the smallest-scoring
// filter wins the row. This tracks what zlib will do far better than a
// fixed filter, and costs one pass per filter over the row.
// One scratch row reused by every filter trial, so no per-row allocation.
let scratchRow = new Uint8Array(0);

function filterRowBest(rawRow, prevRow, bpp, out, outOff) {
  const n = rawRow.length;
  let bestScore = Infinity;
  let bestFilter = 0;
  // Try each filter into a scratch buffer, keep the winner.
  if (scratchRow.length < n) scratchRow = new Uint8Array(n);
  const scratch = scratchRow;
  for (let f = 0; f < 5; f++) {
    let score = 0;
    for (let x = 0; x < n; x++) {
      const left = x >= bpp ? rawRow[x - bpp] : 0;
      const up = prevRow ? prevRow[x] : 0;
      const upLeft = prevRow && x >= bpp ? prevRow[x - bpp] : 0;
      let pred = 0;
      if (f === 1) pred = left;
      else if (f === 2) pred = up;
      else if (f === 3) pred = (left + up) >> 1;
      else if (f === 4) pred = paethPredict(left, up, upLeft);
      const d = (rawRow[x] - pred) & 0xff;
      scratch[x] = d;
      score += d < 128 ? d : 256 - d;
    }
    if (score < bestScore) {
      bestScore = score;
      bestFilter = f;
      out.set(scratch.subarray(0, n), outOff + 1);
    }
  }
  out[outOff] = bestFilter;
}

// ---------- PNG encoding ----------
function encodePng(rgba, width, height) {
  const info = analyse(rgba);
  const total = width * height;
  let colorType;
  let bpp;
  let palette = null;
  // Palette only for non-grey images: on a grey image the palette index
  // order is arbitrary, so neighbouring pixels with near-equal grey
  // levels get unrelated indices and the filters cannot predict them
  // (practice i004: palette 218 KB vs RGBA Paeth 160 KB). Grey pixels
  // keep their own levels in type 0 / 4, which filters predict well.
  if (info.palette && !info.grey) {
    colorType = 3;
    bpp = 1;
    palette = info.palette;
  } else if (info.grey && info.opaque) {
    colorType = 0;
    bpp = 1;
  } else if (info.grey) {
    colorType = 4;
    bpp = 2;
  } else if (info.opaque) {
    colorType = 2;
    bpp = 3;
  } else {
    colorType = 6;
    bpp = 4;
  }

  // Lay the pixels out in the target colour type.
  const enc = new Uint8Array(total * bpp);
  if (colorType === 3) {
    for (let p = 0, i = 0; p < total; p++, i += 4) {
      const key = (rgba[i] << 24) | (rgba[i + 1] << 16) | (rgba[i + 2] << 8) | rgba[i + 3];
      enc[p] = palette.get(key);
    }
  } else if (colorType === 0) {
    for (let p = 0, i = 0; p < total; p++, i += 4) enc[p] = rgba[i];
  } else if (colorType === 4) {
    for (let p = 0, o = 0, i = 0; p < total; p++, o += 2, i += 4) {
      enc[o] = rgba[i];
      enc[o + 1] = rgba[i + 3];
    }
  } else if (colorType === 2) {
    for (let p = 0, o = 0, i = 0; p < total; p++, o += 3, i += 4) {
      enc[o] = rgba[i];
      enc[o + 1] = rgba[i + 1];
      enc[o + 2] = rgba[i + 2];
    }
  } else {
    enc.set(rgba);
  }

  // Two filterings, keep the smaller deflate: the adaptive per-row
  // choice, and all-Paeth (the house baseline's filter). The loser
  // costs one extra deflate; the winner is what ships. This matters
  // because the sum-of-abs heuristic sometimes loses to plain Paeth
  // on smooth/photo-like rows, and we never want to ship that loss.
  const rowBytes = width * bpp;
  const scanA = new Uint8Array(height * (rowBytes + 1));
  const scanB = new Uint8Array(height * (rowBytes + 1));
  for (let y = 0; y < height; y++) {
    const row = enc.subarray(y * rowBytes, (y + 1) * rowBytes);
    const prev = y > 0 ? enc.subarray((y - 1) * rowBytes, y * rowBytes) : null;
    filterRowBest(row, prev, bpp, scanA, y * (rowBytes + 1));
    // All-Paeth row for the second candidate.
    const offB = y * (rowBytes + 1);
    scanB[offB] = 4;
    for (let x = 0; x < rowBytes; x++) {
      const left = x >= bpp ? row[x - bpp] : 0;
      const up = prev ? prev[x] : 0;
      const upLeft = prev && x >= bpp ? prev[x - bpp] : 0;
      scanB[offB + 1 + x] = (row[x] - paethPredict(left, up, upLeft)) & 0xff;
    }
  }
  const idatA = deflateSync(scanA, { level: 9 });
  const idatB = deflateSync(scanB, { level: 9 });
  const idat = idatA.length <= idatB.length ? idatA : idatB;

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = colorType;
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter method
  ihdr[12] = 0; // no interlace

  const parts = [Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr)];
  if (colorType === 3) {
    const plte = Buffer.alloc(palette.size * 3);
    for (const [key, idx] of palette) {
      plte[idx * 3] = (key >>> 24) & 0xff;
      plte[idx * 3 + 1] = (key >>> 16) & 0xff;
      plte[idx * 3 + 2] = (key >>> 8) & 0xff;
    }
    parts.push(chunk('PLTE', plte));
    let needTrns = false;
    for (const [key] of palette) if ((key & 0xff) !== 255) needTrns = true;
    if (needTrns) {
      const trns = Buffer.alloc(palette.size);
      for (const [key, idx] of palette) trns[idx] = key & 0xff;
      parts.push(chunk('tRNS', trns));
    }
  }
  parts.push(chunk('IDAT', idat));
  parts.push(chunk('IEND', Buffer.alloc(0)));
  return Buffer.concat(parts);
}

// ---------- driver ----------
function pickOutputDir() {
  const wanted = process.env.MAKEFUN_OUTPUT_DIR || '/output';
  try {
    mkdirSync(wanted, { recursive: true });
    return wanted;
  } catch {
    mkdirSync('./output', { recursive: true });
    return './output';
  }
}

const inputDir = process.env.MAKEFUN_INPUT_DIR || '/input';
const outputDir = pickOutputDir();
for (const id of readdirSync(inputDir).sort()) {
  const image = decodePng(readFileSync(join(inputDir, id, 'image.png')));
  const png = encodePng(image.rgba, image.width, image.height);
  mkdirSync(join(outputDir, id), { recursive: true });
  writeFileSync(join(outputDir, id, 'image.png'), png);
}
