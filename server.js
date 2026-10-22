#!/usr/bin/env node
// Backend for LOCAL POS. Everything is stored on THIS machine, inside ./data — no cloud database.
//
//   data/config.json      store settings
//   data/products.json    product catalogue
//   data/customers.json   customers keyed by phone (name, visit count, total spent)
//   data/orders.jsonl     one paid bill per line (append-only)
//   data/counters.json    today's bill counter (shared by every device)
//   data/uploads/         product photos
//
// Also relays "show this QR" messages to customer-display screens over WebSocket.
// Run:  npm install && npm start
import express from 'express';
import { createServer } from 'http';
import { WebSocketServer } from 'ws';
import fs from 'fs';
import crypto from 'crypto';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';
import QRCode from 'qrcode';
import { computeDailyStats, computeAchievements, computeStockPosition, buildOrdersCsv, buildProductsCsv, buildDaysCsv } from './stats.js';
import { hashPin, verifyPin, tryPin, requirePin, revokeAll, tokenValid, issueToken } from './auth.js';
import {
  beginEnrolment, confirmEnrolment, disable as disableTwoFactor, verifySecondFactor,
  regenerateBackupCodes, isEnabled as twoFactorEnabled, isBroken as twoFactorBroken,
  clearAttempts as clearTwoFactorAttempts
} from './two-factor.js';
  import { createAuditLog } from './audit.js';
  // The whole complaint policy, in one file that has no network, no database and no phone in it, so every
  // rule about when a customer is answered and when a person is dragged in can be read and tested alone.
  import { AI_STATE, REASON_TEXT, aiMayReply, buildTriagePrompt } from './complaint-ai.js';
  import { createComplaintConversation } from './complaint-conversation.js';
  // Everything provider-specific lives in ai.js: which host a key belongs to, and how a request and an
  // answer differ between Gemini and the OpenAI-compatible hosts. The server only ever calls aiChat().
  import { resolveAi, buildRequest, parseResponse, firstJson, describeAi, supportsAudioInput, geminiModelCandidates } from './ai.js';
  // Reading a photo, a slip or a sentence into draft products. Pure, like complaint-ai.js.
  import { buildScanProductsPrompt, parseProductDrafts, buildProductFromTextPrompt, parseProductFromText, buildSlipPrompt, parseSlip } from './catalog-ai.js';
  // Turning a customer's WhatsApp voice note into an order: the local Whisper request, the prompt that
  // reads the transcript, and the match against the shop's real catalogue. Pure, like catalog-ai.js.
  import { resolveStt, buildTranscribeRequest, parseTranscription, buildVoiceOrderPrompt, parseVoiceOrder, buildVoiceOrderReply } from './voice-ai.js';

// Pure text/parsing helpers only — no Baileys — so this is safe to import even when WhatsApp is off.
import { buildPackedText, buildOutForDeliveryText, buildDeliveredText, buildDeliveryJobText, buildNewCodeText, buildDeliveryOkText, buildDeliveryBadCodeText, buildDeliveryAlreadyText, buildDeliveryLockedText, buildDeliveryBadQrText, buildPickupOkText, buildPickupAlreadyText, buildNotPickedUpText, buildDeliveryDeclinedText, buildDeliveryBoyNothingToDeclineText, buildAnnouncementText, announcementRecipients } from './whatsapp-bot.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.POS_DATA_DIR || path.join(__dirname, 'data'); // set POS_DATA_DIR to keep the data on another drive
const CONFIG_FILE = path.join(DATA_DIR, 'config.json');
const PRODUCTS_FILE = path.join(DATA_DIR, 'products.json');
const CUSTOMERS_FILE = path.join(DATA_DIR, 'customers.json');
const COUNTERS_FILE = path.join(DATA_DIR, 'counters.json');
const COMPLAINTS_FILE = path.join(DATA_DIR, 'complaints.json');
const ORDERS_FILE = path.join(DATA_DIR, 'orders.jsonl');
const AUDIT_FILE = path.join(DATA_DIR, 'audit.jsonl');
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
// Delivery proofs get their own folder on purpose. A handover photo is evidence and may show a
// customer's home, so it must never share a namespace with product photos: the product-photo
// cleanup endpoint deletes by name in uploads/, and a proof file has no business being reachable
// from there.
const PROOF_DIR = path.join(DATA_DIR, 'delivery-photos');
// UPI payment screenshots a customer sends over WhatsApp after their bill. Their own folder for the
// same reason as the handover photos: it is a customer's bank screenshot, it must never be reachable
// from the product-photo cleanup endpoint, and it is served read-only.
const WA_PROOF_DIR = path.join(DATA_DIR, 'wa-payment-proofs');
const PORT = process.env.PORT || 3000;
const TZ = process.env.POS_TZ || 'Asia/Kolkata';                                    // bill numbers roll over at local midnight
const FIRESTORE = process.env.FIRESTORE_ENDPOINT || 'https://firestore.googleapis.com'; // only used by the one-time import

fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(UPLOAD_DIR, { recursive: true });
fs.mkdirSync(PROOF_DIR, { recursive: true });
fs.mkdirSync(WA_PROOF_DIR, { recursive: true });

// Everything in here is a shop secret: the WhatsApp login, the customers file, the UPI ID, the AI key.
// On a shared machine the default umask leaves all of it world-readable, which means any other account
// on the box — or a backup agent running as another user — can read a logged-in WhatsApp account and
// the customer list. Locked down at startup because it is a one-line fix that protects all of it.
try {
  fs.chmodSync(DATA_DIR, 0o700);
  for (const d of [UPLOAD_DIR, PROOF_DIR, WA_PROOF_DIR]) fs.chmodSync(d, 0o700);
} catch { /* not every filesystem supports it (Windows, some mounts); the files are still only here */ }

/* ---------- tiny file database ---------- */
const round2 = (n) => Math.round(n * 100) / 100;
const str = (v, max = 300) => String(v ?? '').trim().slice(0, max);
const bad = (res, error, status = 400) => res.status(status).json({ error });

// A missing file is fine (first run). A DAMAGED file stops the server instead of being silently replaced by an empty one.
function readJson(file, fallback) {
  if (!fs.existsSync(file)) return fallback;
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch { throw new Error(`${file} is damaged. Restore it from your backup (or move it away) and start again.`); }
}
// write to a temp file, then rename: a power cut can never leave a half-written file behind
function writeJson(file, data) {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 }); // owner read/write only
  fs.renameSync(tmp, file);
}

let products = readJson(PRODUCTS_FILE, []);
let customers = readJson(CUSTOMERS_FILE, {});
let counters = readJson(COUNTERS_FILE, {});
// Complaints are kept newest-last in an array, so the shop works down them in the order they came in.
let complaints = readJson(COMPLAINTS_FILE, []);
const saveComplaints = () => writeJson(COMPLAINTS_FILE, complaints);
const orders = new Map();
if (fs.existsSync(ORDERS_FILE)) {
  for (const line of fs.readFileSync(ORDERS_FILE, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try { const o = JSON.parse(line); orders.set(o.id, o); } catch { /* skip a torn last line */ }
  }
}
const saveProducts = () => writeJson(PRODUCTS_FILE, products);
const saveCustomers = () => writeJson(CUSTOMERS_FILE, customers);

/**
 * A 4-digit code for confirming a delivery at handover. Short enough to read out over the phone,
 * and checked against the orders still out so two customers never get the same code at once.
 */
function newDeliveryCode() {
  const live = new Set([...orders.values()]
    .filter((o) => o.delivery?.status === 'out')
    .map((o) => o.delivery.code));
  for (let i = 0; i < 200; i++) {
    const code = String(crypto.randomInt(1000, 10000)); // 4 digits, never starts with 0
    if (!live.has(code)) return code;
  }
  throw new Error('Could not allocate a delivery code');
}

/* ---------- config ---------- */
function readConfig() {
  const cfg = readJson(CONFIG_FILE, null);
  if (cfg && cfg.razorpay) {
    // Older versions kept Razorpay keys here. Keep the UPI ID, and remove the secret from disk.
    if (!cfg.upiVpa && cfg.razorpay.upiVpa) cfg.upiVpa = cfg.razorpay.upiVpa;
    delete cfg.razorpay;
    writeJson(CONFIG_FILE, cfg);
  }
  return cfg;
}
function publicView(cfg) {
  if (!cfg) return null;
  // Everything stripped here holds a secret, and /api/config is deliberately public so the customer
  // display and the weigh station can render without a PIN. That makes this the single most important
  // line in the file for the PIN: anything added to cfg must be listed here or it ships to the browser.
  //   firebase — never needed in the browser
  //   ai       — the API key must not leave this machine; only the aiEnabled flag goes out
  //   voice    — the local Whisper URL/key must not leave this machine either; only voiceEnabled goes out
  //   pin      — the salted hash. Sending it would let anybody offline-crack the PIN from a till.
  const { firebase, ai, voice, pin, ...rest } = cfg;
  return {
    ...rest,
    canImportFirebase: Boolean(firebase?.apiKey && firebase?.projectId),
    aiEnabled: Boolean(ai?.apiKey),
    voiceEnabled: voice?.enabled === true,
    pinSet: Boolean(pin?.hash)
  };
}

/* ---------- helpers ---------- */
// Indian mobile number -> 10 digits, or null if it does not look like one
function normPhone(v) {
  let d = String(v ?? '').replace(/\D/g, '');
  if (d.length === 12 && d.startsWith('91')) d = d.slice(2);
  else if (d.length === 11 && d.startsWith('0')) d = d.slice(1);
  return /^[6-9]\d{9}$/.test(d) ? d : null;
}
function dayKey(d = new Date()) {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: TZ, year: '2-digit', month: '2-digit', day: '2-digit' }).formatToParts(d);
  const get = (t) => parts.find((p) => p.type === t).value;
  return `${get('year')}${get('month')}${get('day')}`;
}
const newProductId = () => `p_${crypto.randomBytes(6).toString('hex')}`;
const clip = (s, n) => Array.from(String(s ?? '').trim()).slice(0, n).join('');

const app = express();
// Nothing under /api may be cached, by the browser or by anything in between it. The response to
// "is a PIN set" is the one that matters most: a stale `{"pinSet":false}` hands somebody an unlocked
// till after the shop has locked it, which is the exact failure the lock is meant to prevent.
app.use('/api', (_req, res, next) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate');
  next();
});
app.use(express.json({ limit: '256kb' }));
app.use(express.static(path.join(__dirname, 'public')));

/* ---------- the shop PIN ----------
 * See auth.js for why this exists. The gate goes here, above every /api route, so a route added later
 * is protected by default rather than by remembering to protect it. Being close to the top of the file
 * is the point: the alternative is a list of unprotected routes that only grows. */
const audit = createAuditLog(AUDIT_FILE);
const savedPin = () => readConfig()?.pin || null;
app.use(requirePin(savedPin));

/** Which device/where an action came from, for the audit line. Deliberately coarse. */
function actorOf(req) {
  return str(req.headers['x-pos-who'] || req.socket?.remoteAddress || 'unknown', 60);
}

app.get('/api/auth/status', (req, res) => {
  // `twoFactor` is here for the same reason `pinSet` is: the login screen has to know whether to show a
  // second box, and knowing a second factor is switched on is not knowing the code.
  //
  // `twoFactorBroken` is reported separately and never folded into `twoFactor`. A file that exists and
  // cannot be read is not the same as a shop that never enrolled, and if the two were merged the screen
  // would ask for one box, the shopkeeper would type their phone code, and the till would still refuse —
  // with nothing on screen to say why. Checked before the other value precisely because asking isEnabled
  // about a damaged file is the question this route answers by refusing.
  const broken = twoFactorBroken(DATA_DIR);
  res.json({
    pinSet: Boolean(savedPin()),
    authenticated: tokenValid(req),
    twoFactor: broken || twoFactorEnabled(DATA_DIR),
    twoFactorBroken: broken
  });
});

app.post('/api/auth/pin', (req, res) => {
  // Checked before the PIN, so a damaged state file cannot be reached by guessing one. Failing *closed*
  // here is deliberate: the old behaviour treated an unreadable file as "not enrolled" and let the till
  // open on the PIN alone, which is a disk error quietly becoming a shop with no second factor.
  if (twoFactorBroken(DATA_DIR)) {
    audit.record('auth.2fa_broken', { at: actorOf(req) });
    return res.status(503).json({
      error: 'The till is locked because its second factor file cannot be read. Delete auth-2fa.json in ' +
             'the data folder to re-enrol, then set it up again in settings.',
      broken: true
    });
  }

  const result = tryPin(req, str((req.body || {}).pin, 64), savedPin());
  if (result.error) {
    // The status is what lets the login screen say "shop PIN" versus "create a PIN" without a second
    // round trip, and it is safe to expose: knowing a PIN exists is not knowing the PIN.
    return res.status(401).json({ error: result.error, pinSet: Boolean(savedPin()) });
  }

  // Second factor. The PIN was right, so this is not a failure and must not read as one: the response says
  // a code is needed and issues nothing, and the same message is returned every time so that a caller
  // cannot use it to tell "PIN wrong" from "PIN right, code still to come". They already know, and so does
  // whoever is guessing.
  if (twoFactorEnabled(DATA_DIR)) {
    const second = verifySecondFactor(DATA_DIR, req, (req.body || {}).code);
    if (!second.ok) {
      if (second.clockDrift) audit.record('auth.clock_drift', { at: actorOf(req) });
      return res.status(401).json({ error: second.error, needsCode: true, clockDrift: Boolean(second.clockDrift) });
    }
    audit.record(second.usedBackup ? 'auth.login_backup_code' : 'auth.login_2fa', {
      at: actorOf(req),
      ...(second.usedBackup ? { backupCodesLeft: second.remaining } : {})
    });
  }

  audit.record('pin.login', { at: actorOf(req) });
  res.json({ token: result.token, expiresAt: result.expiresAt });
});

/* ---------- setting up the second factor ---------- */

// All behind the gate, like every other settings route. A session is required, and for the two that change
// or remove the factor, a working code as well: a phone borrowed for a minute should not be able to quietly
// turn off the thing standing between the till and the money.

app.post('/api/auth/2fa/begin', (req, res) => {
  const cfg = readConfig() || {};
  const result = beginEnrolment(DATA_DIR, {
    account: str((req.body || {}).account, 60) || 'owner',
    issuer: str(cfg.storeName, 80) || 'M3 POS'
  });
  audit.record('auth.2fa_begin', { at: actorOf(req) });
  res.json({ secret: result.secret, url: result.url });
});

app.post('/api/auth/2fa/confirm', (req, res) => {
  const result = confirmEnrolment(DATA_DIR, (req.body || {}).code);
  if (!result.ok) return bad(res, result.error);
  audit.record('auth.2fa_enabled', { at: actorOf(req) });
  // The codes are returned exactly once, here. They are stored hashed, so this response is the only time
  // the shop will ever see them, and the UI has to make that unmissable.
  res.json({ ok: true, backupCodes: result.backupCodes });
});

app.post('/api/auth/2fa/backup-codes', (req, res) => {
  const result = regenerateBackupCodes(DATA_DIR, (req.body || {}).code);
  if (!result.ok) return res.status(401).json({ error: result.error });
  audit.record('auth.2fa_backup_codes', { at: actorOf(req) });
  res.json({ ok: true, backupCodes: result.backupCodes });
});

app.post('/api/auth/2fa/disable', (req, res) => {
  const result = disableTwoFactor(DATA_DIR, (req.body || {}).code);
  if (!result.ok) return res.status(401).json({ error: result.error });
  clearTwoFactorAttempts();
  audit.record('auth.2fa_disabled', { at: actorOf(req) });
  res.json({ ok: true });
});

app.post('/api/auth/change-pin', (req, res) => {
  // Behind the gate already, so a valid session is guaranteed here.
  const next = str((req.body || {}).pin, 64);
  if (!/^\d{4,10}$/.test(next)) return bad(res, 'Use 4 to 10 digits, so it can be typed quickly at the till');
  const cfg = readConfig() || {};
  cfg.pin = hashPin(next);
  writeJson(CONFIG_FILE, cfg);
  // Every other till is signed out. Changing the PIN is what somebody does *because* they think it
  // leaked, so leaving the old sessions alive would defeat the entire reason for changing it.
  revokeAll();
  // The code limiter goes with the sessions. A till whose PIN was just changed by its owner should not also
  // be sitting on a lockout from whoever was guessing it moments earlier — that would lock the new owner
  // out of the second factor for five minutes for something somebody else did.
  clearTwoFactorAttempts();
  audit.record('pin.changed', { at: actorOf(req) });
  res.json({ ok: true, signedOut: true });
});

/* ---------- setup / config ---------- */
// The addresses this server can actually be reached on. Sits next to /api/config rather than in it because
// it describes the machine, not the shop: it changes when the shop moves to a different Wi-Fi or plugs in
// Ethernet, and nothing about it should be saved or copied into the config file. See lanAddresses().
function networkView() {
  const addrs = lanAddresses();
  return {
    port: PORT,
    addresses: addrs,
    // What a phone, a Pi or a second laptop should actually be typed into. localhost is deliberately not in
    // this list: it is the single most common thing a shopkeeper types when they mean "the other device".
    urls: addrs.map((ip) => `http://${ip}:${PORT}`),
    displayUrl: addrs.length ? `http://${addrs[0]}:${PORT}/display.html` : '',
    weighUrl: addrs.length ? `http://${addrs[0]}:${PORT}/weigh.html` : ''
  };
}

