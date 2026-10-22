// Camera-based scanner: an alternative to a USB barcode scanner. Reads a QR code (or a barcode
// printed as one) using the jsQR library, served from this machine rather than a CDN — the shop's
// internet is not guaranteed, and a scanner that silently cannot start offline is useless at a till.
import { h, icon, iconBtn } from './ui.js';
import * as sfx from './sfx.js';

let jsQRPromise = null;
function loadJsQR() {
  if (window.jsQR) return Promise.resolve(window.jsQR);
  if (!jsQRPromise) {
    jsQRPromise = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = '/vendor/jsQR.js';
      s.onload = () => (window.jsQR ? resolve(window.jsQR) : reject(new Error('Camera-scanning library did not load')));
      s.onerror = () => reject(new Error('Could not load the camera-scanning library from the server'));
      document.head.append(s);
    });
  }
  return jsQRPromise;
}

/**
 * Opens a full-screen camera dialog, decodes the first QR code it sees and calls onResult(text).
 * Always offers a "type it instead" box too, in case the camera is unavailable or the code is
 * a plain barcode a phone camera cannot read.
 * @param {{title?:string, onResult:(text:string)=>void}} opts
 */
export function openCameraScanner({ title = 'Scan a code', onResult }) {
  const dlg = h('dialog', { class: 'm3-dialog cam-dialog' });
  const video = h('video', { autoplay: true, playsinline: true, muted: true });
  const canvas = document.createElement('canvas');
  const hint = h('div', { class: 'cam-hint body-m muted' }, 'Starting camera…');
  const manualInput = h('input', { type: 'text', inputmode: 'text', autocomplete: 'off', placeholder: 'Or type the code' });

  let stream = null, raf = null, stopped = false, slowHintTimer = null;
  // The 2D context is asked for once. Asking per frame is cheap in isolation but it makes the
  // browser re-create the backing store, which is exactly the kind of stutter this loop must not
  // have while it is also decoding a QR.
  const ctx2d = canvas.getContext('2d', { willReadFrequently: true });
  // jsQR is a full-image search: cost grows with pixel count, and it dominated the frame budget at
  // 1920x1080, which made the preview stutter and the whole dialog feel like it was struggling.
  // A QR is readable long before that, so the scan runs on a smaller copy while the preview stays
  // at full size.
  const SCAN_MAX = 720;
  // Scans per second. The preview redraws every frame; decoding does not need to. 8/s is far faster
  // than a person can move a phone and leaves the main thread free for the video itself.
  const SCAN_INTERVAL_MS = 125;
  let lastScan = 0;

  function finish(text) {
    if (stopped || !text) return;
    stopped = true;
    dlg.close();
    // The beep has to land here, at the moment of capture, rather than where the code turns out to be
    // used. Pointing a phone at a shelf is all eyes and no attention, so a sound is the only feedback
    // the shopkeeper gets that anything was read at all. No sound on a failed read: that already gets
    // a visible message, and a noise on every failed frame would train people to ignore it.
    sfx.play('scan');
    onResult(text);
  }

  /**
   * Looks for a code in the current video frame. Tries the frame as-shot and then turned on its
   * side: a phone or a label held at an angle is common, and rotating is far cheaper than asking
   * the user to line it up perfectly.
   */
  function scanFrame() {
    const vw = video.videoWidth, vh = video.videoHeight;
    if (!vw || !vh) return null;
    const scale = Math.min(1, SCAN_MAX / Math.max(vw, vh));
    const w = Math.max(1, Math.round(vw * scale));
    const h = Math.max(1, Math.round(vh * scale));
    canvas.width = w;
    canvas.height = h;
    ctx2d.drawImage(video, 0, 0, w, h);
    const img = ctx2d.getImageData(0, 0, w, h);
    let code = window.jsQR(img.data, w, h, { inversionAttempts: 'attemptBoth' });
    if (code?.data) return code.data;
    // Rotated: draw through a quarter turn rather than re-reading the pixels.
    canvas.width = h;
    canvas.height = w;
    ctx2d.save();
    ctx2d.translate(h, 0);
    ctx2d.rotate(Math.PI / 2);
    ctx2d.drawImage(video, 0, 0, w, h);
    ctx2d.restore();
    const turned = ctx2d.getImageData(0, 0, h, w);
    code = window.jsQR(turned.data, h, w, { inversionAttempts: 'attemptBoth' });
    return code?.data || null;
  }

  function tick(now) {
    raf = requestAnimationFrame(tick);
    if (stopped) return;
    if (video.readyState !== video.HAVE_ENOUGH_DATA) return;
    if (now - lastScan < SCAN_INTERVAL_MS) return;
    lastScan = now;
    const data = scanFrame();
    if (data) return finish(data);
  }

  async function start() {
    try {
      await loadJsQR();
      stream = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: 'environment',
          width: { ideal: 1920 }, height: { ideal: 1080 }, // a QR shown on a screen decodes far more
          advanced: [{ focusMode: 'continuous' }]           // reliably at a higher resolution; ignored if unsupported
        }
      });
      if (stopped) { stream.getTracks().forEach((t) => t.stop()); return; }
      video.srcObject = stream;
      hint.textContent = 'Fill the frame with the QR code and hold steady';
      raf = requestAnimationFrame(tick);
      // scanning a QR shown on a screen (glare, moiré, autofocus hunting) is harder than a printed
      // one — after a few seconds with no luck, nudge towards the most common fixes
      slowHintTimer = setTimeout(() => {
        if (!stopped) hint.textContent = 'Still looking… move a little closer or further away, tilt to avoid screen glare, or type the code below';
      }, 6000);
    } catch (err) {
      hint.textContent = `Camera unavailable (${err.message}). Type the code below instead.`;
    }
  }

  dlg.append(
    h('div', { class: 'dlg-head' },
      h('h2', { class: 'title-l' }, title), h('span', { class: 'spacer' }),
      iconBtn('close', () => dlg.close(), 'Close')),
    h('div', { class: 'cam-body' },
      h('div', { class: 'cam-frame' }, video, h('div', { class: 'cam-reticle' })),
      hint,
      h('form', {
        class: 'cam-manual',
        onsubmit: (e) => { e.preventDefault(); finish(manualInput.value.trim()); }
      }, manualInput, h('button', { type: 'submit', class: 'btn btn-tonal' }, 'Use'))));

  dlg.addEventListener('close', () => {
    stopped = true;
    clearTimeout(slowHintTimer);
    if (raf) cancelAnimationFrame(raf);
    if (stream) stream.getTracks().forEach((t) => t.stop());
    dlg.remove();
  });

  document.body.append(dlg);
  dlg.showModal();
  start();
}
