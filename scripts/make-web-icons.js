'use strict';
/**
 * Membuat ikon PWA (PNG) untuk Orion Web — tanpa dependensi eksternal.
 * Menggambar bentuk bintang 4-ujung di atas latar gelap + cincin emas (identitas visual desktop).
 * Output: web/public/icon-192.png, icon-512.png, icon.svg
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

function crc32(buf){
  let c, crc = 0xFFFFFFFF;
  for (let n = 0; n < buf.length; n++){
    c = (crc ^ buf[n]) & 0xFF;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    crc = c ^ (crc >>> 8);
  }
  return (crc ^ 0xFFFFFFFF) >>> 0;
}
function chunk(type, data){
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td), 0);
  return Buffer.concat([len, td, crc]);
}
function png(size, pixels){ // pixels: Uint8Array RGB*size*size
  const raw = Buffer.alloc((size * 3 + 1) * size);
  let o = 0;
  for (let y = 0; y < size; y++){
    raw[o++] = 0; // filter none
    for (let x = 0; x < size; x++){
      const i = (y * size + x) * 3;
      raw[o++] = pixels[i]; raw[o++] = pixels[i + 1]; raw[o++] = pixels[i + 2];
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ]);
}
function render(size){
  const px = Buffer.alloc(size * size * 3);
  const cx = size / 2, cy = size / 2;
  const R = size * 0.42;          // radius cincin
  const ring = size * 0.035;
  const star = size * 0.30;       // panjang bintang
  const waist = size * 0.055;
  for (let y = 0; y < size; y++){
    for (let x = 0; x < size; x++){
      const dx = x - cx, dy = y - cy;
      const d = Math.hypot(dx, dy);
      const i = (y * size + x) * 3;
      // latar
      let r = 7, g = 9, b = 13;
      // cincin emas
      if (Math.abs(d - (R - ring / 2)) < ring / 2){ r = 245; g = 184; b = 46; }
      // bintang 4-ujung (astroid): |x/a|^n + |y/a|^n <= 1 dengan n < 1
      const a = star;
      const n = 0.5;
      const inStar = Math.pow(Math.abs(dx) / a, n) + Math.pow(Math.abs(dy) / a, n) <= 1;
      if (inStar){ r = 245; g = 184; b = 46; }
      if (d < waist) { r = 255; g = 217; b = 120; }
      px[i] = r; px[i + 1] = g; px[i + 2] = b;
    }
  }
  return px;
}
const outDir = path.join(__dirname, '..', 'web', 'public');
fs.mkdirSync(outDir, { recursive: true });
[192, 512].forEach(s => {
  fs.writeFileSync(path.join(outDir, 'icon-' + s + '.png'), png(s, render(s)));
  console.log('icon-' + s + '.png ditulis');
});
const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="14" fill="#07090D"/><circle cx="32" cy="32" r="26" fill="none" stroke="#F5B82E" stroke-width="2.4"/><path d="M32 10 L36 28 L54 32 L36 36 L32 54 L28 36 L10 32 L28 28 Z" fill="#F5B82E"/></svg>\n`;
fs.writeFileSync(path.join(outDir, 'icon.svg'), svg);
console.log('icon.svg ditulis');
