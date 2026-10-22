// Unofficial WhatsApp integration (using the Baileys library). This links to the SHOP'S OWN
// WhatsApp number as a second device — the same way "Linked devices" works in the WhatsApp app —
// so no Meta approval or business verification is needed.
//
// IMPORTANT: this is not the official WhatsApp Business API. It works by automating WhatsApp's
// own app protocol, which is against WhatsApp's terms of service, and carries a small risk of the
// number being temporarily restricted, especially if it sends a lot of messages quickly. Keep
// message volume low (replies to real customers, not bulk marketing) and stop using it if
// WhatsApp shows warnings on the linked number.
//
// This file only runs if @whiskeysockets/baileys is installed (run "npm install" after pulling
// this update) — server.js loads it with a try/catch, so the rest of the POS works fine either way.
import makeWASocket, { useMultiFileAuthState, DisconnectReason, Browsers } from '@whiskeysockets/baileys';
import { downloadMediaMessage } from '@whiskeysockets/baileys/lib/Utils/messages.js';
import pino from 'pino';
import fs from 'fs';
import path from 'path';
import QRCode from 'qrcode';
import sharp from 'sharp';
import {
  buildCatalogText, parseOrder, buildOrderSummaryText,
  buildWelcomeText, buildCancelledText, buildHelpText, buildNotUnderstoodText, buildComplainLaterText,
  buildPaymentPromptText, buildBillCaptionText, buildUpiUnavailableText, buildNamePromptText, parseNameReply,
    buildDeliveryBoyHelpText, buildDeliveryNoQrText, buildDeliveryBadQrText,
    buildOutForDeliveryText, parseNameCommand, buildNameChangedText,
      mentionsComplaint, complaintDetail, buildComplaintPromptText, buildComplaintSavedText,
      complaintRoute,
      buildVoiceListeningText, buildVoiceOffText, buildVoiceUnclearText,
      buildPaymentProofSavedText, buildNoOrderForProofText, buildPaymentProofUnreadableText,
      buildOptOutText, isOptOut,
      readDeliveryCode


} from './whatsapp-bot.js';
  import { buildBillImage } from './whatsapp-bill.js';
import { readQrFromBuffer } from './qr-reader.js';
  

// Deliberately NOT calling fetchLatestBaileysVersion() here — the Baileys maintainers have
// advised against it (a "latest" WhatsApp-protocol version fetched at odd times can be one
// the installed library version doesn't actually support yet). Using the library's own
// bundled default version, and keeping the "@whiskeysockets/baileys" version in package.json
// reasonably current instead, has proven more stable.

/**
 * Decides what a `connection.update` close event means.
 *
 * Split out as a pure function because this one decision is the difference between a bot that recovers on
 * its own and a shop staring at a message that says Starting… forever. It has to be readable and testable
 * without a phone, a network and a WhatsApp account, which is the only place this kind of logic gets tested
 * when it is left inline in an event handler.
 *
 * `retry` is true only for the failures a reconnect genuinely fixes. `loggedOut` means the phone revoked
 * this device: the credentials are gone from the other end, so reconnecting would just loop, and the status
 * has to say a person is needed.
 *
 * Anything unrecognised is treated as retryable, because a status code this version has never seen is far
 * more likely to be a new flavour of network failure than a new flavour of "the user revoked you" — and
 * wrongly retrying a dropped connection costs a few seconds, while wrongly treating a revoke as transient
 * hides the problem behind a message that never resolves.
 */
export function classifyDisconnect(update) {
  const code = update?.lastDisconnect?.error?.output?.statusCode;
  if (code === DisconnectReason.loggedOut) return { loggedOut: true, retry: false, code };
  // Also a revoke in practice: Baileys reports a replaced session this way, and it is equally terminal.
  if (code === DisconnectReason.connectionReplaced) return { loggedOut: true, retry: false, code };
  return { loggedOut: false, retry: true, code };
}

