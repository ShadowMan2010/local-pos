/* The complaint conversation: what the assistant says, and when it stops.
 *
 * This is the part of the shop that talks to a customer on its own, so it is kept out of server.js and
 * given its dependencies one at a time. The reason is testability, and it is not a stylistic preference:
 * the rules in here decide whether a stranger's message reaches a stranger's phone. Testing that through
 * the live server means starting a socket, running a port and driving WhatsApp, which is slow, flaky, and
 * in practice means those rules end up untested. Here they are a function call with five arguments and no
 * network, so every branch can be pinned down.
 *
 * The policy — when a person is needed, what a reply may say, how many turns are allowed — lives in
 * complaint-ai.js. This file does the bookkeeping: reading and writing the complaint, counting turns,
 * writing the transcript, escalating, and telling the caller what to send.
 */

import { AI_STATE, NEEDS_HUMAN, aiMayReply, nextStep, screenReply, transcriptLine } from './complaint-ai.js';

/**
 * @param {object} deps
 * @param {() => Array<object>} deps.list          the complaint records
 * @param {Function} deps.normalise                phone -> comparable key
 * @param {Function} deps.store                    writes the complaint records back
 * @param {Function} deps.onChange                 called with the complaint whenever it changes
 * @param {Function} deps.audit                    (event, fields) => void
 * @param {(c: object, text: string) => Promise<string|null>} deps.askModel
 * @param {() => string} deps.storeName
 * @param {(c: object) => string} deps.fallbackText     the acknowledgement wording
 * @param {(c: object) => string} deps.handoffText      the "a person is taking over" wording
 */
