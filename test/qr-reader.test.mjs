// Feeds readQrFromBuffer a set of photos that reproduce the ways delivery QR scanning actually goes
// wrong in the field, and checks it reads the token and invents nothing where there is no code.
//
// Run with: npm run test:qr
import assert from 'node:assert/strict';
import test from 'node:test';
import QRCode from 'qrcode';
import sharp from 'sharp';
import { readQrFromBuffer } from '../qr-reader.js';

const TOKEN = 'Xk3n7pQm2Vr9Ld4T';

const qrPng = (width, dark = '#000000ff', light = '#ffffffff') =>
  QRCode.toBuffer(TOKEN, { type: 'png', errorCorrectionLevel: 'M', margin: 4, width, color: { dark, light } });

// Builds something closer to a delivery boy's phone photo than to a clean QR: the code sitting in a
// larger frame, optionally turned, optionally washed out, and always saved as a compressed JPEG.
async function photoOfScreen({ qrWidth, canvas, rotate = 0, dark, light, jpegQuality = 72, glare = false }) {
  let frame = await sharp(await qrPng(qrWidth, dark, light))
    .resize(canvas, canvas, { fit: 'contain', background: light || '#ffffffff' })
    .flatten({ background: light || '#ffffff' })
    .toBuffer();
  if (rotate) frame = await sharp(frame).rotate(rotate).toBuffer();
  if (glare) {
    // A soft bright wash across part of the frame, like a reflection on glass.
    const wash = Buffer.from(
      `<svg width="${canvas}" height="${canvas}"><defs><radialGradient id="g" cx="30%" cy="25%" r="60%">` +
      '<stop offset="0%" stop-color="white" stop-opacity="0.55"/>' +
      '<stop offset="100%" stop-color="white" stop-opacity="0"/>' +
      '</radialGradient></defs><rect width="100%" height="100%" fill="url(#g)"/></svg>'
    );
    frame = await sharp(frame).composite([{ input: wash, blend: 'over' }]).toBuffer();
  }
  return sharp(frame).jpeg({ quality: jpegQuality }).toBuffer();
}

const readable = {
  'a sticker QR, straight on': () => photoOfScreen({ qrWidth: 620, canvas: 1400 }),
  'a small QR in a huge photo': () => photoOfScreen({ qrWidth: 260, canvas: 3000 }),
  'a very small QR in a huge photo': () => photoOfScreen({ qrWidth: 190, canvas: 3400, jpegQuality: 62 }),
  'a photo taken sideways': () => photoOfScreen({ qrWidth: 520, canvas: 1600, rotate: 90 }),
  'a photo taken sideways the other way': () => photoOfScreen({ qrWidth: 520, canvas: 1600, rotate: 270 }),
  'a QR washed out by screen glare': () =>
    photoOfScreen({ qrWidth: 520, canvas: 1500, dark: '#6a6a6aff', light: '#c9c9c9ff', glare: true }),
  'a low-contrast, heavily compressed QR': () =>
    photoOfScreen({ qrWidth: 480, canvas: 1500, dark: '#7d7d7dff', light: '#a8a8a8ff', jpegQuality: 45 }),
  'a dark-mode QR (light on black)': () =>
    photoOfScreen({ qrWidth: 520, canvas: 1400, dark: '#ffffffff', light: '#101010ff' })
};

for (const [name, make] of Object.entries(readable)) {
  test(`reads ${name}`, async () => {
    const buf = await make();
    assert.equal(await readQrFromBuffer(buf), TOKEN);
  });
}

test('invents nothing when the photo has no QR code', async () => {
  const buf = await sharp({
    create: { width: 900, height: 600, channels: 3, background: { r: 40, g: 90, b: 160 } }
  }).jpeg().toBuffer();
  assert.equal(await readQrFromBuffer(buf), null);
});

test('invents nothing for a blank image', async () => {
  const buf = await sharp({
    create: { width: 600, height: 600, channels: 3, background: { r: 255, g: 255, b: 255 } }
  }).png().toBuffer();
  assert.equal(await readQrFromBuffer(buf), null);
});

test('returns null instead of throwing on data that is not an image', async () => {
  assert.equal(await readQrFromBuffer(Buffer.from('this is not a photo at all')), null);
  assert.equal(await readQrFromBuffer(Buffer.alloc(0)), null);
  assert.equal(await readQrFromBuffer(null), null);
});

test('returns null rather than hanging on a truncated image', async () => {
  const full = await photoOfScreen({ qrWidth: 400, canvas: 900 });
  const cut = full.subarray(0, Math.floor(full.length / 3)); // JPEG header, no image data
  assert.equal(await readQrFromBuffer(cut), null);
});

test('the common case is fast enough to feel instant', async () => {
  const buf = await photoOfScreen({ qrWidth: 620, canvas: 1400 });
  await readQrFromBuffer(buf); // warm up: the first call pays for libvips start-up, which is not what this measures
  const started = process.hrtime.bigint();
  assert.equal(await readQrFromBuffer(buf), TOKEN);
  const ms = Number(process.hrtime.bigint() - started) / 1e6;
  // A good photo should be settled by the first jsQR pass, without ever reaching the Python helper.
  // This guards against the whole ladder running on every delivery, which would be slow enough for
  // people to give up and type codes instead.
  assert.ok(ms < 1500, `a clean photo took ${Math.round(ms)}ms; the first pass should settle it`);
});