app.get('/api/config', (_req, res) => {
  const cfg = readConfig();
  res.json({ configured: Boolean(cfg?.storeName), config: publicView(cfg), network: networkView() });
});

app.post('/api/setup', (req, res) => {
  const b = req.body || {};
  if (!str(b.storeName)) return bad(res, 'Store name is required');
  const upiVpa = str(b.upiVpa, 100);
  if (upiVpa && !/^[\w.\-]{2,256}@[a-zA-Z][a-zA-Z0-9]{1,63}$/.test(upiVpa)) {
    return bad(res, 'That UPI ID does not look right. It should be like shopname@bank');
  }
  const prev = readConfig() || {};
  const cfg = {
    storeName: str(b.storeName, 80),
    address: str(b.address, 200),
    phone: str(b.phone, 30),
    upiVpa,
    qrMode: b.qrMode === 'external-display' ? 'external-display' : 'receipt',
    displayUrl: str(b.displayUrl, 200).replace(/\/$/, ''),
    updatedAt: new Date().toISOString()
  };
  if (prev.firebase) cfg.firebase = prev.firebase; // kept only so old products can still be imported
  if (Array.isArray(prev.deliveryBoys)) cfg.deliveryBoys = prev.deliveryBoys; // managed on their own screen
  // The AI key is set on its own screen and is the hardest thing here to get back if lost, so changing
  // the shop name or the UPI ID must never quietly delete it.
  if (prev.ai && typeof prev.ai === 'object') cfg.ai = prev.ai;
  // Voice ordering is configured on its own screen too; like the AI key it must survive a shop-details
  // save. `voice` may hold a local Whisper URL and key, so it is carried over whole and stripped by
  // publicView before it can reach a browser.
  if (prev.voice && typeof prev.voice === 'object') cfg.voice = prev.voice;
  // Carried over untouched, so saving the shop's details cannot clear the PIN (which would quietly
  // reopen every protected route) and cannot overwrite it either — changing it goes through
  // /api/auth/change-pin, which signs the other tills out.
  if (prev.pin) cfg.pin = prev.pin;

  // A PIN offered during setup is applied here, and only if there is not one already. This is the
  // first-run path: /api/setup is reachable without a PIN only until one exists, so this is the one
  // moment a shop can choose its PIN. Later changes must come in through the gate.
  const wanted = str(b.pin, 64);
  let pinAccepted = false;
  if (wanted && !cfg.pin) {
    if (!/^\d{4,10}$/.test(wanted)) return bad(res, 'Use 4 to 10 digits for the shop PIN');
    cfg.pin = hashPin(wanted);
    pinAccepted = true;
  }

  // The UPI ID is where customer payments go, so a change to it is the single most consequential thing
  // that can happen in this function. It gets its own audit line naming the old and new values, and
  // the first-ever one is called out separately from an edit.
  if (cfg.upiVpa !== prev.upiVpa) {
    audit.record(prev.upiVpa ? 'setup.upi.changed' : 'setup.upi.set', {
      at: actorOf(req), from: prev.upiVpa || null, to: cfg.upiVpa || null
    });
  }
  if (pinAccepted) audit.record('pin.set', { at: actorOf(req) });
  if (prev.storeName && prev.storeName !== cfg.storeName) {
    audit.record('setup.store.renamed', { at: actorOf(req), from: prev.storeName, to: cfg.storeName });
  }
    writeJson(CONFIG_FILE, cfg);
    // Whoever just chose the PIN is handed a session for it, rather than being locked out by the thing
    // they just set up. Without this, saving the wizard drops a straight black lock screen over the
    // till and asks for a PIN the person only typed once, seconds earlier.
    // issueToken returns { token, expiresAt }; what belongs in this response is the token string
    // itself, matching what /api/auth/pin sends, so the browser has one shape to deal with.
    const token = (pinAccepted || cfg.pin) ? issueToken().token : null;
    res.json({ configured: true, config: publicView(cfg), token });
  });


/* ---------- audit log ---------- */
// Read-only, and behind the PIN like everything else. There is no write route: entries are added by
// the actions themselves, so nothing in the app can quietly remove one.
app.get('/api/audit', (req, res) => {
  const limit = Math.min(500, Math.max(1, Number(req.query.limit) || 200));
  res.json({ entries: audit.read(limit) });
});

/* ---------- delivery boys ----------
 * Their WhatsApp numbers live here so the shop can hand a delivery to a boy by message, and so a
 * message from one of these numbers is read as a delivery update rather than a new customer order. */
const deliveryBoys = () => (Array.isArray(readConfig()?.deliveryBoys) ? readConfig().deliveryBoys : []);

app.get('/api/delivery-boys', (_req, res) => res.json({ boys: deliveryBoys() }));

app.post('/api/delivery-boys', (req, res) => {
  const b = req.body || {};
  const name = str(b.name, 40).trim();
  if (!name) return bad(res, 'Enter the delivery boy\'s name');
  const phone = normPhone(b.phone);
  if (!phone) return bad(res, 'Enter a valid 10-digit WhatsApp number');
  const cfg = readConfig() || {};
  const boys = Array.isArray(cfg.deliveryBoys) ? cfg.deliveryBoys : [];
  if (boys.some((x) => x.phone === phone)) return bad(res, 'That number is already on the list');
  const boy = { name, phone };
  boys.push(boy);
  writeJson(CONFIG_FILE, { ...cfg, deliveryBoys: boys });
  res.status(201).json({ boy, boys });
});

app.delete('/api/delivery-boys/:phone', (req, res) => {
  const phone = normPhone(req.params.phone);
  const cfg = readConfig() || {};
  const boys = Array.isArray(cfg.deliveryBoys) ? cfg.deliveryBoys : [];
  const left = boys.filter((x) => x.phone !== phone);
  if (left.length === boys.length) return bad(res, 'No delivery boy with that number');
  writeJson(CONFIG_FILE, { ...cfg, deliveryBoys: left });
  res.json({ boys: left });
});

/* ---------- products ---------- */
const DEMO = [
  ['8901000000011', 'Basmati Rice 1 kg', 118, 40, 'Grocery', '🍚'],
  ['8901000000028', 'Mustard Oil 1 L', 165, 22, 'Grocery', '🫙'],
  ['8901000000035', 'Tea Leaves 250 g', 92, 4, 'Grocery', '🍵'],
  ['8901000000042', 'Full Cream Milk 500 ml', 34, 60, 'Dairy', '🥛'],
  ['8901000000059', 'Paneer 200 g', 88, 12, 'Dairy', '🧀'],
  ['8901000000066', 'Butter Biscuits', 25, 90, 'Snacks', '🍪'],
  ['8901000000073', 'Potato Chips Classic', 20, 0, 'Snacks', '🥔'],
  ['8901000000080', 'Orange Juice 1 L', 110, 18, 'Beverages', '🍊'],
  ['8901000000097', 'Laundry Soap Bar', 15, 75, 'Household', '🧼'],
  ['8901000000103', 'Dishwash Liquid 500 ml', 99, 30, 'Household', '🧴']
].map(([sku, name, price, stock, category, emoji]) => ({ sku, name, price, stock, category, emoji, image: '', soldByWeight: false }));

// Validates a product coming from the browser. `selfId` lets an edit keep its own SKU.
function cleanProduct(b, selfId = null) {
    const p = {
      sku: str(b.sku, 64), name: str(b.name, 100), price: Number(b.price), stock: Number(b.stock),
      category: str(b.category, 40), emoji: clip(b.emoji, 4), image: str(b.image, 200),
      soldByWeight: Boolean(b.soldByWeight), // price is per kg, stock is kg in stock; sold via the weighing station, not "Add to cart"
      // What the shop paid for one unit. null means "not recorded yet", which is deliberately
      // different from 0: a missing cost must not masquerade as a free item and report 100% margin.
      cost: b.cost === '' || b.cost == null ? null : Number(b.cost)
    };
    if (!p.sku || !p.name) return { error: 'SKU and name are required' };
    if (!Number.isFinite(p.price) || p.price < 0 || p.price > 1e7) return { error: 'Enter a valid price' };
    if (p.cost !== null && (!Number.isFinite(p.cost) || p.cost < 0 || p.cost > 1e7)) return { error: 'Enter a valid cost price' };
    if (p.cost !== null) p.cost = round2(p.cost);
  if (!Number.isFinite(p.stock) || p.stock < 0 || p.stock > 1e7) return { error: 'Enter a valid stock quantity' };
  if (p.image && !/^\/uploads\/[\w-]+\.(jpg|png|webp)$/.test(p.image)) return { error: 'Bad photo path' };
  p.price = round2(p.price);
  p.stock = Math.round(p.stock * 1000) / 1000;
  const clash = products.find((x) => x.sku === p.sku && x.id !== selfId);
  if (clash) return { error: `SKU ${p.sku} is already used by "${clash.name}"`, status: 409 };
  return { product: p };
}

// A weighing station can be its own small computer; allow it to call these from another origin.
function allowCrossOrigin(req, res, next) {
  res.set({
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS'
  });
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
}
app.use('/api/products', allowCrossOrigin);
app.use('/api/weigh', allowCrossOrigin);

app.get('/api/products', (_req, res) => res.json({ products }));

app.post('/api/products', (req, res) => {
  const r = cleanProduct(req.body || {});
  if (r.error) return bad(res, r.error, r.status);
  const product = { id: newProductId(), ...r.product };
  products.push(product);
  saveProducts();
  res.status(201).json({ product });
});

app.put('/api/products/:id', (req, res) => {
  const cur = products.find((p) => p.id === req.params.id);
  if (!cur) return bad(res, 'Product not found', 404);
  const r = cleanProduct(req.body || {}, cur.id);
  if (r.error) return bad(res, r.error, r.status);
  Object.assign(cur, r.product);
  saveProducts();
  res.json({ product: cur });
});

app.delete('/api/products/:id', (req, res) => {
  const i = products.findIndex((p) => p.id === req.params.id);
  if (i < 0) return bad(res, 'Product not found', 404);
  products.splice(i, 1);
  saveProducts();
  res.json({ ok: true });
});

// 10 sample grocery items so a brand-new store can try the POS. Only works while the catalogue is empty.
app.post('/api/products/demo', (_req, res) => {
  if (products.length) return bad(res, 'Products already exist', 409);
  products = DEMO.map((p) => ({ id: newProductId(), ...p }));
  saveProducts();
  res.json({ products });
});

/* ---------- one-time import of products that were saved in Firebase earlier ---------- */
function fsValue(v) {
  if (!v || typeof v !== 'object') return '';
  if ('stringValue' in v) return v.stringValue;
  if ('integerValue' in v) return Number(v.integerValue);
  if ('doubleValue' in v) return Number(v.doubleValue);
  return '';
}
function parseFirestoreDoc(doc) {
  const f = doc?.fields || {};
  const g = (k) => fsValue(f[k]);
  return { sku: g('sku'), name: g('name'), price: g('price'), stock: g('stock'), category: g('category'), emoji: g('emoji'), image: g('image') };
}

app.post('/api/products/import-firebase', async (_req, res) => {
  const fb = readConfig()?.firebase || {};
  if (!fb.apiKey || !fb.projectId) return bad(res, 'No Firebase project is saved on this server');
  const base = `${FIRESTORE}/v1/projects/${encodeURIComponent(fb.projectId)}/databases/(default)/documents/products`;
  const docs = [];
  try {
    let token = '';
    do {
      const url = `${base}?pageSize=300&key=${encodeURIComponent(fb.apiKey)}${token ? `&pageToken=${encodeURIComponent(token)}` : ''}`;
      const r = await fetch(url);
      const data = await r.json().catch(() => ({}));
      if (!r.ok) return bad(res, data?.error?.message || `Firebase error (${r.status})`, 502);
      docs.push(...(data.documents || []));
      token = data.nextPageToken || '';
    } while (token && docs.length < 5000);
  } catch (err) {
    return bad(res, `Could not reach Firebase: ${err.message}`, 502);
  }

  let imported = 0, skipped = 0;
  for (const d of docs) {
    const parsed = parseFirestoreDoc(d);
    const r = parsed.price === '' || parsed.stock === '' ? { error: 'missing price or stock' } : cleanProduct(parsed);
    if (r.error) { skipped++; continue; } // bad data, or the SKU is already here
    products.push({ id: newProductId(), ...r.product });
    imported++;
  }
  if (imported) saveProducts();
  res.json({ imported, skipped, products });
});

/* ---------- weighing-station tickets ---------- */
// The weighing station creates a short-lived, one-time code; the till scans it to add the exact
// weighed item and price to a bill. Kept in memory only: if the server restarts, any ticket not
// yet scanned is gone and the item must be weighed again.
const weighTickets = new Map();
const TICKET_TTL_MS = 20 * 60 * 1000; // 20 minutes is plenty to walk from the scale to the till
const newTicketCode = () => `WT${crypto.randomBytes(4).toString('hex').toUpperCase()}`;

function sweepExpiredTickets() {
  const now = Date.now();
  for (const [code, t] of weighTickets) if (t.expiresAt < now) weighTickets.delete(code);
}
setInterval(sweepExpiredTickets, 5 * 60 * 1000).unref();

app.post('/api/weigh/tickets', (req, res) => {
  const sku = str(req.body?.sku, 64);
  const weightKg = Number(req.body?.weightKg);
  if (!sku) return bad(res, 'Choose an item');
  if (!Number.isFinite(weightKg) || weightKg <= 0 || weightKg > 500) return bad(res, 'Enter a valid weight in kg');
  const product = products.find((p) => p.sku === sku);
  if (!product) return bad(res, 'That item was not found on this server', 404);
  if (!product.soldByWeight) return bad(res, `"${product.name}" is not marked "Sold by weight"`, 400);

  sweepExpiredTickets();
  const code = newTicketCode();
  const ticket = {
    code, sku: product.sku, name: product.name,
    weightKg: Math.round(weightKg * 1000) / 1000,
    pricePerKg: product.price,
    price: round2(product.price * weightKg),
    createdAt: new Date().toISOString(),
    expiresAt: Date.now() + TICKET_TTL_MS
  };
  weighTickets.set(code, ticket);
  res.status(201).json({ ticket });
});

// One-time use: the till calls this once, when it scans the ticket's QR code.
app.post('/api/weigh/tickets/:code/redeem', (req, res) => {
  const code = String(req.params.code || '').trim().toUpperCase();
  const ticket = weighTickets.get(code);
  if (!ticket) return bad(res, 'Ticket not found, already used, or expired', 404);
  if (ticket.expiresAt < Date.now()) { weighTickets.delete(code); return bad(res, 'This ticket has expired — weigh the item again', 410); }
  weighTickets.delete(code);
  res.json({ ticket });
});

/* ---------- bills ---------- */
// Bill numbers come from the server so two phones can never issue the same number.
app.post('/api/orders/next-id', (_req, res) => {
  const day = dayKey();
  const n = (counters[day] || 0) + 1;
  counters = { [day]: n }; // older days are dropped, the file stays tiny
  writeJson(COUNTERS_FILE, counters);
  res.json({ id: `INV-${day}-${String(n).padStart(4, '0')}` });
});

/**
 * The two messages that go out when a WhatsApp order's bill is charged: "we are packing this" to the
 * customer, and the job to the delivery boy. The customer's handover code is deliberately NOT sent
 * yet — it waits until he has collected the parcel, so a boy who never turns up can't spoil it.
 * Shared by the first send and by "resend" so both behave identically. Never throws — each result is
 * reported so the record can show what did and didn't go out.
 */
async function sendDeliveryMessages(o) {
  const store = readConfig()?.storeName || 'The shop';
  const d = o.delivery;
  const phone = o.customer?.phone;
  const itemCount = d.itemCount ?? o.items.reduce((s, it) => s + (it.isWeight ? 1 : it.qty), 0);
  const itemLines = o.items.map((it) => (it.isWeight ? `${it.weightKg} kg ${it.name}` : `${it.qty} x ${it.name}`)).join(', ');
  const who = o.customer?.name ? `${o.customer.name} (${phone})` : `Customer — ${phone}`;

  d.notified = await wa?.sendText(phone, buildPackedText(store, { itemCount, orderId: o.id, boyName: d.boy?.name }))
    .catch((err) => { console.error('Packed message failed:', err.message); return false; }) === true;
  d.jobSent = await wa?.sendText(d.boy?.phone, buildDeliveryJobText(store, {
    orderId: o.id, customer: who, items: itemLines, total: o.total
  })).catch((err) => { console.error('Delivery job message failed:', err.message); return false; }) === true;
  return { notified: d.notified, jobSent: d.jobSent };
}

/**
 * The moment the parcel changes hands. The customer is told it is out for delivery and only now
 * receives the QR and 4-digit code that can mark it delivered. Sending these before pickup would let
 * a boy who never collected the goods walk into the code, which is exactly what the sticker scan
 * prevents. Shared by the scan itself and by the shop's manual "mark picked up" button.
 */
