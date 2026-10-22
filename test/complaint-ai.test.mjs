/* The shop's WhatsApp complaint policy, tested on its own.
 *
 * These are the rules that decide whether a message reaches a customer and whether a person is dragged
 * out of the shop to deal with it. They are tested apart from the server and the bot on purpose: this is
 * the layer where a mistake is a real customer being told something untrue, and it should be possible to
 * read every rule and every example in one place.
 *
 * The examples are written the way customers actually type, not the way a specification would phrase
 * them, because the specification is not what arrives on WhatsApp. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  needsHumanNow, readCustomerReply, screenReply, buildTriagePrompt,
    NEEDS_HUMAN, REASON_TEXT, VERDICT, transcriptLine,
    nextStep, aiMayReply, AI_STATE, MAX_AI_TURNS
} from '../complaint-ai.js';

/* ---------- when a person is needed ---------- */

test('a customer asking for a person gets one, however they phrase it', () => {
  // This is the rule the shop asked for. The phrasings are the ones that arrive, including the ones that
  // are not even asking a question, and including Bengali — a shop that only catches the English wording
  // ignores exactly the customers it most needs to hear.
  for (const t of [
    'I want to talk to a person',
    'let me speak to the owner',
    'connect me to a human',
    'is there a real person there',
    'I want the manager',
    'someone in charge please',
    'talk to your owner',
    'customer care please',
    'ওনার সাথে কথা বলতে চাই',
    'মালিক দের সাথে কথা বলাবো',
    'কেউ আছে?'
  ]) {
    assert.equal(needsHumanNow(t), NEEDS_HUMAN.ASKED_FOR_HUMAN, `should reach a person: "${t}"`);
  }
});

test('safety and illness outrank everything else', () => {
  // A customer who says they feel ill is not a triage case, and a rule that looked for "ask for a person"
  // first would quietly file their message as a routine request for the owner.
  for (const [t, want] of [
    ['the milk was spoiled and I feel sick', NEEDS_HUMAN.SAFETY],
    ['there was a stone inside the dal', NEEDS_HUMAN.SAFETY],
    ['I am going to the hospital', NEEDS_HUMAN.SAFETY],
    ['the packet was expired', NEEDS_HUMAN.SAFETY],
    ['পচা সবজি পেয়েছি', NEEDS_HUMAN.SAFETY]
  ]) {
    assert.equal(needsHumanNow(t), want, `"${t}" should be a safety escalation`);
  }
});

test('a threat to escalate is taken seriously', () => {
  for (const t of [
    'I will call the police', 'my lawyer will call you', 'I will go to the consumer forum',
    'I will post this in the media', 'I am going to the court'
  ]) {
    assert.equal(needsHumanNow(t), NEEDS_HUMAN.ANGRY, `"${t}" should bring a person in`);
  }
});

test('anything about money brings a person in, because triage cannot offer it', () => {
  // The shop may not offer money, so a customer asking for it has asked for something the AI cannot
  // possibly give. Carrying on regardless would end in a reply that says no, which is a worse answer than
  // a phone call.
  for (const t of [
    'I want a refund', 'give me my money back', 'I want Rs 200 back', 'you should give me a discount',
    'টাকা ফেরত দিন'
  ]) {
    assert.equal(needsHumanNow(t), NEEDS_HUMAN.MONEY, `"${t}" should reach a person`);
  }
});

test('an ordinary complaint is triaged, not handed straight to a person', () => {
  // The whole reason the shop asked for this. If every complaint escalated immediately there would be no
  // point having it answer at all.
  for (const t of [
    'the rice packet was torn',
    'wrong item delivered',
    'one packet is missing',
    'the oil can was leaking',
    'you delivered late again',
    'the quality is not good',
    'চালের প্যাকেট ছিঁড়া'
  ]) {
    assert.equal(needsHumanNow(t), null, `"${t}" should be handled without a person`);
  }
});

/* ---------- reading the customer's reply ---------- */

