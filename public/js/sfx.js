// Notification sounds for the till, the weigh station and the customer display.
//
// Why these are generated rather than shipped as .mp3/.wav files: this runs on a Raspberry Pi in a
// shop with intermittent internet, and a till that goes quiet when the wifi drops is worse than one
// that is slightly the wrong pitch. A few oscillators cost nothing, load instantly, work offline, and
// add no binaries or licences to a project that vendors its other dependencies locally.
//
// Why most of them are two or three notes rather than one beep: a shop assistant working a queue
// cannot look at the screen for every action. What they need to know from audio alone is one of three
// things - "that went in", "that did not", or "money". A single short beep for all of that would tell
// them nothing, so each family rises, falls, or repeats in a way that is recognisable without looking.
//
//   paid    rising three notes, the brightest thing here. Money received. Deliberately impossible to
//           mistake for anything else, because it is the one sound that ends a sale.
//   success rising pair. Something was saved.
//   error   falling pair, slightly rough. Something was refused and the assistant has to fix it.
//   warn    falling pair, smooth. Something needs changing before it will work.
//   alert   the same note three times. Something arrived that nobody touched the till to cause -
//           a WhatsApp order or a complaint - and it is waiting to be looked at.
//   scan    one high blip. A barcode or QR was read.
//   add     one soft blip. Something went into the cart.
//   unlock  rising pair. The till was opened.
//
// The families are deliberately pitched apart from each other (roughly an octave apart) so they stay
// distinguishable on a small speaker in a noisy shop.
export const TONES = {
  // Notes are deliberately not overlapped, even slightly. A chime with its notes running into each
  // other is more musical, but the point of these is to be told apart by ear in a noisy shop, and
  // overlapping partials are exactly what makes two sounds blur into one.
  paid:    { gain: 0.18, steps: [{ f: 1047, at: 0, dur: 0.10 }, { f: 1319, at: 0.10, dur: 0.11 }, { f: 1568, at: 0.21, dur: 0.30 }] },
  success: { gain: 0.13, steps: [{ f: 659, at: 0, dur: 0.09 }, { f: 988, at: 0.09, dur: 0.14 }] },
  error:   { gain: 0.15, steps: [{ f: 294, at: 0, dur: 0.16, wave: 'sawtooth' }, { f: 220, at: 0.18, dur: 0.26, wave: 'sawtooth' }] },
  warn:    { gain: 0.12, steps: [{ f: 523, at: 0, dur: 0.09 }, { f: 392, at: 0.10, dur: 0.13 }] },
  alert:   { gain: 0.15, steps: [{ f: 880, at: 0, dur: 0.10 }, { f: 660, at: 0.12, dur: 0.10 }, { f: 880, at: 0.24, dur: 0.18 }] },
  scan:    { gain: 0.15, steps: [{ f: 1760, at: 0, dur: 0.045 }] },
  add:     { gain: 0.09, steps: [{ f: 880, at: 0, dur: 0.04, wave: 'triangle' }] },
  unlock:  { gain: 0.12, steps: [{ f: 523, at: 0, dur: 0.09 }, { f: 784, at: 0.09, dur: 0.18 }] }
};

export const SOUND_NAMES = Object.keys(TONES);

/* ---------- preferences ---------- */
// Follows the same shape as the paper-size and theme settings: a plain key in localStorage, so it
// survives a reload and needs no server round trip. Sound is a per-till preference, not a shop-wide
// one, because two tills in the same shop may sit in different rooms.
const KEY_ON = 'm3pos.sound';
const KEY_LEVEL = 'm3pos.soundLevel';
const read = (k) => { try { return localStorage.getItem(k); } catch { return null; } };
const write = (k, v) => { try { localStorage.setItem(k, v); } catch { /* private mode: this session only */ } };

export const isEnabled = () => read(KEY_ON) !== 'off';
export const level = () => (read(KEY_LEVEL) === 'low' ? 'low' : 'normal');
export function setEnabled(on) { write(KEY_ON, on ? 'on' : 'off'); return on; }
export function setLevel(l) { write(KEY_LEVEL, l === 'low' ? 'low' : 'normal'); return level(); }

/* ---------- the audio engine ---------- */

