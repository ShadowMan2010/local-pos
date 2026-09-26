// Tests the image pipeline the WhatsApp side uses on a delivery boy's photo: shrink it for keeping,
// then still read the QR out of the shrunken copy. Runs with no server and no data dir.
//
//   node test/proof-image-pipeline.test.mjs
//
// The rule this protects: the picture is stored shrunk and re-encoded, and that must not be the
// reason a handover stops working. A QR that reads fine in the original photo has to survive the
// exact transform applied before it is filed, or a delivery that really happened cannot be closed.
import sharp from 'sharp';
import jsQR from 'jsqr';
import QRCode from 'qrcode';

let pass = 0;
let fail = 0;
const ok = (c, m) => { c ? pass++ : fail++; console.log((c ? '  ok   ' : '  FAIL ') + m); };
const section = (t) => console.log(`\n--- ${t} ---`);

/** Mirrors prepareProofPhoto() in whatsapp.js. Kept in step with it by the assertions below. */
async function prepareProofPhoto(buf) {
  return sharp(buf)
    .rotate()
    .resize({ width: 1280, height: 1280, fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: 80 })
    .toBuffer();
}

/** Mirrors readQrFromBuffer() in whatsapp.js: RGBA, because jsQR throws on any other stride. */
async function readQr(buf) {
  if (!buf?.length) return null;
  const { data, info } = await sharp(buf)
    .rotate()
    .resize({ width: 1200, height: 1200, fit: 'inside', withoutEnlargement: true })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const res = jsQR(data, info.width, info.height);
  return res ? res.data : null;
}

const TOKEN = 'M3-PICKUP-8f2a41c7d9e04b6f';

try {
  section('1. a QR survives being shrunk to the size a proof photo is stored at');
  // A phone photo is far bigger than a QR needs, so the stored copy is capped at 1280px. Rendered
  // large on purpose: this is the case most likely to break, since a naive resize can blur the
  // modules enough to stop them decoding.
  const big = await QRCode.toBuffer(TOKEN, { width: 1400, margin: 4 });
  ok((await readQr(big)) === TOKEN, 'the original renders and reads');
  const shrunk = await prepareProofPhoto(big);
  ok((await readQr(shrunk)) === TOKEN, 'and still reads after the shrink-and-re-encode');
  // Deliberately not asserting "smaller" here: a rendered QR is a synthetic image that PNG
  // compresses better than JPEG, so the re-encode can grow it. The cap that matters is the pixel
  // one, asserted in section 2, and the byte win on real photographs, asserted below.
  const bigMeta = await sharp(big).metadata();
  const smallMeta = await sharp(shrunk).metadata();
  ok(smallMeta.width <= 1280 && smallMeta.height <= 1280,
    `a 1400px render is capped to ${smallMeta.width}x${smallMeta.height}`);

  section('2. a real-sized phone photo is stored far smaller than it arrives');
  // Noise stands in for photographic detail, which is what makes a real photo heavy. A modern
  // phone sends several MB; the whole point of re-encoding is that the shop is not keeping a copy
  // of every one of them at full size forever.
  const noise = await sharp({
    create: { width: 3000, height: 2000, channels: 3, background: { r: 128, g: 128, b: 128 },
      noise: { type: 'gaussian', mean: 128, sigma: 40 } }
  }).png({ compressionLevel: 0 }).toBuffer();
  const storedNoise = await prepareProofPhoto(noise);
  ok(storedNoise.length < noise.length / 4,
    `a ${(noise.length / 1e6).toFixed(1)} MB photo is stored as ${(storedNoise.length / 1e3).toFixed(0)} KB`);
  const noiseMeta = await sharp(storedNoise).metadata();
  ok(noiseMeta.width === 1280, `and capped to 1280px wide (got ${noiseMeta.width})`);

  section('3. a small QR is not blown up into a blurry one');
  const small = await QRCode.toBuffer(TOKEN, { width: 240, margin: 4 });
  const smallStored = await prepareProofPhoto(small);
  ok((await readQr(smallStored)) === TOKEN, 'a small QR still reads after the pipeline');
  // withoutEnlargement must be doing its job, or every small photo would be blown up to 1280px of
  // interpolation and stored far larger than it needs to be.
  const meta = await sharp(smallStored).metadata();
  ok(meta.width <= 240, `a small photo is not enlarged (width ${meta.width})`);

  section('4. a photo with no QR in it yields nothing rather than throwing');
  const blank = await sharp({
    create: { width: 400, height: 400, channels: 3, background: { r: 200, g: 200, b: 200 } }
  }).jpeg().toBuffer();
  ok((await readQr(blank)) === null, 'a blank photo reads as no QR');
  ok((await readQr(Buffer.alloc(0))) === null, 'an empty buffer reads as no QR');

  section('5. the stored copy carries no EXIF, so a phone photo cannot leak the customer\'s location');
  // A handover photo is taken at the customer's door, and phone cameras record exactly where. That
  // must not be kept next to the delivery record.
  const withExif = await sharp(big).withMetadata({ exif: { IFD0: { Copyright: 'x' } } }).jpeg().toBuffer();
  const stored = await prepareProofPhoto(withExif);
  const outMeta = await sharp(stored).metadata();
  ok(!outMeta.exif, 'the re-encoded proof carries no EXIF block');
  ok(Buffer.isBuffer(stored) && stored[0] === 0xff && stored[1] === 0xd8, 'the stored proof is a JPEG');

  section('6. the transform matches what whatsapp.js actually applies');
  const waSrc = await import('node:fs').then((fs) => fs.readFileSync('whatsapp.js', 'utf8'));
  ok(/resize\(\{ width: 1280, height: 1280, fit: 'inside', withoutEnlargement: true \}\)/.test(waSrc),
    'whatsapp.js caps the stored copy at 1280px');
  ok(/\.jpeg\(\{ quality: 80 \}\)/.test(waSrc), 'whatsapp.js stores JPEG at quality 80');
  ok(!/withMetadata/.test(waSrc), 'whatsapp.js never asks sharp to copy metadata across');
  // The scan side must stay RGBA. jsQR throws on any other bytes-per-pixel, and the failure looks
  // like "no QR found" rather than an error, so a greyscale "optimisation" would silently break
  // every scan in the field.
  ok(/\.ensureAlpha\(\)/.test(waSrc), 'whatsapp.js scans in RGBA, which is what jsQR requires');
  // sharp throws on an empty buffer rather than returning nothing, so the length check has to come
  // first or a failed photo download crashes the message loop.
  ok(/if \(!buf\?\.length\) return null;/.test(waSrc), 'whatsapp.js bails out on an empty buffer before sharp sees it');
} catch (err) {
  ok(false, `threw: ${err && err.stack ? err.stack : err}`);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
