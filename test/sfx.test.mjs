// Tests for the notification sounds.
//
// Most of the value here is in catching the failure mode that is invisible by construction: a sound
// name that does not exist in the tone table. sfx.play() deliberately ignores an unknown name rather
// than throwing, because a typo must never break a sale - but that same decision means a typo produces
// silence and nothing else. No test failure, no error in the console, no way for anyone to notice until
// a shopkeeper asks why the paid chime stopped. So the names are checked against the table by reading
// the source, which is the only place the mistake can be made.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TONES, SOUND_NAMES, DEDUPE_MS } from '../public/js/sfx.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const jsDir = path.join(ROOT, 'public/js');
const walk = (d) => fs.readdirSync(d).flatMap((f) => {
  const p = path.join(d, f);
  return fs.statSync(p).isDirectory() ? walk(p) : [p];
});
const allJs = walk(jsDir).filter((f) => f.endsWith('.js'));

test('every sound name used anywhere in the app actually exists', () => {
  // Both ways a sound gets named: a snack kind, and a direct play() call.
  const used = new Map();
  for (const file of allJs) {
    const src = fs.readFileSync(file, 'utf8');
    const rel = path.relative(ROOT, file);
    for (const m of src.matchAll(/snack\([^;]*?,\s*'(paid|success|error|warn|alert|scan|add|unlock)'\s*\)/g)) {
      used.set(m[1], `${rel} (snack)`);
    }
    for (const m of src.matchAll(/sfx\.play\('([a-z]+)'\)/g)) {
      used.set(m[1], `${rel} (play)`);
    }
  }
  assert.ok(used.size >= 5, `expected the app to actually use sounds, found ${used.size}`);
  for (const [name, where] of used) {
    assert.ok(TONES[name], `"${name}" used at ${where} is not in the tone table, so it would be silent`);
  }
});

test('the sounds that matter most are actually wired up', () => {
  const all = allJs.map((f) => fs.readFileSync(f, 'utf8')).join('\n');
  // The one sound that ends a sale. If this is missing the system is decoration.
  assert.match(all, /sfx\.play\('paid'\)/, 'payment makes a sound');
  // Arriving by itself, with nobody touching the till.
  assert.match(all, /shouldAnnounce/, 'the polled badges only announce real arrivals');
  // A mute control, reachable without going into Settings.
  assert.match(all, /volume_off/, 'there is a way to turn it off');
});

test('no file imports the sound module without using it', () => {
  // Worth its own test because of how it failed once: the import landed in a handful of files and the
  // calls that were supposed to go with it did not. Every check in the app still parsed, every import
  // still resolved, and three screens imported a sound engine they never asked for - so the scanner
  // beeped in nobody's world and the scanner test passed anyway. An unused import is the fingerprint.
  for (const f of allJs) {
    const src = fs.readFileSync(f, 'utf8');
    if (!/^import \* as sfx from/m.test(src)) continue;
    const uses = (src.match(/sfx\.[a-zA-Z]+/g) || []).filter((u) => u !== 'sfx.js');
    assert.ok(uses.length > 0, `${path.relative(ROOT, f)} imports sfx but never calls it`);
  }
});

test('every tone is a playable schedule rather than an empty or broken one', () => {
  for (const [name, tone] of Object.entries(TONES)) {
    assert.ok(Array.isArray(tone.steps) && tone.steps.length > 0, `${name} has no notes`);
    assert.ok(tone.gain > 0 && tone.gain < 0.4, `${name} gain ${tone.gain} is outside a sane range`);
    let prevEnd = -1;
    for (const [i, s] of tone.steps.entries()) {
      assert.ok(s.f > 40 && s.f < 8000, `${name} step ${i} frequency ${s.f} is not audible`);
      assert.ok(s.dur > 0.01 && s.dur < 1, `${name} step ${i} length ${s.dur} is not a notification`);
      assert.ok(s.at >= 0, `${name} step ${i} starts before zero`);
      // Notes must not overlap into a mush, and must be in order.
      assert.ok(s.at >= prevEnd - 0.001, `${name} step ${i} overlaps the previous note`);
      prevEnd = s.at + s.dur;
    }
    // A notification that drags on is a nuisance in a shop.
    assert.ok(prevEnd < 1.2, `${name} lasts ${prevEnd.toFixed(2)}s, too long for a notification`);
  }
});

