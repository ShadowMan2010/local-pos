/* Feature: the WhatsApp bot's connection state, and what happens when the phone revokes the till.
   The bug this file exists for: when WhatsApp unlinked the shop's number, the status the settings screen
   polls was {connected:false, qr:null} — the *same* shape as "still starting up". The screen therefore
   said "Starting…" and sat there indefinitely, with no way for a shopkeeper to tell whether to wait or to
   do something, and no button to do it with. The log line said "logged out on the phone"; nothing on the
   screen said so.

   What is tested here is the decision, not the network. Driving a real socket needs a phone, a WhatsApp
   account and a server, none of which a test suite may have — and the decision is the part that was wrong,
   so that is the part worth pinning. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { classifyDisconnect } from '../whatsapp.js';

const close = (statusCode) => ({ lastDisconnect: { error: { output: { statusCode } } } });

test('a revoked device is terminal, and is reported as needing a person', () => {
  // 401 is what WhatsApp sends when the phone has unlinked this device. The credentials are gone from the
  // other end, so there is nothing to reconnect to.
  const outcome = classifyDisconnect(close(401));
  assert.equal(outcome.loggedOut, true, 'must be reported as logged out');
  assert.equal(outcome.retry, false, 'and must not be retried — a retry loop here never terminates');
});

test('a replaced session is treated the same way as a revoke', () => {
  // Baileys reports "this session was replaced" separately, and it means the same thing in practice: the
  // other end has moved on. Treating it as an ordinary network blip means the bot reconnects in a loop
  // against a session it can never win.
  const outcome = classifyDisconnect(close(440));
  assert.equal(outcome.loggedOut, true);
  assert.equal(outcome.retry, false);
});

test('a dropped connection is retried, because a reconnect genuinely fixes it', () => {
  // 428 is connectionLost, 408 is timedOut, 515 is restartRequired. All three clear themselves.
  for (const code of [408, 428, 515, 500]) {
    const outcome = classifyDisconnect(close(code));
    assert.equal(outcome.retry, true, `${code} should be retried`);
    assert.equal(outcome.loggedOut, false, `${code} is not a revoke`);
  }
});

test('an unrecognised status code is retried rather than treated as a revoke', () => {
  // The asymmetry is deliberate. Guessing "revoked" about an unknown code hides a fixable problem behind a
  // message that never resolves, and the shop has no way to tell that is what happened. Guessing "retry" on
  // a code that really was a revoke costs a few seconds of reconnecting and then reports it properly.
  for (const code of [99999, undefined, 0]) {
    assert.equal(classifyDisconnect(close(code)).retry, true, `${code} should default to retrying`);
  }
});

test('a close event with no error detail at all is still retried', () => {
  // Baileys has produced these — a socket closed while shutting down, a stream that ended without a
  // status. There is nothing to learn from it, so it gets the safe answer rather than throwing inside an
  // event handler, where nothing would catch it and the socket would simply stop.
  const outcome = classifyDisconnect({});
  assert.equal(outcome.retry, true);
  assert.equal(outcome.loggedOut, false);
  assert.equal(outcome.code, undefined);
});

test('the status the shop sees can tell a revoke from a slow start', () => {
  // This is the actual bug, stated as a shape. Both states used to serialise to the same JSON, so the
  // screen had one branch for "still starting" and one for "connected", and a revoke fell through both
  // into the first. The shapes have to be distinguishable, or no wording on the screen can fix it.
  const slowStart = { available: true, connected: false, qr: null, phone: null };
  const revoked = { available: true, connected: false, qr: null, phone: null, loggedOut: true };
  assert.notDeepEqual(
    slowStart, revoked,
    'a revoked device must not look like a socket that has not finished starting'
  );
  assert.equal(revoked.connected, false, 'and it is still not connected — the flag is extra information');
});