let ctx = null;        // created on first use, not at load
let master = null;
let unlocked = false;  // has a real user gesture been seen yet
let lastPlayed = Object.create(null);

// The same sound twice in a row is almost always a duplicated notification - a poll that fired twice,
// or two polls landing together - and two identical alerts read as one louder one, which trains people
// to ignore them.
export const DEDUPE_MS = 1500;

function audio() {
  if (ctx) return ctx;
  const Ctor = window.AudioContext || window.webkitAudioContext;
  if (!Ctor) return null;
  try {
    ctx = new Ctor();
    master = ctx.createGain();
    master.connect(ctx.destination);
  } catch {
    return null;
  }
  return ctx;
}

/**
 * Browsers refuse to make noise until the page has been touched. Rather than pretending otherwise, we
 * remember that we are waiting and play the moment a gesture happens - which for the customer display
 * is the single tap it needs anyway, and for the till is the first tap on the PIN pad.
 */
export function primeAudio() {
  if (unlocked) return;
  unlocked = true;
  audio()?.resume?.().catch(() => {});
}

/**
 * True when a sound of this name is allowed to play right now, remembering that it just did.
 *
 * `force` bypasses the mute setting here as well as in `play`. It has to: leaving the enabled check in
 * one function and not the other means a forced play passes the first gate and is then quietly dropped
 * by the second, which is exactly the "preview button does nothing" bug this option exists to fix.
 */
export function canPlay(name, { force = false } = {}) {
  if (!force && !isEnabled()) return false;
  const now = Date.now();
  if (now - (lastPlayed[name] || 0) < DEDUPE_MS) return false;
  lastPlayed[name] = now;
  return true;
}

/**
 * Plays a named sound. Unknown names are ignored rather than throwing: a typo must not break a sale.
 *
 * `force` is for deliberate auditioning - the "preview this sound" button in Settings. It has to work
 * while muted, because the moment somebody wants to hear a sound is while deciding whether to turn it
 * on; a preview button that stays silent because sound is off is worse than no preview at all, since
 * it reads as a broken speaker.
 */
export function play(name, { force = false } = {}) {
  const tone = TONES[name];
  if (!tone || (!force && !isEnabled())) return false;
  if (!canPlay(name, { force })) return false;

  const ac = audio();
  if (!ac) return false;
  // A context created before any gesture starts suspended. Try to wake it; if that is refused, the
  // next real interaction will prime it and later sounds will work.
  if (ac.state === 'suspended') ac.resume?.().catch(() => {});

  const vol = (level() === 'low' ? 0.5 : 1) * tone.gain;
  for (const step of tone.steps) {
    const osc = ac.createOscillator();
    const gain = ac.createGain();
    osc.type = step.wave || 'sine';
    osc.frequency.value = step.f;
    // A short ramp in and out on every note. A hard start or stop on an oscillator is an audible click,
    // and a click on a shop speaker at payment time sounds like a fault.
    const t0 = ac.currentTime + step.at;
    gain.gain.setValueAtTime(0.0001, t0);
    gain.gain.exponentialRampToValueAtTime(vol, t0 + 0.012);
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + step.dur);
    osc.connect(gain).connect(master);
    osc.start(t0);
    osc.stop(t0 + step.dur + 0.02);
  }
  return true;
}

/* ---------- announcing things that arrive by themselves ---------- */

/**
 * Whether a polled count going from `prev` to `next` is something worth making a noise about.
 *
 * The alternative - sound whenever a badge is non-zero - means a till that is left open all day
 * announces the same three backlogged orders every eight seconds until people switch it off, which
 * then silences the one order that actually matters. So: only a genuine increase, and never on the
 * first reading, which is just the backlog that was already there when the page opened.
 */
export function shouldAnnounce(prev, next) {
  if (prev === null || prev === undefined) return false; // first reading: the existing backlog
  return Number(next) > Number(prev);
}

/* ---------- test seam ---------- */
// The engine is built on globals so it works in a browser, but tests need to see what was asked for
// without a speaker. Exposing the state lets a test drive the real decision logic.
export const _internals = { TONES, DEDUPE_MS, get ctx() { return ctx; } };
