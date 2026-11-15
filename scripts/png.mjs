// Minimal PNG writer (no dependencies). Used for the app icons and for the
// photo fixtures in the tests.
import { deflateSync } from 'node:zlib';

const CRC = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

// pixel(x, y) -> [r, g, b]
export function encodePng(width, height, pixel) {
  const raw = Buffer.alloc((width * 3 + 1) * height);
  let o = 0;
  for (let y = 0; y < height; y++) {
    raw[o++] = 0; // filter: none
    for (let x = 0; x < width; x++) {
      const [r, g, b] = pixel(x, y);
      raw[o++] = r; raw[o++] = g; raw[o++] = b;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 2; // 8 bit, RGB
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0)),
  ]);
}

// App icon: the "synced" ring from the status markers on the accent colour.
export function iconPng(size, { maskable = false } = {}) {
  const accent = [14, 90, 74];
  const paper = [243, 242, 237];
  const c = (size - 1) / 2;
  const outer = size * (maskable ? 0.24 : 0.3);
  const inner = outer * 0.58;
  return encodePng(size, size, (x, y) => {
    const d = Math.hypot(x - c, y - c);
    return d <= outer && d >= inner ? paper : accent;
  });
}

// A field-photo stand-in: smooth gradients with a coarse pattern, so the
// file is small but the image is not trivially flat.
export function fixturePhoto(width, height, seed = 1) {
  return encodePng(width, height, (x, y) => {
    const block = ((Math.floor(x / 80) + Math.floor(y / 80) + seed) % 3) * 18;
    return [
      (60 + (x * 120) / width + block) & 255,
      (90 + (y * 100) / height + block + seed * 20) & 255,
      (50 + ((x + y) * 60) / (width + height) + seed * 35) & 255,
    ];
  });
}
