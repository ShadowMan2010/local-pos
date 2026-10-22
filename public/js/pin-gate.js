// The shop PIN, asked for once at the start of a shift.
//
// Deliberately a full-screen takeover rather than a dialog over the till. Until somebody types the PIN
// the till cannot take money, cannot see a customer and cannot change a price, so showing them the
// dashboard in a half-usable state would be worse than showing them nothing — and it makes it obvious
// the till is locked instead of looking broken.
//
// On a shop with no PIN set yet there is nothing to ask for, so the gate stays out of the way entirely
// and the app behaves exactly as it did before this existed. Setting one is opt-in, in Settings.
import { h, icon, snack } from './ui.js';
import * as api from './api.js';

let gate = null;
let onUnlock = null;

/**
 * Whether a PIN is set, or null when the server cannot say.
 *
 * The null case is the important one. It used to answer "yes, a PIN is set" whenever the status
 * request failed, on the reasoning that failing towards locked is the safe direction. That is wrong
 * here: the till was serving new JavaScript against a server that had not been restarted yet, so
 * /api/auth/status did not exist, every first-run shop got a full-screen lock it could not get past,
 * and the till was simply black with no clue why. A server that cannot answer is not a locked server.
 * Gating is therefore only ever done on a definite yes.
 */
export async function pinIsSet() {
  try {
    const s = await api.getAuthStatus();
    return Boolean(s?.pinSet);
  } catch {
    return false;
  }
}

/**
 * Whether this tab already holds a session the server still accepts.
 *
 * This is what stops the lock screen coming back on every reload. The token lives in sessionStorage, which
 * deliberately survives a reload and dies with the tab, so the till was being asked for its PIN again every
 * time somebody refreshed — dozens of times a shift, on a machine that reloads on its own more often than
 * anybody expects. The server already reports `authenticated` on the one endpoint the boot sequence calls
 * anyway, so the answer costs no extra request.
 *
 * Answering false when the status call fails is the safe direction: an unreachable server must not be read
 * as a valid session. The gate then appears, which is right, because the till genuinely cannot be trusted
 * until it has been told who is using it.
 */
export async function hasValidSession() {
  try {
    const s = await api.getAuthStatus();
    return Boolean(s?.authenticated);
  } catch {
    return false;
  }
}

