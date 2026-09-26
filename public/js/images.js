// Product photos: shrink on the phone first, then store the file on the POS server's disk (data/uploads).
// Only the short path (e.g. /uploads/1726-ab12.jpg) is saved in Firestore, so photos stay off the cloud
// and every device on the same server shows them.

/** Resize to at most `max` px on the longest side and re-encode as JPEG (~30–80 KB). */
export async function compressImage(file, max = 640, quality = 0.82) {
  let src;
  try {
    src = await createImageBitmap(file, { imageOrientation: 'from-image' }); // respects phone camera rotation
  } catch {
    src = await new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error('Could not read this image'));
      img.src = URL.createObjectURL(file);
    });
  }
  const w = src.width || src.naturalWidth;
  const hgt = src.height || src.naturalHeight;
  const scale = Math.min(1, max / Math.max(w, hgt));

  const canvas = document.createElement('canvas');
  canvas.width = Math.round(w * scale);
  canvas.height = Math.round(hgt * scale);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff'; // PNG transparency -> white
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(src, 0, 0, canvas.width, canvas.height);

  return new Promise((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('Could not compress the image'))), 'image/jpeg', quality));
}

/** @returns {Promise<string>} public path such as /uploads/… */
export async function uploadImage(blob) {
  const res = await fetch('/api/upload', { method: 'POST', headers: { 'Content-Type': 'image/jpeg' }, body: blob });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Photo upload failed (${res.status})`);
  return data.url;
}

/** Best-effort cleanup of a photo file that is no longer used. */
export function deleteImage(url) {
  if (!url || !url.startsWith('/uploads/')) return Promise.resolve();
  return fetch(`/api/upload/${encodeURIComponent(url.split('/').pop())}`, { method: 'DELETE' }).catch(() => {});
}
