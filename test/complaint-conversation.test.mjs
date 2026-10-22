/* The complaint conversation, tested on its own.
 *
 * These are the tests that matter most in the whole complaint feature, because this is the only part of the
 * shop that writes to a customer without anybody pressing a button first. It is a function call here, with
 * the complaint list and the model held in memory, so every branch can be pinned down — including the ones
 * that are painful to reach through a real server, like "the model tried to promise a refund".
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { createComplaintConversation } from '../complaint-conversation.js';
import { AI_STATE, MAX_AI_TURNS, NEEDS_HUMAN, REASON_TEXT, VERDICT } from '../complaint-ai.js';

const SENT = [];

/** A complaint as it arrives: filed by WhatsApp, nobody has looked at it yet. */
function newComplaint(over = {}) {
  return {
    id: 'CMP-0001',
    phone: '9876543210',
    customerName: 'Rahim',
    billId: 'B-12',
    billTotal: 340,
    text: 'the dal packet was torn',
    source: 'whatsapp',
    status: 'open',
    severity: 'major',
    handledBy: '',
    note: '',
    repliedAt: null,
    aiState: AI_STATE.AWAITING_SHOP,
    aiTurns: 0,
    transcript: [],
    aiEscalation: null,
    aiEscalatedAt: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    resolvedAt: null,
    ...over
  };
}

/** The wording the shop sends. Same rules as server.js, because it is shop policy, not test scaffolding. */
const handoffText = (c) => [
  'We are sorry to leave you waiting on this one.',
  '',
  `Corner Store is putting a person on it now. They will call you about your complaint ${c.id}.`,
  '',
  'Please keep that reference. Nothing has been settled yet — a person will decide what happens.'
].join('\n');

/**
 * A conversation wired to in-memory records and a model that can be told what to say.
 *
 * @param {object} opts
 * @param {object[]} opts.complaints  the records, mutated in place as the conversation runs
 * @param {(c: object, text: string) => string|null} [opts.model]  what the model returns
 * @param {string} [opts.reason]      set to make escalation fail, to test a complaint that is not open
 */
function setup({ complaints = [newComplaint()], model } = {}) {
  SENT.length = 0;
  const events = [];
  const conv = createComplaintConversation({
    list: () => complaints,
    normalise: (p) => String(p || '').replace(/\D/g, '').slice(-10),
    store: () => events.push({ store: true }),
    onChange: (c) => events.push({ change: c.id }),
    audit: (event, fields) => events.push({ audit: event, ...fields }),
    askModel: async (c, text) => (model ? model(c, text) : SAFE),
    storeName: () => 'Corner Store',
    fallbackText: (c) => `Your complaint reference is ${c.id}. Corner Store will call you back shortly.`,
    handoffText
  });
  return { conv, complaints, events, sent: SENT };
}

/** A safe reply, long enough to be worth screening. */
const SAFE = 'We are sorry about the torn packet. Could you share your bill number so we can look it up? '
  + 'Your reference is CMP-0001 and someone will call you today.';

/* ---------- the shop's gate ---------- */

test('the assistant says nothing until the shop marks the complaint minor', async () => {
  const { conv, complaints } = setup();
  const c = complaints[0];
  // The state on arrival is AWAITING_SHOP, and the default severity is major.
  assert.equal(c.aiState, AI_STATE.AWAITING_SHOP);
  const r = await conv.handle({ phone: c.phone, text: 'it is still torn' });
  assert.equal(r.handled, false, 'not ours to answer yet');
  assert.equal(r.text, null);
  assert.equal(c.transcript.length, 0, 'and nothing is written to the record either');
});

test('a complaint marked major again is taken off the assistant mid-conversation', async () => {
  // The most dangerous shape of this bug: the shop marks a complaint serious because the customer got angry,
  // and the bot carries on talking anyway because it cached "minor" an hour ago. The severity is re-read on
  // every turn precisely so that cannot happen.
  const { conv, complaints } = setup();
  const c = complaints[0];
  c.severity = 'minor';
  c.aiState = AI_STATE.ACTIVE;
  const first = await conv.handle({ phone: c.phone, text: 'the packet is torn' });
  assert.equal(first.handled, true);
  assert.equal(first.text, SAFE);

  c.severity = 'serious';
  const second = await conv.handle({ phone: c.phone, text: 'I want to speak to the manager' });
  assert.equal(second.handled, false, 'a person has taken this one over');
  assert.equal(second.text, null);
  assert.equal(c.aiState, AI_STATE.ACTIVE, 'and the state is left for the server, which owns severity changes');
});

test('a resolved complaint is never picked up, however the customer writes', async () => {
  const { conv, complaints } = setup({ complaints: [newComplaint({ status: 'resolved', resolvedAt: '2026-01-02T00:00:00.000Z' })] });
  const r = await conv.handle({ phone: '9876543210', text: 'you never fixed it' });
  assert.equal(r.handled, false, 'a closed complaint is not something the bot reopens from the far end');
});

