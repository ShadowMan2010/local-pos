/* Feature: a customer's UPI payment screenshot, filed against their order.
   The filing itself needs a live WhatsApp inbound message, which the fake connection cannot produce,
   so the pure replies are tested here: they are what the customer actually sees, and each one has to
   say the right thing — accepted, no order to attach it to, or send it again. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildPaymentProofSavedText, buildNoOrderForProofText, buildPaymentProofUnreadableText
} from '../whatsapp-bot.js';

const BENGALI = /[\u0980-\u09FF]/;

test('the payment-screenshot replies are English-only and different from one another', () => {
  const saved = buildPaymentProofSavedText();
  const none = buildNoOrderForProofText();
  const bad = buildPaymentProofUnreadableText();
  assert.notEqual(saved, none);
  assert.notEqual(none, bad);
  assert.notEqual(saved, bad);
  for (const text of [saved, none, bad]) {
    assert.ok(text.length > 15, 'a reply long enough to be a sentence');
    assert.ok(!BENGALI.test(text), 'English-only, per the shop directive');
  }
});

test('a screenshot with no order tells the customer to order first', () => {
  assert.match(buildNoOrderForProofText(), /menu/i);
});

test('an unreadable image asks them to send it again', () => {
  assert.match(buildPaymentProofUnreadableText(), /again/i);
});
