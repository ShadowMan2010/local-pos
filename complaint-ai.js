/* Deciding whether a customer still needs a person.
 *
 * This file is the whole policy for the shop's WhatsApp complaint handling, and it is deliberately
 * separate from both the server and the bot so that every decision in it can be tested without a
 * network, a database or a phone.
 *
 * The arrangement the shop asked for: the shop talks to the customer first, sorts out what it can, and
 * hands over to a person the moment the customer asks for one — or the moment the conversation turns into
 * something a shopkeeper must see.
 *
 * Two things this file is careful about, because both are irreversible once the message is sent:
 *
 *   1. The shop may not offer the customer anything. Not a refund, not a replacement, not a discount.
 *      So the AI's job is triage — apologise, work out which bill and which item, give the reference, and
 *      tell them a person will call. Which means the AI cannot actually *fix* anything, and a customer
 *      saying "ok thanks" is not a solved complaint. That is recorded as what it is (see WENT_QUIET below),
 *      because a shop whose records say "resolved" when nothing was fixed is a shop that argues with the
 *      same customer next week.
 *
 *   2. Nothing is sent to a customer that has not been read. Every generated reply passes through
 *      screenReply() first, and a reply that mentions money, or claims an action the shop has not taken,
 *      is thrown away rather than sent. A prompt is advice to a model, not a guarantee about one.
 */

/* Why it went to a person, in the shop's language, for the escalation banner. The keys are the reasons
 * themselves, so the reason a rule returns and the wording the shop reads can never drift apart. */
export const REASON_TEXT = {
  'asked-for-human': 'The customer asked to talk to a person',
  'angry-or-threatening': 'The customer sounded angry or threatened to escalate',
  'safety-or-illness': 'Possible food safety or illness problem',
  'asking-for-money': 'The customer asked about money',
  'ai-unavailable': 'The shop could not answer on its own',
  'ai-could-not-settle': 'The assistant could not settle it, so a person should take over',
  'reply-unsafe': 'The automatic reply was not safe to send',
  'reply-too-long': 'The automatic reply was too long to send',
  'shop-decided': 'A person in the shop took it over'
};

/* Short names for the reasons, because the rules below read better as NEEDS_HUMAN.SAFETY than as the
 * string 'safety-or-illness'. Written out by hand rather than derived from the keys above: generating
 * them turns a missing name into an `undefined` reason that only shows up at runtime, and a reason that
 * is undefined is the one thing the shop screen cannot explain. */
export const NEEDS_HUMAN = {
  ASKED_FOR_HUMAN: 'asked-for-human',
  ANGRY: 'angry-or-threatening',
  SAFETY: 'safety-or-illness',
  MONEY: 'asking-for-money',
  AI_UNAVAILABLE: 'ai-unavailable',
  AI_COULD_NOT_SETTLE: 'ai-could-not-settle',
  AI_WENT_TOO_FAR: 'reply-unsafe',
  REPLY_TOO_LONG: 'reply-too-long',
  SHOP_DECIDED: 'shop-decided'
};

/* Asking for a person. This is the trigger the shop chose, so it is checked first and in several
 * languages: a shop in West Bengal gets a request for the owner in Bengali, and a rule that only
 * understood English would ignore exactly the customers it most needs to catch. */