/* ---------- escalation ---------- */

test('asking for a person hands it over on the spot, whatever turn it is', async () => {
  for (const turns of [0, 1, MAX_AI_TURNS, 9]) {
    const { conv, complaints } = setup();
    const c = complaints[0];
    c.severity = 'minor';
    c.aiState = AI_STATE.ACTIVE;
    c.aiTurns = turns;
    const r = await conv.handle({ phone: c.phone, text: 'ok thanks but let me talk to the owner' });
    assert.equal(r.action === undefined, true);
    assert.equal(r.handled, true);
    assert.equal(r.reason, NEEDS_HUMAN.ASKED_FOR_HUMAN);
    assert.equal(c.aiState, AI_STATE.ESCALATED);
    assert.equal(c.aiEscalation, NEEDS_HUMAN.ASKED_FOR_HUMAN);
    assert.ok(c.aiEscalatedAt, 'and it is stamped so the shop can see how long it has been waiting');
    // The customer is told a person is on it. Leaving somebody who asked for a person with no answer at
    // all is the outcome that turns one complaint into two.
    assert.match(r.text, /putting a person on it/i);
    assert.match(r.text, /CMP-0001/);
  }
});

test('safety outranks politeness, and a rule cannot be talked past', async () => {
  const { conv, complaints } = setup();
  const c = complaints[0];
  c.severity = 'minor';
  c.aiState = AI_STATE.ACTIVE;
  const r = await conv.handle({ phone: c.phone, text: 'thanks, but there was a stone inside the dal and I feel sick' });
  assert.equal(r.reason, NEEDS_HUMAN.SAFETY, 'a customer who is ill is not a triage case');
  assert.equal(c.aiState, AI_STATE.ESCALATED);
});

test('money hands it over, because triage cannot offer any', async () => {
  const { conv, complaints } = setup();
  const c = complaints[0];
  c.severity = 'minor';
  c.aiState = AI_STATE.ACTIVE;
  const r = await conv.handle({ phone: c.phone, text: 'I want my Rs 200 back' });
  assert.equal(r.reason, NEEDS_HUMAN.MONEY);
});

test('two turns and then a person is dragged in', async () => {
  const { conv, complaints } = setup();
  const c = complaints[0];
  c.severity = 'minor';
  c.aiState = AI_STATE.ACTIVE;
  for (let i = 0; i < MAX_AI_TURNS; i++) {
    const r = await conv.handle({ phone: c.phone, text: 'it is still torn' });
    assert.equal(r.text, SAFE, `turn ${i + 1} should be answered`);
  }
  assert.equal(c.aiTurns, MAX_AI_TURNS);
  const last = await conv.handle({ phone: c.phone, text: 'it is still torn' });
  assert.equal(last.reason, NEEDS_HUMAN.AI_COULD_NOT_SETTLE);
  assert.equal(c.aiState, AI_STATE.ESCALATED);
  assert.ok(REASON_TEXT[last.reason].length > 8, 'and the shop can read why it was handed over');
});

test('a customer who stops pushing is left alone, and the complaint stays open', async () => {
  const { conv, complaints } = setup();
  const c = complaints[0];
  c.severity = 'minor';
  c.aiState = AI_STATE.ACTIVE;
  const r = await conv.handle({ phone: c.phone, text: 'ok thanks' });
  assert.equal(r.handled, true);
  assert.equal(r.text, null, 'they said thanks; answering that is noise on top of a promise of a call');
  assert.equal(c.aiState, AI_STATE.WENT_QUIET);
  // The point of the whole design: nothing was fixed, so nothing is closed.
  assert.equal(c.status, 'open');
  assert.equal(c.aiEscalation, null, 'and nobody is dragged off a job to be told "ok thanks"');
});

test('an escalated complaint stays escalated, however often the customer writes', async () => {
  const { conv, complaints } = setup();
  const c = complaints[0];
  c.severity = 'minor';
  c.aiState = AI_STATE.ACTIVE;
  await conv.handle({ phone: c.phone, text: 'let me talk to the owner' });
  const first = c.aiEscalatedAt;
  const again = await conv.handle({ phone: c.phone, text: 'are you there? I asked for the owner' });
  assert.equal(again.handled, true);
  assert.equal(c.aiEscalatedAt, first, 'the handover is not restamped every time they write');
  assert.match(again.text, /putting a person on it/i, 'but they are still told it is with a person');
});

/* ---------- what the model is allowed to say ---------- */