test('a customer who stops pushing is recorded as withdrawing, not as resolved', () => {
  // The distinction this file exists to protect. The shop is not allowed to offer a remedy, so "ok thanks"
  // means they have stopped pushing — not that anything was fixed. Recording it as resolved would leave
  // the shop claiming a fix it never made.
  for (const t of ['ok', 'okay', 'thanks', 'thank you', 'fine', 'noted', 'got it', 'ধন্যবাদ', 'ঠিক আছে']) {
    assert.equal(readCustomerReply(t).verdict, VERDICT.WENT_QUIET, `"${t}" means they have stopped pushing`);
  }
});

test('"ok but I still want my money" is not satisfaction', () => {
  // The failure mode of any pattern match. A bare "ok" inside a longer message, or next to a refusal, is
  // not a thank-you, and reading it as one closes a complaint that is still very much open.
  for (const t of [
    'ok but I still want my money back',
    'fine, this is still not resolved',
    'thanks but nobody has called me',
    'ok I will complain again'
  ]) {
    const got = readCustomerReply(t).verdict;
    assert.notEqual(got, VERDICT.WENT_QUIET, `"${t}" must not be read as satisfied`);
  }
});

test('asking for a person wins even inside a polite message', () => {
  // "ok thanks but let me talk to the owner" is a request for the owner. A rule that looked for the
  // thank-you first would have quietly closed it and answered nobody.
    const got = readCustomerReply('ok thanks but let me talk to the owner');
    assert.equal(got.escalate, NEEDS_HUMAN.ASKED_FOR_HUMAN);
    assert.notEqual(got.verdict, VERDICT.WENT_QUIET);
});

test('a message with nothing recognisable keeps the conversation open', () => {
  // The safe default. Guessing "satisfied" from a message we did not understand is how a customer's
  // complaint disappears without anybody noticing.
  for (const t of ['', '   ', 'hmm', 'ok ok ok but', 'ঠিক আছে ঠিক আছে কিন্তু']) {
    assert.notEqual(readCustomerReply(t).verdict, VERDICT.WENT_QUIET, `"${t}" must not close a complaint`);
  }
});

/* ---------- the last check before a customer sees it ---------- */

test('a generated reply promising money is thrown away, not sent', () => {
  // The one guarantee that cannot depend on the model behaving. Every reply, including ones from a
  // release that has been tested and approved, goes through this before it reaches anyone.
  for (const t of [
    'We are sorry. We will refund you Rs 50 for the trouble.',
    'I have arranged a replacement for you',
    'We have replaced the packet and it will arrive tomorrow',
    'You will get a 20% discount on your next bill',
    'We have credited the amount to your account',
    'no problem, free replacement'
  ]) {
    const r = screenReply(t);
    assert.equal(r.ok, false, `must not be sent: "${t}"`);
    assert.equal(r.reason, NEEDS_HUMAN.AI_WENT_TOO_FAR);
  }
});

test('a reply claiming an action that was never taken is thrown away', () => {
  // Triage has not replaced anything, because triage cannot. A reply that says it has is simply untrue,
  // and the customer will come back with a screenshot.
  for (const t of [
    'We have dispatched your replacement',
    'I have refunded the amount',
    'Your order has been cancelled and re-ordered'
  ]) {
    assert.equal(screenReply(t).ok, false, `must not be sent: "${t}"`);
  }
});

test('a sincere triage reply is allowed through', () => {
  // The other half. If this screen rejected honest apologising replies the shop would get silence, which
  // is the worst possible answer to a customer and certainly not a resolution.
  for (const t of [
    'We are sorry about the torn packet. Could you share your bill number so we can look it up? Your complaint reference is CMP-0004. Someone from the shop will call you back today.',
    'আমরা দুঃখিত। আপনার বিল নম্বরটা জানাবেন? আপনার অভিযোগ নম্বর CMP-0004। দোকান থেকে কেউ ফোন করবে।',
    'Sorry about this. We have noted your complaint as CMP-0002 and someone will call you shortly.'
  ]) {
    const r = screenReply(t);
    assert.equal(r.ok, true, `should be allowed: "${t}" (${r.reason})`);
    assert.equal(r.text, t.trim());
  }
});

