// USB barcode scanners act like a keyboard: they "type" the code very fast and finish with Enter.
// We buffer keystrokes; if the gap between keys is tiny and Enter arrives, it's a scan, not a human.

/**
 * @param {(code:string)=>void} onScan
 * @param {{minLength?:number, maxGapMs?:number}} opts
 * @returns {() => void} call it to stop listening
 */
export function initBarcodeScanner(onScan, { minLength = 6, maxGapMs = 80 } = {}) {
  let buffer = '';
  let lastKeyAt = 0;

  function onKeyDown(e) {
    // let people type normally in text fields (search, discount, setup form…)
    if (e.target.closest?.('input, textarea, select, [contenteditable="true"]')) return;
    if (e.ctrlKey || e.metaKey || e.altKey) return;

    const now = performance.now();
    if (now - lastKeyAt > maxGapMs) buffer = ''; // slow typing = human, start over
    lastKeyAt = now;

    if (e.key === 'Enter') {
      if (buffer.length >= minLength) {
        e.preventDefault(); // stops Enter from "clicking" a focused button
        const code = buffer;
        buffer = '';
        onScan(code);
      } else {
        buffer = '';
      }
      return;
    }
    if (e.key.length === 1) buffer += e.key; // ignore Shift, Tab, arrows…
  }

  window.addEventListener('keydown', onKeyDown, true);
  return () => window.removeEventListener('keydown', onKeyDown, true);
}