/** Shows the lock screen. Safe to call repeatedly — an existing gate is reused, not stacked. */
export function showPinGate(after) {
  if (after) onUnlock = after;
  if (gate) return gate;

  const input = h('input', {
    class: '', type: 'password', inputmode: 'numeric', autocomplete: 'current-password',
    maxlength: '10', placeholder: ' ', 'aria-label': 'Shop PIN'
  });
  // Built up front but not shown until the server says a code is needed, so a shop with no second factor
  // sees exactly the one box it saw before. Adding a second field "just in case" would mean every shift
  // starts with something to fill in that does nothing.
  const codeWrap = h('div', { class: 'm3-field', style: 'width:100%', hidden: true });
  const codeInput = h('input', {
    class: '', type: 'text', inputmode: 'numeric', autocomplete: 'one-time-code',
    // 14, not 6: a backup code is twelve digits and the card it is read from has dashes in it. A 6 here
    // silently truncated the first six characters of every backup code, so the codes printed at setup were
    // unusable — the shop only found out when the phone was already lost.
    maxlength: '14', placeholder: '000000', 'aria-label': 'Code from your phone'
  });
  // The dashes are removed as they arrive, so a pasted or read-off-the-card code and a plain typed one are
  // the same string. Nobody can type a dash on the keypad beside the till, and somebody holding a card
  // should not have to think about that.
  codeInput.addEventListener('input', () => {
    const digits = codeInput.value.replace(/[\s-]/g, '');
    if (digits !== codeInput.value) codeInput.value = digits;
  });
  const codeErr = h('p', { class: 'body-s', style: 'color:var(--md-error);min-height:18px;margin:4px 0 0' });
  // The label goes *after* the input, and that order is load-bearing rather than cosmetic. The floating
  // label is absolutely positioned and lifts on `.m3-field input:focus + span` — an adjacent sibling that
  // only matches input-then-label. Written the other way round the label never lifts, so it stays at
  // top:16px, directly on top of the digits being typed, and the box looks broken. The PIN field below is
  // in the correct order; this one was not.
  codeWrap.append(codeInput, h('span', {}, 'Code from your phone'), codeErr);

  const err = h('p', { class: 'body-s', style: 'color:var(--md-error);min-height:18px;margin:4px 0 0' });
  const btn = h('button', { type: 'submit', class: 'btn btn-filled' }, 'Unlock');

  const form = h('form', { class: 'm3-field', style: 'width:min(320px,80vw);display:grid;gap:14px' },
    h('div', { class: 'm3-field', style: 'width:100%' }, input, h('span', {}, 'Shop PIN')), codeWrap);

  const hint = h('p', { class: 'body-m muted', style: 'margin:0', 'data-pin-hint': '1' },
    'Enter the shop PIN to start selling.');

  async function submit(e) {
    e?.preventDefault();
    const pin = input.value.trim();
    if (!pin) return;
    // A backup code is a legitimate second factor, so the same box takes one. The label mentions it rather
    // than adding a mode switch: somebody who has lost their phone wants one field to type into, not a
    // choice to make before they can start.
    const code = codeWrap.hidden ? undefined : codeInput.value.trim();
    if (!codeWrap.hidden && !code) { (codeErr.textContent = 'Enter the code from your phone'); return; }

    btn.disabled = true;
    btn.textContent = 'Checking…';
    err.textContent = '';
    codeErr.textContent = '';
    try {
      await api.login(pin, code);
      input.value = '';
      codeInput.value = '';
      hidePinGate();
      snack('Unlocked', 1500, 'unlock');
      onUnlock?.();
      onUnlock = null;
    } catch (e2) {
      if (e2.broken) {
        // The till is closed on purpose, not by a wrong guess. Saying "not right" would have somebody
        // trying the next code, and the next, with nothing on screen to say why none of them can work.
        (codeWrap.hidden ? err : codeErr).textContent = e2.message;
      } else if (e2.needsCode) {
        // The PIN was right and only the code is missing or wrong. The first time this happens the box
        // appears, because before it the server had not said a second factor was in play. On later attempts
        // it is already visible, so this is a no-op and the message just lands under the right field.
        const firstTime = codeWrap.hidden;
        codeWrap.hidden = false;
        (firstTime ? codeErr : err).textContent = e2.message;
        if (firstTime) {
          // The PIN is known good, so it is not asked for again, and the heading says so. Leaving the box
          // editable would invite a shopkeeper to change a PIN that is not the problem.
          input.readOnly = true;
          hint.textContent = 'Now the code from your phone, or a backup code.';
        }
        codeInput.focus();
        codeInput.select();
      } else {
        // A wrong PIN, a lockout, or a code that has been used. Shown as the server words it, because after
        // a few wrong tries that message explains the lockout. Making somebody guess why it stopped working
        // is just frustration.
        (codeWrap.hidden ? err : codeErr).textContent = e2.message;
        input.value = '';
        input.focus();
      }
    } finally {
      btn.disabled = false;
      btn.textContent = 'Unlock';
    }
  }

  form.addEventListener('submit', submit);
  form.append(btn, err);

  // Styled as a card on a dimmed backdrop rather than a solid fill. A full-bleed background colour is
  // how this ended up as a featureless black rectangle once: if anything inside fails to build, the
  // till shows a blank colour with no text and no clue what happened. A card with a border, a title
  // and a field means even a partial failure is legible.
  gate = h('div', {
    class: 'pin-gate', 'data-pin-gate': '1',
    style: 'position:fixed;inset:0;z-index:9999;display:grid;place-items:center;padding:24px;' +
           'background:color-mix(in srgb, var(--md-on-surface,#1A1C16) 45%, transparent);' +
           'backdrop-filter:blur(3px)'
  },
    h('div', { class: 'card-elevated pin-gate-card', style: 'display:grid;justify-items:center;gap:14px;padding:32px 28px;text-align:center;max-width:min(420px,92vw)' },
      h('span', { style: 'font-size:44px;line-height:1;color:var(--md-primary)' }, icon('lock')),
      h('h1', { class: 'headline-m' }, 'Till locked'),
      hint,
      form));

  document.body.append(gate);
  input.focus();
  return gate;
}

export function hidePinGate() {
  gate?.remove();
  gate = null;
}

export const pinGateVisible = () => Boolean(gate);

/**
 * Wires the gate to the api layer: a 401 from anywhere raises it, and it goes away as soon as a token
 * exists. Returns a teardown for the caller.
 */
export function initPinGate() {
  return api.onPinNeeded(() => { if (!api.getToken()) showPinGate(); });
}
