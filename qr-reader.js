// Reading a delivery token out of a photo the delivery boy sent.
//
// This is its own module rather than a closure inside the WhatsApp loop so it can be tested against
// real generated photos. The cases that used to fail here are ordinary in the field: the token is a
// QR on the *customer's* screen, photographed by a delivery boy on a phone, so it is often small in
// a big frame, sideways, washed out by screen glare, or shown from a phone in dark mode.
import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import sharp from 'sharp';
import jsQR from 'jsqr';

const APP_DIR = path.dirname(fileURLToPath(import.meta.url));
// Optional second opinion, see scanQrWithOpenCv. Overridable so a shop that installs it elsewhere
// (or not at all) does not need a code change.
export const QR_PYTHON = process.env.POS_QR_PYTHON || 'python3';
export const QR_SCRIPT = process.env.POS_QR_SCRIPT || path.join(APP_DIR, 'tools', 'qr-scan.py');
// Long enough for the helper's slowest realistic photo, short enough that a wedged child process
// cannot sit on a delivery boy's message.
const QR_PYTHON_TIMEOUT_MS = 8000;

/**
 * Stretches contrast in place so jsQR's own binarisation has an easier time.
 *
 * A phone photo of another phone's screen is often low-contrast and shot through glare, and
 * that is a large share of the photos that fail. Sharp's `.greyscale().normalize()` does the same
 * job but measured ~6x slower (744ms vs 120ms on a 1400px photo) because it has to re-encode,
 * and it cannot be done inline at all: `.greyscale()` latches a sharp pipeline to a single channel
 * and a following `.toColourspace('srgb')` will not put the colour channels back, so `ensureAlpha()`
 * then yields 2 bytes per pixel and jsQR throws on every single photo.
 *
 * Written out longhand it is two cheap passes over bytes the decoder is about to walk anyway.
 * Alpha is left untouched, so this cannot damage the buffer for jsQR.
 */
function stretchContrast(px) {
  const d = px.data;
  let min = 255, max = 0;
  // First pass finds the range. Striding 4 pixels is plenty — a QR's modules are many pixels
  // wide, so this still sees both extremes, and it keeps the pass cheap on a large image.
  for (let i = 0; i < d.length; i += 16) {
    const l = (d[i] * 77 + d[i + 1] * 150 + d[i + 2] * 29) >> 8; // integer luminance
    if (l < min) min = l;
    if (l > max) max = l;
  }
  const range = max - min;
  // A good photo already spans enough range; remapping it would only discard information, so
  // the common case skips the second pass entirely.
  if (range < 40) return px;
  const k = 255 / range;
  for (let i = 0; i < d.length; i += 4) {
    const l = (d[i] * 77 + d[i + 1] * 150 + d[i + 2] * 29) >> 8;
    const v = (l - min) * k;
    d[i] = d[i + 1] = d[i + 2] = v < 0 ? 0 : v > 255 ? 255 : v;
  }
  return px;
}

/**
 * Turns a photo into the exact RGBA bytes jsQR needs.
 *
 * jsQR insists on exactly 4 bytes per pixel and THROWS otherwise, so this keeps the guard rather
 * than trusting the pipeline: a throw here would look like "no QR found" instead of a bug.
 */
async function toScanPixels(buf, { max, rotate = 0, normalise = true, enlarge = false }) {
  const resize = enlarge
    // Deliberately sharp's default (Lanczos) rather than nearest-neighbour: a QR needs
    // anti-aliased edges, and blocky upscaling makes the detector worse rather than better.
    ? { width: max, height: max, fit: 'inside' }
    : { width: max, height: max, fit: 'inside', withoutEnlargement: true };
  let img = sharp(buf)
    .rotate() // honour the photo's EXIF orientation before anything else
    .resize(resize)
    .flatten({ background: '#ffffff' }); // a transparent QR would otherwise scan as nothing
  if (rotate) img = img.rotate(rotate);
  const px = await img
    .toColourspace('srgb')
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  if (px.data.length !== px.info.width * px.info.height * 4) {
    console.error(`QR scan skipped: expected RGBA pixels, got ${px.info.channels} channel(s)`);
    return null;
  }
  const out = normalise ? stretchContrast(px) : px;
  // sharp hands back a Node Buffer. jsQR needs a Uint8ClampedArray and throws "Malformed data
  // passed to binarizer" on a Buffer, which the caller would swallow as "no QR found" — so every
  // photo would quietly fail. The conversion is what keeps that from happening.
  return {
    data: new Uint8ClampedArray(out.data.buffer, out.data.byteOffset, out.data.length),
    width: out.info.width,
    height: out.info.height
  };
}

