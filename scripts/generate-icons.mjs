// Renders the app icon (a stylised QR code) to assets/icon.png and assets/icon.ico with no image tools.
// Run manually after changing the design: node scripts/generate-icons.mjs
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const OUT = path.resolve(import.meta.dirname, '..', 'apps', 'desktop', 'assets');
const PUBLIC = path.resolve(import.meta.dirname, '..', 'apps', 'web', 'public');
const BG = [37, 99, 235];
const FG = [255, 255, 255];

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const byte of buf) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type, data) => {
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const out = Buffer.alloc(body.length + 8);
  out.writeUInt32BE(data.length, 0);
  body.copy(out, 4);
  out.writeUInt32BE(crc32(body), body.length + 4);
  return out;
};

// 9x9 module pattern: three finder squares and a few data modules.
const PATTERN = [
  '111101111',
  '101001011',
  '111100111',
  '000010000',
  '110101010',
  '000011100',
  '111100101',
  '101001110',
  '111101011',
];

function coverage(x, y, size) {
  const radius = size * 0.2;
  const dx = Math.max(radius - x, x - (size - radius), 0);
  const dy = Math.max(radius - y, y - (size - radius), 0);
  return Math.min(1, Math.max(0, radius - Math.hypot(dx, dy) + 0.5));
}

function png(size) {
  const margin = size * 0.17;
  const module = (size - margin * 2) / PATTERN.length;
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    const row = y * (size * 4 + 1);
    for (let x = 0; x < size; x++) {
      const mx = Math.floor((x + 0.5 - margin) / module);
      const my = Math.floor((y + 0.5 - margin) / module);
      const on = PATTERN[my]?.[mx] === '1';
      const color = on ? FG : BG;
      const at = row + 1 + x * 4;
      raw[at] = color[0];
      raw[at + 1] = color[1];
      raw[at + 2] = color[2];
      raw[at + 3] = Math.round(255 * coverage(x + 0.5, y + 0.5, size));
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8; // bit depth
  header[9] = 6; // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function ico(sizes) {
  const images = sizes.map(png);
  const dir = Buffer.alloc(6 + 16 * images.length);
  dir.writeUInt16LE(1, 2);
  dir.writeUInt16LE(images.length, 4);
  let offset = dir.length;
  images.forEach((image, i) => {
    const at = 6 + 16 * i;
    dir[at] = sizes[i] === 256 ? 0 : sizes[i];
    dir[at + 1] = sizes[i] === 256 ? 0 : sizes[i];
    dir.writeUInt16LE(1, at + 4);
    dir.writeUInt16LE(32, at + 6);
    dir.writeUInt32LE(image.length, at + 8);
    dir.writeUInt32LE(offset, at + 12);
    offset += image.length;
  });
  return Buffer.concat([dir, ...images]);
}

fs.mkdirSync(PUBLIC, { recursive: true });
fs.writeFileSync(path.join(OUT, 'icon.png'), png(256));
fs.writeFileSync(path.join(OUT, 'icon.ico'), ico([16, 24, 32, 48, 64, 128, 256]));
fs.writeFileSync(path.join(PUBLIC, 'icon-192.png'), png(192));
