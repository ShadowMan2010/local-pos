// Generates the logo PNGs the till and the browser need, from public/logo-source.jpg.
//
// The source is often a photo of a printed logo on white paper, with lots of empty space around it and
// dark grey ink rather than pure black. The crop finds the bounding box of "ink" (anything that is not
// very close to white), removes the border, then scales up to the needed sizes. For the mark used as a
// favicon / app icon it is padded slightly and placed in the upper middle: browsers tend to clip a
// third of the canvas, so used as-is the favicon would render the actual logo about 9 pixels wide.
//
// Some sources are JPEGs with white artboard rather than a transparent background. We do NOT make
// inside it, so turning white transparent would delete the logo's own interior. Only the outer
// whitespace that was cropped away is gone; the logo itself stays as drawn.
// The asset names are fixed (logo.png, icon-192.png, icon-512.png, apple-touch-icon.png) because index.html
// and manifest.webmanifest reference them directly.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const src = path.join(root, 'public', 'logo-source.jpg');

if (!fs.existsSync(src)) {
  console.error(`No logo to work from: ${src} is missing.`);
  console.error('Put a photo/copy of the shop logo there (JPG or PNG) and run this script again.');
  process.exit(1);
}

const img = sharp(src).ensureAlpha();
const { data, info } = await img.raw().toBuffer({ resolveWithObject: true });
const w = info.width, h = info.height;

function isInk(x, y) {
  const i = (y * w + x) * 4;
  const r = data[i], g = data[i + 1], b = data[i + 2];
  // near-white is background; anything meaningfully darker is ink
  return (r + g + b) < 650;
}

// find bounding box of ink
let minX = w, minY = h, maxX = -1, maxY = -1;
for (let y = 0; y < h; y++) {
  for (let x = 0; x < w; x++) {
    if (isInk(x, y)) { if (x < minX) minX = x; if (y < minY) minY = y; if (x > maxX) maxX = x; if (y > maxY) maxY = y; }
  }
}
if (maxX < 0) { console.error('The logo source looks blank — there is no ink to crop to.'); process.exit(1); }

const boxW = maxX - minX + 1, boxH = maxY - minY + 1;
if (boxW < 10 || boxH < 10) { console.error('The detected logo is too small — is the source the right file?'); process.exit(1); }

const cropped = await sharp(src).extract({ left: minX, top: minY, width: boxW, height: boxH }).png().toBuffer();

// Fit into a given width keeping aspect, padded slightly so it isn't clipped by UI chrome
async function fit(buf, targetW) {
  const meta = await sharp(buf).metadata();
  const h = Math.round(targetW * (meta.height / meta.width));
  return sharp(buf)
    .resize(targetW, h, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png()
    .toBuffer();
}

// App/icon versions: leave breathing room and nudge up so a circular/rounded launcher crop doesn't lop the top off
async function icon(buf, size) {
  const inner = Math.round(size * 0.78);
  const fitted = await fit(buf, inner);
  const meta = await sharp(fitted).metadata();
  const top = Math.round((size - meta.height) / 2 - size * 0.03);
  return sharp({
    create: { width: size, height: size, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } }
  }).composite([{ input: fitted, left: Math.round((size - meta.width) / 2), top: Math.max(0, top) }]).png().toBuffer();
}

const master = path.join(root, 'public', 'logo.png');
await sharp(cropped).resize(208, undefined, { fit: 'inside', withoutEnlargement: false }).png().toFile(master);
fs.writeFileSync(path.join(root, 'public', 'icon-192.png'), await icon(cropped, 192));
fs.writeFileSync(path.join(root, 'public', 'icon-512.png'), await icon(cropped, 512));
fs.writeFileSync(path.join(root, 'public', 'apple-touch-icon.png'), await icon(cropped, 180));

const made = await sharp(master).metadata();
console.log(`Generated from ${path.relative(root, src)} (cropped to ${boxW}x${boxH})`);
console.log(`  ${'logo.png'.padEnd(24)} ${made.width}x${made.height} (cropped from ${boxW}x${boxH}, natural aspect)`);
console.log(`  ${'icon-192.png'.padEnd(24)} 192x192`);
console.log(`  ${'icon-512.png'.padEnd(24)} 512x512`);
console.log(`  ${'apple-touch-icon.png'.padEnd(24)} 180x180`);
