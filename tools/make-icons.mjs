/* Renders the HK Bus Finder app icons.
   No image libraries are available in this environment, so this writes the
   PNGs directly: a tiny supersampled rasteriser plus a zlib-backed PNG
   encoder. The glyph is the same bus mark the app header draws, so the icon
   and the product read as the same thing. */

import { deflateSync } from 'node:zlib';
import { writeFileSync } from 'node:fs';

/* ------------------------------------------------------------------ raster */

const SS = 4; // supersampling factor, 4x4 samples per output pixel

/** @param {number} size @param {number[]} rgb */
function createCanvas(size, rgb) {
  const w = size * SS;
  const buf = new Uint8Array(w * w * 4);
  for (let i = 0; i < w * w; i += 1) {
    buf[i * 4] = rgb[0];
    buf[i * 4 + 1] = rgb[1];
    buf[i * 4 + 2] = rgb[2];
    buf[i * 4 + 3] = 255;
  }
  return { buf, w, h: w };
}

/** @param {{buf: Uint8Array, w: number, h: number}} canvas */
function blend(canvas, x, y, rgb, alpha) {
  if (x < 0 || y < 0 || x >= canvas.w || y >= canvas.h) return;
  const i = (y * canvas.w + x) * 4;
  const a = Math.max(0, Math.min(1, alpha));
  canvas.buf[i] = Math.round(canvas.buf[i] * (1 - a) + rgb[0] * a);
  canvas.buf[i + 1] = Math.round(canvas.buf[i + 1] * (1 - a) + rgb[1] * a);
  canvas.buf[i + 2] = Math.round(canvas.buf[i + 2] * (1 - a) + rgb[2] * a);
  canvas.buf[i + 3] = 255;
}

/** @param {{buf: Uint8Array, w: number, h: number}} canvas */
function fillRoundedRect(canvas, x0, y0, x1, y1, r, rgb) {
  const left = Math.round(x0 * SS);
  const right = Math.round(x1 * SS);
  const top = Math.round(y0 * SS);
  const bottom = Math.round(y1 * SS);
  const radius = Math.round(r * SS);
  for (let y = top; y < bottom; y += 1) {
    for (let x = left; x < right; x += 1) {
      // Distance test against a rounded rectangle.
      const dx = Math.max(left + radius - x, x - (right - radius - 1), 0);
      const dy = Math.max(top + radius - y, y - (bottom - radius - 1), 0);
      if (dx * dx + dy * dy <= radius * radius) blend(canvas, x, y, rgb, 1);
    }
  }
}

/** @param {{buf: Uint8Array, w: number, h: number}} canvas */
function fillCircle(canvas, cx, cy, r, rgb) {
  const cxp = cx * SS;
  const cyp = cy * SS;
  const rp = r * SS;
  const left = Math.floor(cxp - rp);
  const right = Math.ceil(cxp + rp);
  const top = Math.floor(cyp - rp);
  const bottom = Math.ceil(cyp + rp);
  for (let y = top; y <= bottom; y += 1) {
    for (let x = left; x <= right; x += 1) {
      const dx = x + 0.5 - cxp;
      const dy = y + 0.5 - cyp;
      if (dx * dx + dy * dy <= rp * rp) blend(canvas, x, y, rgb, 1);
    }
  }
}

/** Box-downsample the supersampled canvas to the final size. */
function resolve(canvas, size) {
  const out = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      let r = 0;
      let g = 0;
      let b = 0;
      for (let sy = 0; sy < SS; sy += 1) {
        for (let sx = 0; sx < SS; sx += 1) {
          const i = ((y * SS + sy) * canvas.w + (x * SS + sx)) * 4;
          r += canvas.buf[i];
          g += canvas.buf[i + 1];
          b += canvas.buf[i + 2];
        }
      }
      const n = SS * SS;
      const o = (y * size + x) * 4;
      out[o] = Math.round(r / n);
      out[o + 1] = Math.round(g / n);
      out[o + 2] = Math.round(b / n);
      out[o + 3] = 255;
    }
  }
  return out;
}

/* -------------------------------------------------------------------- png */

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

/** @param {Buffer} buffer */
function crc32(buffer) {
  let c = 0xffffffff;
  for (let i = 0; i < buffer.length; i += 1) c = CRC_TABLE[(c ^ buffer[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** @param {string} type @param {Buffer} data */
function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([length, body, crc]);
}

/** @param {number} size @param {Buffer} rgba */
function encodePng(size, rgba) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8; // bit depth
  header[9] = 6; // truecolour with alpha
  header[10] = 0;
  header[11] = 0;
  header[12] = 0;

  const stride = size * 4;
  const raw = Buffer.alloc((stride + 1) * size);
  for (let y = 0; y < size; y += 1) {
    raw[y * (stride + 1)] = 0; // filter: none
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/* ------------------------------------------------------------------ icon */

const BACKGROUND = [0x00, 0x66, 0xc7]; // a bus-blue that reads on a phone
const GLYPH = [0xff, 0xff, 0xff];

/**
 * The bus mark, matching the inline SVG in the app header.
 * @param {number} size
 */
function drawIcon(size) {
  const canvas = createCanvas(size, BACKGROUND);
  // Scale the 24x24 mark onto the canvas with a small margin.
  const m = size * 0.2;
  const s = (size - m * 2) / 24;
  const px = (v) => m + v * s;

  // Body.
  fillRoundedRect(canvas, px(3), px(3), px(21), px(16), 3 * s, GLYPH);
  // Window band, cut back out of the body.
  fillRoundedRect(canvas, px(3.4), px(9.2), px(20.6), px(10.8), 0.8 * s, BACKGROUND);
  // Headlights.
  fillCircle(canvas, px(7.5), px(13.4), 1.15 * s, BACKGROUND);
  fillCircle(canvas, px(16.5), px(13.4), 1.15 * s, BACKGROUND);
  // Wheels.
  fillRoundedRect(canvas, px(6.1), px(14.5), px(8.1), px(21), 1 * s, GLYPH);
  fillRoundedRect(canvas, px(15.9), px(14.5), px(17.9), px(21), 1 * s, GLYPH);

  return encodePng(size, resolve(canvas, size));
}

/* ------------------------------------------------------------------ main */

const outDir = process.argv[2] ?? '.';
const targets = [
  { file: 'apple-touch-icon.png', size: 180 },
  { file: 'icon-192.png', size: 192 },
  { file: 'icon-512.png', size: 512 },
];

for (const target of targets) {
  const png = drawIcon(target.size);
  writeFileSync(`${outDir}/${target.file}`, png);
  console.log(`${target.file}  ${target.size}x${target.size}  ${png.length} bytes`);
}
