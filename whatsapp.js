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
import jsQR from 'jsqr';
import {
  buildCatalogText, parseOrder, buildOrderSummaryText,
  buildWelcomeText, buildCancelledText, buildHelpText,
  buildPaymentPromptText, buildBillCaptionText, buildUpiUnavailableText, buildNamePromptText, parseNameReply,
  buildDeliveryBoyHelpText, buildDeliveryNoQrText, buildDeliveryBadQrText,
  buildOutForDeliveryText,
  readDeliveryCode
} from './whatsapp-bot.js';
import { buildBillImage } from './whatsapp-bill.js';

// Deliberately NOT calling fetchLatestBaileysVersion() here — the Baileys maintainers have
// advised against it (a "latest" WhatsApp-protocol version fetched at odd times can be one
// the installed library version doesn't actually support yet). Using the library's own
// bundled default version, and keeping the "@whiskeysockets/baileys" version in package.json
// reasonably current instead, has proven more stable.

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
 *   confirmDeliveryByQr: (token: string, byPhone?: string) => string
 * }} ctx
 */
export async function startWhatsApp(ctx) {
  const authDir = path.join(ctx.dataDir, 'whatsapp-session');
  fs.mkdirSync(authDir, { recursive: true });
  const { state, saveCreds } = await useMultiFileAuthState(authDir);

  const status = { connected: false, qr: null, phone: null };
  // one small conversation state per customer phone number: which step of the order flow they're on
  const sessions = new Map();
  let sock = null;
  let stopped = false;

  function connect() {
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
        status.phone = sock.user?.id?.split(':')[0] || sock.user?.id || null;
        console.log('WhatsApp linked as', status.phone);
      }
      if (update.connection === 'close') {
        status.connected = false;
        const code = update.lastDisconnect?.error?.output?.statusCode;
        const loggedOut = code === DisconnectReason.loggedOut;
        console.log(`WhatsApp disconnected (${loggedOut ? 'logged out on the phone' : 'reconnecting'})`);
        if (!stopped && !loggedOut) setTimeout(connect, 3000);
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
        if (!text && !isImage) continue;
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
   * Pulls a delivery token out of a photo the delivery boy sent. WhatsApp hands the picture over
   * already decrypted, so this is just decode-and-match. Never throws: a photo we cannot read is an
   * ordinary outcome (blurry shot, screenshot of the wrong thing, a sticker), and it must not be
   * able to disturb the rest of the message loop.
   * @returns {Promise<string|null>} the decoded text, or null if there is no readable QR
   */
  async function readQrFromMessage(msg) {
    if (!msg?.message?.imageMessage) return null;
    try {
      const buf = await downloadMediaMessage(msg, 'buffer', {});
      if (!buf?.length) return null;
      // Cap the size: a full-resolution phone photo is far more pixels than a QR needs, and
      // scanning is slow on a big buffer. Fitting it inside this box keeps a small QR readable
      // while dropping a huge one to something sane.
      //
      // jsQR insists on exactly 4 bytes per pixel and THROWS otherwise, so the pixels must be
      // RGBA here. Do not "optimise" this into greyscale: jsQR does its own luminance conversion
      // internally, and greyscale hands it 1 byte per pixel, which makes every photo unreadable.
      const { data, info } = await sharp(buf)
        .rotate() // honour the photo's EXIF orientation before scanning
        .resize({ width: 1400, height: 1400, fit: 'inside', withoutEnlargement: true })
        .flatten({ background: '#ffffff' }) // drop alpha; a transparent QR would scan as nothing
        .toColourspace('srgb')
        .ensureAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true });
      if (data.length !== info.width * info.height * 4) {
        console.error(`QR scan skipped: expected RGBA pixels, got ${info.channels} channel(s)`);
        return null;
      }
      const found = jsQR(new Uint8ClampedArray(data), info.width, info.height);
      return found?.data || null;
    } catch (err) {
      // An unreadable photo is ordinary (blurry shot, a sticker, the wrong image), so it is logged
      // and swallowed. This must never escape into the message loop.
      console.error('Could not read a QR code from that photo:', err.message);
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
      method,
      upiVpa: method === 'upi' ? ctx.upiVpa() : ''
    });
    sessions.set(phone, { step: 'idle', pending: null });
    await sock.sendMessage(jid, { image, mimetype: 'image/png', caption: buildBillCaptionText(order.code, method) });
  }

  async function handleMessage(jid, text, msg) {
    const phone = jid.split('@')[0];
    const lower = text.trim().toLowerCase();
    const session = sessions.get(phone) || { step: 'idle', pending: null };

    if (lower === 'cancel') {
      sessions.set(phone, { step: 'idle', pending: null });
      return reply(jid, buildCancelledText());
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
        const token = await readQrFromMessage(msg);
        if (!token) return reply(jid, buildDeliveryNoQrText());
        return reply(jid, await ctx.confirmScanByQr(token, phone));
      }
      const code = readDeliveryCode(lower);
      if (code) return reply(jid, ctx.confirmDeliveryByCode(code, phone));
      return reply(jid, buildDeliveryBoyHelpText());
    }

    if (session.step === 'confirming' && ['yes', 'y', 'হ্যাঁ', 'ha', 'হ্যা'].includes(lower)) {
      const order = session.pending;
      const code = ctx.nextOrderCode();
      const record = { code, phone, name: '', items: order.items, total: order.total, status: 'pending', createdAt: new Date().toISOString() };
      ctx.saveOrder(record);
      ctx.broadcast({ type: 'wa-order', order: record });
      // The order is saved now. The name is asked for next so the till can pre-fill it, which is
      // what puts a name on the printed bill and on the customer's own record at charge time.
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
      if (!result.ok) return reply(jid, buildHelpText());
      sessions.set(phone, { step: 'confirming', pending: result });
      return reply(jid, buildOrderSummaryText(result));
    }

    return reply(jid, buildHelpText());
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

    /** Forgets the linked number. The auth files are deleted; restart the server to link a new number. */
    async unlink() {
      stopped = true;
      try { await sock?.logout(); } catch { /* already disconnected is fine */ }
      fs.rmSync(authDir, { recursive: true, force: true });
    }
  };
}