/**
 * The status the card should show after the shop unlinks the number.
 *
 * Split out as a pure function for the same reason `classifyDisconnect` is: it is the one decision that
 * decides whether the settings card makes a promise the bot cannot keep, and it is not reachable in a test
 * without a phone, a linked account, and a real revoke — none of which a test run may assume it has.
 *
 * The bug this replaces was `unlink()` setting only the internal `stopped` flag, leaving `enabled` true. The
 * status it went on to report was `{connected:false, qr:null, loggedOut:false}` — indistinguishable from a
 * socket that has not finished starting — so the card fell into its "Starting…" branch and waited on a
 * connection that unlinking had just made impossible. The button's own message even said to start the bot
 * again, directly under a promise that one was on its way.
 *
 * So: `enabled` goes false, because the shop's switch is off and nothing here is going to turn it back on;
 * `loggedOut` stays false, because nothing revoked these credentials — the shop deleted them, and blaming
 * the handset sends them to the wrong screen; and `phone` goes null, because reporting a linked number whose
 * credentials are gone is a claim they have to disprove rather than a fact they can act on.
 *
 * @param {{enabled?: boolean, connected?: boolean, qr?: unknown, phone?: string|null, loggedOut?: boolean}} status
 * @returns {typeof status}
 */
export function statusAfterUnlink(status = {}) {
  return { ...status, enabled: false, connected: false, qr: null, phone: null, loggedOut: false };
}

/**
 * @param {{
 *   dataDir: string,
 *   storeName: () => string,
 *   upiVpa: () => string,
 *   getProducts: () => object[],
 *   saveOrder: (order: object) => void,
 *   nextOrderCode: () => string,
 *   broadcast: (event: object) => void,
 *   deliveryBoys: () => {name: string, phone: string}[],
 *   normPhone: (v: unknown) => string|null,
 *   confirmDeliveryByCode: (code: string, byPhone?: string) => string,
 *   confirmDeliveryByQr: (token: string, byPhone?: string) => string,
 *   attachPaymentProof?: (info: {phone: string, buf: Buffer}) => Promise<{ok: boolean, text?: string}>,
 *   optOut?: (phone: string) => void
 * }} ctx
 */
