// Generates a small PNG icon at runtime with NO native/compiled dependencies.
// It rasterizes a progress ring into an RGBA buffer and encodes it as a valid
// PNG using Node's built-in zlib -- so the tray icon can reflect current usage
// (fill = 5-hour-block %, color = severity) without any image library.

const zlib = require('zlib');

// ---- PNG encoding -----------------------------------------------------------

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

function encodePNG(width, height, rgba) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type: RGBA
  ihdr[10] = 0; // deflate
  ihdr[11] = 0; // adaptive filtering
  ihdr[12] = 0; // no interlace

  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0; // filter byte "none"
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, y * stride + stride);
  }
  const idat = zlib.deflateSync(raw, { level: 9 });

  return Buffer.concat([
    sig,
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---- ring rasterizer --------------------------------------------------------

function hexToRgb(h) {
  const s = h.replace('#', '');
  return [
    parseInt(s.slice(0, 2), 16),
    parseInt(s.slice(2, 4), 16),
    parseInt(s.slice(4, 6), 16),
  ];
}

// Draw a donut whose filled arc = pct (0..1), starting at 12 o'clock going
// clockwise. Returns a PNG Buffer. Supersampled 3x for smooth edges.
function drawRingIcon(pct, color, opts = {}) {
  const size = opts.size || 32;
  const ss = 3; // supersample factor
  const S = size * ss;
  const acc = new Float32Array(S * S * 4);

  const cx = S / 2 - 0.5;
  const cy = S / 2 - 0.5;
  const outer = S * (opts.outer || 0.47);
  const inner = S * (opts.inner || 0.30);
  const [fr, fg, fb] = hexToRgb(color);
  const trackA = 0.22; // faint remaining-track opacity
  const p = Math.max(0, Math.min(1, pct));
  const fillAngle = p * Math.PI * 2;

  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const dx = x - cx;
      const dy = y - cy;
      const dist = Math.sqrt(dx * dx + dy * dy);
      if (dist > outer || dist < inner) continue;
      let ang = Math.atan2(dx, -dy); // 0 at top, increases clockwise
      if (ang < 0) ang += Math.PI * 2;
      const a = ang <= fillAngle ? 1 : trackA;
      const i = (y * S + x) * 4;
      acc[i] = fr;
      acc[i + 1] = fg;
      acc[i + 2] = fb;
      acc[i + 3] = a;
    }
  }

  // Downsample (box filter) into the final RGBA buffer.
  const out = Buffer.alloc(size * size * 4, 0);
  const area = ss * ss;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (let sy = 0; sy < ss; sy++) {
        for (let sx = 0; sx < ss; sx++) {
          const i = ((y * ss + sy) * S + (x * ss + sx)) * 4;
          const pa = acc[i + 3];
          r += acc[i] * pa;
          g += acc[i + 1] * pa;
          b += acc[i + 2] * pa;
          a += pa;
        }
      }
      const o = (y * size + x) * 4;
      if (a > 0) {
        out[o] = Math.round(r / a);
        out[o + 1] = Math.round(g / a);
        out[o + 2] = Math.round(b / a);
        out[o + 3] = Math.round((a / area) * 255);
      }
    }
  }

  return encodePNG(size, size, out);
}

module.exports = { drawRingIcon, encodePNG };
