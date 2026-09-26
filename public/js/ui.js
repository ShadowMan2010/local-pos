// Small UI helpers shared by every component (no framework needed).

/** Create a DOM element: h('button', { class:'btn', onclick }, icon('add'), 'Add') */
export function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (v === true) el.setAttribute(k, '');
    else el.setAttribute(k, v);
  }
  for (const c of children.flat(Infinity)) {
    if (c == null || c === false) continue;
    el.append(c.nodeType ? c : document.createTextNode(String(c)));
  }
  return el;
}

export const icon = (name) => h('span', { class: 'material-symbols-rounded', 'aria-hidden': 'true' }, name);

export const iconBtn = (name, onclick, label, extra = '') =>
  h('button', { type: 'button', class: `icon-btn ${extra}`.trim(), onclick, 'aria-label': label, title: label }, icon(name));

const inr = new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', minimumFractionDigits: 2 });
export const money = (n) => inr.format(Number(n) || 0);

let snackTimer;
export function snack(message, ms = 3200) {
  const el = document.getElementById('snackbar');
  if (!el) return;
  el.textContent = message;
  el.classList.add('show');
  clearTimeout(snackTimer);
  snackTimer = setTimeout(() => el.classList.remove('show'), ms);
}

/* ---- theme ---- */
export function initTheme() {
  const stored = localStorage.getItem('m3pos.theme');
  if (!stored) {
    matchMedia('(prefers-color-scheme: dark)').addEventListener('change', (e) => {
      if (!localStorage.getItem('m3pos.theme')) document.documentElement.dataset.theme = e.matches ? 'dark' : 'light';
    });
  }
}
export function toggleTheme() {
  const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
  document.documentElement.dataset.theme = next;
  localStorage.setItem('m3pos.theme', next);
  return next;
}

/** Render text as a QR code and return a PNG data URL (safe to clone for printing). */
export function qrDataUrl(text, size = 256) {
  if (!window.QRCode) throw new Error('QR library did not load (check internet / CDN access)');
  const box = document.createElement('div');
  new window.QRCode(box, { text, width: size, height: size, correctLevel: window.QRCode.CorrectLevel.M });
  return box.querySelector('canvas').toDataURL('image/png');
}
