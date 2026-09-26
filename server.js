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
import { computeDailyStats, computeAchievements, computeStockPosition } from './stats.js';
// Pure text/parsing helpers only — no Baileys — so this is safe to import even when WhatsApp is off.
import { buildPackedText, buildOutForDeliveryText, buildDeliveredText, buildDeliveryJobText, buildNewCodeText, buildDeliveryOkText, buildDeliveryBadCodeText, buildDeliveryAlreadyText, buildDeliveryLockedText, buildDeliveryBadQrText, buildPickupOkText, buildPickupAlreadyText, buildNotPickedUpText, buildDeliveryDeclinedText, buildDeliveryBoyNothingToDeclineText } from './whatsapp-bot.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.POS_DATA_DIR || path.join(__dirname, 'data'); // set POS_DATA_DIR to keep the data on another drive
const CONFIG_FILE = path.join(DATA_DIR, 'config.json');
const PRODUCTS_FILE = path.join(DATA_DIR, 'products.json');
const CUSTOMERS_FILE = path.join(DATA_DIR, 'customers.json');
const COUNTERS_FILE = path.join(DATA_DIR, 'counters.json');
const ORDERS_FILE = path.join(DATA_DIR, 'orders.jsonl');
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
const PORT = process.env.PORT || 3000;
const TZ = process.env.POS_TZ || 'Asia/Kolkata';                                    // bill numbers roll over at local midnight
const FIRESTORE = process.env.FIRESTORE_ENDPOINT || 'https://firestore.googleapis.com'; // only used by the one-time import

fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

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
  const { firebase, ...rest } = cfg; // the old Firebase settings never go to the browser
  return { ...rest, canImportFirebase: Boolean(firebase?.apiKey && firebase?.projectId) };
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
app.use(express.json({ limit: '256kb' }));
app.use(express.static(path.join(__dirname, 'public')));

/* ---------- setup / config ---------- */
app.get('/api/config', (_req, res) => {
  const cfg = readConfig();
  res.json({ configured: Boolean(cfg?.storeName), config: publicView(cfg) });
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
  writeJson(CONFIG_FILE, cfg);
  res.json({ configured: true, config: publicView(cfg) });
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
  res.json({ deliveries: out });
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
  completeDelivery(o, String(req.body?.by || 'delivery').slice(0, 40));
  // The token is echoed nowhere: it is a bearer secret for the customer's QR, and a response is
  // somewhere it could end up in a log or a browser history for no benefit.
  res.json({ ok: true, order: { id: o.id, delivery: { code: o.delivery.code, status: o.delivery.status, deliveredAt: o.delivery.deliveredAt, confirmedBy: o.delivery.confirmedBy } } });
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
      code: o.delivery.code, orderId: o.id
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

function confirmDeliveryByQr(token, byPhone) {
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
  return completeDelivery(o, o.delivery.boy?.name);
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
function completeDelivery(o, by) {
  o.delivery.status = 'delivered';
  o.delivery.deliveredAt = new Date().toISOString();
  o.delivery.confirmedBy = by || o.delivery.boy?.name || 'delivery';
  fs.appendFileSync(ORDERS_FILE, `${JSON.stringify(o)}\n`, { mode: 0o600 });
  orders.set(o.id, o);
  const phone = o.customer?.phone;
  if (phone) {
    wa?.sendText(phone, buildDeliveredText(readConfig()?.storeName || 'The shop', { orderId: o.id }))
      .catch((err) => console.error('Delivery confirmation message failed:', err.message));
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
const wss = new WebSocketServer({ server, path: '/ws' });
wss.on('error', () => {}); // a startup failure (e.g. the port is busy) is reported once, below, via server.on('error')
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
  if (!['payment', 'paid', 'idle'].includes(msg.type)) return bad(res, 'type must be payment, paid or idle');
  broadcast(msg);
  res.json({ ok: true, clients: displays.size });
});

app.get('/api/display/status', (_req, res) => res.json({ clients: displays.size }));

/* ---------- WhatsApp orders (unofficial — see whatsapp.js) ---------- */
// A second WebSocket hub, separate from the customer display: this one is for the till itself,
// to show a live badge when a new WhatsApp order comes in.
const adminClients = new Set();
const wssAdmin = new WebSocketServer({ server, path: '/ws-admin' });
wssAdmin.on('error', () => {});
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

// null until (if) whatsapp.js finishes connecting; every route below must tolerate that
let wa = null;

app.get('/api/whatsapp/status', (_req, res) => {
  if (!wa) return res.json({ available: false, connected: false, qr: null, phone: null });
  res.json({ available: true, ...wa.getStatus() });
});

app.post('/api/whatsapp/unlink', async (_req, res) => {
  if (!wa) return bad(res, 'WhatsApp is not running');
  await wa.unlink();
  res.json({ ok: true });
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

// Starts in the background; if @whiskeysockets/baileys isn't installed yet, the rest of the POS
// still runs normally — this just means WhatsApp features stay off until "npm install" is run.
(async () => {
  try {
    const { startWhatsApp } = await import('./whatsapp.js');
    wa = await startWhatsApp({
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
      confirmDeliveryByCode,
      confirmDeliveryByQr,
      // A delivery boy's photo could be either QR, so the server decides which one it is and does the
      // right thing: the sticker on the parcel means he is collecting it, the customer's own means
      // the goods have reached them.
      confirmScanByQr: async (token, byPhone) => (
        findDeliveryByPickupToken(token)
          ? await confirmPickupByQr(token, byPhone)
          : confirmDeliveryByQr(token, byPhone)
      ),
      declineDelivery
    });
  } catch (err) {
    const missing = /Cannot find (package|module) '@whiskeysockets\/baileys'/.test(err.message);
    console.log(missing
      ? 'WhatsApp feature not started: run "npm install" to add it, then restart the server.'
      : `WhatsApp feature not started: ${err.message}`);
  }
})();

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