async function sendOutForDeliveryMessage(o) {
  const store = readConfig()?.storeName || 'The shop';
  const d = o.delivery;
  const itemCount = d.itemCount ?? o.items.reduce((s, it) => s + (it.isWeight ? 1 : it.qty), 0);
  // The customer gets the QR picture. If that can't go out (older bill with no token, or a send
  // failure) fall back to plain text so the 4-digit code still reaches them.
  d.notified = d.token
    ? await wa?.sendDeliveryQr(o.customer?.phone, { code: d.code, itemCount, orderId: o.id, token: d.token, boyName: d.boy?.name, boyPhone: d.boy?.phone })
      .catch((err) => { console.error('Delivery QR message failed:', err.message); return false; }) === true
    : false;
  if (!d.notified) {
    d.notified = await wa?.sendText(o.customer?.phone, buildOutForDeliveryText(store, {
      code: d.code, itemCount, orderId: o.id, boyName: d.boy?.name, boyPhone: d.boy?.phone
    })).catch((err) => { console.error('Delivery message failed:', err.message); return false; }) === true;
  }
  return d.notified;
}

// Called once a bill is paid: stores the bill, lowers stock, updates the customer's visit count.
app.post('/api/orders', async (req, res) => {
  const b = req.body || {};
  const id = String(b.id || '');
  if (!/^INV-\d{6}-\d{4,}$/.test(id)) return bad(res, 'Bad bill number');

  const known = orders.get(id); // a retry of a bill we already saved: answer, change nothing
  if (known) return res.json({ order: known, customer: known.customer?.phone ? customers[known.customer.phone] || null : null, duplicate: true });

  if (!Array.isArray(b.items) || b.items.length === 0 || b.items.length > 200) return bad(res, 'The bill has no items');

  // A WhatsApp sale is a delivery, so who is delivering it is settled here — before the customer's
  // visit count is touched — rather than after the bill has half-built itself.
  let deliveryBoy = null;
  if (b.waCode) {
    const bPhone = normPhone(b.deliveryBoy?.phone);
    if (!bPhone) return bad(res, 'Pick who is delivering this WhatsApp order');
    const known = deliveryBoys().find((x) => x.phone === bPhone);
    if (!known) return bad(res, 'That delivery boy is not on the list — add his number in Settings first');
    deliveryBoy = known;
  }

  const items = [];
  for (const it of b.items) {
    const qty = Number(it.qty), price = Number(it.price);
    if (!Number.isFinite(qty) || !(qty > 0) || !Number.isFinite(price) || price < 0) return bad(res, 'One of the items on the bill is invalid');
    const line = { id: str(it.id, 60), sku: str(it.sku, 64), name: str(it.name, 100), price: round2(price), qty };
    if (it.weightKg !== undefined) { // a weighing-station line: qty is always 1, weightKg is the real quantity sold
      const weightKg = Number(it.weightKg);
      if (!Number.isFinite(weightKg) || weightKg <= 0) return bad(res, 'One of the items on the bill is invalid');
      line.weightKg = Math.round(weightKg * 1000) / 1000;
    }
    // Snapshot the cost onto the line at the moment of sale, taken from the catalogue rather than the
    // browser. Profit for a bill has to stay correct after the shop later changes a purchase price,
    // and a client-supplied cost could be anything.
    const fromCatalogue = products.find((x) => x.sku === line.sku && x.sku) || products.find((x) => x.id === line.id);
    const catCost = fromCatalogue && Number.isFinite(fromCatalogue.cost) ? fromCatalogue.cost : null;
    const sentCost = Number(it.cost);
    line.cost = catCost !== null ? catCost : (Number.isFinite(sentCost) && sentCost >= 0 ? round2(sentCost) : null);
    items.push(line);
  }
  const paymentMethod = ['cash', 'upi'].includes(b.paymentMethod) ? b.paymentMethod : null;
  if (!paymentMethod) return bad(res, 'Payment method must be cash or upi');

  const subtotal = round2(items.reduce((s, i) => s + i.price * i.qty, 0));
  const discount = Math.min(Math.max(round2(Number(b.discount) || 0), 0), subtotal);
  const total = round2(subtotal - discount);

  const cin = b.customer || {};
  const name = clip(cin.name, 60);
  const rawPhone = str(cin.phone, 30);
  let phone = '';
  if (rawPhone) {
    phone = normPhone(rawPhone);
    if (!phone) return bad(res, 'Customer phone must be a 10-digit mobile number');
  }

  const now = new Date().toISOString();
  const order = {
    id,
    createdAt: Number.isFinite(Date.parse(b.createdAt)) ? new Date(b.createdAt).toISOString() : now,
    paidAt: now,
    status: 'paid',
    paymentMethod,
    items, subtotal, discount, total,
    discountRule: { type: b.discountRule?.type === 'flat' ? 'flat' : 'percent', value: Math.max(0, Number(b.discountRule?.value) || 0) },
    customer: name || phone ? { name, phone } : null,
    visitNo: null
  };

  let customer = null;
  if (phone) {
    const isNewCustomer = !customers[phone];
    customer = customers[phone] ||= { phone, name: '', visits: 0, totalSpent: 0, firstVisit: now, lastVisit: now };
    if (name) customer.name = name;
    customer.visits += 1;
    customer.totalSpent = round2(customer.totalSpent + total);
    customer.lastVisit = now;
    order.visitNo = customer.visits;
    order.customer.name = customer.name;
    // fire-and-forget: never let a WhatsApp hiccup slow down or fail the bill being saved
    if (isNewCustomer) wa?.sendWelcome(phone, customer.name).catch((err) => console.error('WhatsApp welcome failed:', err.message));
  }

  // A sale that was loaded from a WhatsApp order starts a delivery in two stages, the way a parcel
  // courier works: the shop packs it and the customer is told so, then the delivery boy collects it
  // from the shop by scanning the sticker on the parcel, and only then is the customer told it is
  // out for delivery and sent the code that proves the handover at the door. So the customer is
  // never told an order is on its way until a boy is actually carrying it.
  if (b.waCode && phone) {
    const code = newDeliveryCode();
    const itemCount = items.reduce((s, it) => s + (it.isWeight ? 1 : it.qty), 0);
    order.waCode = String(b.waCode);
    order.delivery = {
      code,
      token: newDeliveryToken(),
      // The package sticker's own secret, separate from the customer's handover QR. It is printed by
      // the shop and stuck on the parcel, and only a delivery boy holding the goods can scan it —
      // which is what proves the parcel actually left the shop.
      pickupToken: newDeliveryToken(),
      status: 'packed',
      packedAt: now,
      outAt: null,
      declinedAt: null,
      declinedBy: null,
      deliveredAt: null,
      confirmedBy: null,
      notified: null,
      jobSent: null
    };
    // Sent BEFORE the bill is written so the results land in the saved record.
    await sendDeliveryMessages(order);
  }

  // the bill itself is written first: it is the record that matters most
  fs.appendFileSync(ORDERS_FILE, `${JSON.stringify(order)}\n`, { mode: 0o600 });
  orders.set(id, order);

  for (const it of items) {
    const p = products.find((x) => x.id === it.id) || products.find((x) => x.sku === it.sku);
    if (p) p.stock = Math.max(0, Math.round((p.stock - (it.weightKg ?? it.qty)) * 1000) / 1000);
  }
  saveProducts();
  if (customer) saveCustomers();

  res.status(201).json({ order, customer });
});

/* ---------- deliveries ---------- */

/** Bills paid from a WhatsApp order that are still moving: packed in the shop, or out with a boy. */
app.get('/api/deliveries', (_req, res) => {
  const out = [...orders.values()]
    .filter((o) => o.delivery && (o.delivery.status === 'packed' || o.delivery.status === 'out'))
    .sort((a, b) => String(a.delivery.outAt || a.delivery.packedAt || a.paidAt).localeCompare(String(b.delivery.outAt || b.delivery.packedAt || b.paidAt)))
    .map((o) => ({
      id: o.id,
      status: o.delivery.status,
      customer: o.customer,
      total: o.total,
      itemCount: o.items.reduce((s, it) => s + (it.isWeight ? 1 : it.qty), 0),
      packedAt: o.delivery.packedAt,
      outAt: o.delivery.outAt,
      pickedUpBy: o.delivery.pickedUpBy || null,
      boy: o.delivery.boy || null,
      hasSticker: !!o.delivery.pickupToken,
      // both false mean the shop has to pass the message on by hand
      notified: o.delivery.notified !== false,
      jobSent: o.delivery.jobSent !== false,
      // the code itself is not sent to the list: the delivery boy types what the customer says
      items: o.items.map((it) => ({ name: it.name, qty: it.qty, weightKg: it.weightKg, isWeight: it.isWeight }))
    }));
  // Delivered jobs leave the list above, which used to mean a stored handover photo had nowhere to
  // be seen. The most recent ones are kept here so a disputed delivery can actually be checked.
  // Still no code and no token: those are the secrets that close a job, and this list is not the
  // place to confirm anything.
  const recentDelivered = [...orders.values()]
    .filter((o) => o.delivery?.status === 'delivered')
    .sort((a, b) => String(b.delivery.deliveredAt || '').localeCompare(String(a.delivery.deliveredAt || '')))
    .slice(0, 25)
    .map((o) => ({
      id: o.id,
      status: 'delivered',
      customer: o.customer,
      total: o.total,
      itemCount: o.items.reduce((s, it) => s + (it.isWeight ? 1 : it.qty), 0),
      packedAt: o.delivery.packedAt,
      outAt: o.delivery.outAt,
      deliveredAt: o.delivery.deliveredAt,
      pickedUpBy: o.delivery.pickedUpBy || null,
      boy: o.delivery.boy || null,
      confirmedBy: o.delivery.confirmedBy || null,
      // A delivered order with no photo is a real possibility for bills that predate this feature,
      // and for a handover closed by typing the 4-digit code. It is shown as such, not hidden.
      ...proofFields(o),
      notified: o.delivery.notified !== false,
      jobSent: o.delivery.jobSent !== false,
      items: o.items.map((it) => ({ name: it.name, qty: it.qty, weightKg: it.weightKg, isWeight: it.isWeight }))
    }));
  res.json({ deliveries: out, recentDelivered });
});

/**
 * Shop-side fallback for a sticker the boy could not scan (a torn sticker, a phone that can't read
 * it). Uses the same path as the scan, so the record and the customer's message are identical.
 */
app.post('/api/orders/:id/delivery/pickup', async (req, res) => {
  const o = orders.get(req.params.id);
  if (!o) return bad(res, 'No such bill');
  if (!o.delivery) return bad(res, 'This bill is not a delivery');
  if (o.delivery.status === 'delivered') return bad(res, 'That order is already delivered');
  const r = await startDeliveryRun(o, String(req.body?.by || 'shop').slice(0, 40));
  // The sticker scan was skipped on purpose, which is what makes this the most abused of the three
  // shop-side fallbacks: it is the one that can start a delivery run with no proof the goods left the
  // shop. Recorded every time, which is the only thing that makes it safe to leave unlocked.
  audit.record('delivery.pickup.manual', { at: actorOf(req), id: o.id, by: String(req.body?.by || 'shop').slice(0, 40) });
  res.json({ ok: true, already: r.already, notified: r.notified });
});

/**
 * Hands a job back. The boy may be stuck, off, or simply not going out, and the parcel is sitting in
 * the shop — the customer has only been told it is being packed, so nothing has been promised that
 * this breaks. The order leaves the delivery list so the cashier can give it to somebody else.
 */
app.post('/api/orders/:id/delivery/decline', (req, res) => {
  const o = orders.get(req.params.id);
  if (!o) return bad(res, 'No such bill');
  if (!o.delivery) return bad(res, 'This bill is not a delivery');
  if (o.delivery.status === 'delivered') return bad(res, 'That order is already delivered');
  if (o.delivery.status === 'out') return bad(res, 'He already has the parcel — mark it delivered or reassign is too late');
  o.delivery.status = 'declined';
  o.delivery.declinedAt = new Date().toISOString();
  o.delivery.declinedBy = String(req.body?.by || 'delivery').slice(0, 40);
  fs.appendFileSync(ORDERS_FILE, `${JSON.stringify(o)}\n`, { mode: 0o600 });
  orders.set(o.id, o);
  audit.record('delivery.declined', { at: actorOf(req), id: o.id, by: o.delivery.declinedBy });
  res.json({ ok: true });
});

/**
 * Points a job at a different delivery boy. Only possible while the parcel is still in the shop: once
 * a boy has scanned the sticker he is holding the goods, so swapping the name on the record would be
 * a lie about who has it. The new boy is messaged the job, the old one is not told anything (he never
 * had the handover code, so there is nothing to spoil).
 */
app.post('/api/orders/:id/delivery/assign', async (req, res) => {
  const o = orders.get(req.params.id);
  if (!o) return bad(res, 'No such bill');
  if (!o.delivery) return bad(res, 'This bill is not a delivery');
  if (o.delivery.status === 'delivered') return bad(res, 'That order is already delivered');
  if (o.delivery.status === 'out') return bad(res, 'The parcel is already out with a delivery boy');
  const boy = (req.body?.boys || []).find?.((b) => b)
    || (req.body?.phone ? { name: String(req.body.name || 'Delivery boy').slice(0, 40), phone: normPhone(req.body.phone) } : null);
  if (!boy?.phone) return bad(res, 'Pick a delivery boy');
  o.delivery.boy = { name: String(boy.name || 'Delivery boy').slice(0, 40), phone: normPhone(boy.phone) };
  o.delivery.status = 'packed';
  o.delivery.declinedAt = null;
  o.delivery.declinedBy = null;
  await sendDeliveryMessages(o);
  fs.appendFileSync(ORDERS_FILE, `${JSON.stringify(o)}\n`, { mode: 0o600 });
  orders.set(o.id, o);
  audit.record('delivery.reassigned', { at: actorOf(req), id: o.id, to: o.delivery.boy?.name || '', phone: o.delivery.boy?.phone || '' });
  res.json({ ok: true, jobSent: o.delivery.jobSent !== false });
});

/**
 * Confirms a handover. The code comes from the customer, so this is the proof that the goods reached
 * them — an order cannot be closed by guesswork. Replays are rejected rather than silently ignored.
 */
app.post('/api/orders/:id/deliver', (req, res) => {
  const o = orders.get(req.params.id);
  if (!o) return bad(res, 'No such bill');
  if (!o.delivery) return bad(res, 'This bill is not a delivery');
  if (o.delivery.status === 'delivered') {
    return bad(res, `Already delivered on ${new Date(o.delivery.deliveredAt).toLocaleString('en-IN')}`);
  }

  const given = String(req.body?.code || '').trim();
  if (!/^\d{4}$/.test(given)) return bad(res, 'Enter the 4-digit code from the customer');
  if (given !== o.delivery.code) {
    return bad(res, 'That code does not match this order. Ask the customer to read it out again.');
  }
  // The customer is not even sent the code until the parcel has been collected, so a bill still
  // sitting in the shop cannot be closed by a code that was read out of an old message.
  if (o.delivery.status !== 'out') {
    return bad(res, 'The delivery boy has not collected this parcel yet — mark it picked up first');
  }

  // Same completion path the bot uses, so a bill closed by hand and one closed from WhatsApp end up
  // recorded and messaged identically. Only the recorded name differs: here we know who typed it.
  // The 4-digit code is what closes the delivery. A photo is attached when the till is given one,
  // but is not required, so closing a handover never depends on a camera working.
  const photo = proofUrlIsReal(req.body?.photo);
  if (req.body?.photo && !photo) return bad(res, 'That photo could not be used. Send a JPG, PNG or WebP, or clear it and confirm with the code alone.');
  completeDelivery(o, String(req.body?.by || 'delivery').slice(0, 40), photo ? { url: photo, via: 'till' } : null);
  // The token is echoed nowhere: it is a bearer secret for the customer's QR, and a response is
  // somewhere it could end up in a log or a browser history for no benefit.
  res.json({ ok: true, order: { id: o.id, delivery: { code: o.delivery.code, status: o.delivery.status, deliveredAt: o.delivery.deliveredAt, confirmedBy: o.delivery.confirmedBy, ...proofFields(o) } } });
});

/** Re-sends the messages for a bill, whichever stage it is at. For when the first attempt didn't reach anyone. */
app.post('/api/orders/:id/resend', async (req, res) => {
  const o = orders.get(req.params.id);
  if (!o) return bad(res, 'No such bill');
  if (!o.delivery) return bad(res, 'This bill is not a delivery');
  if (o.delivery.status === 'delivered') return bad(res, 'That order is already delivered');
  if (!wa) return bad(res, 'WhatsApp is not linked on this server', 409);
  // Once the parcel is out the customer is waiting on the handover QR, so that is what gets resent.
  // Before that, the useful thing to repeat is the job to the boy.
  const r = o.delivery.status === 'out'
    ? { notified: await sendOutForDeliveryMessage(o), jobSent: o.delivery.jobSent !== false }
    : await sendDeliveryMessages(o);
  fs.appendFileSync(ORDERS_FILE, `${JSON.stringify(o)}\n`, { mode: 0o600 });
  orders.set(o.id, o);
  res.json({ ok: true, ...r });
});