test('an empty or absurdly long reply is refused', () => {
  assert.equal(screenReply('').ok, false);
  assert.equal(screenReply('   ').ok, false);
  assert.equal(screenReply('a'.repeat(701)).ok, false);
});

/* ---------- the instructions given to the model ---------- */

test('the model is told it may offer nothing, and may claim nothing was done', () => {
  const prompt = buildTriagePrompt({
    storeName: 'Corner Store',
    complaint: { id: 'CMP-0007', text: 'the packet was torn', billId: 'INV-1', items: ['Rice'] },
    history: [{ from: 'customer', text: 'hello' }, { from: 'shop', text: 'we are sorry' }]
  });
  assert.match(prompt, /may not offer|promise, agree to or mention any money/i,
    'it is told outright it cannot offer money');
  assert.match(prompt, /Nothing has been done yet/i, 'and that nothing has been done yet');
  assert.match(prompt, /will call them back/i, 'while being allowed the one promise that is true');
  assert.match(prompt, /CMP-0007/, 'it is given the reference to pass on');
  assert.match(prompt, /never ask for an OTP|password|card number/i, 'and told never to ask for money details');
});

test('a Bengali complaint is understood but answered in English', () => {
  // The shop sends one language, so the reply is always English — but the Bengali complaint itself is
  // still read, so the model is given the customer's own words.
  const prompt = buildTriagePrompt({
    storeName: 'দোকান', complaint: { id: 'CMP-1', text: 'চালের প্যাকেট ছিঁড়া' }
  });
  assert.match(prompt, /in English/i, 'it is asked to reply in English');
  assert.match(prompt, /চালের প্যাকেট ছিঁড়া/, 'and still sees the Bengali complaint');
});

test('every escalation reason has something the shop can read', () => {
  // The banner on the screen shows this text, so a reason with no sentence behind it would show a code.
  for (const [reason, text] of Object.entries(REASON_TEXT)) {
    assert.ok(typeof text === 'string' && text.length > 8, `${reason} needs a readable explanation`);
  }
  // The names in NEEDS_HUMAN are derived from REASON_TEXT, so the real risk is a rule returning a
  // reason that has no sentence behind it. That is what is checked here, rather than two hand-kept lists
  // that could drift apart while both still looked correct.
  const returned = Object.values(NEEDS_HUMAN).sort();
  assert.deepEqual(returned, Object.keys(REASON_TEXT).sort(), 'every reason the code can return has a sentence');
  assert.equal(new Set(returned).size, returned.length, 'and no reason is defined twice');
  // A name that does not exist yields undefined rather than throwing, so a typo here would show up as a
  // complaint escalated with no explanation at all. This is the check that would have caught it.
  for (const [name, reason] of Object.entries(NEEDS_HUMAN)) {
    assert.equal(typeof reason, 'string', `NEEDS_HUMAN.${name} must be a reason, not undefined`);
  }
});

test('a transcript line is timestamped and trimmed', () => {
  const line = transcriptLine('customer', 'x'.repeat(2000));
  assert.equal(line.from, 'customer');
  assert.equal(line.text.length, 600, 'a very long message is trimmed for the screen');
  assert.ok(Date.parse(line.at), 'and it is stamped so the shop can see how stale it is');
});

/* ---------- the trap that would have stopped every complaint in the shop ---------- */

test('an ordinary reply is not mistaken for a match', () => {
  // Written as `if (/re1/ || /re2/)` the guard below tests two RegExp objects rather than their matches,
  // and a RegExp is truthy however little it matches. That form rejects every reply, which shows up in
  // production as "every complaint needs a human" and is invisible to any test that only checks the
  // cases the guard was written to catch. The two assertions below are the ones that would have caught it.
  for (const t of [
    'a',
    'We are sorry about the torn packet. Could you share your bill number?',
    'We have noted your complaint as CMP-0002 and someone will call you shortly.'
  ]) {
    assert.equal(screenReply(t).ok, true, `"${t}" is an honest triage reply and must be allowed through`);
  }
});

