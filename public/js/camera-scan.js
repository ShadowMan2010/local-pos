// Camera-based scanner: an alternative to a USB barcode scanner. Reads a QR code (or a barcode
// printed as one) using the jsQR library, loaded from a CDN the first time it is needed.
import { h, icon, iconBtn } from './ui.js';

let jsQRPromise = null;
function loadJsQR() {
  if (window.jsQR) return Promise.resolve(window.jsQR);
  if (!jsQRPromise) {
    jsQRPromise = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = 'https://cdn.jsdelivr.net/npm/jsqr@1.4.0/dist/jsQR.min.js';
      s.onload = () => (window.jsQR ? resolve(window.jsQR) : reject(new Error('Camera-scanning library did not load')));
      s.onerror = () => reject(new Error('Could not load the camera-scanning library (check the internet connection)'));
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

  function finish(text) {
    if (stopped || !text) return;
    stopped = true;
    dlg.close();
    onResult(text);
  }

  function tick() {
    if (stopped) return;
    if (video.readyState === video.HAVE_ENOUGH_DATA && video.videoWidth) {
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
      const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
      const code = window.jsQR(img.data, img.width, img.height);
      if (code?.data) return finish(code.data);
    }
    raf = requestAnimationFrame(tick);
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