export async function startWhatsApp(ctx) {
  const authDir = path.join(ctx.dataDir, 'whatsapp-session');
  fs.mkdirSync(authDir, { recursive: true });
  // This folder is a complete, logged-in WhatsApp account. Whoever can read it can message the shop's
  // customers as the shop — including asking them for money — so it is treated as the most sensitive
  // thing in the data directory, not just another config folder.
  //
  // Baileys writes these files itself with the process umask, which on most machines leaves them
  // world-readable, so the mode is set here and enforced again whenever credentials are saved. That
  // second pass matters: without it the next save recreates the files at the wider mode and quietly
  // undoes the first one.
  try { fs.chmodSync(authDir, 0o700); } catch { /* filesystem without POSIX modes */ }
  const lockSessionDir = () => {
    try {
      fs.chmodSync(authDir, 0o700);
      for (const f of fs.readdirSync(authDir)) {
        try { fs.chmodSync(path.join(authDir, f), 0o600); } catch { /* a file vanishing mid-sweep is fine */ }
      }
    } catch { /* best effort: never block pairing on a permissions problem */ }
  };
  lockSessionDir();

  // `let` rather than `const` so relink() can re-read the auth files after wiping them. Baileys hands back a
  // live object that it mutates as the connection progresses, so a fresh read is the only way to genuinely
  // start over — reusing the old object links the new QR against credentials the phone has already revoked.
  let { state, saveCreds } = await useMultiFileAuthState(authDir);
  {
    // Wrapped rather than replaced: the credentials have to keep saving normally, and the lock is
    // layered on top so a newly written session file is never left at a readable mode.
    const wrap = (raw) => async (...args) => {
      const out = await raw(...args);
      lockSessionDir();
      return out;
    };
    saveCreds = wrap(saveCreds);
  }

  // `loggedOut` is the one state here that needs a person rather than a retry. The other three are the
  // ordinary life of a socket; this one means the phone has revoked this device and the shop has to scan a
  // new QR. It is part of the status rather than a log line because the person who needs to act is looking
  // at the settings screen, not at the till's log file.
  // `enabled` is the shop's own switch, kept apart from `connected` on purpose. A bot the shop has turned
  // off is not a bot that is failing to connect, and reporting the two the same way is how the "Starting…"
  // bug comes back: a stopped bot shows no QR, is not connected, and would otherwise sit on a message
  // promising a connection that nobody asked for.
  const status = { enabled: true, connected: false, qr: null, phone: null, loggedOut: false };
  // one small conversation state per customer phone number: which step of the order flow they're on
  const sessions = new Map();
  let sock = null;
  // `stopped` is the shop's intent; `running` is what the socket is actually doing. Two variables because
  // the intent outlives a connection attempt: pressing Stop during a slow connect has to keep the reconnect
  // suppressed after that attempt finishes, which `running` alone could not express.
  let stopped = false;
  let running = false;

  function connect() {
    // Reached from the reconnect timer as well as from start(), so it re-checks rather than trusting the
    // caller. A timer scheduled just before Stop must not bring the bot back up on its own.
    if (stopped) return;
    running = true;
    sock = makeWASocket({
      auth: state,
      logger: pino({ level: 'silent' }),
      browser: Browsers.ubuntu('LOCAL POS'),
      syncFullHistory: false
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', (update) => {
      if (update.qr) { status.qr = update.qr; status.connected = false; }
      if (update.connection === 'open') {
        status.connected = true;
        status.qr = null;
        // Cleared as well as the others: this is a genuinely fresh link, so any "unlinked from the phone"
        // from an earlier attempt no longer describes anything.
        status.loggedOut = false;
        status.phone = sock.user?.id?.split(':')[0] || sock.user?.id || null;
        console.log('WhatsApp linked as', status.phone);
      }
      if (update.connection === 'close') {
        const outcome = classifyDisconnect(update);
        running = false;
        status.connected = false;
        // A deliberate stop arrives here as a close event like any other, and is checked first. Falling
        // through to the revoke branch would report the phone as having unlinked the device — which is a
        // serious thing to tell a shop, and entirely self-inflicted.
        if (stopped) {
          console.log('WhatsApp bot stopped');
          return;
        }
        // The distinction that this whole function exists to preserve. A dropped connection is retried and
        // clears itself. A revoked device is not retried, and never will clear itself, because the phone has
        // thrown the credentials away — it needs a person to scan a new QR. Both used to leave the status
        // as {connected:false, qr:null}, which is also what "still starting up" looks like, so the settings
        // screen said Starting… and stayed there with no way to tell whether to wait or to do something.
        if (outcome.loggedOut) {
          status.loggedOut = true;
          status.qr = null;
          status.phone = null;
          console.log('WhatsApp was unlinked from the phone. Re-scan a QR code in Settings to link it again.');
        } else {
          console.log('WhatsApp disconnected (reconnecting)');
        }
        if (!stopped && outcome.retry) setTimeout(connect, 3000);
      }
    });

    sock.ev.on('messages.upsert', ({ messages, type }) => {
      if (type !== 'notify') return;
      for (const msg of messages) {
        if (!msg.message || msg.key.fromMe) continue;
        // WhatsApp increasingly addresses 1:1 chats by an opaque LID ("…@lid") and puts the real
        // phone number in remoteJidAlt, so remoteJid on its own is often NOT a phone-number JID.
        // Pick whichever of the two is the phone-number JID; replying to the LID instead would
        // fail, and dropping non-phone JIDs here would leave the customer with no reply at all.
        const jid = [msg.key.remoteJid, msg.key.remoteJidAlt]
          .find((j) => typeof j === 'string' && j.endsWith('@s.whatsapp.net'));
        if (!jid) continue; // groups / broadcast lists / status updates / newsletters
        const text = (msg.message.conversation || msg.message.extendedTextMessage?.text || '').trim();
        // A delivery boy confirming a handover sends a photo of the QR code and no words, so an
        // image with no caption still has to reach handleMessage. Everyone else's images are
        // dropped there, so a sticker or a selfie can't turn into an order.
        const isImage = !!msg.message.imageMessage;
        // A voice note is handled for the same reason an image is: it carries no words, so the "nothing
        // to do" test below would drop it before anyone heard it.
        const isAudio = !!msg.message.audioMessage;
        if (!text && !isImage && !isAudio) continue;
        handleMessage(jid, text, msg).catch((err) => console.error('WhatsApp message handling failed:', err.message));
      }
    });
  }

  const reply = (jid, text) => sock.sendMessage(jid, { text });

  /**
   * Phone number -> WhatsApp JID. Bills store the customer number normalised to 10 digits, but a
   * JID needs the country code: sending to "9876543210@s.whatsapp.net" is silently dropped by
   * WhatsApp, so a 10-digit number has to become 91 + number first.
   */
  const toJid = (phone) => {
    const d = String(phone ?? '').replace(/\D/g, '');
    return `${d.length === 10 ? `91${d}` : d}@s.whatsapp.net`;
  };

  /**
   * Renders the delivery token as a QR image for the customer to show the delivery boy. The
   * customer is the only one who gets this, so it doubles as proof they were there. Size and error
   * correction are deliberately generous: the boy will often be photographing a phone screen, and
   * WhatsApp recompresses images it forwards, which can eat the fine detail a QR needs.
   */
  async function buildDeliveryQr(token) {
    return QRCode.toBuffer(token, {
      type: 'png',
      errorCorrectionLevel: 'M',
      margin: 4,
      width: 640,
      color: { dark: '#000000ff', light: '#ffffffff' }
    });
  }

    /**
     * Fetches the picture the delivery boy sent. WhatsApp hands it over already decrypted, so this is
     * just a download. Never throws: a photo we cannot fetch is an ordinary outcome and must not be
     * able to disturb the rest of the message loop.
     * @returns {Promise<Buffer|null>}
     */
    async function downloadPhoto(msg) {
      if (!msg?.message?.imageMessage) return null;
      try {
        const buf = await downloadMediaMessage(msg, 'buffer', {});
        return buf?.length ? buf : null;
      } catch (err) {
        console.error('Could not download that photo:', err.message);
        return null;
      }
    }

    /**
     * Fetches a voice note the customer sent. Same shape as downloadPhoto: WhatsApp hands the audio over
     * already decrypted, so this is only a download, and a note we cannot fetch must not be able to
     * throw into the message loop and take the rest of the batch down with it.
     * @returns {Promise<Buffer|null>}
     */
    async function downloadVoice(msg) {
      if (!msg?.message?.audioMessage) return null;
      try {
        const buf = await downloadMediaMessage(msg, 'buffer', {});
        return buf?.length ? buf : null;
      } catch (err) {
        console.error('Could not download that voice note:', err.message);
        return null;
      }
    }

    /**
     * Turns a delivered parcel photo into something worth keeping for years: shrunk to a sensible
     * size and re-encoded as JPEG, so a modern phone's 5 MB picture does not fill the disk after a
     * few hundred deliveries. Re-encoding also strips EXIF, which on a phone photo carries the GPS
     * coordinates of the customer's home — not something to keep next to a delivery record.
     * @returns {Promise<Buffer|null>}
     */
    async function prepareProofPhoto(buf) {
      if (!buf?.length) return null;
      try {
        return await sharp(buf)
          .rotate() // honour the phone's EXIF orientation before resizing, or the shot lands sideways
          .resize({ width: 1280, height: 1280, fit: 'inside', withoutEnlargement: true })
          .jpeg({ quality: 80 })
          .toBuffer();
      } catch (err) {
        console.error('Could not prepare that photo as proof:', err.message);
        return null;
      }
    }

    /**
     * Prepares a customer's UPI payment screenshot for filing.
     *
     * Deliberately larger and cleaner than a handover photo: this one is read for small text — the
     * amount, the UPI reference — and a screenshot shrunk until the digits blur is useless as proof.
     * Re-encoded all the same, which strips any EXIF the phone attached to it.
     * @returns {Promise<Buffer|null>}
     */
    async function preparePaymentProof(buf) {
      if (!buf?.length) return null;
      try {
        return await sharp(buf)
          .rotate()
          .resize({ width: 1600, height: 1600, fit: 'inside', withoutEnlargement: true })
          .jpeg({ quality: 88 })
          .toBuffer();
      } catch (err) {
        console.error('Could not prepare that payment screenshot:', err.message);
        return null;
      }
    }

  /** Draws the order as a picture and sends it. Payment is still confirmed by the cashier. */
  async function sendBill(jid, order, method) {
    const phone = jid.split('@')[0];
    const image = await buildBillImage({
      storeName: ctx.storeName(),
      code: order.code,
      items: order.items,
      total: order.total,
      phone,
      // Asked for at the ordering step and answered in the flow; the bill is the thing that name is for, so
      // it goes on the bill. It was collected, stored on the order and then never reached the renderer.
      name: order.name || '',
      method,
      upiVpa: method === 'upi' ? ctx.upiVpa() : ''
    });
    sessions.set(phone, { step: 'idle', pending: null });
    await sock.sendMessage(jid, { image, mimetype: 'image/png', caption: buildBillCaptionText(order.code, method) });
  }

    // A customer's voice note, turned into an order.
    //
    // Speech-to-text and the model take a few seconds, so the customer is told the note landed before
    // the wait begins — otherwise a slow transcription reads as "it did not work" and the same note gets
    // sent three more times. Whatever happens next, they are answered in words: a note that produced no
    // order must not leave them on read, which is what an unguarded transcribe call would do.
    async function handleVoiceNote(jid, phone, msg) {
      await reply(jid, buildVoiceListeningText());
      if (!ctx.voiceOrder) return reply(jid, buildVoiceOffText());
      const audio = await downloadVoice(msg);
      if (!audio) return reply(jid, buildVoiceUnclearText());
      const out = await ctx.voiceOrder({ audio, mimeType: msg.message.audioMessage.mimetype || 'audio/ogg' });
      if (out?.reason === 'off') return reply(jid, buildVoiceOffText());
      if (!out?.ok || !out.verdict) return reply(jid, buildVoiceUnclearText());
      // Only an order with real items is held for confirmation. A note that matched nothing is answered
      // and forgotten, so a later "yes" cannot place an empty order.
      if (!out.verdict.items.length) {
        sessions.set(phone, { step: 'idle', pending: null });
        return reply(jid, out.reply);
      }
      sessions.set(phone, { step: 'confirming', pending: out.verdict });
      return reply(jid, out.reply);
    }

  async function handleMessage(jid, text, msg) {
    const phone = jid.split('@')[0];
    const lower = text.trim().toLowerCase();
    const session = sessions.get(phone) || { step: 'idle', pending: null };

      if (lower === 'cancel') {
        sessions.set(phone, { step: 'idle', pending: null });
        return reply(jid, buildCancelledText());
      }

      // A real help screen. "help" used to fall through to the "I did not understand that" message,
      // which is a poor answer to somebody explicitly asking what the bot can do — and it is how the
      // complaint feature stayed invisible, since nothing ever listed it.
      if (['help', '?', 'commands', 'কি commands'].includes(lower) || lower === 'সাহায্য') {
        return reply(jid, buildHelpText(ctx.storeName()));
      }


    // A registered delivery boy is not ordering anything: the only thing we want from him is the
    // handover code he got from the customer. Checked before the order flow so a code like "1234"
    // is never read as "12 pieces of item 34".
    //
    // Both sides must go through normPhone: a number saved in Settings is stored as 10 digits,
    // while the JID of an incoming message is the full 12 ("91" + number). Comparing them raw
    // never matches, which would silently mean no delivery boy could ever confirm a handover.
    if (ctx.deliveryBoys().some((x) => ctx.normPhone(x.phone) === ctx.normPhone(phone))) {
      // Handing the job back, so the shop can give it to somebody else. Checked before the photo and
      // the code, otherwise "can't" would fall through to the "not a code" help message.
      if (["can't", 'cant', 'cannot', 'notnow', 'nope', 'reject', 'decline'].includes(lower)) {
        return reply(jid, ctx.declineDelivery(phone));
      }
      // A photo can only ever be a delivery QR from him, so the order flow never sees it. There are
      // two of them and he sends both to the same place: the sticker on the parcel (collected at the
      // shop) and the customer's own code (handed over at the door). The server works out which.
        if (msg?.message?.imageMessage) {
          // Downloaded once and used twice: the QR decides which job this is, and the same picture
          // is the proof of the handover. Downloading it separately for each would double the wait
          // on a phone connection and could fail one half of the pair.
          const photo = await downloadPhoto(msg);
          const token = photo ? await readQrFromBuffer(photo) : null;
          if (!token) return reply(jid, buildDeliveryNoQrText());
          return reply(jid, await ctx.confirmScanByQr(token, phone, await prepareProofPhoto(photo)));
        }

      const code = readDeliveryCode(lower);
      if (code) return reply(jid, ctx.confirmDeliveryByCode(code, phone));
      return reply(jid, buildDeliveryBoyHelpText());
    }

    // Somebody asking not to receive the shop's announcements any more. Delivery boys returned
    // above; for a customer this is checked before anything else so "stop" is never read as an item
    // number or a complaint.
    if (ctx.optOut && isOptOut(lower)) {
      ctx.optOut(ctx.normPhone(phone) || phone);
      return reply(jid, buildOptOutText());
    }

    // A photo from a customer is a payment screenshot. The bot has just sent their bill with a UPI
    // QR, so this is the proof the money was sent, and it is filed against their order for the shop
    // to check. There is no other photo a customer is asked for, so anything that cannot be read is
    // answered in words rather than dropped.
    if (msg?.message?.imageMessage) {
      const photo = await downloadPhoto(msg);
      if (!photo) return reply(jid, buildPaymentProofUnreadableText());
      const buf = (await preparePaymentProof(photo)) || photo;
      const filed = ctx.attachPaymentProof
        ? await ctx.attachPaymentProof({ phone: ctx.normPhone(phone) || phone, buf })
        : null;
      if (filed?.ok) return reply(jid, filed.text || buildPaymentProofSavedText());
      return reply(jid, filed?.text || buildNoOrderForProofText());
    }

    // A voice note from a customer. Delivery boys have been handled above, so this is only ever an order.
    if (msg?.message?.audioMessage) {
      return handleVoiceNote(jid, phone, msg);
    }

    // A follow-up about a complaint already on file. This is checked before anything else, because a
    // customer writing "it is still torn" must not have it read as a new order or filed as a second
    // complaint — and because once the assistant is talking to someone, what it says next is the only
    // thing that should decide how that conversation goes.
    //
    // Only a complaint the shop has marked minor, and only one already handed to a person, are picked up
    // (that choice is made in activeComplaintFor, not here). A complaint still waiting for the shop is
    // left alone on purpose, so somebody who has a second problem can still raise it and have it filed.
    if (ctx.continueComplaint) {
      const live = await ctx.continueComplaint({ phone, text });
      if (live?.handled) {
        // Nothing said back is a deliberate answer, not a dropped one: the customer said thanks, and
        // replying to that is noise on top of a promise of a call.
        if (live.text) return reply(jid, live.text);
        return;
      }
    }

    // A complaint. The decision itself lives in complaintRoute() in whatsapp-bot.js so it can be
    // tested directly — it used to be written inline here, untested, and a customer writing "complain"
    // was told the bot did not understand.
    //
    // Three shapes: a message that says what went wrong, which is filed at once; a bare "complain",
    // which gets one follow-up question so the shop is not left an empty row to clear; and a complaint
    // raised while they are mid-order, which is held until they finish rather than parsed as items.
    const complaint = complaintRoute(text, session.step);
    if (complaint.kind === 'later') {
      // Not ignored, and not treated as an order. Told to finish, and told the complaint will be taken
      // afterwards — otherwise "the packet was torn" at the payment screen becomes an order for torn
      // packet, which is how a complaint turns into a second, worse complaint.
      return reply(jid, buildComplainLaterText());
    }
    if (complaint.kind === 'ask') {
      sessions.set(phone, { step: 'complaining', pending: null });
      return reply(jid, buildComplaintPromptText());
    }
    if (complaint.kind === 'file') {
      const filed = await ctx.raiseComplaint({ phone, text: complaint.detail });
      sessions.set(phone, { step: 'idle', pending: null });
      return reply(jid, filed.text || buildComplaintSavedText(filed.complaint.id, ctx.storeName()));
    }

    // Their answer to the question above.
    if (session.step === 'complaining') {
      if (lower === 'menu') {
        sessions.set(phone, { step: 'idle', pending: null });
        return reply(jid, buildCatalogText(ctx.storeName(), ctx.getProducts()));
      }
      const detail = complaintDetail(text) || text.trim().slice(0, 500);
      const filed = await ctx.raiseComplaint({ phone, text: detail });
      sessions.set(phone, { step: 'idle', pending: null });
      return reply(jid, filed.text || buildComplaintSavedText(filed.complaint.id, ctx.storeName()));
    }

    // A name the customer wants to correct. Checked before the order steps so it works wherever
    // they are in the flow, and it deliberately leaves a half-built order alone.
    const nameChange = parseNameCommand(text);
    if (nameChange && session.pending?.code) {
      ctx.setOrderName(session.pending.code, nameChange.name);
      return reply(jid, buildNameChangedText(nameChange.name));
    }

    if (session.step === 'confirming' && ['yes', 'y', 'হ্যাঁ', 'ha', 'হ্যা'].includes(lower)) {
      const order = session.pending;
      const code = ctx.nextOrderCode();
      // Reuse the name from a previous bill if there is one. Asking again every single order is
      // needless friction for someone the shop already knows, and a name typed once is remembered
      // on the customer record when the bill is charged.
      const knownName = ctx.knownName ? ctx.knownName(phone) : '';
      const record = {
        code, phone, name: knownName,
        items: order.items, total: order.total, status: 'pending', createdAt: new Date().toISOString()
      };
      ctx.saveOrder(record);
      ctx.broadcast({ type: 'wa-order', order: record });
      if (knownName) {
        // Name already known, so go straight to payment rather than asking a question whose answer
        // is on file. The till still gets the name pre-filled, which is what the bill prints.
        sessions.set(phone, { step: 'payment', pending: record });
        return reply(jid, buildPaymentPromptText(ctx.storeName(), record.code, record.total));
      }
      // No name on file: the order is saved now and the name is asked for next, so the till can
      // pre-fill it and the customer's own record picks it up at charge time.
      sessions.set(phone, { step: 'naming', pending: record });
      return reply(jid, buildNamePromptText(ctx.storeName()));
    }


    if (session.step === 'naming' && session.pending) {
      const order = session.pending;
      if (lower === 'menu') { // same escape hatch as the payment step: back to the catalogue
        sessions.set(phone, { step: 'idle', pending: null });
        return reply(jid, buildCatalogText(ctx.storeName(), ctx.getProducts()));
      }
      const { name, isPayment } = parseNameReply(text);
      if (name) ctx.setOrderName(order.code, name);
      sessions.set(phone, { step: 'payment', pending: order });
      if (isPayment) return handleMessage(jid, text, msg);
      return reply(jid, buildPaymentPromptText(ctx.storeName(), order.code, order.total));
    }

    if (session.step === 'payment' && session.pending) {
      if (lower === 'menu') { // let them back out to the catalogue without losing the saved order
        sessions.set(phone, { step: 'idle', pending: null });
        return reply(jid, buildCatalogText(ctx.storeName(), ctx.getProducts()));
      }
      if (lower === 'cash' || lower === 'no' || lower === 'n') {
        return sendBill(jid, session.pending, 'cash');
      }
      if (lower === 'upi' || lower === 'gpay' || lower === 'phonepe' || lower === 'paytm') {
        if (!ctx.upiVpa()) return reply(jid, buildUpiUnavailableText());
        return sendBill(jid, session.pending, 'upi');
      }
      // Anything else: re-ask rather than dropping them back to the catalogue.
      return reply(jid, buildPaymentPromptText(ctx.storeName(), session.pending.code, session.pending.total));
    }

    if (lower === 'menu' || lower === 'hi' || lower === 'hello' || session.step === 'idle') {
      sessions.set(phone, { step: 'ordering', pending: null });
      return reply(jid, buildCatalogText(ctx.storeName(), ctx.getProducts()));
    }

    if (session.step === 'ordering') {
      const result = parseOrder(ctx.getProducts(), text);
      if (!result.ok) return reply(jid, buildNotUnderstoodText());
      sessions.set(phone, { step: 'confirming', pending: result });
      return reply(jid, buildOrderSummaryText(result));
    }

    return reply(jid, buildNotUnderstoodText());
  }

  connect();

  return {
    getStatus: () => ({ ...status }),

    /** Fire-and-forget: called once, the first time a phone number is saved as a customer. */
    async sendWelcome(phone, _name) {
      if (!status.connected) return;
      await reply(toJid(phone), buildWelcomeText(ctx.storeName()));
    },

    /**
     * Sends a one-off message to a customer — used for delivery updates. Returns false when
     * WhatsApp isn't linked or the send failed, so the caller can record that it never went out.
     */
    async sendText(phone, text) {
      if (!status.connected || !phone) return false;
      try {
        await reply(toJid(phone), text);
        return true;
      } catch (err) {
        console.error('WhatsApp send failed:', err.message);
        return false;
      }
    },

    /**
     * Sends the out-for-delivery message with the customer's QR code as a picture, and the 4-digit
     * code in the caption as a backup. Returns false when WhatsApp isn't linked or the send failed,
     * so the caller can record that it never went out.
     */
    async sendDeliveryQr(phone, { code, itemCount, orderId, token, boyName, boyPhone }) {
      if (!status.connected || !phone || !token) return false;
      try {
        const image = await buildDeliveryQr(token);
        await sock.sendMessage(toJid(phone), {
          image,
          mimetype: 'image/png',
          caption: buildOutForDeliveryText(ctx.storeName(), { code, itemCount, orderId, boyName, boyPhone }, { hasQr: true })
        });
        return true;
      } catch (err) {
        console.error('Delivery QR message failed:', err.message);
        return false;
      }
    },

    /**
     * Turns the bot on.
     *
     * Idempotent, because the button in settings can be pressed twice, and because a reconnect timer may
     * already be in flight. Two sockets on one session fight each other — each login invalidates the other —
     * so a second connect() here would knock a working shop's bot offline.
     */
    async start() {
      stopped = false;
      status.enabled = true;
      if (running) return { ok: true, alreadyRunning: true };
      connect();
      return { ok: true, alreadyRunning: false };
    },

    /**
     * Turns the bot off, keeping the linked number.
     *
     * `end()` and not `logout()`, and that distinction is the whole point. logout() tells WhatsApp to unlink
     * this device, which is a different and much more destructive thing than the shop pausing its own bot:
     * the linked number would then have to be scanned in again from scratch. Stopping has to be reversible
     * from the screen the shop is already looking at.
     */
    async stop() {
      stopped = true;
      status.enabled = false;
      status.connected = false;
      // No QR either: a stopped bot is not waiting for someone to scan anything.
      status.qr = null;
      running = false;
      try { sock?.end(undefined); } catch { /* already gone is fine */ }
      return { ok: true };
    },

    /**
     * Forgets the linked number. The auth files are deleted; start the bot again to link a new number.
     *
     * `stop()` sets `enabled = false` and so does this, and the reason matters. `enabled` is the shop's own
     * on/off switch, and it is what the settings card branches on first: a status of `enabled:true` with
     * nothing connected falls through to the "Starting…" branch, which is a promise to connect and one that
     * nothing here is going to keep. Unlinking cannot connect anything by itself, so it has to leave the
     * switch off and the card showing "Start the bot" — the same resting state `stop()` produces, and
     * reached from a button on that same card.
     *
     * `phone` is cleared too. The credentials are gone, so reporting a linked number that no longer exists
     * would be a lie the shop has to disprove rather than a fact they can act on.
     */
    async unlink() {
      stopped = true;
      running = false;
      // The transition itself lives in `statusAfterUnlink`, where a test can reach it. Kept in step with
      // `stop()` deliberately: both end on the same resting state, and both are reached from the same card.
      Object.assign(status, statusAfterUnlink(status));
      try { await sock?.logout(); } catch { /* already disconnected is fine */ }
      fs.rmSync(authDir, { recursive: true, force: true });
      return { ok: true };
    },

    /**
     * Starts pairing again, without restarting the server.
     *
     * This exists because of the revoked-device case. When WhatsApp unlinks a device there is nothing to
     * reconnect to — the phone has thrown the credentials away — so the old behaviour left the shop with a
     * settings screen that said "Starting…" and an instruction to restart a server they were trying to
     * reach through the browser in the first place. Wiping the auth files and reconnecting produces a fresh
     * QR on the same screen they are already looking at.
     */
    async relink() {
      stopped = true;
      try { await sock?.logout(); } catch { /* already disconnected is fine */ }
      // The auth directory is a complete logged-in account, so it is removed rather than emptied, and then
      // recreated by the read below. Anything left in it would be credentials the phone has already revoked.
      fs.rmSync(authDir, { recursive: true, force: true });
      fs.mkdirSync(authDir, { recursive: true });
      try { fs.chmodSync(authDir, 0o700); } catch { /* filesystem without POSIX modes */ }

      ({ state, saveCreds } = await useMultiFileAuthState(authDir));
      const raw = saveCreds;
      saveCreds = async (...args) => {
        const out = await raw(...args);
        lockSessionDir();
        return out;
      };

      status.connected = false;
      status.qr = null;
      status.phone = null;
      // Cleared here and not on 'open', so the screen leaves the "unlinked" message as soon as pairing
      // actually starts rather than sitting on a warning about a problem that is now being fixed.
      status.loggedOut = false;
      stopped = false;
      // Staggered, so a socket that is still tearing down cannot have its close event read as a fresh
      // failure and cancel the reconnect we just asked for.
      setTimeout(connect, 500);
      return { ok: true };
    }
  };
}
