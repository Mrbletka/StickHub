// Draws the StickHub app icons as PNG (no dependencies: node:zlib for the PNG data).
// Run: node scripts/make-icons.mjs   -> hub/ui/icons/icon-192.png, icon-512.png, maskable-192.png, maskable-512.png
// Same picture as hub/ui/icon.svg (96x96 design units): a USB stick on black.

import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT = join(dirname(dirname(fileURLToPath(import.meta.url))), 'hub', 'ui', 'icons');
const GREEN = [0x5d, 0xf2, 0xa0];
const BLACK = [0, 0, 0];

function inRoundRect(px, py, x, y, w, h, r) {
  if (px < x || py < y || px > x + w || py > y + h) return false;
  const cx = Math.max(x + r, Math.min(px, x + w - r));
  const cy = Math.max(y + r, Math.min(py, y + h - r));
  return (px - cx) ** 2 + (py - cy) ** 2 <= r * r;
}

/** Color at a point in design units, or null for transparent. */
function sample(u, v, maskable) {
  // Maskable icons: full black square, picture shrunk into the middle 70% (Android crops the rest).
  if (maskable) {
    const s = 0.7;
    const [mu, mv] = [(u - 48) / s + 48, (v - 48) / s + 48];
    return shape(mu, mv) || BLACK;
  }
  if (!inRoundRect(u, v, 0, 0, 96, 96, 22)) return null;
  return shape(u, v) || BLACK;
}

function shape(u, v) {
  const cap = inRoundRect(u, v, 27.5, 7.5, 41, 25, 6.5) && !inRoundRect(u, v, 32.5, 12.5, 31, 15, 1.5);
  const body = inRoundRect(u, v, 22, 30, 52, 56, 12) && (u - 48) ** 2 + (v - 58) ** 2 > 100;
  return cap || body ? GREEN : null;
}

const CRC = new Int32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c;
});
function crc32(buf) {
  let c = -1;
  for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

/** RGBA PNG of the icon, 4x4 supersampled for smooth edges. */
function png(size, maskable) {
  const rows = [];
  const n = 4;
  for (let y = 0; y < size; y++) {
    const row = Buffer.alloc(1 + size * 4); // first byte: filter type 0
    for (let x = 0; x < size; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < n; sy++) {
        for (let sx = 0; sx < n; sx++) {
          const c = sample(((x + (sx + 0.5) / n) / size) * 96, ((y + (sy + 0.5) / n) / size) * 96, maskable);
          if (c) { r += c[0]; g += c[1]; b += c[2]; a++; }
        }
      }
      const o = 1 + x * 4;
      if (a) { row[o] = r / a; row[o + 1] = g / a; row[o + 2] = b / a; row[o + 3] = (a / (n * n)) * 255; }
    }
    rows.push(row);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr.set([8, 6, 0, 0, 0], 8); // 8-bit RGBA
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', deflateSync(Buffer.concat(rows), { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

mkdirSync(OUT, { recursive: true });
for (const size of [192, 512]) {
  writeFileSync(join(OUT, `icon-${size}.png`), png(size, false));
  writeFileSync(join(OUT, `maskable-${size}.png`), png(size, true));
}
console.log(`Icons written to ${OUT}`);