const ASK_HUMAN_EN = /\b(human|person|real person|owner|shopkeeper|manager|supervisor|someone in charge|actual person|talk to (?:a |the )?(?:human|person|owner|manager)|speak to (?:a |the )?(?:human|person|owner|manager)|customer care|support team)\b/i;
const ASK_HUMAN_BN = /(মালিক|মানুষের সাথে|ওনাদের|ওনাকে|ওনার|অধিকারী|ম্যানেজার|মানুষজন|কেউ আছে|যোগাযোগ)/;
const ANGRY = /\b(lawyer|legal|police|court|consumer forum|fssai|expose|media|news channel|legal action|consumer court|ghariba|vakil)\b/i;
const ANGRY_BN = /(আইনি|পুলিশ|থানা|আদালত|কনজিউমার|মিডিয়া|মামলা)/;
/* Illness and foreign objects are never a thing to be triaged over text. */
const SAFETY = /\b(spoiled|spoilt|rotten|mould|mold|infection|poison|expired|food poisoning|sick|nausea|vomit|vomiting|fever|hospital|diarrhoea|stomach upset)\b|\b(stone|glass|blade|wire|nail|bone|pin|bug|insect|hair)\b\s*(?:in|inside|within)\b/i;
const SAFETY_BN = /(পচা|পচাটা|বাসি|কেঁচো|প্রাণী|বিষ|অসুস্থ|হাসপাতার)/;
const MONEY = /\b(refund|reimburse|credit|discount|free|waive|compensation|money back|cash ?back|payment)\b|rs\.?\s*\d|\u20b9|\u09f3/iu;
const MONEY_BN = /(টাকা ফেরত|ফেরত|রিফান্ড|পয়সা)/;

/* What the customer says when they are done. Kept short on purpose: over-eager matching is how a bot
 * decides a customer is satisfied when they were being sarcastic. */
/* The words a customer uses when they have stopped pushing.
 *
 * A closed list of courtesy words, and a message has to be made of nothing else. That is what keeps
 * "ok thanks" (the sign-off, and the case this whole design turns on) apart from "ok but the packet is
 * still torn", which is the same first word and the opposite meaning.
 */
const COURTESY_EN = String.raw`(?:ok(?:ay)?|thanks?|thank you|thx|noted|got it|understood|fine|good|alright|all right|no problem|that's all|👍|🙏)`;
const COURTESY_BN = '(?:স্ল্যাস|ধন্যবাদ|ঠিক আছে|বুঝলাম|অসুবিধা নেই|ধন্যবাদ)';
const COURTESY = new RegExp(`^(?:${COURTESY_EN}|${COURTESY_BN})(?:[\\s,.!।]*(?:${COURTESY_EN}|${COURTESY_BN}))*[\\s.!।]*$`, 'i');
const STILL_ANGRY = /\b(still|not|again|already|never|no one|no-one|nobody|koi nahi|kuch nahi|phir se|फिर से)\b|^(না|ঠিক না)/i;

/**
 * Does this message require a person, whatever the shop might otherwise have said?
 *
 * Returns the reason or null. Order matters only for which reason is reported, and every one of them
 * means the same thing to the shop: stop, a person is needed now.
 */
export function needsHumanNow(text) {
  const t = String(text || '');
  if (!t.trim()) return null;
  // Safety first. A customer who is ill is not a triage case, whatever else they say, and a rule that
  // asked about a human before checking for this would label their message "asked for the owner".
  if (SAFETY.test(t) || SAFETY_BN.test(t)) return NEEDS_HUMAN.SAFETY;
  if (ANGRY.test(t) || ANGRY_BN.test(t)) return NEEDS_HUMAN.ANGRY;
  if (MONEY.test(t) || MONEY_BN.test(t)) return NEEDS_HUMAN.MONEY;
  if (ASK_HUMAN_EN.test(t) || ASK_HUMAN_BN.test(t)) return NEEDS_HUMAN.ASKED_FOR_HUMAN;
  return null;
}

/**
 * What the customer is doing in reply to the shop's last message.
 *
 * There is no "resolved" here, and that is the point. Triage is not allowed to fix anything, so a
 * customer who says "ok thanks" has not had anything fixed — they have stopped pushing. WENT_QUIET is
 * that: the bot stops, and the complaint stays open for a person to close honestly.
 */
export const VERDICT = { WENT_QUIET: 'went-quiet', STILL_UNHAPPY: 'still-unhappy', ASKING: 'asking', NOTHING: 'nothing' };

/**
 * Always returns an object, so a caller never has to guess whether it got a string or a decision.
 */
