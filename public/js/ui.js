// Small UI helpers shared by every component (no framework needed).
import * as sfx from './sfx.js';

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

export const icon = (name, { spin = false } = {}) =>
  h('span', { class: 'material-symbols-rounded', 'aria-hidden': 'true', ...(spin ? { 'data-spin': '' } : {}) }, name);

/**
 * Fades the boot splash out and takes it off the page.
 *
 * Takes a plain event as its argument because it is wired straight to `window.addEventListener('error')`
 * in both entry points, where it is the one thing guaranteed to run when a module fails to load and the
 * splash would otherwise sit on top of a permanently blank till. The argument is ignored either way.
 *
 * The fade is a CSS class rather than a direct `display:none`, so the splash crossfades out instead of
 * vanishing mid-frame. Removal waits for the transition, and is guarded twice: the `dismissed` flag stops
 * two callers racing in the same tick (the boot promise resolving while an error fires) from restarting the
 * fade, and the timeout is a backstop for the case where `transitionend` never arrives - a backgrounded tab
 * that never paints a frame would otherwise leave the splash in the DOM, overlapping a working POS on the
 * next navigation back to this element.
 */
export function dismissBoot() {
  const el = document.getElementById('boot');
  // The app container is marked aria-busy in the HTML so that a screen reader announces the till as
  // still loading while the splash covers it. Removing the attribute - rather than setting it to "false" -
  // is what actually returns the region to the accessibility tree's normal state, and leaving a stale
  // aria-busy="false" behind means assistive tech keeps treating a working till as a pending region.
  document.getElementById('app')?.removeAttribute('aria-busy');
  if (!el || el.dataset.dismissed === '1') return;
  el.dataset.dismissed = '1';
  el.classList.add('leaving');
  const done = () => { if (el.classList.contains('leaving')) el.remove(); };
  el.addEventListener('transitionend', done, { once: true });
  setTimeout(done, 600);
}

export const iconBtn = (name, onclick, label, extra = '') =>
  h('button', { type: 'button', class: `icon-btn ${extra}`.trim(), onclick, 'aria-label': label, title: label }, icon(name));

const inr = new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', minimumFractionDigits: 2 });
export const money = (n) => inr.format(Number(n) || 0);

let snackTimer;
/**
 * Shows a message, and optionally sounds.
 *
 * `kind` is one of the sound names in sfx.js (paid, success, error, warn, alert, scan, add, unlock).
 * It is deliberately optional and defaults to *no sound*. This function is called from 60 places, and
 * making every call site audible by default would turn a shop into a chiming market stall. Silence is
 * also the honest default for the ones nobody has thought about: a message that has not been
 * classified has not been decided to be worth interrupting anybody for, and it can stay that way
 * until someone decides it is.
 *
 * Message and sound are separate arguments rather than one, because they answer different questions and a
 * shop will want them to disagree: "Only 2 of Milk in stock" is worth reading but not worth a noise that
 * could be mistaken for money, and "Bill saved" deserves a sound even when the cashier is looking at the
 * screen rather than reading it.
 *
 * The timer is cleared before it is set. Without that, a second message arriving while the first is still
 * up leaves the first one's timeout pending and the bar disappears early - usually while a long "could not
 * save the bill, it is kept on this device" is still being read.
 */
export function snack(message, ms = 3200, kind = '') {
  const el = document.getElementById('snackbar');
  if (!el) return;
  el.textContent = message;
  el.classList.add('show');
  clearTimeout(snackTimer);
  snackTimer = setTimeout(() => el.classList.remove('show'), ms);
  // Played after the text is set, so the sound belongs to the message now on screen rather than to the
  // previous one still fading out.
  if (kind) sfx.play(kind);
}

export function busy(btn, on = true) {
  if (!btn) return;
  if (on) {
    // A second call while already busy would otherwise stack a second spinner in the middle of the first.
    if (btn.dataset.busy) return;
    // Remembered so a button that was already disabled for its own reasons is not left enabled at the end,
    // which would offer an action that cannot work.
    btn.dataset.busyDisabled = btn.disabled ? '1' : '0';
    btn.dataset.busy = '1';
    btn.setAttribute('aria-busy', 'true');
    btn.disabled = true;
    btn.prepend(h('span', { class: 'md-spinner', 'aria-hidden': 'true' }));
    return;
  }
  if (!btn.dataset.busy) return;
  delete btn.dataset.busy;
  btn.removeAttribute('aria-busy');
  btn.disabled = btn.dataset.busyDisabled === '1';
  delete btn.dataset.busyDisabled;
  for (const s of btn.querySelectorAll('.md-spinner')) s.remove();
}

/**
 * Runs an async action with the button showing a loading state.
 *
 * The state is cleared in `finally` rather than at the end of the happy path, so a failed action — the
 * common case on a shop's flaky connection — does not leave a permanently spinning button that the only
 * way out of is reloading the page.
 */
export async function runBusy(btn, fn) {
  busy(btn, true);
  try { return await fn(); } finally { busy(btn, false); }
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

/* ---- copy to clipboard ---- */
/**
 * Copies text and says so. The confirmation is not optional: on a till at a counter the person tapping
 * "copy" is usually doing it to retype the address into a phone, so a copy that silently failed leaves
 * them reading an address off the screen character by character with no idea anything went wrong.
 *
 * Falls back to the old execCommand route because navigator.clipboard is unavailable on plain http://,
 * which is exactly how a shop runs this on its own LAN - and the whole reason the address has to be copied
 * is to type it into a phone on that same LAN.
 */
export async function copyText(text, label = 'Copied') {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
    } else {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.style.cssText = 'position:fixed;top:-1000px;opacity:0';
      document.body.append(ta);
      ta.select();
      if (!document.execCommand('copy')) throw new Error('copy command rejected');
      ta.remove();
    }
    snack(label);
    return true;
  } catch {
    snack('Could not copy — select the address and copy it by hand', 5000, 'warn');
    return false;
  }
}
