/* Turning a picture or a sentence into product records.
 *
 * Three jobs, one idea: read something a shopkeeper already has — a photo of a shelf, a handwritten
 * weighing slip, a supplier's bill, or a spoken sentence — and turn it into the structured fields this
 * till stores. The words the model returns are only ever a *draft*: nothing here writes a product, and
 * every field is validated and clipped before it is offered to the shop to accept.
 *
 * Like complaint-ai.js, this is pure. Prompts and parsers are separated from the network call so the
 * part that can be wrong in a way nobody notices — a price read as text, a quantity read as negative, a
 * name that swallows the next row — is tested with no key and no network. The server does the talking.
 */

import { firstJson } from './ai.js';

const clip = (s, n) => Array.from(String(s ?? '').replace(/\s+/g, ' ').trim()).slice(0, n).join('');

/** A number a model wrote, or null. Rejects NaN, Infinity and the strings that sneak through those. */
function num(v) {
  if (v == null || v === '') return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  const s = String(v).trim();
  // A trailing slash writes rupees ("55/-") and a comma groups thousands ("1,250.50"); neither is a
  // digit, so both are dropped. Only a leading sign is a sign — otherwise "55/-" would read as -55.
  const neg = /^[-−]/.test(s);
  const digits = s.replace(/[^\d.]/g, '');
  if (!digits || digits === '.') return null;
  const n = Number(digits);
  if (!Number.isFinite(n)) return null;
  return neg ? -n : n;
}

/** Money is never negative on a shelf, and a stray minus is a model reading a hyphenated name. */
function money(v) {
  const n = num(v);
  return n == null ? null : Math.max(0, Math.round(n * 100) / 100);
}

const WEIGHTY = /kg|kilo|gram|g\b|loose|weigh|weight/i;

/**
 * One product, from whatever the model produced for it.
 *
 * Price is allowed to be null on purpose. A shelf photo often has the product but not the price, and a
 * draft that says "price not read" is more useful than an invented number the shop has to notice and
 * correct — the same reason the complaint flow never lets a model state a figure.
 */
export function cleanProductDraft(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const name = clip(raw.name ?? raw.product ?? raw.item ?? raw.title, 80);
  if (!name) return null;
  const unit = clip(raw.unit ?? raw.uom ?? '', 24);
  const emoji = Array.from(String(raw.emoji ?? '').trim()).slice(0, 4).join('');
  const draft = {
    name,
    price: money(raw.price ?? raw.mrp ?? raw.rate ?? raw.sellingPrice),
    cost: money(raw.cost ?? raw.purchasePrice ?? raw.buyPrice),
    sku: clip(raw.sku ?? raw.code ?? raw.barcode ?? raw.skuCode, 40),
    category: clip(raw.category ?? raw.group ?? '', 40),
    emoji,
    stock: num(raw.stock ?? raw.qty ?? raw.quantity ?? raw.stockQty),
    soldByWeight: raw.soldByWeight === true || (raw.soldByWeight !== false && WEIGHTY.test(unit))
  };
  // null means "not read"; the form shows an empty field rather than a zero the shop might save.
  if (draft.price == null) delete draft.price;
  if (draft.cost == null) delete draft.cost;
  if (draft.stock == null) delete draft.stock;
  return draft;
}

const PRODUCTS_RULES =
  'Rules, all of them firm:\n' +
  '- Read only what is actually there. Never invent a price, a barcode or a quantity you cannot see.\n' +
  '- If the price is not visible, omit the "price" field entirely. Do not guess and do not write 0.\n' +
  '- One object per DISTINCT product. Do not repeat the same item twice, and do not merge two items.\n' +
  '- Names are as printed, without the price or the quantity glued onto them.\n' +
  '- Prices are numbers in rupees, digits only: 55, not "Rs 55/" and not "MRP 55".\n' +
  '- "emoji" is a single emoji that suits the item, or leave it out.\n' +
  '- "soldByWeight" is true only for loose goods sold by the kilo (rice, sugar, vegetables).\n' +
  '- Plain JSON only. No markdown, no explanation, no text before or after.';

/**
 * The instruction for reading a photo of products.
 *
 * `categories` is handed in so the model reuses the shop's own words instead of inventing a taxonomy the
 * reports then have to reconcile.
 */
export function buildScanProductsPrompt({ storeName = 'the shop', categories = [] } = {}) {
  const known = categories.filter(Boolean).slice(0, 30);
  return (
    `You are reading a photograph for the owner of ${storeName}, a small shop in India, so the items in ` +
    'it can be added to their till. The photo may be a shelf, a supplier\'s price list, a stack of ' +
    'packets, or a page of a stock register. It may be in English, Hindi or Bengali.\n\n' +
    'Reply with JSON only, in exactly this shape:\n' +
    '{"products":[{"name":"","price":0,"cost":0,"sku":"","category":"","emoji":"","stock":0,"soldByWeight":false}]}\n\n' +
    (known.length ? `Categories already used by this shop (reuse one when it fits): ${known.join(', ')}.\n\n` : '') +
    PRODUCTS_RULES
  );
}