export function readCustomerReply(text) {
  const t = String(text || '').trim();
  if (!t) return { verdict: VERDICT.NOTHING, escalate: null };
  // An explicit request for a person outranks anything else in the message, including politeness. "ok
  // thanks but let me talk to the owner" is a request for the owner.
  const escalate = needsHumanNow(t);
  if (escalate === NEEDS_HUMAN.ASKED_FOR_HUMAN) return { verdict: VERDICT.ASKING, escalate };
  if (escalate) return { verdict: VERDICT.STILL_UNHAPPY, escalate };
  if (STILL_ANGRY.test(t)) return { verdict: VERDICT.STILL_UNHAPPY, escalate: null };
  if (COURTESY.test(t)) return { verdict: VERDICT.WENT_QUIET, escalate: null };
  return { verdict: VERDICT.ASKING, escalate: null };
}

/* Naming these matters. Written inline as `if (/re1/ || /re2/)` the condition tests the two RegExp
 * objects, and a RegExp is always truthy however badly it fails to match — so that form accepts nothing.
 * Every match in this file goes through .test(). */
const CLAIMS_DONE = /\b(we have|i have|we've|i've) (replaced|refunded|credited|given|dispatched|cancelled|ordered|arranged|fixed)\b/i;
const CLAIMS_PASSIVE = /\b(has been|was) (replaced|refunded|credited|dispatched|cancelled)\b/i;

/**
 * The last line of defence before a generated message reaches a customer.
 *
 * Returns the text to send, or a reason it must not. Nothing generated by a model is sent without going
 * through this, including the "safe" fallback wording, because the whole value of a fallback is that it
 * was written by somebody who could not be surprised.
 */
export function screenReply(text) {
  const t = String(text || '').trim();
  if (!t) return { ok: false, reason: NEEDS_HUMAN.AI_UNAVAILABLE };
  if (t.length > 700) return { ok: false, reason: NEEDS_HUMAN.REPLY_TOO_LONG };
  // A number is the sharpest test for a promise, and the one most likely to slip through a synonym. Any
  // rupee figure, and any of the words that attach a promise to it, is refused.
  if (MONEY.test(t) || MONEY_BN.test(t)) return { ok: false, reason: NEEDS_HUMAN.AI_WENT_TOO_FAR };
  // Claiming an action the shop has not taken is the other way a generated sentence becomes a lie the
  // shop has to honour. "We have replaced it" is not something triage may say.
  if (CLAIMS_DONE.test(t) || CLAIMS_PASSIVE.test(t)) {
    return { ok: false, reason: NEEDS_HUMAN.AI_WENT_TOO_FAR };
  }
  return { ok: true, text: t };
}

/**
 * The instruction the model is given for a triage reply.
 *
 * It is in English, and the reply is English too: the shop sends everything in one language, whatever
 * language the customer wrote in. The customer's own words are still read in whatever language they
 * used — the recognition below is bilingual — only the reply is fixed to English. The rules are short
 * because a long list of prohibitions reads to a model like a list of things it is being asked to
 * avoid; the hard guarantees are the ones in screenReply(), not the ones in here.
 */
export function buildTriagePrompt({ storeName, complaint, history }) {
  const bills = complaint?.billId ? `Bill number: ${complaint.billId}` : 'Bill number: not known yet';
  const item = complaint?.items?.length ? `Items on that bill: ${complaint.items.slice(0, 10).join(', ')}` : '';
  return [
    `You are the WhatsApp assistant for ${storeName}, a small neighbourhood shop in India.`,
    `A customer has complained and you are handling it. Reply as the shop, to the customer, in English.`,
    ``,
    `Their complaint: ${complaint?.text || 'not known'}`,
    bills,
    item,
    `Complaint reference: ${complaint?.id || 'not known'}`,
    history?.length ? `\nSo far in this conversation:\n${history.map((h) => `${h.from === 'customer' ? 'Customer' : 'Shop'}: ${h.text}`).join('\n')}` : '',
    ``,
    `Reply with the customer's message text only. No JSON, no quotes around it, no explanation.`,
    ``,
    `What this reply must do:`,
    `- Apologise briefly and sincerely, once. Not twice, and not the word "unfortunately".`,
    `- If you do not know which bill or which item, ask for one of them. A short question is better than a long message.`,
    `- Give the complaint reference if you have it, so the shop can look it up.`,
    `- Say that a person from the shop will call them back. That is true, and it is the promise you may make.`,
    ``,
    `What this reply must not do:`,
    `- Do not offer, promise, agree to or mention any money, refund, discount, replacement or free item. Not even "we can look into a refund". The shop cannot do any of it, so mentioning it is a promise the shop will have to keep.`,
    `- Do not say anything has been done, replaced, sent or credited. Nothing has been done yet.`,
    `- Do not argue, and do not explain why it happened.`,
    `- Do not blame the customer, the delivery boy, or anyone else.`,
    `- Keep it under about 60 words. A shop assistant that writes an essay gets muted.`,
    `- Never ask for an OTP, a password, a card number, or any bank detail. Ever.`
  ].filter(Boolean).join('\n');
}