/**
 * Asks OpenCV for a second opinion on a photo, over a short-lived child process.
 *
 * OpenCV's detector reads photos that jsQR cannot — a QR washed out by screen glare is the
 * common one, and it is exactly the photo this bot depends on. It is spawned per photo rather
 * than kept running: that costs ~0.7s of interpreter start-up, but a supervised long-lived child
 * at a shop till can hang or die and then quietly stop working, which is worse.
 *
 * This is a bonus, never a requirement. Every failure mode — python not installed, cv2 missing,
 * a crash, a timeout — resolves to null so the caller simply carries on with jsQR. `unavailable`
 * latches after the first failure so a machine without python does not pay for a failed spawn on
 * every photo for the rest of the day.
 */
const pyState = { unavailable: false };
function scanQrWithOpenCv(buf) {
  if (pyState.unavailable) return Promise.resolve(null);
  if (!fs.existsSync(QR_SCRIPT)) {
    pyState.unavailable = true;
    return Promise.resolve(null);
  }
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(QR_PYTHON, [QR_SCRIPT], { stdio: ['pipe', 'pipe', 'ignore'] });
    } catch {
      pyState.unavailable = true;
      return resolve(null);
    }
    const chunks = [];
    let settled = false;
    // One exit path for all four endings, because a late timeout firing after the child already
    // exited is a classic way to kill an unrelated process.
    const done = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => {
      pyState.unavailable = true; // something is wrong with the setup; stop paying for it
      try { child.kill('SIGKILL'); } catch { /* already gone */ }
      done(null);
    }, QR_PYTHON_TIMEOUT_MS);
    child.stdout.on('data', (d) => chunks.push(d));
    child.on('error', (err) => {
      // ENOENT here means there is no python3 at all, which is a setup problem, not a bad photo.
      if (err.code === 'ENOENT') pyState.unavailable = true;
      done(null);
    });
    child.on('close', () => {
      const text = Buffer.concat(chunks).toString('utf8').trim();
      done(text || null);
    });
    // A photo that cannot be piped is a photo this helper will never see; that must not throw
    // into the message loop either.
    child.stdin.on('error', () => { try { child.kill('SIGKILL'); } catch { /* already gone */ } });
    child.stdin.end(buf);
  });
}

/**
 * Pulls a delivery token out of a photo the delivery boy sent. Never throws: a photo we cannot
 * read is an ordinary outcome (blurry shot, screenshot of the wrong thing, a sticker), and it
 * must not be able to disturb the rest of the message loop.
 *
 * No single scanner is reliable on these photos, which is the whole problem. Measured against
 * real-world cases (a small code inside a huge phone photo, a photo taken sideways with no EXIF,
 * one washed out by screen glare, a low-contrast one, and a customer's phone in dark mode), the
 * old single-downscale jsQR pass read about half. jsQR and OpenCV each read cases the other
 * misses, so they are stacked rather than swapped:
 *
 *   1. jsQR at a modest size, contrast-stretched. Fast — this is the common case and it lands
 *      in a few hundred milliseconds, so nearly every good photo never reaches step 2.
 *   2. OpenCV, which is much better at glared and sideways photos.
 *   3. jsQR again, enlarged and rotated, for a small code in a big photo.
 *
 * It runs once per received photo rather than per video frame, so the seconds spent on a
 * hopeless photo cost the user nothing: Node stays responsive and the reply simply says no QR
 * was found and to type the code.
 * @returns {Promise<string|null>} the decoded text, or null if there is no readable QR
 */
async function readQrFromBuffer(buf) {
  if (!buf?.length) return null;
  try {
    // The common case first, and cheap.
    const quick = await toScanPixels(buf, { max: 1400 });
    if (quick) {
      const hit = jsQR(quick.data, quick.width, quick.height, { inversionAttempts: 'attemptBoth' });
      if (hit?.data) return hit.data;
    }

    // A stronger, differently-wrong detector. Null for any reason and we simply continue.
    const viaOpenCv = await scanQrWithOpenCv(buf);
    if (viaOpenCv) return viaOpenCv;

    // Last resort: bigger, and turned. Enlargement is what rescues a small code in a large
    // photo, and it only works with smooth interpolation — nearest-neighbour leaves jagged edges
    // that the detector reads as noise, which is easy to write by accident.
    for (const a of [
      { max: 2400, enlarge: true },
      { max: 1400, rotate: 90, enlarge: true },
      { max: 1400, rotate: 270, enlarge: true }
    ]) {
      const px = await toScanPixels(buf, a);
      if (!px) continue;
      const hit = jsQR(px.data, px.width, px.height, { inversionAttempts: 'attemptBoth' });
      if (hit?.data) return hit.data;
    }
    return null;
  } catch (err) {
    // An unreadable photo is ordinary, so it is logged and swallowed. This must never escape
    // into the message loop.
    console.error('Could not read a QR code from that photo:', err.message);
    return null;
  }
}
export { readQrFromBuffer };