/**
 * Issues a fresh code and a fresh token, and texts the customer the new code. Needed when the
 * current pair can no longer be trusted as proof — a message that was lost, or a code the delivery
 * boy has seen. The boy is deliberately not told: his job message never carries either secret, so
 * the replacements stay secret from him and the handover check keeps its meaning. Both the old
 * code and the old QR stop working at once.
 */
app.post('/api/orders/:id/new-code', async (req, res) => {
  const o = orders.get(req.params.id);
  if (!o) return bad(res, 'No such bill');
  if (!o.delivery) return bad(res, 'This bill is not a delivery');
  if (o.delivery.status === 'delivered') return bad(res, 'That order is already delivered');
  // Rotating the handover code only makes sense once the customer has it. Before pickup the customer
  // has never been sent a code, so there is nothing to rotate and the button would only be confusing.
  if (o.delivery.status !== 'out') return bad(res, 'The customer has not been sent a code yet — it goes out when the parcel is collected');
  if (!wa) return bad(res, 'WhatsApp is not linked on this server', 409);
  o.delivery.code = newDeliveryCode();
  o.delivery.token = newDeliveryToken();
  o.delivery.codeRotatedAt = new Date().toISOString();
  const store = readConfig()?.storeName || 'The shop';
  // Same QR-first send as a new order, so the customer always ends up with the picture.
  o.delivery.notified = await wa.sendDeliveryQr(o.customer?.phone, {
    code: o.delivery.code, itemCount: o.delivery.itemCount, orderId: o.id, token: o.delivery.token,
    boyName: o.delivery.boy?.name, boyPhone: o.delivery.boy?.phone
  }).catch((err) => { console.error('New code QR message failed:', err.message); return false; }) === true;
  if (!o.delivery.notified) {
      o.delivery.notified = await wa?.sendText(o.customer?.phone, buildNewCodeText(store, {
        code: o.delivery.code, orderId: o.id, boyName: o.delivery.boy?.name
      })).catch((err) => { console.error('New code message failed:', err.message); return false; }) === true;

  }
  fs.appendFileSync(ORDERS_FILE, `${JSON.stringify(o)}\n`, { mode: 0o600 });
  orders.set(o.id, o);
  res.json({ ok: true, notified: o.delivery.notified });
});

/**
 * Confirms a handover from the QR code the customer showed. The token is unguessable, so this
 * needs no rate limiting; a photo that reads as nothing is a camera problem, not an attack, so it
 * is not counted against the boy either.
 */
/**
 * The parcel has changed hands: the delivery boy scanned the sticker while standing in the shop, so
 * the goods are genuinely with him. This is the point the customer is told it is out for delivery and
 * is sent the handover QR and code. Shared by the scan and the shop's manual button so a record can't
 * differ depending on which one was used.
 */
async function startDeliveryRun(o, by) {
  if (o.delivery.status === 'out') {
    return { already: true, notified: o.delivery.notified !== false };
  }
  o.delivery.status = 'out';
  o.delivery.outAt = new Date().toISOString();
  o.delivery.pickedUpBy = by || o.delivery.boy?.name || 'delivery';
  await sendOutForDeliveryMessage(o);
  fs.appendFileSync(ORDERS_FILE, `${JSON.stringify(o)}\n`, { mode: 0o600 });
  orders.set(o.id, o);
  return { already: false, notified: o.delivery.notified };
}

/** Called by the bot when a delivery boy photographs the sticker on a parcel. */
function confirmPickupByQr(token, byPhone) {
  const o = findDeliveryByPickupToken(token);
  if (!o) return buildDeliveryBadQrText();
  if (o.delivery.status === 'delivered') {
    return buildPickupAlreadyText(o.id);
  }
  return startDeliveryRun(o, o.delivery.boy?.name).then(
    (r) => buildPickupOkText(o.id, r.notified),
    (err) => { console.error('Pickup failed:', err.message); return buildDeliveryBadQrText(); }
  );
}