export function createComplaintConversation(deps) {
  const {
    list, normalise, store, onChange, audit, askModel, storeName, fallbackText, handoffText
  } = deps;

  const now = () => new Date().toISOString();

  /** Appends to the transcript, trimmed, so a long thread cannot grow the record without bound. */
  function say(complaint, who, text) {
    if (!text) return;
    if (!Array.isArray(complaint.transcript)) complaint.transcript = [];
    complaint.transcript.push(transcriptLine(who, text));
    // The whole thread is kept for the shop to read, but only the tail is ever fed to the model: a long
    // history costs more and makes it worse at the one job it has.
    if (complaint.transcript.length > 40) complaint.transcript = complaint.transcript.slice(-40);
  }

  /**
   * Hands the complaint to a person and records why.
   *
   * The only place that moves a complaint to ESCALATED, so "why did the assistant stop?" has one answer,
   * written on the record. Refuses a complaint that is not open, and refuses to escalate one that already
   * is — otherwise a customer who keeps writing could drag a person back in over and over.
   *
   * @returns {boolean} whether this call is the one that escalated it
   */
  function escalate(complaint, reason) {
    if (!complaint || complaint.status !== 'open') return false;
    if (complaint.aiState === AI_STATE.ESCALATED) return false;
    const at = now();
    complaint.aiState = AI_STATE.ESCALATED;
    complaint.aiEscalation = reason;
    complaint.aiEscalatedAt = at;
    complaint.updatedAt = at;
    store();
    // The reason and the turn count, not the transcript. A customer can put anything in a message, and
    // this log ends up in every backup of the shop's records.
    audit('complaint.escalated', {
      at, id: complaint.id, reason, severity: complaint.severity, bill: complaint.billId,
      turns: complaint.aiTurns || 0
    });
    onChange(complaint);
    return true;
  }

  /**
   * The complaint this number is currently talking to, if any.
   *
   * ACTIVE, ESCALATED and TAKEN_OVER. A complaint still waiting for the shop is deliberately left out, so
   * a customer with something else wrong can still raise it and have it filed — which is what a shopkeeper
   * reading their messages would expect to happen.
   *
   * TAKEN_OVER is in here because a customer who has just been answered by a person and writes again is
   * still talking about the same problem. Leaving it out would file it a second time, and the shop would
   * be looking at two complaints about one torn packet.
   */
  function activeFor(phone) {
    const key = normalise(phone);
    if (!key) return null;
    const all = list();
    // Most recent first, so somebody with an old resolved complaint and a new one talks to the new one.
    for (let i = all.length - 1; i >= 0; i--) {
      const c = all[i];
      if (normalise(c.phone) !== key) continue;
      if (c.status !== 'open') continue;
      if (c.aiState === AI_STATE.ACTIVE || c.aiState === AI_STATE.ESCALATED
        || c.aiState === AI_STATE.TAKEN_OVER) return c;
    }
    return null;
  }

  /**
   * Records a reply the shop wrote itself, and stops the assistant.
   *
   * Deliberately not screened, and deliberately not a promise the code has to approve. The rules in here
   * exist to stop a *model* from putting words in the shop's mouth; the person typing has already decided
   * what they are promising, and refusing to let the owner say "we have refunded you" is not a safety
   * feature. What they do get is the transcript, because a message that really was sent is the thing a
   * dispute is later settled from.
   *
   * Called *after* the message has actually gone, not before, so the record can never claim something was
   * sent that was not.
   *
   * @param {object} complaint the complaint it was sent about
   * @param {string} text what the shop wrote
   * @returns {object} the complaint, for the caller to return
   */
  function staffSaid(complaint, text) {
    if (!complaint) return null;
    const body = String(text || '').trim();
    if (!body) return complaint;
    say(complaint, 'staff', body);
    const at = now();
    // The shopkeeper has spoken to this customer, so the assistant stops. Not as a judgement on the person
    // — a bot talking over the owner is the failure everyone can see from the counter.
    if (complaint.aiState === AI_STATE.ACTIVE) complaint.aiState = AI_STATE.TAKEN_OVER;
    complaint.repliedAt = complaint.repliedAt || at;
    complaint.updatedAt = at;
    store();
    onChange(complaint);
    return complaint;
  }

  /**
   * One turn, called when a customer writes again about a complaint already on file.
   *
   * The order of the checks is the whole safety story:
   *
   *   1. The shop has to have marked it minor. Any other scope means a person owns it and this must not
   *      speak. Re-read on every turn rather than trusted from the stored state, so a complaint marked
   *      serious in another tab cannot keep talking.
   *   2. The customer's own words are read first, so asking for a person ends the conversation whatever
   *      the turn count and whatever the model was about to say.
   *   3. Only then is anything generated, and it is screened before it is sent. A refused reply is not
   *      retried with different wording: a model that has just tried to promise the shop a refund is not
   *      one to be given another go at the same customer.
   *
   * @returns {Promise<{handled: boolean, text: string|null, reason: string|null, complaintId?: string}>}
   *          `text` is what to send, or null to say nothing at all — which is a deliberate answer, not a
   *          dropped one.
   */
  async function turn(complaint, customerText) {
    if (!complaint) return { handled: false, text: null, reason: null };
    const shop = storeName();

    if (complaint.status !== 'open') return { handled: false, text: null, reason: null };

    // Already with a person. Answering again would be a bot talking over the shopkeeper, so the customer
    // is simply told it is being handled and nothing about it changes.
    if (complaint.aiState === AI_STATE.ESCALATED) {
      return {
        handled: true, text: handoffText(complaint, shop), reason: complaint.aiEscalation, complaintId: complaint.id
      };
    }

    // The shop has replied itself and is dealing with it. The model is not consulted at all — it has
    // nothing to add to a conversation a person is already having. What the customer gets is the fixed
    // acknowledgement, because leaving somebody silent straight after a human wrote to them reads as
    // being ignored, and this is fixed wording that promises nothing.
    if (complaint.aiState === AI_STATE.TAKEN_OVER) {
      const incoming = String(customerText || '').trim().slice(0, 1000);
      say(complaint, 'customer', incoming);
      const at = now();
      complaint.updatedAt = at;
      store();
      onChange(complaint);
      return { handled: true, text: fallbackText(complaint, shop), reason: null, complaintId: complaint.id };
    }

    if (!aiMayReply(complaint.severity) || complaint.aiState !== AI_STATE.ACTIVE) {
      return { handled: false, text: null, reason: null };
    }

    const incoming = String(customerText || '').trim().slice(0, 1000);
    say(complaint, 'customer', incoming);

    const step = nextStep({ turns: complaint.aiTurns || 0, customerText: incoming });

    if (step.action === 'stop-bot') {
      // The customer has stopped pushing. That is not a fix and the complaint stays open, so the state
      // records exactly that. Nothing is sent: they said thanks, and answering that is noise.
      complaint.aiState = AI_STATE.WENT_QUIET;
      complaint.updatedAt = now();
      store();
      onChange(complaint);
      return { handled: true, text: null, reason: null, complaintId: complaint.id };
    }

    if (step.action === 'escalate') {
      const first = escalate(complaint, step.reason);
      return {
        handled: true,
        // Said once, and to the customer: leaving somebody who asked for a person with no answer at all is
        // the outcome that turns one complaint into two.
        text: first ? handoffText(complaint, shop) : null,
        reason: step.reason,
        complaintId: complaint.id
      };
    }

    const draft = await askModel(complaint, incoming);
    const screened = screenReply(draft || '');
    if (!screened.ok) {
      // Two different things went wrong and the shop should be able to tell them apart. No wording at all
      // means we could not answer, which is nobody's fault. Wording we had to throw away means the model
      // went somewhere we do not allow, which is exactly what a person needs to see.
      const reason = draft ? screened.reason : NEEDS_HUMAN.AI_UNAVAILABLE;
      const first = escalate(complaint, reason);
      return {
        handled: true, text: first ? handoffText(complaint, shop) : null, reason, complaintId: complaint.id
      };
    }

    say(complaint, 'assistant', screened.text);
    complaint.aiTurns = (complaint.aiTurns || 0) + 1;
    const at = now();
    complaint.repliedAt = complaint.repliedAt || at;
    complaint.updatedAt = at;
    store();
    // Recorded because this is the one path in the till where the shop speaks to a customer with nobody
    // having read what it said. A later dispute has to be settled from the record, not from memory.
    audit('complaint.ai-replied', {
      at, id: complaint.id, severity: complaint.severity, bill: complaint.billId,
      turn: complaint.aiTurns, characters: screened.text.length, text: screened.text
    });
    onChange(complaint);
    return { handled: true, text: screened.text, reason: null, complaintId: complaint.id };
  }

  /** The entry point the WhatsApp side calls for every inbound message. */
  async function handle({ phone, text }) {
    const complaint = activeFor(phone);
    if (!complaint) return { handled: false, text: null, reason: null };
    return turn(complaint, text);
  }

  return { escalate, activeFor, turn, handle, staffSaid };
}