test('a model that promises money is thrown away and the shop is told', async () => {
  const { conv, complaints, events } = setup({
    model: () => 'We have refunded your Rs 340 already, the money is on its way.'
  });
  const c = complaints[0];
  c.severity = 'minor';
  c.aiState = AI_STATE.ACTIVE;
  const r = await conv.handle({ phone: c.phone, text: 'what happened to my packet' });
  assert.equal(r.reason, NEEDS_HUMAN.AI_WENT_TOO_FAR);
  assert.equal(c.aiState, AI_STATE.ESCALATED);
  // Nothing generated is recorded as said, and nothing generated is in the handoff message either.
  assert.equal(c.transcript.filter((l) => l.from === 'assistant').length, 0);
  assert.doesNotMatch(r.text, /refund/i);
  assert.ok(events.some((e) => e.audit === 'complaint.escalated'), 'and the escalation is on the record');
});

test('a model that claims an action was taken is refused as firmly', async () => {
  const { conv, complaints } = setup({ model: () => 'Sorry about this. We have replaced the packet already.' });
  const c = complaints[0];
  c.severity = 'minor';
  c.aiState = AI_STATE.ACTIVE;
  assert.equal((await conv.handle({ phone: c.phone, text: 'my packet was torn' })).reason, NEEDS_HUMAN.AI_WENT_TOO_FAR);
});

test('a model that returns nothing hands over as "we could not answer", not as misbehaviour', async () => {
  const { conv, complaints } = setup({ model: () => null });
  const c = complaints[0];
  c.severity = 'minor';
  c.aiState = AI_STATE.ACTIVE;
  const r = await conv.handle({ phone: c.phone, text: 'my packet was torn' });
  assert.equal(r.reason, NEEDS_HUMAN.AI_UNAVAILABLE);
  assert.equal(c.aiState, AI_STATE.ESCALATED);
});

test('a refused reply is not retried with different wording', async () => {
  // A model that has just tried to promise the shop a refund is not one to be given another go at the same
  // customer, so there is exactly one call and then a person.
  let calls = 0;
  const { conv, complaints } = setup({ model: () => { calls++; return 'We will refund you Rs 500.'; } });
  const c = complaints[0];
  c.severity = 'minor';
  c.aiState = AI_STATE.ACTIVE;
  await conv.handle({ phone: c.phone, text: 'it is torn' });
  assert.equal(calls, 1);
});

/* ---------- the record ---------- */

test('what was said is written down, both ways', async () => {
  const { conv, complaints, events } = setup();
  const c = complaints[0];
  c.severity = 'minor';
  c.aiState = AI_STATE.ACTIVE;
  await conv.handle({ phone: c.phone, text: 'the packet is torn' });
  const said = events.find((e) => e.audit === 'complaint.ai-replied');
  assert.ok(said, 'the words are recorded');
  assert.equal(said.text, SAFE, 'in full, because a dispute is settled from the record');
  assert.equal(said.turn, 1);
  assert.deepEqual(c.transcript.map((l) => l.from), ['customer', 'assistant']);
  assert.equal(c.transcript[1].text, SAFE);
  assert.ok(Date.parse(c.transcript[0].at), 'and every line is stamped');
});

test('a long thread is trimmed so the record cannot grow without bound', async () => {
  const { conv, complaints } = setup();
  const c = complaints[0];
  c.severity = 'minor';
  c.aiState = AI_STATE.ACTIVE;
  c.transcript = Array.from({ length: 60 }, (_, i) => ({ from: 'customer', text: `old ${i}`, at: '2026-01-01T00:00:00.000Z' }));
  await conv.handle({ phone: c.phone, text: 'it is still torn' });
  assert.ok(c.transcript.length <= 42, `kept ${c.transcript.length} lines`);
  assert.equal(c.transcript[c.transcript.length - 1].from, 'assistant', 'and the newest exchange is still there');
});

/* ---------- the shop replying for itself ---------- */

test('a reply the shop writes is recorded, and the assistant stops', async () => {
  const { conv, complaints } = setup();
  const c = complaints[0];
  c.severity = 'minor';
  c.aiState = AI_STATE.ACTIVE;
  conv.staffSaid(c, 'I have refunded the Rs 340 and the boy is on his way.');
  assert.equal(c.transcript.length, 1);
  assert.equal(c.transcript[0].from, 'staff', 'it is recorded as a person, not the assistant');
  assert.equal(c.transcript[0].text, 'I have refunded the Rs 340 and the boy is on his way.');
  assert.equal(c.aiState, AI_STATE.TAKEN_OVER, 'so the assistant does not talk over the shopkeeper');
  assert.equal(c.status, 'open', 'and the complaint is not resolved by having been answered');
  assert.equal(c.aiEscalation, null, 'nothing went wrong, so nothing is escalated');
  assert.ok(c.repliedAt, 'and the record says the customer has been answered');
});