/** One line of the conversation, for the shop to read. */
export function transcriptLine(from, text) {
  return { from, text: String(text || '').slice(0, 600), at: new Date().toISOString() };
}

/* ---------- when the assistant is allowed to speak at all ---------- */

/** How many replies the assistant gets before a person is dragged in, whatever the customer says. */
export const MAX_AI_TURNS = 2;

/**
 * The states a complaint's conversation can be in.
 *
 * AWAITING_SHOP is the default and the important one. A complaint starts here and stays here until a
 * person in the shop has looked at it and marked it minor, so nothing an unreviewed complaint can say
 * ever reaches a customer on its own. That is the shop's own rule — the scope is chosen by a person, not
 * guessed from the text — and it means the assistant is never the first thing that speaks about a
 * complaint it was not allowed to look at.
 */
export const AI_STATE = {
  AWAITING_SHOP: 'awaiting-shop',
  ACTIVE: 'active',
  WENT_QUIET: 'went-quiet',
  // A person from the shop has written to this customer themselves. The assistant stops, and says so on
  // the record — but this is deliberately not ESCALATED, because nothing went wrong. The shopkeeper was
  // there, and that is the normal case, not a failure.
  TAKEN_OVER: 'taken-over',
  ESCALATED: 'escalated'
};

/**
 * May the assistant talk to this customer?
 *
 * Only a complaint a person has marked minor. 'major' and 'serious' are somebody saying they will deal
 * with it themselves, and a bot that keeps talking after that is the reason people stop trusting a shop's
 * phone number.
 */
export function aiMayReply(severity) {
  return String(severity || '').trim().toLowerCase() === 'minor';
}

/**
 * What should happen after the customer sends one more message.
 *
 * The order is the whole policy in four lines:
 *
 *   1. Anything that means a person is needed ends it now, whatever turn it is. A customer asking for the
 *      owner on the fourth message gets the owner, not a fourth apology.
 *   2. A customer who has stopped pushing ends it too — but that is not a resolution, and the complaint
 *      stays open. See WENT_QUIET above.
 *   3. Otherwise the assistant gets its turn, until it has used them up.
 *   4. After that a person is dragged in, because a bot that keeps apologising at a customer who is still
 *      unhappy is worse than a bot that admits it cannot help.
 *
 * @param {{turns?: number, customerText?: string}} state
 * @returns {{action: 'reply'|'stop-bot'|'escalate', reason: string|null, verdict: string}}
 */
export function nextStep({ turns = 0, customerText = '' } = {}) {
  const read = readCustomerReply(customerText);
  if (read.escalate) return { action: 'escalate', reason: read.escalate, verdict: read.verdict };
  if (read.verdict === VERDICT.WENT_QUIET) return { action: 'stop-bot', reason: null, verdict: read.verdict };
  if (Number(turns) >= MAX_AI_TURNS) {
    return { action: 'escalate', reason: NEEDS_HUMAN.AI_COULD_NOT_SETTLE, verdict: read.verdict };
  }
  return { action: 'reply', reason: null, verdict: read.verdict };
}