function confirmDeliveryByQr(token, byPhone, photoBuf) {
  const o = findDeliveryByToken(token);
  if (!o) return buildDeliveryBadQrText();
  if (o.delivery.status === 'delivered') {
    return buildDeliveryAlreadyText(o.id, new Date(o.delivery.deliveredAt).toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit' }));
  }
  // The customer's handover code is not a substitute for collecting the parcel. Without this a boy
  // could take a photo of the customer's screen at the door of a shop and close a job he never
  // picked up — and the customer would have been told nothing was moving.
  if (o.delivery.status !== 'out') return buildNotPickedUpText(o.id);
  if (byPhone) clearBadCodes(byPhone);
  // He photographed the customer's code, so the picture is the proof and is stored with the bill.
  // Saving is best-effort: a delivery that really happened is never refused because a file could
  // not be written, and the bill is recorded without a photo so the gap stays visible.
  const url = photoBuf ? saveProofPhoto(photoBuf, o.id) : null;
  if (photoBuf && !url) console.error(`Could not store the handover photo for ${o.id}; recorded without one`);
  return completeDelivery(o, o.delivery.boy?.name, url ? { url, via: 'whatsapp' } : null);
}

/** Called by the bot when a delivery boy sends a code from his own WhatsApp. */
/**
 * The secret inside the customer's QR code. A 4-digit code is only 10,000 possibilities, so a
 * delivery boy could brute-force every open order just by sending numbers until one lands. This is
 * 96 bits of randomness instead, so guessing is not a threat. 16 chars keeps the QR small enough
 * to stay readable when WhatsApp has recompressed a screenshot of it.
 */
function newDeliveryToken() {
  const live = new Set([...orders.values()]
    .filter((o) => (o.delivery?.status === 'out' || o.delivery?.status === 'packed') && o.delivery.token)
    .map((o) => o.delivery.token));
  for (let i = 0; i < 200; i++) {
    const token = crypto.randomBytes(12).toString('base64url');
    if (!live.has(token)) return token;
  }
  throw new Error('Could not allocate a delivery token');
}

function findDeliveryByCode(code) {
  for (const o of orders.values()) {
    if (o.delivery?.code === code) return o;
  }
  return null;
}

function findDeliveryByToken(token) {
  for (const o of orders.values()) {
    if (o.delivery?.token === token) return o;
  }
  return null;
}

/** The parcel sticker, as a picture the shop can print and stick on the package. */
function findDeliveryByPickupToken(token) {
  for (const o of orders.values()) {
    if (o.delivery?.pickupToken === token) return o;
  }
  return null;
}

/**
 * The QR printed on the parcel sticker. This is deliberately a separate secret from the customer's
 * handover QR: this one only says "this boy is walking out of the shop with this parcel", while the
 * customer's one is the proof of handover. Keeping them apart means neither can be used to fake the
 * other. The image is generated here rather than by the browser so the sticker is identical on every
 * device and works even if the till's JavaScript can't reach the server.
 */
app.get('/api/orders/:id/delivery/sticker.png', async (req, res) => {
  const o = orders.get(req.params.id);
  if (!o) return bad(res, 'No such bill');
  if (!o.delivery) return bad(res, 'This bill is not a delivery');
  if (!o.delivery.pickupToken) return bad(res, 'This bill has no package sticker (it was billed before stickers existed)');
  try {
    const image = await QRCode.toBuffer(o.delivery.pickupToken, {
      type: 'png',
      errorCorrectionLevel: 'M',
      margin: 4,
      width: 640,
      color: { dark: '#000000ff', light: '#ffffffff' }
    });
    res.type('png').set('Cache-Control', 'no-store').send(image);
  } catch (err) {
    console.error('Sticker QR failed:', err.message);
    bad(res, 'Could not draw the sticker QR', 500);
  }
});

/** Closes the delivery and tells the customer. Returns a reply for the delivery boy. */
/**
 * Guards the 4-digit code against brute force. A delivery boy sending wrong codes is the only way
 * to attack it, so the limit is per boy: too many misses in a row and he is told to wait. A couple
 * of honest typos is fine, so the allowance is generous; a full sweep of 10,000 codes is not.
 * In-memory only — a restart clears it, which is acceptable for a single-till shop.
 */
const BAD_CODE_LIMIT = 5;
const BAD_CODE_WINDOW_MS = 10 * 60 * 1000;
const BAD_CODE_LOCK_MS = 10 * 60 * 1000;
const codeAttempts = new Map(); // boy phone -> { misses, firstAt, lockedUntil }

function noteBadCode(phone) {
  const now = Date.now();
  const rec = codeAttempts.get(phone);
  if (!rec || now - rec.firstAt > BAD_CODE_WINDOW_MS) {
    codeAttempts.set(phone, { misses: 1, firstAt: now, lockedUntil: 0 });
    return null;
  }
  rec.misses += 1;
  if (rec.misses >= BAD_CODE_LIMIT) {
    rec.lockedUntil = now + BAD_CODE_LOCK_MS;
    rec.firstAt = now;
    rec.misses = 0;
  }
  return rec.lockedUntil > now ? rec.lockedUntil : null;
}

function lockRemainingMs(phone) {
  const rec = codeAttempts.get(phone);
  if (!rec?.lockedUntil) return 0;
  return Math.max(0, rec.lockedUntil - Date.now());
}

function clearBadCodes(phone) {
  codeAttempts.delete(phone);
}

/**
 * Closes a delivery and tells the customer. Shared by the code path and the QR path so the two
 * can't drift apart in what they record or what the customer is told.
 */
/**
 * Writes a handover photo and returns the URL to record on the bill.
 *
 * The file type comes from the bytes, never from a filename or a client-declared type, and the name
 * is built here rather than taken from the request — so a caller cannot choose where the file lands
 * or what it is called. Returns null for anything that is not a real JPG/PNG/WebP, which the callers
 * treat as "no photo", never as a delivered order.
 */
function saveProofPhoto(buf, orderId) {
  const ext = Buffer.isBuffer(buf) ? imageExt(buf) : null;
  if (!ext) return null;
  const bill = /^INV-\d{6}-\d{4,}$/.test(String(orderId || '')) ? orderId : 'unknown';
  const name = `${bill}-${Date.now()}-${crypto.randomBytes(4).toString('hex')}.${ext}`;
  fs.writeFileSync(path.join(PROOF_DIR, name), buf);
  return `/delivery-photos/${name}`;
}

// A photo URL arriving from a client is only ever believed if it looks like one this server issued
// and the file is really there. The name pattern admits no "/" and no "..", so joining it onto
// PROOF_DIR cannot escape the folder.
function proofUrlIsReal(url) {
  const s = String(url || '');
  const prefix = '/delivery-photos/';
  if (!s.startsWith(prefix)) return null;
  const name = s.slice(prefix.length);
  if (!/^INV-\d{6}-\d{4,}-\d+-[\da-f]{8}\.(jpg|png|webp)$/.test(name)) return null;
  return fs.existsSync(path.join(PROOF_DIR, name)) ? s : null;
}

/**
 * Stores a customer's UPI payment screenshot. Same rules as a handover proof — the type comes from
 * the bytes rather than a filename, and the name is built here so nothing a caller sends can choose
 * where the file lands — but in its own folder, named after the WA order it belongs to. Returns null
 * for anything that is not a real JPG/PNG/WebP.
 */
function saveWaPaymentProof(buf, code) {
  const ext = Buffer.isBuffer(buf) ? imageExt(buf) : null;
  if (!ext) return null;
  const order = /^WA-\d{6,8}-\d{1,4}$/.test(String(code || '')) ? code : 'unknown';
  const name = `${order}-${Date.now()}-${crypto.randomBytes(4).toString('hex')}.${ext}`;
  fs.writeFileSync(path.join(WA_PROOF_DIR, name), buf);
  return `/wa-payment-proofs/${name}`;
}

/**
 * What a client is given about a stored handover photo. On the bill it is kept as a record
 * ({url, at, by, via}), but on the wire `proofPhoto` is only ever the URL string, with the
 * bookkeeping in fields of its own. A field called proofPhoto that is sometimes a string and
 * sometimes an object is a trap: the first version of the deliveries dialog used it straight as an
 * <img src> and rendered "[object Object]".
 */
function proofFields(o) {
  const p = o.delivery?.proofPhoto;
  return {
    proofPhoto: p?.url || null,
    proofPhotoAt: p?.at || null,
    proofPhotoVia: p?.via || null
  };
}

  function completeDelivery(o, by, proof) {
    o.delivery.status = 'delivered';
    o.delivery.deliveredAt = new Date().toISOString();
  o.delivery.confirmedBy = by || o.delivery.boy?.name || 'delivery';
  // The photo is the proof of handover, so it goes on before the bill is written. It is optional:
  // a delivery closed by typing the 4-digit code has no picture, and that is recorded honestly
  // rather than being treated as a failure.
  if (proof?.url) {
    o.delivery.proofPhoto = { url: proof.url, at: o.delivery.deliveredAt, by: o.delivery.confirmedBy, via: proof.via || 'unknown' };
  }
  fs.appendFileSync(ORDERS_FILE, `${JSON.stringify(o)}\n`, { mode: 0o600 });
  orders.set(o.id, o);

  const phone = o.customer?.phone;
  if (phone) {
    // The customer is told who handed the order over: the boy assigned to the run, and failing
    // that whoever actually confirmed it, so the name is never blank while the bill records one.
    wa?.sendText(phone, buildDeliveredText(readConfig()?.storeName || 'The shop', {
      orderId: o.id, boyName: o.delivery.boy?.name || o.delivery.confirmedBy
    })).catch((err) => console.error('Delivery confirmation message failed:', err.message));
  }

  return buildDeliveryOkText(o.id);
}

function confirmDeliveryByCode(code, byPhone) {
  if (byPhone) {
    const waitMs = lockRemainingMs(byPhone);
    if (waitMs) return buildDeliveryLockedText(Math.ceil(waitMs / 60000));
  }
  const o = findDeliveryByCode(code);
  if (!o) {
    const until = byPhone ? noteBadCode(byPhone) : null;
    return until ? buildDeliveryLockedText(Math.ceil((until - Date.now()) / 60000)) : buildDeliveryBadCodeText();
  }
  if (o.delivery.status === 'delivered') {
    return buildDeliveryAlreadyText(o.id, new Date(o.delivery.deliveredAt).toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit' }));
  }
  if (o.delivery.status !== 'out') return buildNotPickedUpText(o.id);
  if (byPhone) clearBadCodes(byPhone);
  // The 4-digit code is a complete confirmation in its own right and always has been — the boy
  // reads it out at the door, and that is the proof the shop relies on. A photo is kept as well
  // when one is sent, but its absence must never be a reason to refuse a delivery that really
  // happened; the bill is simply recorded without a photo and the list shows that.
  return completeDelivery(o, o.delivery.boy?.name);
}

/**
 * Called by the bot when a delivery boy hands a job back. Only the boy the job is actually assigned
 * to can decline it, so a message from one boy cannot cancel somebody else's work. Returns a reply
 * for him; the cashier sees the job come back in the till's delivery list.
 */
function declineDelivery(byPhone) {
  const store = readConfig()?.storeName || 'The shop';
  const mine = [...orders.values()]
    .filter((o) => o.delivery?.status === 'packed'
      && normPhone(o.delivery.boy?.phone) === normPhone(byPhone))
    .sort((a, b) => String(a.delivery.packedAt).localeCompare(String(b.delivery.packedAt)));
  // With nothing outstanding, "can't" is nearly always a message about a job that has already moved
  // on, so say which orders he is still expected to collect rather than pretending to accept it.
  if (!mine.length) return buildDeliveryBoyNothingToDeclineText();
  for (const o of mine) {
    o.delivery.status = 'declined';
    o.delivery.declinedAt = new Date().toISOString();
    o.delivery.declinedBy = o.delivery.boy?.name || 'delivery';
    fs.appendFileSync(ORDERS_FILE, `${JSON.stringify(o)}\n`, { mode: 0o600 });
    orders.set(o.id, o);
  }
  return buildDeliveryDeclinedText(store, mine.map((o) => o.id).join(', '));
}

/* ---------- complaints ----------
 * A complaint is recorded first and replied to second. That order is the whole point: the polite
 * wording is a nicety, but losing a customer's complaint because a language model was slow, rate
 * limited or unreachable would be the actual failure. So nothing about the AI is allowed to decide
 * whether a complaint gets saved.
 */
const COMPLAINT_STATUSES = ['open', 'resolved'];

/**
 * How much of a problem a complaint is, and the only one of these three that may be answered without a
 * person reading it first.
 *
 * The shop asked for small problems to be answered automatically, and the reason that is safe to do is
 * this list: 'minor' is the only value that can send anything, and it can only send the wording below,
 * which cannot mention money. Anything the shop calls 'major' or 'serious' is held for a human even if
 * the model is confident, because the cost of wrongly auto-answering a serious complaint — a customer who
 * feels brushed off, food safety, a threat to go to the consumer forum — falls on the shop. Being wrong
 * the other way costs a person a minute of reading.
 */
const COMPLAINT_SEVERITIES = ['minor', 'major', 'serious'];
/** Words that mean a person must look at this, whatever severity was chosen. */
const SERIOUS_TEXT = /\b(lawyer|legal|police|court|consumer forum|fssai|food safety|expose|media|news|hospital|poison|spoiled|spoilt|rotten|mould|mold|infection|injur|adverse)\b/i;

/** Money. A reply that does not mention it cannot commit the shop to any. */
const MONEY_TEXT = /\b(refund|reimburse|credit|discount|free|waive|compensation|money back|₹|rs\.?\s*\d|payment|cash ?back)\b/i;

const newComplaintId = () => {
  // Counted off the existing ones rather than kept in a separate counter file, so a complaint can
  // never end up sharing a number just because a counter was out of step.
  let n = 0;
  for (const c of complaints) {
    const m = /^CMP-(\d+)$/.exec(c.id || '');
    if (m) n = Math.max(n, Number(m[1]));
  }
  return `CMP-${String(n + 1).padStart(4, '0')}`;
};

// The most recent bill this customer paid for, so a complaint arrives with something to look up
// instead of just a phone number. Read from the in-memory orders rather than the file, which is
// append-only and would mean re-reading it on every complaint.
function latestBillFor(phone) {
  const key = normPhone(phone);
  if (!key) return null;
  let best = null;
  for (const o of orders.values()) {
    if (normPhone(o.customer?.phone) !== key) continue;
    if (!best || (o.paidAt || o.createdAt || '') > (best.paidAt || best.createdAt || '')) best = o;
  }
  return best;
}

/**
 * Files a complaint and returns it. Nothing here can throw for an ordinary reason: a complaint that
 * fails to save because of a slightly odd message is worse than one saved with less detail.
 */
function addComplaint({ phone, text, source = 'whatsapp' }) {
  const now = new Date().toISOString();
  const key = normPhone(phone);
  const bill = key ? latestBillFor(key) : null;
  const complaint = {
    id: newComplaintId(),
    phone: key || String(phone || '').slice(0, 20),
    // Carried over from the customer record rather than asked for again, for the same reason the bot
    // stopped asking returning customers their name.
    customerName: (key ? (customers[key]?.name || '') : '').slice(0, 60),
    billId: bill?.id || null,
    // What the bill was worth, copied in rather than looked up on screen. Complaints outlive the bill
    // list, and a replacement or a refund has to land on the right amount weeks later.
    billTotal: bill?.total ?? null,
    text: String(text || '').trim().slice(0, 1000),
    source: ['whatsapp', 'staff'].includes(source) ? source : 'whatsapp',
    status: 'open',
    // Starts as 'major' rather than 'minor', so a complaint nobody has looked at is never answered by the
    // assistant. Being wrong here means a person reads a message that could have gone out by itself; being
    // wrong the other way means the shop speaks for itself about something it has not read.
    severity: 'major',
    handledBy: '',
    note: '',
    // Set once the customer has actually been sent something. Without it, "no reply sent" is a warning
    // that can never fire, because a complaint filed on WhatsApp always gets a reply of some kind.
    //
    // It records that something was SENT, not that anything was FIXED. A complaint is only ever closed by
    // a person writing down what they did.
    repliedAt: null,
    // ---------- the assistant's side of the conversation ----------
    // AWAITING_SHOP until somebody marks the complaint minor. The assistant never speaks first: the shop
    // decides the scope, the assistant works inside it.
    aiState: AI_STATE.AWAITING_SHOP,
    // How many replies the assistant has sent. Compared against MAX_AI_TURNS so it cannot keep going.
    aiTurns: 0,
    // Everything said both ways, because "the bot talked to them twice and gave up" is not something the
    // shop can be told on the screen, and a customer disputing what was said needs the record.
    transcript: [],
    // Why it was handed to a person, as one of the reasons in complaint-ai.js, and when.
    aiEscalation: null,
    aiEscalatedAt: null,
    createdAt: now,
    updatedAt: now,
    resolvedAt: null
  };
  complaints.push(complaint);
  saveComplaints();
  return complaint;
}

/** Applies a staff change to a complaint. Only the fields a person can meaningfully set. */
function updateComplaint(id, patch) {
  const c = complaints.find((x) => x.id === id);
  if (!c) return null;
  if (patch.status !== undefined) {
    if (!COMPLAINT_STATUSES.includes(patch.status)) return { error: 'That is not a valid status' };
    // A complaint cannot be closed without saying what was done. The note is the only record of what
    // happened, so a blank "resolved" is refused here rather than in the dialog: anything posting to
    // this endpoint — the shop screen, a script, a future phone app — would otherwise be able to
    // close one with nothing written down, and that is exactly how the same customer gets argued
    // with next week about something already settled.
    //
    // A note already on file does not count. Reopening keeps it as history, but resolving again means
    // something new happened and that has to be written down.
    if (patch.status === 'resolved') {
      const note = String(patch.note !== undefined ? patch.note : '').trim();
      if (note.length < 3) return { error: 'Say what was done about it, even one line — that note is the record' };
    }
    c.status = patch.status;
    c.resolvedAt = patch.status === 'resolved' ? new Date().toISOString() : null;
    // Closing or reopening a complaint is a person taking charge of it, so the assistant steps aside both
    // ways. A reopened complaint goes back to waiting for the shop rather than straight back to talking: it
    // was reopened because the previous answer was not good enough, and the shop has not said it is minor
    // again.
    if (c.aiState !== AI_STATE.ESCALATED) {
      c.aiState = patch.status === 'open' && aiMayReply(c.severity) ? AI_STATE.ACTIVE : AI_STATE.AWAITING_SHOP;
    }
  }
    if (patch.note !== undefined) c.note = String(patch.note || '').trim().slice(0, 1000);
    if (patch.handledBy !== undefined) c.handledBy = str(patch.handledBy, 60);
    if (patch.severity !== undefined) {
      const wanted = String(patch.severity).toLowerCase();
      if (!COMPLAINT_SEVERITIES.includes(wanted)) return { error: 'That is not a valid severity' };
      c.severity = wanted;
      // The scope the shop chose is also the gate on the assistant. Raising it takes the assistant away
      // mid-conversation: somebody marking a complaint serious has just said they will deal with it
      // themselves, and a bot that keeps talking after that is how a shop's number stops being trusted.
      if (c.aiState !== AI_STATE.ESCALATED) {
        c.aiState = aiMayReply(wanted) && c.status === 'open' ? AI_STATE.ACTIVE : AI_STATE.AWAITING_SHOP;
      }
    }
    c.updatedAt = new Date().toISOString();
    saveComplaints();
    return c;
  }

// The wording a customer gets when no AI is configured or the AI cannot be reached. It has to stand
// on its own: apologise, give the reference, say a person will call. It must not promise money,
// because nothing here is allowed to commit the shop to a refund.
const complaintFallbackText = (c, storeName) => [
  `We are sorry about this, and we have noted it down.`,
  ``,
  `Your complaint reference is ${c.id}. Please keep it — the shop can look it up straight away.`,
  ``,
  `${storeName} will call you back shortly to sort it out.`
].join('\n');

/**
 * One call to whichever AI host is configured, returning the model's text or null.
 *
 * Every AI feature goes through here, so the provider switch is one decision in one place: a Gemini key
 * and an OpenRouter key take the same path from the caller's point of view. It resolves the config on
 * every call rather than caching, because the owner can change the key from the settings screen and
 * expects the next tap to use it.
 *
 * It never throws. A missing key, a refused key, a bad day at the provider and a slow network all mean
 * the same thing to every caller — no AI, fall back to a person — so that is what it returns.
 *
 * @returns {Promise<string|null>} the model's answer, or null
 */
async function aiChat({ system = '', user = '', images = [], json = false, maxTokens = 300, temperature = 0.3, timeoutMs = 10000 } = {}) {
  const ai = readConfig()?.ai;
  const resolved = resolveAi(ai);
  if (!resolved.configured) return null;
  // Google retires model names and the newest is sometimes briefly overloaded, and either one used to
  // take the whole AI surface down because every feature funnels through a single name. Gemini therefore
  // walks a short list — the configured name first, then known-good fallbacks — and only gives up when
  // none answers. An OpenAI-compatible host has one model, so its list is that one.
  const candidates = resolved.provider === 'gemini' ? geminiModelCandidates(ai) : [resolved.model];
  for (const model of candidates) {
    const req = buildRequest({ ai: { ...ai, model }, system, user, images, json, maxTokens, temperature });
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(req.url, {
        method: 'POST',
        headers: req.headers,
        signal: controller.signal,
        body: JSON.stringify(req.body)
      });
      if (res.ok) {
        // An empty answer is a real answer (the model declined); another model name will not change it.
        return parseResponse(req.provider, await res.json()) || null;
      }
      // The status is worth a line because a 400 and a 429 need different fixes; the body is not, because
      // a provider error can echo the request back and the request can carry a key in its URL.
      console.error('AI request declined:', req.provider, model, res.status);
      // 404 (name retired) and 503 (name overloaded) are about the name, so the next one may work.
      if (res.status !== 404 && res.status !== 503) return null;
    } catch (err) {
      console.error('AI unavailable:', req.provider, model, err.message);
      // A model that timed out or could not be reached is worth skipping for the next name; a request the
      // provider plainly refused is not a network problem and should not be hammered down the list.
      if (err.name !== 'AbortError' && !/fetch failed|network|ENOTFOUND|ECONN/i.test(err.message)) return null;
    } finally {
      clearTimeout(timer);
    }
  }
  return null;
}

/**
 * Transcribes a WhatsApp voice note, and returns null if that is not possible.
 *
 * Two engines, tried in order. Gemini first, when the shop has a Gemini key: its model can hear audio
 * directly, so the same key that reads photos and writes replies also transcribes — no second service to
 * install and, importantly, no dependence on the till's CPU, which on a low-power shop machine is far too
 * slow to run Whisper. Only if that is unavailable does this fall back to a locally-run Whisper server,
 * which keeps the audio on the shop's own network. A failure either way is an ordinary outcome, so this
 * returns null and lets the caller answer the customer with words rather than leaving the note on read.
 *
 * @param {Buffer} audio the OGG/Opus bytes off WhatsApp
 * @returns {Promise<string|null>} the transcript, or null
 */
const VOICE_TRANSCRIBE_PROMPT =
  'You transcribe voice messages sent to a grocery shop. Write down exactly what the customer said, in ' +
  'the language they spoke (English, Hindi, Bengali or a mix), with no translation, no commentary, no ' +
  'quotes and no formatting. If the message is silence or noise, reply with an empty line.';

async function aiTranscribe(audio, mimeType = 'audio/ogg') {
  const cfg = readConfig() || {};
  if (!Buffer.isBuffer(audio) || !audio.length) return null;
  // WhatsApp sends "audio/ogg; codecs=opus"; Gemini wants the bare type, so the parameter is dropped.
  const mime = String(mimeType || 'audio/ogg').split(';')[0].trim() || 'audio/ogg';

  // Gemini hears the audio directly: an inlineData part carries it exactly as it carries a photo.
  if (supportsAudioInput(cfg.ai)) {
    const text = await aiChat({
      system: VOICE_TRANSCRIBE_PROMPT,
      user: 'Transcribe this voice message.',
      images: [{ mimeType: mime, base64: audio.toString('base64') }],
      maxTokens: 800,
      temperature: 0,
      timeoutMs: 30000
    });
    if (text) return text;
  }

  // Fall back to a Whisper server on the shop's own machine, if one is switched on.
  const stt = resolveStt(cfg.voice);
  if (!stt.configured) return null;
  const req = buildTranscribeRequest({ stt, audio, mimeType: mime });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30000);
  try {
    const res = await fetch(req.url, { method: 'POST', headers: req.headers, signal: controller.signal, body: req.body });
    if (!res.ok) {
      console.error('STT request declined:', res.status);
      return null;
    }
    return parseTranscription(await res.json()) || null;
  } catch (err) {
    console.error('STT unavailable:', err.message);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Asks the model for one turn of the triage reply, and returns null if that is not possible.
 *
 * Deliberately the least important part of the flow. The rules live in buildTriagePrompt() in
 * complaint-ai.js, and the part that is not negotiable — no money, no claimed action — lives in
 * screenReply(), which runs on the answer before anything is sent. A prompt is advice to a model; a
 * screen is a gate.
 *
 * It sees this one complaint and nothing about any other. The transcript is trimmed to the last few turns
 * because a long one costs more and makes the model worse at the one job it has.
 *
 * @param {object} complaint the complaint being talked about
 * @returns {Promise<string|null>} the wording, or null so the caller escalates
 */
async function aiComplaintTurn(complaint) {
  // A customer mid-conversation should not be left staring at a typing bubble because a provider is
  // having a bad day. Ten seconds, then a person.
  const text = await aiChat({
    system: buildTriagePrompt({
      storeName: readConfig()?.storeName || 'The shop',
      complaint,
      history: complaint.transcript || []
    }),
    maxTokens: 220,
    temperature: 0.3,
    timeoutMs: 10000
  });
  // A provider can answer 200 with an empty or refusal-shaped message. Anything that thin is worse than
  // nothing, because it would be sent and read by a customer as the shop giving up mid-sentence.
  if (!text || text.length < 12) return null;
  return text.slice(0, 900);
}

/**
 * Asks the AI what should be done about a complaint, for the shop to accept or ignore.
 *
 * This is deliberately NOT allowed to change anything. It returns text and nothing else, and there is
 * no code path from its output to a customer balance, a refund, a stock level or a complaint's status.
 * That is the whole design, and it is the reason this can safely be pointed at text a stranger typed:
 * a complaint is attacker-controlled input, and a model asked to "resolve" one is one bad prompt away
 * from issuing a refund. So the AI's job stops at a suggestion a human has to agree with.
 *
 * The wording is also constrained to the boring cases. The model is told to say when a person must
 * look at it, and `needsHuman` is set from that plus a check for any concrete promise, because a
 * confident "offer a ₹50 credit" is exactly the output that must not be one tap from happening.
 */
async function aiResolutionSuggestion(complaint) {
  const system =
    'You advise the owner of a small neighbourhood shop in India on a customer complaint. ' +
    'Reply with JSON only, no other text, in exactly this shape:\n' +
    '{"summary":"one line, what the customer is saying","category":"damaged|missing|wrong_item|' +
    'late|quality|quantity|other","severity":"low|medium|high",' +
    '"suggestion":"one short sentence on what the shop should do",' +
    '"noteDraft":"one sentence the owner can save as the resolution note",' +
    '"needsHuman":true|false}\n' +
    'Rules, all of them firm:\n' +
    '- You are advising only. You cannot promise, issue or authorise any money, refund, ' +
    'replacement or discount, and neither can your suggestion be acted on without the owner.\n' +
    '- Keep "suggestion" to things that cost nothing: replacing from stock, checking a bill, ' +
    'apologising, calling the customer, checking a weight, re-delivering.\n' +
    '- Set "needsHuman" to true whenever money is involved in any way, the customer is angry ' +
    'or threatening legal action, the complaint is about safety (spoiled food, a foreign object), ' +
    'or you are not confident. When in doubt, true.\n' +
    '- "noteDraft" must be phrased as something the owner did or decided, and must not ' +
    'contain a figure of money unless it was in the customer\'s own message.\n' +
    '- Plain text inside the JSON. No markdown.';
  const user =
    `Shop: ${readConfig()?.storeName || 'The shop'}\n` +
    `Customer name: ${complaint.customerName || 'not known'}\n` +
    `Bill number: ${complaint.billId || 'not known'}\n` +
    `Bill total: ${complaint.billTotal != null ? 'Rs ' + complaint.billTotal : 'not known'}\n` +
    `Items on the bill: ${(complaint.items || []).slice(0, 12).join(', ') || 'not known'}\n\n` +
    `The customer wrote: ${complaint.text}`;

  // Asked for JSON so the screen can show a suggestion and a ready-to-edit note side by side, rather
  // than asking somebody to parse a paragraph.
  const raw = await aiChat({ system, user, json: true, maxTokens: 300, temperature: 0.2, timeoutMs: 10000 });
  if (!raw) return null;

  // firstJson tolerates the fences and stray sentences providers still add around a JSON answer.
  const out = firstJson(raw);
  if (!out || typeof out !== 'object') return null;

  const one = (v, n) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, 300);
  const suggestion = one(out.suggestion, 200);
  if (!suggestion) return null;

  // Anything that reads like a commitment gets escalated to a person, whatever the model claimed.
  // Being wrong here is cheap: a human looks at it. Being wrong the other way is not.
  const risky = /\b(refund|reimburse|credit|discount|free|waive|compensation|₹|rs\.?\s*\d|payment)/i;
  const angry = /\b(lawyer|legal|police|court|consumer forum|expose|media|news|refund my|money back)/i;
  const needsHuman = out.needsHuman === true
    || out.needsHuman === 'true'
    || risky.test(suggestion)
    || angry.test(complaint.text || '')
    || String(out.severity || '').toLowerCase() === 'high';

  return {
    summary: one(out.summary, 160),
    category: ['damaged', 'missing', 'wrong_item', 'late', 'quality', 'quantity', 'other']
      .includes(String(out.category)) ? out.category : 'other',
    severity: ['low', 'medium', 'high'].includes(String(out.severity)) ? out.severity : 'low',
    suggestion,
    noteDraft: one(out.noteDraft, 200),
    // The UI shows this as a warning and still renders the suggestion, because hiding it would just
    // mean the owner retypes the same thing from scratch.
    needsHuman,
    suggestedAt: new Date().toISOString(),
    // Recorded so the screen can say where it came from. An unsigned suggestion would be
    // indistinguishable from something the owner wrote.
    source: 'ai'
  };
}

  app.get('/api/complaints', (req, res) => {
    const want = String(req.query.status || '').trim();
    let list = complaints.slice();
    if (want === 'open' || want === 'resolved') list = list.filter((c) => c.status === want);
    // Newest first is what the shop wants on screen: whatever came in while they were away.
    list.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
    const open = complaints.filter((c) => c.status === 'open').length;
    // The reason is written out here, from the same table the rules use, rather than the browser holding
    // its own copy of what each reason means. Two copies of this is how a screen ends up saying a
    // complaint was handed over "for safety" when the shop called it for an angry customer.
    const withText = list.slice(0, 300).map((c) => ({
      ...c,
      escalationText: c.aiEscalation ? ESCALATION_TEXT(c.aiEscalation) : null
    }));
    res.json({ total: list.length, open, resolved: complaints.length - open, complaints: withText });
  });

app.get('/api/complaints/:id', (req, res) => {
  const c = complaints.find((x) => x.id === req.params.id);
  if (!c) return bad(res, 'Complaint not found', 404);
  res.json({ complaint: c });
});

/**
 * Asks the AI what should be done about one complaint, and stores the suggestion on it.
 *
 * Note what this route cannot do: it does not change status, does not write a note, and does not touch
 * any balance. It only ever attaches a suggestion. Resolving stays a separate, PIN-gated, deliberately
 * slow action that needs a human to type what was actually done. If someone later wires an "auto
 * resolve" button to this, the complaint would still be open and no money would have moved.
 */
  /**
   * Sends a reply the shop wrote itself, to the customer, on WhatsApp.
   *
   * This is the till doing the thing a shopkeeper would do with their own phone: read the complaint, type
   * an answer, send it. It is behind the same PIN as everything else, because it puts the shop's name to a
   * customer and a till that is signed in is not the same as a person who has thought about it.
   *
   * Two things it deliberately does not do. It does not screen the words: the rules about money and
   * promises exist to stop a *model* from inventing them, and the owner typing "we have refunded you" is a
   * decision, not a hallucination. And it does not resolve anything — the complaint stays open and the
   * note still has to be written, because a customer being answered and a customer being helped are two
   * different things and only the shop knows which one happened.
   *
   * The order matters: send first, then record. A record written beforehand would claim a message went out
   * that never did, and that is the exact thing a dispute gets settled on.
   */
  app.post('/api/complaints/:id/reply', async (req, res) => {
    const c = complaints.find((x) => x.id === req.params.id);
    if (!c) return bad(res, 'Complaint not found', 404);
    if (c.status !== 'open') return bad(res, 'That one is already resolved');
    const text = str(req.body?.text, 1000).trim();
    if (!text) return bad(res, 'Write the reply first');
    const phone = normPhone(c.phone);
    if (!phone) return bad(res, 'This complaint has no phone number to reply to');
    if (!wa) return res.status(502).json({ error: 'WhatsApp is not connected', sent: false });
    const sent = await wa.sendText(phone, text);
    if (!sent) return res.status(502).json({ error: 'Could not send — WhatsApp is not connected', sent: false });
    complaintConversation.staffSaid(c, text);
    // The words themselves are in the transcript on the complaint; copying them here as well would push a
    // customer's message into every backup of the audit file. Who sent it, and how long it was, is what
    // makes the transcript entry trustworthy.
    audit.record('complaint.replied', {
      at: actorOf(req), id: c.id, channel: 'whatsapp', characters: text.length, hadNumber: true
    });
    res.json({ complaint: c, sent: true });
  });

  app.post('/api/complaints/:id/suggest', async (req, res) => {
  const c = complaints.find((x) => x.id === req.params.id);
  if (!c) return bad(res, 'Complaint not found', 404);
  if (c.status !== 'open') return bad(res, 'That one is already resolved');
  const suggestion = await aiResolutionSuggestion(c);
  if (!suggestion) {
    // No AI configured, or it could not be reached. Not an error worth shouting about: the owner
    // resolves the complaint by hand, exactly as before this existed.
    return res.json({ suggestion: null, reason: 'No AI available — sort this one out by hand' });
  }
  c.suggestion = suggestion;
  c.updatedAt = new Date().toISOString();
  saveComplaints();
  // Recorded because a suggestion on a screen is an instruction somebody may act on. If money later
  // moves on this complaint, "the AI suggested it" needs to be a checkable fact, not a memory.
  audit.record('complaint.suggested', { at: actorOf(req), id: c.id, category: suggestion.category, severity: suggestion.severity, needsHuman: suggestion.needsHuman });
  broadcastAdmin({ type: 'complaint', complaint: c });
  res.json({ suggestion });
});

app.post('/api/complaints', async (req, res) => {
  const b = req.body || {};
  const text = str(b.text, 1000).trim();
  if (!text) return bad(res, 'Say what the complaint is about');
  const complaint = addComplaint({ phone: b.phone, text, source: 'staff' });
  broadcastAdmin({ type: 'complaint', complaint });
  // What the shop could read out to them. Fixed words rather than generated ones, for the same reason the
  // WhatsApp acknowledgement is: this is said to a real customer about a problem nobody has read yet. The
  // complaint is already saved, so nothing here can cost anything but this one field.
  const store = readConfig()?.storeName || 'The shop';
  const suggestedReply = complaintFallbackText(complaint, store);
  res.status(201).json({ complaint, suggestedReply });
});

app.patch('/api/complaints/:id', (req, res) => {
  const r = updateComplaint(req.params.id, req.body || {});
  if (!r) return bad(res, 'Complaint not found', 404);
  if (r.error) return bad(res, r.error);
  // Closing a complaint is a judgement about a customer, made by a person, and the note says what was
  // done. It is recorded because "we said it was resolved" and what actually happened are exactly the
  // two things that diverge when nobody is watching. The complaint text is not copied in — it is
  // already stored on the complaint, and duplicating it here would push customer words into every
  // backup of the audit file.
  if (req.body?.status === 'resolved') {
    audit.record('complaint.resolved', {
      at: actorOf(req), id: r.id, by: r.handledBy || 'unknown', bill: r.billId, noteLength: String(r.note || '').length
    });
  } else if (req.body?.status === 'open') {
    audit.record('complaint.reopened', { at: actorOf(req), id: r.id });
  }
  broadcastAdmin({ type: 'complaint', complaint: r });
  res.json({ complaint: r });
});

/**
 * The words a customer gets when a person takes over.
 *
 * Fixed text, written here rather than generated, for the same reason the acknowledgement is: this is the
 * one message the shop cannot afford to have a model improvise. It promises a person and a call, which is
 * exactly what is about to be true, and nothing else. It goes through screenReply like any other wording
 * anyway, because a guarantee that depends on nobody ever editing this string is not a guarantee.
 */
const complaintHandoffText = (c, storeName) => [
  `We are sorry to leave you waiting on this one.`,
  ``,
  `${storeName} is putting a person on it now. They will call you about your complaint ${c.id}.`,
  ``,
  `Please keep that reference. Nothing has been settled yet — a person will decide what happens.`
].join('\n');

/** The shop is told which complaints want them, rather than a list of codes. */
const ESCALATION_TEXT = (reason) => REASON_TEXT[reason] || 'A person needs to answer this one';

/**
 * The complaint conversation, built once.
 *
 * It lives in its own file so the rules about what reaches a customer can be tested without a server, a
 * port or a phone. Everything it needs is handed in here: the complaint records, how to write them back,
 * how to tell the till something changed, the audit log, and the one call that generates words. Nothing
 * in it reaches a customer by itself — it returns text, and the WhatsApp side is what sends it.
 */
const complaintConversation = createComplaintConversation({
  list: () => complaints,
  normalise: normPhone,
  store: saveComplaints,
  onChange: (c) => broadcastAdmin({ type: 'complaint', complaint: c }),
  audit: (event, fields) => audit.record(event, fields),
  askModel: (c) => aiComplaintTurn(c),
  storeName: () => readConfig()?.storeName || 'The shop',
  fallbackText: complaintFallbackText,
  handoffText: complaintHandoffText
});

/* ---------- customers ---------- */
app.get('/api/customers/lookup', (req, res) => {
  const phone = normPhone(req.query.phone);
  res.json({ customer: phone ? customers[phone] || null : null });
});

app.get('/api/customers', (req, res) => {
  const q = str(req.query.q, 60).toLowerCase();
  let list = Object.values(customers);
  if (q) list = list.filter((c) => c.name.toLowerCase().includes(q) || c.phone.includes(q));
  list.sort((a, b) => b.lastVisit.localeCompare(a.lastVisit));
  res.json({ total: list.length, customers: list.slice(0, 500) });
});

/* ---------- daily sales summary + achievements ---------- */
// ?date=YYMMDD (same format as a bill number's date part); defaults to today in POS_TZ.
app.get('/api/stats/daily', (req, res) => {
  const day = /^\d{6}$/.test(req.query.date || '') ? req.query.date : dayKey();
  const dayOrders = [...orders.values()].filter((o) => dayKey(new Date(o.paidAt)) === day);
  const stats = computeDailyStats(dayOrders);
  const achievements = computeAchievements(stats);
  const stock = computeStockPosition(products);
  res.json({ date: day, ...stats, achievements, ...stock });
});

/* ---------- reports over a date range (what is selling, and what it earns) ---------- */

// YYMMDD compares correctly as a string, so lexicographic order is chronological order.
const isDay = (s) => /^\d{6}$/.test(String(s || ''));

// Bills are bucketed by their paid date in POS_TZ. A bill with an unusable timestamp is skipped
// rather than filed under today, which would quietly inflate one day's numbers.
function ordersInRange(from, to) {
  return [...orders.values()].filter((o) => {
    const t = new Date(o.paidAt).getTime();
    if (Number.isNaN(t)) return false;
    const k = dayKey(new Date(t));
    return k >= from && k <= to;
  });
}

app.get('/api/stats/range', (req, res) => {
  // Default to the last 7 days: a week is the shortest period that shows a trend without
  // being dominated by one quiet Sunday.
  const to = isDay(req.query.to) ? req.query.to : dayKey();
  const from = isDay(req.query.from) ? req.query.from : dayKey(new Date(Date.now() - 6 * 86400000));
  if (from > to) return bad(res, '"from" must be on or before "to"');
  if (to - from > 36500) return bad(res, 'Range is too long; pick a period under 100 years');

  const picked = ordersInRange(from, to);
  const byDay = new Map();
  for (const o of picked) {
    const k = dayKey(new Date(o.paidAt));
    if (!byDay.has(k)) byDay.set(k, []);
    byDay.get(k).push(o);
  }
  // Days with no sales are left out of the trend rather than reported as zero-revenue days,
  // so the chart shows when the shop was open, not padding.
  const days = [...byDay.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([date, os]) => ({ date, ...computeDailyStats(os) }));

  const overall = computeDailyStats(picked);
  res.json({ from, to, days: days.length, overall, byDay: days, ...overall });
});

/* ---------- CSV export ---------- */
function sendCsv(res, filename, body) {
  // Fixed filename prefix + validated date: no user text reaches the header, so no header injection.
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.send(body);
}

app.get('/api/export/:kind.csv', (req, res) => {
  const to = isDay(req.query.to) ? req.query.to : dayKey();
  const from = isDay(req.query.from) ? req.query.from : dayKey(new Date(Date.now() - 6 * 86400000));
  if (from > to) return bad(res, '"from" must be on or before "to"');

  const picked = ordersInRange(from, to);
  const byDay = new Map();
  for (const o of picked) {
    const k = dayKey(new Date(o.paidAt));
    if (!byDay.has(k)) byDay.set(k, []);
    byDay.get(k).push(o);
  }
  const suffix = `${from}-${to}`;
  switch (req.params.kind) {
    case 'orders':
      return sendCsv(res, `bills-${suffix}.csv`, buildOrdersCsv(picked));
    case 'products': {
      const items = computeDailyStats(picked).items;
      return sendCsv(res, `product-sales-${suffix}.csv`, buildProductsCsv(items));
    }
    case 'days':
      return sendCsv(res, `daily-summary-${suffix}.csv`, buildDaysCsv(
        [...byDay.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([date, os]) => ({ date, ...computeDailyStats(os) }))
      ));
    default:
      return bad(res, 'Unknown report. Use orders, products or days');
  }
});

/* ---------- product images (kept on this server's disk, shared by every device) ---------- */
app.use('/uploads', express.static(UPLOAD_DIR, { maxAge: '30d', immutable: true }));

// decide the file type from the bytes themselves, never from what the client claims
function imageExt(buf) {
  if (buf.length < 12) return null;
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpg';
  if (buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png';
  if (buf.subarray(0, 4).toString('ascii') === 'RIFF' && buf.subarray(8, 12).toString('ascii') === 'WEBP') return 'webp';
  return null;
}

app.post('/api/upload', express.raw({ type: () => true, limit: '2mb' }), (req, res) => {
  const buf = req.body;
  const ext = Buffer.isBuffer(buf) ? imageExt(buf) : null;
  if (!ext) return bad(res, 'Send a JPG, PNG or WebP image (max 2 MB)');
  const name = `${Date.now()}-${crypto.randomBytes(4).toString('hex')}.${ext}`;
  fs.writeFileSync(path.join(UPLOAD_DIR, name), buf);
  res.json({ url: `/uploads/${name}` });
});

app.delete('/api/upload/:name', (req, res) => {
  const name = req.params.name;
  if (!/^[\w-]+\.(jpg|png|webp)$/.test(name)) return bad(res, 'Bad file name');
  fs.rm(path.join(UPLOAD_DIR, name), { force: true }, () => res.json({ ok: true }));
});

/* ---------- AI ----------
 * Three ways to turn something a shop already has into product records: a photo, a slip, or a sentence.
 * Every one of them returns a DRAFT and writes nothing. The shop accepts what is right and edits what is
 * not, and the ordinary product endpoints do the saving — so a model that hallucinates a price cannot put
 * one on a shelf, and the whole feature is safe to try.
 *
 * All of these sit behind the PIN like every other /api route (see auth.js). That matters more here than
 * elsewhere: the scan endpoints spend the owner's money on their key, and the config endpoint holds it.
 */

/** The shop's own categories, so a reading reuses the words the reports already group by. */
const aiCategories = () => [...new Set(products.map((p) => p.category).filter(Boolean))].slice(0, 30);

// A photo off a phone is bigger than a product thumbnail. It is compressed in the browser first, so this
// ceiling is only a backstop; over it, the same friendly 413 the delivery photos give.
const aiImageBody = express.raw({ type: () => true, limit: '6mb' });
const readAiImageBody = (req, res, next) => aiImageBody(req, res, (err) => {
  if (!err) return next();
  if (err.type === 'entity.too.large' || err.status === 413) {
    return bad(res, 'That photo is over the 6 MB limit. Send a smaller one.', 413);
  }
  next(err);
});

/** The raw image as base64 with its mime type, or null. */
function aiImage(req) {
  const buf = req.body;
  const ext = Buffer.isBuffer(buf) ? imageExt(buf) : null;
  if (!ext) return null;
  return { base64: buf.toString('base64'), mimeType: ext === 'jpg' ? 'image/jpeg' : `image/${ext}` };
}

/** Whether AI is on, and which host it will use. Never includes the key. */
app.get('/api/ai/status', (_req, res) => res.json({ ...describeAi(readConfig()?.ai) }));
/**
 * Points the AI at a provider and a key, or clears it.
 *
 * The key is written here and read nowhere else but the servers that make the call; publicView() strips
 * `ai` from every response, so the browser can learn `configured` but never the key. Changing the key is
 * a consequence worth an audit line even though it is not a money action, because it decides where the
 * shop's text and photos are sent.
 */
app.post('/api/ai/config', (req, res) => {
  const b = req.body || {};
  const cfg = readConfig() || {};
  const prev = cfg.ai && typeof cfg.ai === 'object' ? cfg.ai : {};

  if (b.clear === true) {
    delete cfg.ai;
  } else {
    const ai = { ...prev };
    const provider = String(b.provider ?? '').trim().toLowerCase();
    if (['gemini', 'openai', 'openrouter'].includes(provider)) ai.provider = provider;
    else delete ai.provider; // '' means "detect it from the key"
    // An empty key field means "leave the saved one alone", so re-saving the model does not erase the key.
    const key = str(b.apiKey, 400);
    if (key) ai.apiKey = key;
    const model = str(b.model, 120);
    if (model) ai.model = model; else delete ai.model;
    const baseUrl = str(b.baseUrl, 300).replace(/\/+$/, '');
    if (baseUrl) ai.baseUrl = baseUrl; else delete ai.baseUrl;
    if (Object.keys(ai).length) cfg.ai = ai; else delete cfg.ai;
  }

  writeJson(CONFIG_FILE, cfg);
  audit.record('ai.config', {
    at: actorOf(req),
    cleared: !cfg.ai,
    ...describeAi(cfg.ai)
  });
  res.json({ ...describeAi(cfg.ai) });
});

/* ---------- voice ordering (local Whisper speech-to-text) ---------- */

/** Whether voice ordering is on, and where it would listen. Never includes the STT key. */
app.get('/api/voice/status', (_req, res) => {
  const cfg = readConfig();
  const stt = resolveStt(cfg?.voice);
  // Which engine a voice note would actually be heard with: Gemini when a key is set (the shop's own
  // machine cannot run Whisper fast enough), otherwise a local Whisper server.
  const engine = supportsAudioInput(cfg?.ai) ? 'gemini' : (stt.configured ? 'whisper' : null);
  res.json({ enabled: stt.configured, baseUrl: stt.baseUrl, model: stt.model, hasKey: Boolean(stt.key), engine });
});

/**
 * Switches voice ordering on or off and points it at a Whisper server.
 *
 * The audio never leaves the shop, so the URL is almost always localhost — but it is a real setting
 * because a shop may run Whisper on a spare machine on the LAN. `enabled` is the switch that matters:
 * the whole voice flow stays dark until the owner turns it on, exactly like the AI key.
 */
app.post('/api/voice/config', (req, res) => {
  const b = req.body || {};
  const cfg = readConfig() || {};
  const prev = cfg.voice && typeof cfg.voice === 'object' ? cfg.voice : {};

  if (b.clear === true) {
    delete cfg.voice;
  } else {
    const voice = { ...prev };
    voice.enabled = b.enabled === true;
    const baseUrl = str(b.baseUrl, 300).replace(/\/+$/, '');
    if (baseUrl) voice.baseUrl = baseUrl; else delete voice.baseUrl;
    const model = str(b.model, 120);
    if (model) voice.model = model; else delete voice.model;
    // As with the AI key, an empty field means "leave the saved key alone" so re-saving the URL does not
    // wipe it.
    const key = str(b.apiKey, 400);
    if (key) voice.apiKey = key;
    if (!voice.enabled && !voice.baseUrl && !voice.model && !voice.apiKey) delete cfg.voice; else cfg.voice = voice;
  }

  writeJson(CONFIG_FILE, cfg);
  const stt = resolveStt(cfg.voice);
  const engine = supportsAudioInput(cfg.ai) ? 'gemini' : (stt.configured ? 'whisper' : null);
  audit.record('voice.config', {
    at: actorOf(req),
    cleared: !cfg.voice,
    enabled: stt.configured,
    engine,
    baseUrl: stt.baseUrl,
    model: stt.model
  });
  res.json({ enabled: stt.configured, baseUrl: stt.baseUrl, model: stt.model, hasKey: Boolean(stt.key), engine });
});

/** A photo of products, a shelf, or a supplier's list, into draft products. */
app.post('/api/ai/scan-products', readAiImageBody, async (req, res) => {
  if (!resolveAi(readConfig()?.ai).configured) return bad(res, 'No AI key is set. Add one in Settings first.', 400);
  const image = aiImage(req);
  if (!image) return bad(res, 'Send a JPG, PNG or WebP image');

  const text = await aiChat({
    system: buildScanProductsPrompt({ storeName: readConfig()?.storeName || 'The shop', categories: aiCategories() }),
    user: 'Read the products in this photo and reply with the JSON.',
    images: [image],
    json: true,
    maxTokens: 2000,
    temperature: 0.2,
    timeoutMs: 45000
  });
  if (text == null) return bad(res, 'The AI could not read that photo. Try a clearer one, or add the item by hand.', 502);

  const drafts = parseProductDrafts(text);
  res.json({ products: drafts, found: drafts.length });
});

/** One sentence — typed or dictated — into a draft product. */
app.post('/api/ai/product-from-text', async (req, res) => {
  if (!resolveAi(readConfig()?.ai).configured) return bad(res, 'No AI key is set. Add one in Settings first.', 400);
  const text = str(req.body?.text, 400);
  if (!text) return bad(res, 'Type what the product is first');

  const answer = await aiChat({
    system: buildProductFromTextPrompt({ storeName: readConfig()?.storeName || 'The shop', categories: aiCategories() }),
    user: text,
    json: true,
    maxTokens: 400,
    temperature: 0.2,
    timeoutMs: 20000
  });
  if (answer == null) return bad(res, 'The AI could not read that. Try typing it a little differently.', 502);

  const product = parseProductFromText(answer);
  if (!product) return bad(res, 'The AI did not find a product in that. Try naming the item.', 502);
  res.json({ product });
});

/** A handwritten slip, a weighing ticket or a supplier bill, into line items and a written total. */
app.post('/api/ai/read-slip', readAiImageBody, async (req, res) => {
  if (!resolveAi(readConfig()?.ai).configured) return bad(res, 'No AI key is set. Add one in Settings first.', 400);
  const image = aiImage(req);
  if (!image) return bad(res, 'Send a JPG, PNG or WebP image');

  const text = await aiChat({
    system: buildSlipPrompt({ storeName: readConfig()?.storeName || 'The shop' }),
    user: 'Read this slip and reply with the JSON.',
    images: [image],
    json: true,
    maxTokens: 2000,
    temperature: 0.1,
    timeoutMs: 45000
  });
  if (text == null) return bad(res, 'The AI could not read that slip. Try a clearer photo.', 502);

  const slip = parseSlip(text);
  if (!slip) return bad(res, 'The AI did not find a slip in that photo.', 502);
  res.json({ slip });
});

/* ---------- delivery proof photos ---------- */
app.use('/delivery-photos', express.static(PROOF_DIR, { maxAge: '30d', immutable: true }));

// Customer UPI screenshots live in their own namespace for the same reasons as handover proofs: a
// banking screenshot belongs to one order and must never be reachable from the product-photo routes.
app.use('/wa-payment-proofs', express.static(WA_PROOF_DIR, { maxAge: '30d', immutable: true }));

// Separate from the product-photo upload on purpose: a proof is tied to one bill, it may show a
// customer's home, and it must not be deletable through the product-photo endpoint.
// The raw body parser runs before the route handler, so an over-sized photo never reaches the checks
// inside the handler — it throws on the way in. Left alone that surfaces as a 500 with a stack trace
// in the log, which looks like a server fault when it is really just a big photo. Turn it into the
// same clear 413 instead.
const photoUpload = express.raw({ type: () => true, limit: '4mb' });
const readPhotoBody = (req, res, next) => photoUpload(req, res, (err) => {
  if (!err) return next();
  if (err.type === 'entity.too.large' || err.status === 413) {
    return bad(res, 'That photo is over the 4 MB limit. Send a smaller one, or confirm with the code alone.', 413);
  }
  next(err);
});

app.post('/api/orders/:id/delivery-photo', readPhotoBody, (req, res) => {
  const o = orders.get(req.params.id);
  if (!o) return bad(res, 'No such bill');
  if (!o.delivery) return bad(res, 'This bill is not a delivery');
  if (o.delivery.status === 'delivered') return bad(res, 'That order is already delivered');
  // A photo is only worth keeping if it can be attached, so an order that is still sitting in the
  // shop is refused rather than accumulating handover shots nobody will ever use.
  if (o.delivery.status !== 'out') return bad(res, 'The delivery boy has not collected this parcel yet');
  const url = saveProofPhoto(req.body, o.id);
  if (!url) return bad(res, 'Send a JPG, PNG or WebP photo (max 4 MB)');
  res.json({ url });
});

/* ---------- customer display hub ---------- */
// CORS so the POS can also POST straight to a Pi running its own copy of this server
app.use('/api/display', (req, res, next) => {
  res.set({
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS'
  });
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

const server = createServer(app);

/* One upgrade handler for both hubs, and it is here rather than left to the two WebSocketServers.
   Two WebSocketServers attached to the same http server with different paths look harmless and are not:
   ws's handleUpgrade answers *any* upgrade request whose path does not match it with a plain HTTP 400, and
   it cannot know that a different server sharing that listener already completed the handshake on the very
   same socket. So the /ws-admin server was writing "400 Bad Request" into sockets that had just been
   upgraded for the customer display.

   The result was that the customer display never worked at all, and nothing in it said so. The handshake
   succeeded, the server's first frame arrived and decoded correctly, and then Chrome read those stray HTTP
   bytes as a malformed WebSocket frame, logged "Invalid frame header", and closed the socket - roughly a
   frame later. The display therefore sat on its welcome screen through every payment, the server's
   /api/display/status reported 0 connected screens, and the only visible symptom at the till was the push
   being accepted with "clients: 0".

   Both hubs now share one upgrade handler, so each request is claimed by exactly one server and an unknown
   path is refused here instead of by a listener that has already lost the race. `noServer` is required: it
   is the mode that stops ws attaching its own listener and doing the damage in the first place. */
const wss = new WebSocketServer({ noServer: true });
const wssAdmin = new WebSocketServer({ noServer: true });
wss.on('error', () => {});
wssAdmin.on('error', () => {});
server.on('upgrade', (req, socket, head) => {
  let pathname = '';
  try { pathname = new URL(req.url || '/', 'http://localhost').pathname; } catch { /* refuse below */ }
  const target = pathname === '/ws-admin' ? wssAdmin : pathname === '/ws' ? wss : null;
  if (!target) {
    // Refused with the same shape ws would have used, then closed, so a client asking for a path that does
    // not exist gets an honest answer instead of a socket that hangs.
    socket.write('HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
    socket.destroy();
    return;
  }
  target.handleUpgrade(req, socket, head, (ws) => target.emit('connection', ws, req));
});
const displays = new Set();
let lastState = { type: 'idle' };

wss.on('connection', (ws) => {
  displays.add(ws);
  ws.send(JSON.stringify(lastState)); // bring a freshly connected screen up to date
  ws.on('close', () => displays.delete(ws));
  ws.on('error', () => displays.delete(ws));
});

function broadcast(msg) {
  lastState = msg;
  const s = JSON.stringify(msg);
  for (const c of displays) if (c.readyState === 1) c.send(s);
}

app.post('/api/display/push', (req, res) => {
  const msg = req.body || {};
  // 'preparing' is the state the display shows between the cashier pressing Charge and the QR arriving.
  // Without it the customer screen sits on the previous sale's idle page for the whole round trip, so it
  // looks like nothing happened at the exact moment the customer is looking up from the counter.
  if (!['preparing', 'payment', 'paid', 'idle'].includes(msg.type)) return bad(res, 'type must be preparing, payment, paid or idle');
  broadcast(msg);
  res.json({ ok: true, clients: displays.size });
});

app.get('/api/display/status', (_req, res) => res.json({ clients: displays.size }));

/* ---------- WhatsApp orders (unofficial — see whatsapp.js) ---------- */
// A second WebSocket hub, separate from the customer display: this one is for the till itself,
// to show a live badge when a new WhatsApp order comes in.
const adminClients = new Set();
// wssAdmin itself is created up with the other hub, above the shared upgrade handler - one handler for both.
wssAdmin.on('connection', (ws) => {
  adminClients.add(ws);
  ws.on('close', () => adminClients.delete(ws));
  ws.on('error', () => adminClients.delete(ws));
});
function broadcastAdmin(event) {
  const s = JSON.stringify(event);
  for (const c of adminClients) if (c.readyState === 1) c.send(s);
}

const WA_ORDERS_FILE = path.join(DATA_DIR, 'wa-orders.json');
const WA_COUNTERS_FILE = path.join(DATA_DIR, 'wa-counters.json'); // kept separate from counters.json on purpose, see nextWaOrderCode
let waOrders = readJson(WA_ORDERS_FILE, []);
let waCounters = readJson(WA_COUNTERS_FILE, {});
const saveWaOrders = () => writeJson(WA_ORDERS_FILE, waOrders);

function nextWaOrderCode() {
  const day = dayKey();
  const n = (waCounters[day] || 0) + 1;
  waCounters = { [day]: n };
  writeJson(WA_COUNTERS_FILE, waCounters);
  return `WA-${day}-${String(n).padStart(3, '0')}`;
}

/**
 * Files a customer's UPI payment screenshot against the order it was sent for.
 *
 * A screenshot carries no order number — the customer just sends the picture after the bill — so the
 * order is found by phone: this number's most recent order that is still pending. Only pending
 * orders are considered, because a screenshot that arrives a week later for an already-charged order
 * has nothing left to prove. Returns {ok:false} when there is no such order, and the bot asks the
 * customer to order first instead of the picture going quietly nowhere.
 *
 * The proof is kept on the order the till already shows ({url, at}), and the till is pinged so the
 * shop sees it arrive rather than finding it the next time the list happens to reload.
 */
function attachWaPaymentProof({ phone, buf }) {
  const key = normPhone(phone);
  if (!key || !Buffer.isBuffer(buf) || !buf.length) return { ok: false };
  // A week is far longer than an order stays pending; the cutoff only stops an old order from a
  // customer with a long-forgotten list being matched by a screenshot sent today.
  const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
  let match = null;
  for (const o of waOrders) {
    if (o.status !== 'pending' || normPhone(o.phone) !== key) continue;
    const at = Date.parse(o.createdAt || '') || 0;
    if (at < cutoff) continue;
    if (!match || at > (Date.parse(match.createdAt || '') || 0)) match = o;
  }
  if (!match) return { ok: false };
  const url = saveWaPaymentProof(buf, match.code);
  if (!url) return { ok: false };
  match.paymentProof = { url, at: new Date().toISOString() };
  saveWaOrders();
  // Let any open till show it arrive, the same way a new order does.
  broadcastAdmin({ type: 'wa-payment-proof', order: match });
  return { ok: true };
}

// null until (if) whatsapp.js finishes connecting; every route below must tolerate that
let wa = null;

/**
 * Wraps the WhatsApp connection so that no message failure can ever reach a request handler.
 *
 * Found the hard way: a customer with no previous bill triggers a welcome message, and when WhatsApp was
 * off that one line threw a TypeError, which Express does not catch, which ended the process. The till
 * then refused to start at all because one customer's first purchase could not be announced. A shop
 * cannot lose its ability to charge someone because a message did not send, so this sits between the
 * code and the connection and turns every possible failure — no connection, no such method, a rejected
 * promise, a synchronous throw — into `false`.
 *
 * It is a wrapper rather than a check at each of the call sites because there are eight of them and they
 * grow; the one that gets forgotten is the one that takes the shop down at the worst moment. Call sites
 * keep their `wa?.` and their `.catch`, and both are now harmless.
 */
function guardWa(conn) {
  if (!conn) return null;
  return new Proxy(conn, {
    get(target, prop) {
      const value = target[prop];
      if (typeof value !== 'function') return value;
      // getStatus is a plain read of the connection's state, and callers want its real value — including
      // an exception if the underlying object is in a strange state, which /api/whatsapp/status must
      // report rather than hide.
      if (prop === 'getStatus') return value.bind(target);
      return (...args) => {
        try {
          return Promise.resolve(value.apply(target, args)).catch((err) => {
            console.error(`WhatsApp ${String(prop)} failed:`, err.message);
            return false;
          });
        } catch (err) {
          console.error(`WhatsApp ${String(prop)} failed:`, err.message);
          return Promise.resolve(false);
        }
      };
    },
    has: (t, p) => p in t
  });
}

app.get('/api/whatsapp/status', (_req, res) => {
  if (!wa) return res.json({ available: false, enabled: false, connected: false, qr: null, phone: null, loggedOut: false });
  // `loggedOut` is passed through rather than folded into `connected`. It is a different situation with a
  // different fix: `connected:false` on its own covers "still starting" and "reconnecting", and both of
  // those clear themselves. A revoked device does not, and showing it as a connecting socket left the shop
  // watching a message that said Starting… for as long as they cared to look. `enabled` is the shop's own
  // on/off switch, which is a third state again: not connected on purpose, and not promising to connect.
  res.json({ available: true, ...wa.getStatus() });
});

app.post('/api/whatsapp/unlink', async (_req, res) => {
  if (!wa) return bad(res, 'WhatsApp is not running');
  await wa.unlink();
  res.json({ ok: true });
});

/**
 * One route for both directions, rather than a start and a stop.
 *
 * The shop's action is a single switch, and a client that has to decide which URL to call can get it
 * backwards — telling a stopped bot to start, or a running one to stop, from a stale answer. The server
 * knows which it is, so the client sends the intent and the server works out the direction.
 */
app.post('/api/whatsapp/toggle', async (_req, res) => {
  if (!wa) return bad(res, 'WhatsApp is not running');
  const on = typeof wa.start === 'function' && typeof wa.stop === 'function';
  if (!on) return bad(res, 'This server cannot start or stop the bot — restart it instead.');
  try {
    const running = wa.getStatus().enabled !== false;
    const result = running ? await wa.stop() : await wa.start();
    res.json({ ok: true, enabled: !running, ...result });
  } catch (err) {
    console.error('WhatsApp start/stop failed:', err.message);
    bad(res, 'Could not change whether the bot is running. Try again.');
  }
});

app.post('/api/whatsapp/relink', async (_req, res) => {
  if (!wa) return bad(res, 'WhatsApp is not running');
  // Behind the gate like everything else in settings, and it matters more here than most: this route
  // produces the QR that controls the shop's WhatsApp account, so it is exactly as sensitive as the
  // phone number itself.
  if (!wa.relink) return bad(res, 'This server cannot start pairing again — restart it instead.');
  try {
    await wa.relink();
    res.json({ ok: true });
  } catch (err) {
    console.error('WhatsApp relink failed:', err.message);
    bad(res, 'Could not start pairing again. Restart the POS server, then try.');
  }
});

app.get('/api/whatsapp/orders', (_req, res) => {
  res.json({ orders: waOrders.filter((o) => o.status === 'pending') });
});

app.post('/api/whatsapp/orders/:code/accept', (req, res) => {
  const o = waOrders.find((x) => x.code === req.params.code);
  if (!o) return bad(res, 'Order not found', 404);
  o.status = 'accepted';
  saveWaOrders();
  res.json({ ok: true });
});

app.post('/api/whatsapp/orders/:code/dismiss', (req, res) => {
  const o = waOrders.find((x) => x.code === req.params.code);
  if (!o) return bad(res, 'Order not found', 404);
  o.status = 'dismissed';
  saveWaOrders();
  res.json({ ok: true });
});

/* ---------- one-off customer announcement ---------- */
/*
 * The shop told its saved customers, once, that it now takes orders by voice note. Two rules make
 * this more than a for-loop, and both are about trust:
 *
 *   - it must fire exactly once. A shop that texts its whole customer list twice in a day looks like
 *     a spammer, and the number is on an unofficial connection that can be restricted for it. State
 *     is written to disk before the first message and after every one, so a crash or a restart in
 *     the middle resumes instead of starting over.
 *   - the audience is fixed: customers.json, i.e. people who have ordered before, minus anyone who
 *     has replied "stop". It never grows into "everyone who ever messaged us".
 *
 * The timing knobs are environment variables so the test can drive this in a second instead of the
 * several minutes a real send to a customer list takes.
 */
const ANNOUNCEMENTS_FILE = path.join(DATA_DIR, 'announcements.json');
let announcements = readJson(ANNOUNCEMENTS_FILE, {});
const saveAnnouncements = () => writeJson(ANNOUNCEMENTS_FILE, announcements);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ANNOUNCE_FIRST_MS = Number(process.env.POS_ANNOUNCE_DELAY_MS ?? 15000);
const ANNOUNCE_GAP_MS = Number(process.env.POS_ANNOUNCE_GAP_MS ?? 4000);

// Remembers that a number asked not to be messaged again. Called from the bot when a customer
// replies "stop"; kept even if the announcement has already gone, in case the shop sends another.
function optOutOfAnnouncements(phone) {
  const key = normPhone(phone);
  if (!key) return;
  announcements.optOut = announcements.optOut || {};
  announcements.optOut[key] = true;
  saveAnnouncements();
}

let announcing = false;
async function maybeAnnounce() {
  if (announcing) return;
  // Stay out of the way of tests unless one explicitly asks for the announcement. Tests run against
  // a throwaway data dir and a stand-in WhatsApp, and without this the stand-in counts as connected.
  if (process.env.POS_NO_WHATSAPP === '1' && process.env.POS_ANNOUNCE !== '1') return;
  if (announcements.voiceOrdering?.sentAt) return;       // already sent; never again
  if (!wa || !wa.getStatus?.().connected) return;         // not connected yet; try on the next tick
  const recipients = announcementRecipients(customers, announcements.optOut || {});
  if (!recipients.length) {
    // Nobody to tell is still finished — otherwise an empty customer list retries forever.
    announcements.voiceOrdering = { sentAt: new Date().toISOString(), sent: [], failed: [] };
    saveAnnouncements();
    return;
  }
  announcing = true;
  try {
    const state = (announcements.voiceOrdering = {
      startedAt: announcements.voiceOrdering?.startedAt || new Date().toISOString(),
      sent: announcements.voiceOrdering?.sent || [],
      failed: announcements.voiceOrdering?.failed || []
    });
    saveAnnouncements();
    const text = buildAnnouncementText(readConfig()?.storeName || 'Our shop');
    const done = new Set(state.sent);
    for (const phone of recipients) {
      if (done.has(phone)) continue;                      // a previous run already reached them
      const ok = await wa.sendText(phone, text);
      if (ok === false) { if (!state.failed.includes(phone)) state.failed.push(phone); }
      else { state.sent.push(phone); done.add(phone); }
      saveAnnouncements();                                // written per send, so a restart resumes
      // Several seconds apart on purpose: a burst is what gets a number flagged, and a slow trickle
      // reads like somebody typing.
      await sleep(ANNOUNCE_GAP_MS);
    }
    state.sentAt = new Date().toISOString();
    saveAnnouncements();
    console.log(`Announcement sent to ${state.sent.length} saved customer(s)${state.failed.length ? `, ${state.failed.length} failed` : ''}.`);
  } finally {
    announcing = false;
  }
}

// First check shortly after boot (shortly, not immediately: the WhatsApp connection is usually still
// opening), then every half minute until it has gone out. Running it from a timer means a restart
// mid-send simply resumes, which is why the state is written after every message.
setTimeout(() => { maybeAnnounce().catch((e) => console.error('Announcement failed:', e.message)); }, ANNOUNCE_FIRST_MS);
setInterval(() => { maybeAnnounce().catch(() => {}); }, 30000);

  // Starts in the background; if @whiskeysockets/baileys isn't installed yet, the rest of the POS
  // still runs normally — this just means WhatsApp features stay off until "npm install" is run.
  //
  // POS_NO_WHATSAPP=1 keeps the socket from ever starting. Tests need this: they run against a
  // throwaway copy of the data dir, and that copy includes whatsapp-session/, so without the switch
  // a test brings the shop's real WhatsApp account online and can text real customers from a
  // synthetic bill. Every test sets it.
  if (process.env.POS_NO_WHATSAPP === '1') {
    console.log('WhatsApp is off (POS_NO_WHATSAPP=1) — the till works, messages are recorded as failed.');
    // A stand-in sender, so the code paths that talk to a customer can still be tested.
    //
    // Without it, every test of a reply hits the "WhatsApp could not be reached" branch, and the one
    // thing worth proving — that the shop's record of what it said in a customer's name is written down
    // correctly — becomes untestable. This collects what was sent and sends nothing anywhere. It is
    // driven by an environment variable rather than a query string, so there is no URL a browser could
    // use to make the till send messages through it.
    if (process.env.POS_FAKE_WHATSAPP === '1') {
      // Imported here, and only here, so the stand-in can reuse the real state transitions rather than
      // restating them. Importing whatsapp.js pulls in Baileys and its dependencies, which is why this is a
      // dynamic import inside the branch rather than one at the top of the file.
      const { statusAfterUnlink } = await import('./whatsapp.js');
      const log = process.env.POS_FAKE_WHATSAPP_LOG;
      // available:true because a stand-in that says it is not installed can only ever test the "not set up"
      // screen. The real connection is present-but-unlinked in every state worth checking, and that is the
      // difference the status fix is about.
      let fakeStatus = { available: true, enabled: true, connected: false, qr: null, phone: null, loggedOut: false };
      try {
        if (process.env.POS_FAKE_WHATSAPP_STATUS) {
          fakeStatus = { ...fakeStatus, ...JSON.parse(process.env.POS_FAKE_WHATSAPP_STATUS) };
        }
      } catch { /* a malformed override is not worth failing a test run over */ }
      const record = (phone, text) => {
        if (log) fs.appendFileSync(log, `${JSON.stringify({ phone, text })}\n`);
        return true;
      };
      // Every method the real connection has, not just the ones today's tests happen to call. A stand-in
      // missing one is not a smaller stand-in, it is a stand-in that throws TypeError on the route that
      // uses it — which is how a test for complaints ended up killing the server it was testing.
      wa = {
        sendText: async (phone, text) => record(phone, text),
        sendWelcome: async (phone, name) => record(phone, `Welcome ${name}`),
        sendDeliveryQr: async (phone, info) => record(phone, `QR for ${info?.code}`),
        // Uses the real transition from whatsapp.js rather than restating it. A hand-copied stand-in state
        // was how these tests came to pass while the code under them was wrong: reverting the fix in
        // whatsapp.js changed nothing here, because the stand-in answered instead. Sharing the function means
        // the stand-in cannot disagree with the thing it stands in for.
        unlink: async () => {
          fakeStatus = statusAfterUnlink(fakeStatus);
          return { ok: true };
        },
        // Present for the same reason as the rest: this stand-in exists so routes can be tested, and a
        // stand-in missing the newest method is a stand-in that 400s on a route that works in production.
        // Moves to the state the real thing moves to: no longer revoked, and waiting on a QR. If this
        // returned without changing anything, a test could still pass by only ever checking the revoked
        // screen, and the button on it would be untested.
        relink: async () => {
          fakeStatus = { connected: false, qr: 'FAKE-QR-PENDING', phone: null, loggedOut: false };
          return true;
        },
        // Flips the same flag the settings screen reads, so a test can check the button actually says
        // "Stop" after a start and "Start" after a stop rather than just that the route returned 200.
        start: async () => { fakeStatus = { ...fakeStatus, enabled: true }; return { ok: true }; },
        stop: async () => { fakeStatus = { ...fakeStatus, enabled: false, connected: false, qr: null }; return { ok: true }; },
        // Settable rather than fixed, so a test can put the till in the states the phone can actually put
        // it in. A stand-in that only ever answers "not available" cannot be used to check that a revoked
        // device looks different on screen from a socket that has not started yet — which is the whole
        // distinction the WhatsApp status fix exists to draw.
        getStatus: () => ({ fake: true, ...fakeStatus })
      };
    }
  } else {
  (async () => {

  try {
    const { startWhatsApp } = await import('./whatsapp.js');
    wa = guardWa(await startWhatsApp({
      dataDir: DATA_DIR,
      storeName: () => readConfig()?.storeName || 'The shop',
      upiVpa: () => readConfig()?.upiVpa || '',
      getProducts: () => products,
      saveOrder: (order) => { waOrders.push(order); saveWaOrders(); },
      // The name arrives after the order is already saved, so it is patched onto the stored record.
      // Without this the till would have nothing to pre-fill and the bill would print no name.
      setOrderName: (code, name) => {
        const o = waOrders.find((x) => x.code === code);
        if (!o) return;
        o.name = name;
        saveWaOrders();
        // let any open till update its pending-orders list straight away
        broadcastAdmin({ type: 'wa-order-name', order: o });
      },
        nextOrderCode: nextWaOrderCode,
        broadcast: broadcastAdmin,
        deliveryBoys,
        normPhone,
        // Lets the bot skip the name question for someone it has already met. Repeating "what is your
        // name?" on every single order is the sort of thing that makes people stop ordering, and the
        // name is already on file from their last bill — so the bot reuses it and only ever asks a
        // genuinely new customer. Blank names are ignored: an order charged without a name must not
        // make the bot think it knows the answer.
        knownName: (phone) => {
          const key = normPhone(phone);
          const name = key ? (customers[key]?.name || '').trim() : '';
          return name.slice(0, 40);
        },
          // Saves the complaint, and acknowledges it in fixed words. No model is involved here, and that
          // is the point rather than an omission: the complaint arrives as 'major' and stays that way
          // until a person in the shop has read it and marked it minor. Nothing an unreviewed complaint
          // says can reach a customer on its own, and the customer is never left on read in the meantime.
          raiseComplaint: async ({ phone, text }) => {
            const complaint = addComplaint({ phone, text, source: 'whatsapp' });
            broadcastAdmin({ type: 'complaint', complaint });
            const store = readConfig()?.storeName || 'The shop';
            // Recorded as sent, which is only true. It is not a resolution, and only a person can close a
            // complaint; the shop screen tells those two apart by the status, not by this.
            complaint.repliedAt = new Date().toISOString();
            complaint.updatedAt = complaint.repliedAt;
            saveComplaints();
            return { complaint, text: complaintFallbackText(complaint, store) };
          },

          // The conversation itself, for a customer writing again about a complaint already on file.
          // Returns handled:false when there is nothing live to talk about, and the bot carries on with
          // whatever else the message might be: a new order, or a different complaint.
          continueComplaint: (msg) => complaintConversation.handle(msg),

          // A customer's WhatsApp voice note, turned into an order.
          //
          // Three steps, and the order the third one produces is the only one the shop will see: speech to
          // text (Gemini hears the note; a local Whisper server is the fallback), the model proposes which
          // products the words mean, and parseVoiceOrder decides against the real catalogue and the real
          // stock. An item the shop does not sell, or has none of, becomes "not available" with
          // substitutes — never a line with a price the model made up. Returns a null-able `reason` so the
          // bot can say why in plain words. The reply is always English (the shop wants one English bill);
          // the note itself is understood in whatever language the customer spoke.
          //
          // `verdict` is what the customer then confirms. It carries no code yet — that is minted on
          // "yes", exactly like a typed order — so the whole existing confirm/pay flow is reused.
          voiceOrder: async ({ audio, mimeType }) => {
            const cfg = readConfig() || {};
            // The switch in Settings is the master gate, so voice ordering never turns itself on just
            // because a Gemini key was added for some other feature.
            if (cfg.voice?.enabled !== true) return { ok: false, reason: 'off' };
            const store = cfg.storeName || 'The shop';
            const transcript = await aiTranscribe(audio, mimeType);
            if (!transcript) return { ok: false, reason: 'unclear' };
            const text = await aiChat({
              system: buildVoiceOrderPrompt({ storeName: store, products, transcript }),
              user: 'Return the JSON now.',
              json: true,
              maxTokens: 900,
              temperature: 0.2,
              timeoutMs: 25000
            });
            if (!text) return { ok: false, reason: 'unclear' };
            const verdict = parseVoiceOrder(text, { products });
            if (!verdict.ok) return { ok: false, reason: 'unclear' };
            return { ok: true, verdict, reply: buildVoiceOrderReply({ storeName: store, verdict }) };
          },
        confirmDeliveryByCode,
        confirmDeliveryByQr,
        // A customer's UPI payment screenshot, filed against the order it pays for.
        attachPaymentProof: attachWaPaymentProof,
        // A customer replying "stop" opts out of the shop's announcements.
        optOut: optOutOfAnnouncements,

      // A delivery boy's photo could be either QR, so the server decides which one it is and does the
      // right thing: the sticker on the parcel means he is collecting it, the customer's own means
      // the goods have reached them. Only the second one is a handover, so only that one carries
      // the photo through as proof.
      //
      // The picture travels as a buffer, not a saved URL, on purpose: which bill it belongs to is
      // only known once the QR inside it has been decoded and matched, so the server stores it
      // itself rather than being handed a path for a bill it has not identified yet.
      confirmScanByQr: async (token, byPhone, photoBuf) => (
        findDeliveryByPickupToken(token)
          ? await confirmPickupByQr(token, byPhone)
          : confirmDeliveryByQr(token, byPhone, photoBuf)
      ),
      declineDelivery
    }));
  } catch (err) {
    const missing = /Cannot find (package|module) '@whiskeysockets\/baileys'/.test(err.message);
    console.log(missing
      ? 'WhatsApp feature not started: run "npm install" to add it, then restart the server.'
      : `WhatsApp feature not started: ${err.message}`);
  }
})();
  }

// any error inside an /api route comes back as JSON, never as an HTML error page
app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(500).json({ error: 'Something went wrong on the server' });
});

// The addresses phones/other computers on the same Wi-Fi should use — "localhost" only works
// on this machine itself. Prints every network address found, in case there's more than one
// (Wi-Fi + Ethernet, for example).
function lanAddresses() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const iface of list || []) {
      if (iface.family === 'IPv4' && !iface.internal) out.push(iface.address);
    }
  }
  return out;
}

// A friendly message instead of a raw crash — most often this means the POS is already running
// in another window/tab, or a previous run didn't shut down cleanly.
server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`\nPort ${PORT} is already in use — the POS may already be running elsewhere.`);
    console.error(`Find it with:  lsof -i :${PORT}   (or: sudo lsof -i :${PORT})`);
    console.error('Then stop it with:  kill <the PID number shown>');
    console.error(`Or run this copy on a different port:  PORT=3001 npm start\n`);
  } else {
    console.error('Server failed to start:', err.message);
  }
  process.exit(1);
});

server.listen(PORT, '0.0.0.0', () => {
  const addrs = lanAddresses();
  console.log(`LOCAL POS running on http://localhost:${PORT} (this machine only)`);
  if (addrs.length) {
    console.log('On phones and other computers on the same Wi-Fi, use:');
    for (const ip of addrs) console.log(`  http://${ip}:${PORT}`);
  } else {
    console.log('Could not detect this machine\'s Wi-Fi/network address — check it is connected to a network.');
  }
  console.log(`Customer display page: http://<this-machine-ip>:${PORT}/display.html`);
  console.log(`Weighing station: http://<this-machine-ip>:${PORT}/weigh.html`);
});