test('the pass-through and the refusal are decided the same way', () => {
  // If the safe wording were blocked while the promise wording passed, the guard would be worse than
  // having none, so both directions are pinned here rather than trusting the regexes by inspection.
  assert.equal(screenReply('Sorry. Reference CMP-0002. Someone will call you today.').ok, true);
  assert.equal(screenReply('Your refund of Rs 500 has been processed.').ok, false);
  assert.equal(screenReply('We have replaced the packet and couriered a new one.').ok, false);
  assert.equal(screenReply('The item was replaced already.').ok, false);
});

/* ---------- when the assistant is allowed to speak, and for how long ---------- */

test('only a complaint a person marked minor gets the assistant', () => {
  // The scope is the shop's own decision. A bot that keeps talking to someone the shop has already said
  // they will handle is how a phone number stops being trusted.
  assert.equal(aiMayReply('minor'), true);
  // Casing and stray spaces are tolerated rather than treated as "not minor". Both spellings still mean
  // the shop picked minor, and quietly demoting one to "a person must answer this" would be the sort of
  // silence that leaves a customer waiting. Anything that is not minor at all is refused.
  assert.equal(aiMayReply('Minor'), true);
  assert.equal(aiMayReply('MINOR'), true);
  assert.equal(aiMayReply(' minor '), true);
  for (const s of ['major', 'serious', '', undefined, null, 'minorish', 'least']) {
    assert.equal(aiMayReply(s), false, `${JSON.stringify(s)} must not start a conversation`);
  }
});

test('anything needing a person ends it, whatever turn it is on', () => {
  // Asking for the owner on the fourth message has to get the owner, not a fourth apology.
  for (const turns of [0, 1, 2, 5]) {
    assert.deepEqual(nextStep({ turns, customerText: 'let me talk to the owner' }), {
      action: 'escalate', reason: NEEDS_HUMAN.ASKED_FOR_HUMAN, verdict: VERDICT.ASKING
    });
  }
});

test('the assistant gets its two turns and then a person is dragged in', () => {
  assert.equal(nextStep({ turns: 0, customerText: 'the packet is torn' }).action, 'reply');
  assert.equal(nextStep({ turns: 1, customerText: 'it is still torn' }).action, 'reply');
  // The third time round it is not a complaint the bot can help with, and saying so out loud is better
  // than apologising until the customer stops replying.
  const third = nextStep({ turns: MAX_AI_TURNS, customerText: 'it is still torn' });
  assert.equal(third.action, 'escalate');
  assert.equal(third.reason, NEEDS_HUMAN.AI_COULD_NOT_SETTLE);
  assert.ok(REASON_TEXT[third.reason].length > 8, 'and the shop can read why it was handed over');
});

test('a customer who stops pushing is not escalated and not resolved', () => {
  // The complaint stays open for a person to close. Escalating here would drag somebody off a job to be
  // told "ok thanks", and closing it here would record a fix that never happened.
  const r = nextStep({ turns: 1, customerText: 'ok thanks' });
  assert.equal(r.action, 'stop-bot');
  assert.equal(r.reason, null, 'nothing to escalate: the customer is content to wait for the call');
  // And it must not sneak past as a resolution, even on the last turn the bot was allowed.
  assert.equal(nextStep({ turns: MAX_AI_TURNS, customerText: 'ok thanks' }).action, 'stop-bot');
});

test('a missing turn count is treated as the first turn, not the last', () => {
  // nextStep is called straight off a stored complaint, and older records have no aiTurns at all. Defaulting
  // to "already used up" would escalate a brand new complaint to a person on its first word.
  assert.equal(nextStep({ customerText: 'the packet is torn' }).action, 'reply');
  assert.equal(nextStep().action, 'reply');
  assert.equal(nextStep({ turns: '2', customerText: 'still torn' }).action, 'escalate');
});