test('what the owner is allowed to say is not filtered', async () => {
  // The screen exists to catch a *model* inventing a promise. The owner saying one is a decision they
  // have made, and a till that refuses to let them say "we have refunded you" is not a safety feature.
  const { conv, complaints } = setup();
  const c = complaints[0];
  c.severity = 'minor';
  c.aiState = AI_STATE.ACTIVE;
  const refund = 'We have refunded your Rs 340 to your UPI. Sorry again.';
  conv.staffSaid(c, refund);
  assert.equal(c.transcript[0].text, refund, 'it goes on the record exactly as typed');
});

test('a customer writing again after a personal reply stays on the same complaint', async () => {
  // Without this the second message files a second complaint about the same torn packet, and the shop
  // ends up with two rows and half a picture.
  const { conv, complaints } = setup();
  const c = complaints[0];
  c.severity = 'minor';
  c.aiState = AI_STATE.ACTIVE;
  conv.staffSaid(c, 'The boy is on his way with a new packet.');
  const r = await conv.handle({ phone: c.phone, text: 'he has not come yet' });
  assert.equal(r.complaintId, c.id, 'it is the same complaint');
  assert.equal(complaints.length, 1, 'and no second one was filed');
  // The model is not consulted: a person is already dealing with it.
  assert.match(r.text, /CMP-0001/, 'the customer is told it is being looked at, in fixed words');
  assert.equal(c.aiState, AI_STATE.TAKEN_OVER, 'and the assistant is still out of it');
  assert.equal(c.transcript.at(-1).from, 'customer', 'but their message is on the record for the shop');
});

test('a personal reply does not resurrect an escalated complaint', async () => {
  const { conv, complaints } = setup();
  const c = complaints[0];
  c.severity = 'minor';
  c.aiState = AI_STATE.ACTIVE;
  await conv.handle({ phone: c.phone, text: 'I want to speak to the manager' });
  assert.equal(c.aiState, AI_STATE.ESCALATED);
  conv.staffSaid(c, 'I am the manager, what happened?');
  assert.equal(c.aiState, AI_STATE.ESCALATED, 'the reason it was handed over stays on the record');
  assert.equal(c.aiEscalation, NEEDS_HUMAN.ASKED_FOR_HUMAN);
});

test('an empty personal reply writes nothing', async () => {
  const { conv, complaints } = setup();
  const c = complaints[0];
  c.severity = 'minor';
  c.aiState = AI_STATE.ACTIVE;
  conv.staffSaid(c, '   ');
  assert.equal(c.transcript.length, 0, 'a blank box is not a message');
  assert.equal(c.aiState, AI_STATE.ACTIVE, 'and it does not switch the assistant off');
});

/* ---------- picking the right complaint ---------- */

test('a customer with two complaints talks about the newest open one', async () => {
  // The model is told which complaint it is talking about, so the reference it quotes has to be that one.
  // Getting this wrong means the assistant apologises about the oil while the customer is asking about the
  // packet, and the shop cannot tell which complaint the conversation was about.
  const { conv, complaints } = setup({
    complaints: [
      newComplaint({ id: 'CMP-0001', severity: 'minor', aiState: AI_STATE.ACTIVE }),
      newComplaint({ id: 'CMP-0002', severity: 'minor', aiState: AI_STATE.ACTIVE, text: 'the oil was leaking' })
    ],
    model: (c) => `We are sorry about this. Your reference is ${c.id} and someone will call you today.`
  });
  const r = await conv.handle({ phone: '9876543210', text: 'it is still torn' });
  assert.equal(r.complaintId, 'CMP-0002');
  assert.match(r.text, /CMP-0002/, 'and the reference it quotes is that one, not the older complaint');
  assert.equal(complaints[0].transcript.length, 0, 'and the older complaint is not written to at all');
  assert.equal(complaints[1].transcript.length, 2);
});

test('somebody else\'s complaint is never picked up', async () => {
  const { conv } = setup();
  const r = await conv.handle({ phone: '9999999999', text: 'it is still torn' });
  assert.equal(r.handled, false);
});

test('a number that is the same written differently is the same customer', async () => {
  // WhatsApp hands over jids with country codes and punctuation; the till has ten-digit numbers. If these
  // did not match, every follow-up would file itself as a new complaint instead of continuing the old one.
  const { conv } = setup();
  for (const phone of ['+91 98765-43210', '919876543210', '  9876543210  ']) {
    const r = await conv.handle({ phone, text: 'it is still torn' });
    assert.equal(r.handled, false, 'major severity, so not answered — but it found the complaint');
  }
});

/* ---------- the handoff wording is held to the same screen as the model ---------- */

test('the fixed handoff wording would pass the screen, so a hand edit cannot slip a promise in', async () => {
  const { screenReply } = await import('../complaint-ai.js');
  const c = newComplaint();
  const screened = screenReply(handoffText(c));
  assert.equal(screened.ok, true, `the shop's own wording was refused: ${screened.reason}`);
});