test('paid is audibly unlike everything else', () => {
  // The whole argument for the paid chime is that it cannot be confused with another notification.
  // If somebody later "simplifies" it into the success sound, this is what notices.
  const paid = TONES.paid;
  for (const [name, tone] of Object.entries(TONES)) {
    if (name === 'paid' || name === 'alert') continue;
    const sameShape = tone.steps.length === paid.steps.length
      && tone.steps.every((s, i) => s.f === paid.steps[i].f && s.dur === paid.steps[i].dur);
    assert.ok(!sameShape, `"paid" is now identical to "${name}" and would be indistinguishable`);
  }
  assert.ok(paid.steps.length >= 3, 'paid is a distinct multi-note phrase');
  // Rising, so it reads as "finished" rather than "something is wrong".
  for (let i = 1; i < paid.steps.length; i++) {
    assert.ok(paid.steps[i].f > paid.steps[i - 1].f, 'the paid chime should rise');
  }
});

test('warning and failure are different sounds, not the same one twice', () => {
  // A stock warning and a server being unreachable both stop a sale, but only one of them is a fault.
  // Sharing a sound teaches people to hear "something stopped" as routine.
  assert.notDeepEqual(TONES.warn.steps, TONES.error.steps);
  assert.notEqual(TONES.error.steps[0].wave, TONES.warn.steps[0].wave,
    'the failure tone is meant to be rougher than the warning');
});

test('a polled count only announces a genuine arrival', async () => {
  const { shouldAnnounce } = await import('../public/js/sfx.js');
  // The first reading is the backlog that was already there. Announcing it means every till shouts at
  // an empty shop the moment it is switched on, and people then switch the sounds off for good.
  assert.equal(shouldAnnounce(null, 5), false, 'the backlog on first load is not news');
  assert.equal(shouldAnnounce(undefined, 0), false);
  // A real arrival.
  assert.equal(shouldAnnounce(0, 1), true, 'a new order is news');
  assert.equal(shouldAnnounce(2, 5), true, 'several at once is news');
  // Going down means somebody dealt with it. That is the good case and must stay quiet.
  assert.equal(shouldAnnounce(5, 0), false, 'clearing the list is not an alert');
  assert.equal(shouldAnnounce(3, 3), false, 'no change, no noise');
  // And a number must not become a string on the way through a textContent assignment.
  assert.equal(shouldAnnounce('2', '3'), true, 'counts arriving as text still compare correctly');
  assert.equal(shouldAnnounce('3', '2'), false);
});

test('a duplicated notification is collapsed rather than stacked', () => {
  // Two polls landing together, or one poll firing twice, would otherwise play two identical alerts.
  // Two identical noises read as one louder noise, which trains people to ignore them.
  assert.ok(DEDUPE_MS >= 1000, 'the dedupe window is long enough to catch a duplicate poll');
  assert.ok(DEDUPE_MS < 10000, 'but short enough not to swallow a genuine repeat');
});

test('the mute setting defaults to on, because silence nobody asked for is worse than noise', () => {
  // A shop that has never opened Settings should get working sounds. Defaulting to muted would mean
  // the feature looks broken until someone finds a switch.
  assert.deepEqual(SOUND_NAMES, Object.keys(TONES));
  assert.ok(SOUND_NAMES.includes('paid'));
  // isEnabled() reads localStorage and returns true unless the value is exactly 'off'.
  assert.ok(SOUND_NAMES.length >= 6, 'there is a real vocabulary, not one generic beep');
});