/** Every product a photo yielded, in order, capped. An empty list is a valid answer, not an error. */
export function parseProductDrafts(text, { max = 40 } = {}) {
  const parsed = firstJson(text);
  const list = Array.isArray(parsed) ? parsed : (Array.isArray(parsed?.products) ? parsed.products : []);
  const out = [];
  const seen = new Set();
  for (const raw of list) {
    const d = cleanProductDraft(raw);
    if (!d) continue;
    const k = d.name.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(d);
    if (out.length >= max) break;
  }
  return out;
}

/**
 * The instruction for turning a sentence into one product — typed or dictated.
 *
 * The shopkeeper's own words are the whole input, so the rules are the same as for a photo with one
 * addition: the model may round a spoken price into rupees, because "fifty-six rupees" is a price and
 * saying so is not inventing one.
 */
export function buildProductFromTextPrompt({ storeName = 'the shop', categories = [] } = {}) {
  const known = categories.filter(Boolean).slice(0, 30);
  return (
    `You are filling in a product record for ${storeName}, a small shop in India, from one line the ` +
    'owner typed or said. It may be in English, Hindi or Bengali, and it may be terse: ' +
    '"Amul butter 100g 56", "পেঁয়াজ ৪০ টাকা কেজি", "Surf Excel 1kg MRP 132".\n\n' +
    'Reply with JSON only, in exactly this shape (no array, one object):\n' +
    '{"name":"","price":0,"cost":0,"sku":"","category":"","emoji":"","stock":0,"soldByWeight":false}\n\n' +
    (known.length ? `Categories already used by this shop (reuse one when it fits): ${known.join(', ')}.\n\n` : '') +
    '- A price stated in words ("fifty six", "৫৬") becomes the number. That is reading, not inventing.\n' +
    '- A weight in the name ("100g", "1kg") stays in the name, and marks loose goods sold by weight.\n' +
    '- Omit anything the sentence does not say. Never invent a barcode or a cost.\n' +
    '- Plain JSON only. No markdown, no explanation.'
  );
}

/** One product from a sentence, or null if the sentence did not yield a usable name. */
export function parseProductFromText(text) {
  const parsed = firstJson(text);
  const raw = Array.isArray(parsed) ? parsed[0] : (Array.isArray(parsed?.products) ? parsed.products[0] : parsed);
  return cleanProductDraft(raw);
}

/**
 * The instruction for reading a handwritten slip, a weighing ticket or a supplier bill.
 *
 * These are read for a different reason than a shelf: the shop wants the line items and the total, to
 * check a bill or to add a delivery, so the shape is about rows and a sum rather than about products to
 * sell. A slip is also the most likely thing to be scrawled and wrong, hence `kind` and the refusal to
 * total the rows itself — the written total is quoted, and a mismatch is left for a person to see.
 */
export function buildSlipPrompt({ storeName = 'the shop' } = {}) {
  return (
    `You are reading a handwritten slip for ${storeName}, a small shop in India. It may be a weighing ` +
    'ticket, a supplier\'s bill, a credit note, or a note a customer left. It may be in English, Hindi ' +
    'or Bengali, and the handwriting may be poor.\n\n' +
    'Reply with JSON only, in exactly this shape:\n' +
    '{"kind":"invoice|weigh-slip|note|unknown","supplier":"","date":"","total":0,' +
    '"items":[{"name":"","qty":0,"unit":"","price":0}]}\n\n' +
    '- "qty" is a number (2, 0.5). "unit" is "kg", "g", "pcs", "packet" or similar.\n' +
    '- "price" is the line amount if written, in rupees, digits only.\n' +
    '- "total" is the total as WRITTEN on the slip, even if the rows do not add up to it. Do not fix it.\n' +
    '- Omit a field you cannot read rather than inventing it. An empty items list is a valid answer.\n' +
    '- Plain JSON only. No markdown, no explanation.'
  );
}

/** The structured slip, with unreadable fields left out rather than invented. */
export function parseSlip(text, { max = 60 } = {}) {
  const parsed = firstJson(text);
  if (!parsed || typeof parsed !== 'object') return null;
  const kinds = ['invoice', 'weigh-slip', 'note', 'unknown'];
  const items = (Array.isArray(parsed.items) ? parsed.items : []).slice(0, max).map((it) => {
    if (!it || typeof it !== 'object') return null;
    const name = clip(it.name ?? it.item ?? it.description, 80);
    if (!name) return null;
    const qty = num(it.qty ?? it.quantity ?? it.weight);
    const price = money(it.price ?? it.amount ?? it.rate ?? it.lineTotal);
    return {
      name,
      ...(qty != null ? { qty } : {}),
      ...(clip(it.unit ?? it.uom ?? '', 16) ? { unit: clip(it.unit ?? it.uom, 16) } : {}),
      ...(price != null ? { price } : {})
    };
  }).filter(Boolean);
  return {
    kind: kinds.includes(String(parsed.kind)) ? String(parsed.kind) : 'unknown',
    supplier: clip(parsed.supplier ?? parsed.vendor ?? parsed.from, 80),
    date: clip(parsed.date, 40),
    total: money(parsed.total ?? parsed.grandTotal ?? parsed.amount),
    items
  };
}
