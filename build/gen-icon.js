// Generates build/icon.ico (a filled ring app mark) from the pure-JS PNG encoder.
// Run: node build/gen-icon.js
const fs = require('fs');
const path = require('path');
const { drawRingIcon } = require('../src/tray-icon');

const BRAND = '#D97757'; // warm Claude-ish terracotta
const SIZES = [256, 128, 64, 48, 32, 16];

// Each ICO entry embeds a full PNG (Vista+ supports PNG-compressed icons).
const pngs = SIZES.map((s) =>
  drawRingIcon(1, BRAND, { size: s, inner: 0.16, outer: 0.48 })
);

const count = SIZES.length;
const header = Buffer.alloc(6);
header.writeUInt16LE(0, 0); // reserved
header.writeUInt16LE(1, 2); // type: icon
header.writeUInt16LE(count, 4);

const entries = Buffer.alloc(16 * count);
let offset = 6 + 16 * count;
SIZES.forEach((s, i) => {
  const e = entries.subarray(i * 16, i * 16 + 16);
  e[0] = s >= 256 ? 0 : s; // width  (0 == 256)
  e[1] = s >= 256 ? 0 : s; // height
  e[2] = 0; // color palette
  e[3] = 0; // reserved
  e.writeUInt16LE(1, 4); // color planes
  e.writeUInt16LE(32, 6); // bits per pixel
  e.writeUInt32LE(pngs[i].length, 8); // size of image data
  e.writeUInt32LE(offset, 12); // offset of image data
  offset += pngs[i].length;
});

const ico = Buffer.concat([header, entries, ...pngs]);
const out = path.join(__dirname, 'icon.ico');
fs.writeFileSync(out, ico);
console.log('wrote', out, ico.length, 'bytes,', count, 'sizes');
