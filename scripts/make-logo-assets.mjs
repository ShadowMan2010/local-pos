#!/usr/bin/env node
// Generates the logo PNGs the till and the browser need, from public/logo-source.jpg.
//
// The source is a square JPEG that pads the mark with a lot of white: the mark fills only about a
// third of the canvas, so used as-is the favicon would render the actual logo about 9 pixels wide.
// So every size here is cropped to the ink first and only then scaled.
//
// The white background is deliberately KEPT. The mark is dark teal on white and has white detail
// inside it, so turning white transparent would delete the logo's own interior. Only the outer
// padding is trimmed, never the colour.
import sharp from 'sharp';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const src = path.join(root, 'public', 'logo-source.jpg');
if (!fs.existsSync(src)) {
  console.error(`No logo to work from: ${src} is missing.`);
  process.exit(1);
}

// Anything this far from white counts as part of the mark.
const INK_THRESHOLD = 54; // summed 255-minus-channel across RGB, so ~18 per channel
const { data, info } = await sharp(src).raw().toBuffer({ resolveWithObject: true });
const { width: W, height: H, channels: C } = info;
let minX = W, minY = H, maxX = -1, maxY = -1;
for (let y = 0; y < H; y++) {
  for (let x = 0; x < W; x++) {
    const o = (y * W + x) * C;
    if ((255 - data[o]) + (255 - data[o + 1]) + (255 - data[o + 2]) > INK_THRESHOLD) {
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
}
if (maxX < 0) {
  console.error('The logo source looks blank — there is no ink to crop to.');
  process.exit(1);
}
const box = { left: minX, top: minY, width: maxX - minX + 1, height: maxY - minY + 1 };
const side = Math.max(box.width, box.height);
console.log(`Source is ${W}x${H}; the mark is ${box.width}x${box.height} at (${minX},${minY}) — ${(box.width * box.height / (W * H) * 100).toFixed(0)}% of the canvas.`);

/**
 * Crops to the ink, scales it to fill `size`, and pads it out to an exact size x size square.
 * Returns the PNG buffer and measured size so callers can write it out or embed it.
 *
 * sharp always applies `extend` AFTER `resize`, whatever order they appear in the chain. So the
 * scale-down has to happen first and the padding is computed from the already-scaled dimensions;
 * padding a full-size resize just inflates the output past the size you asked for.
 */
async function squareBuf(size, marginPct) {
  const margin = Math.round(size * marginPct);
  const inner = size - 2 * margin; // longest edge the mark itself gets
  // Crop, scale to fit the inner box, then pad that up to the full square.
  const scaled = await sharp(src)
    .extract({ left: box.left, top: box.top, width: box.width, height: box.height })
    .resize(inner, inner, { fit: 'inside', kernel: 'lanczos3' })
    .toBuffer({ resolveWithObject: true });
  const padX = size - scaled.info.width;
  const padY = size - scaled.info.height;
  const { data } = await sharp(scaled.data)
    .extend({
      left: Math.floor(padX / 2), right: Math.ceil(padX / 2),
      top: Math.floor(padY / 2), bottom: Math.ceil(padY / 2),
      background: '#ffffff'
    })
    .flatten({ background: '#ffffff' })
    .png({ compressionLevel: 9 })
    .toBuffer({ resolveWithObject: true });
  return { data, width: scaled.info.width, height: scaled.info.height };
}

async function square(size, marginPct, out) {
  const target = path.join(root, 'public', out);
  const { data } = await squareBuf(size, marginPct);
  await fs.promises.writeFile(target, data);
  // Assert the real output rather than trusting the pipeline: a mis-sized favicon still "works" in a
  // browser, it just looks wrong, and that is exactly the sort of thing that ships unnoticed.
  const got = await sharp(target).metadata();
  if (got.width !== size || got.height !== size) {
    throw new Error(`${out} came out ${got.width}x${got.height}, expected ${size}x${size}`);
  }
  console.log(`  ${out.padEnd(24)} ${got.width}x${got.height}`);
}

/**
 * Packs PNG frames into a classic .ico container. Browsers that honour the <link> tags do not need
 * this, but plenty of tooling — and older browsers — request /favicon.ico outright, and a 404 there
 * is the sort of thing that shows up in every log forever.
 */
async function writeIco() {
  const sizes = [16, 32, 48];
  const frames = [];
  for (const s of sizes) frames.push({ size: s, data: (await squareBuf(s, 0)).data });
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);            // reserved
  header.writeUInt16LE(1, 2);            // type 1 = icon
  header.writeUInt16LE(frames.length, 4);
  let offset = 6 + frames.length * 16;
  const dir = [];
  for (const f of frames) {
    const e = Buffer.alloc(16);
    e.writeUInt8(f.size >= 256 ? 0 : f.size, 0);  // 0 means 256
    e.writeUInt8(f.size >= 256 ? 0 : f.size, 1);
    e.writeUInt8(0, 2);                  // palette size
    e.writeUInt8(0, 3);                  // reserved
    e.writeUInt16LE(1, 4);               // colour planes
    e.writeUInt16LE(32, 6);              // bits per pixel
    e.writeUInt32LE(f.data.length, 8);
    e.writeUInt32LE(offset, 12);
    offset += f.data.length;
    dir.push(e);
  }
  const out = path.join(root, 'public', 'favicon.ico');
  await fs.promises.writeFile(out, Buffer.concat([header, ...dir, ...frames.map((f) => f.data)]));
  const total = fs.statSync(out).size;
  console.log(`  ${'favicon.ico'.padEnd(24)} ${sizes.join('/')} frames, ${total} bytes`);
}

// Tight for the tab icon, roomier for the bigger surfaces.
await writeIco();
await square(512, 0.04, 'icon-512.png');
await square(192, 0.04, 'icon-192.png');
await square(180, 0.02, 'apple-touch-icon.png'); // iOS masks its own icon, so less margin reads bigger
await square(32, 0, 'favicon-32.png');
await square(16, 0, 'favicon-16.png');

// The master: the mark at its natural aspect, cropped, with a little air around it.
const master = path.join(root, 'public', 'logo.png');
await sharp(src)
  .extract(box)
  .extend({
    top: Math.round(box.height * 0.04), bottom: Math.round(box.height * 0.04),
    left: Math.round(box.width * 0.04), right: Math.round(box.width * 0.04),
    background: '#ffffff'
  })
  .flatten({ background: '#ffffff' })
  .png({ compressionLevel: 9 })
  .toFile(master);
// Report what was actually written, not what was asked for — the padding above is easy to get wrong
// and a silent mismatch here would just propagate into the README and every receipt.
const made = await sharp(master).metadata();
console.log(`  ${'logo.png'.padEnd(24)} ${made.width}x${made.height} (cropped from ${box.width}x${box.height}, natural aspect)`);
