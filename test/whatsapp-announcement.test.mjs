/* Feature: the one-off announcement the shop sends its saved customers.
   The risky part is not the wording, it is who gets it: this reaches real people's phones, and the two
   ways it goes wrong — messaging somebody twice, or messaging somebody who asked to stop — are both
   decided by announcementRecipients, so that is a pure function with its own tests rather than a loop
   buried in server.js. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  announcementRecipients, buildAnnouncementText, isOptOut, buildOptOutText
} from '../whatsapp-bot.js';

test('announcementRecipients returns each saved 10-digit number once, sorted', () => {
  const customers = {
    '9876543210': { name: 'Rina' },
    '9123456780': { name: 'Amit' },
    '9876543210 ': { name: 'duplicate in disguise' }, // trailing space, same person
    '919123456780': { name: 'stored in country-code form' }, // 12 digits: not a number we send to
    'abc': { name: 'junk key' }
  };
  assert.deepEqual(announcementRecipients(customers), ['9123456780', '9876543210']);
});

test('announcementRecipients leaves out anyone who asked to stop', () => {
  const customers = { '9876543210': {}, '9123456780': {} };
  assert.deepEqual(announcementRecipients(customers, { '9876543210': true }), ['9123456780']);
});

test('announcementRecipients tolerates a missing or empty customer list', () => {
  assert.deepEqual(announcementRecipients(), []);
  assert.deepEqual(announcementRecipients({}, {}), []);
});

test('the announcement names the shop, explains voice ordering, and offers a way out', () => {
  const text = buildAnnouncementText('Gupta Store');
  assert.match(text, /Gupta Store/);
  assert.match(text, /voice note/i);
  assert.match(text, /microphone|record|mic/i);
  assert.match(text, /"stop"/i);
});

test('the announcement falls back to a name rather than "undefined" without a shop name', () => {
  const text = buildAnnouncementText('');
  assert.ok(!/undefined/i.test(text));
  assert.ok(text.length > 20);
});

test('isOptOut understands the ways people say stop, and only those', () => {
  for (const w of ['stop', 'STOP', '  stop ', 'unsubscribe', 'opt out', 'optout']) {
    assert.equal(isOptOut(w), true, `should opt out: ${JSON.stringify(w)}`);
  }
  for (const w of ['', 'menu', '2 kg rice', 'please stop', 'nonstop', 'stop it']) {
    assert.equal(isOptOut(w), false, `should not opt out: ${JSON.stringify(w)}`);
  }
});

test('the opt-out reply points back to ordering', () => {
  assert.match(buildOptOutText(), /menu/i);
});
