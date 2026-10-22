/* Turning a customer's voice note into an order.
 *
 * A customer sends the shop a WhatsApp voice message — often an older person who would rather speak
 * than type. Three steps turn it into something the till can use, and each one is a place the model can
 * be wrong, so each one is validated here rather than trusted:
 *
 *   1. Speech to text. The shop's Gemini key hears the note directly, because its model takes audio the
 *      same way it takes a photo; WhatsApp voice notes are OGG/Opus and go straight in. (A locally-run
 *      Whisper server remains a fallback for a shop with no key — see the server's aiTranscribe.) The
 *      words are kept verbatim in the customer's own language, so this understands any language spoken,
 *      but the reply that comes back is always English (see buildVoiceOrderReply).
 *   2. The transcript becomes a list of items. A model (Gemini) reads the sentence — which may be in
 *      English, Hindi, Bengali or a mix, and may be mis-heard — and names the products it recognises.
 *   3. The names are matched against the shop's real catalogue. This file does that matching, and only
 *      this file decides what is in the order: the model's job is to suggest a *name*, and a name that
 *      matches nothing on the shelf, or an item with no stock, becomes "not available" with a few
 *      in-stock substitutes, never an invented line.
 *
 * Like catalog-ai.js and complaint-ai.js, this is pure: it builds request objects and reads response
 * objects and does no `fetch` of its own, so the risky part — a price read off a mis-heard word, a
 * quantity of 0, an item the shop does not sell — is tested with no server, no key and no audio.
 */

import { firstJson } from './ai.js';

const clip = (s, n) => Array.from(String(s ?? '').replace(/\s+/g, ' ').trim()).slice(0, n).join('');
const trimSlash = (s) => String(s || '').replace(/\/+$/, '');

/** Letters and digits only, so "পেঁয়াজ" and "peyaj " and "Peyaj," compare equal. */
const norm = (s) => String(s ?? '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');

function num(v) {
  if (v == null || v === '') return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  const s = String(v).trim();
  const neg = /^[-−]/.test(s);
  const digits = s.replace(/[^\d.]/g, '');
  if (!digits || digits === '.') return null;
  const n = Number(digits);
  if (!Number.isFinite(n)) return null;
  return neg ? -n : n;
}

/** A whole number of pieces, at least 1: a customer cannot order half a packet, and "0" is a slip. */
function positiveInt(v, fallback = 1) {
  const n = num(v);
  if (n == null) return fallback;
  const i = Math.round(n);
  return i >= 1 ? i : fallback;
}

const round2 = (n) => Math.round(n * 100) / 100;
const round3 = (n) => Math.round(n * 1000) / 1000;

/* ---------- step 1: the local Whisper server ---------- */

export const DEFAULT_STT_BASE = 'http://127.0.0.1:8000';
export const DEFAULT_STT_MODEL = 'whisper-1';

/**
 * The local Whisper server, in one shape.
 *
 * `configured` is true only when the owner has switched voice ordering on, because a feature that sends
 * audio to a server nobody started should stay dark rather than fail on every voice note. A base URL is
 * always returned so a caller can log where it *would* have gone.
 */
export function resolveStt(voice) {
  return {
    baseUrl: trimSlash(voice?.baseUrl) || DEFAULT_STT_BASE,
    model: String(voice?.model || '').trim() || DEFAULT_STT_MODEL,
    key: String(voice?.apiKey || '').trim(),
    configured: voice?.enabled === true
  };
}

const extFor = (mimeType) => {
  const m = String(mimeType || '').toLowerCase();
  if (m.includes('wav')) return 'wav';
  if (m.includes('mpeg') || m.includes('mp3')) return 'mp3';
  if (m.includes('mp4') || m.includes('m4a') || m.includes('aac')) return 'm4a';
  if (m.includes('webm')) return 'webm';
  return 'ogg';
};

/**
 * The multipart request to `fetch`, as `{ url, headers, body }`, for an OpenAI-compatible transcription
 * endpoint.
 *
 * `body` is a Buffer rather than a FormData so this stays pure and a test can open it up and prove the
 * audio bytes are inside. `boundary` is a fixed string for the same reason — the value only has to not
 * occur in the payload, and an OGG/Opus stream will not contain this marker.
 */
export function buildTranscribeRequest({ stt, audio, mimeType = 'audio/ogg', language = '', filename, boundary = '----m3posVoiceBoundary7f3a' } = {}) {
  const s = resolveStt(stt);
  const bytes = Buffer.isBuffer(audio) ? audio : Buffer.from(String(audio || ''), 'base64');
  const name = filename || `voice.${extFor(mimeType)}`;
  const field = (k, v) => Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`);
  const body = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${name}"\r\nContent-Type: ${mimeType}\r\n\r\n`),
    bytes,
    Buffer.from('\r\n'),
    field('model', s.model),
    field('response_format', 'json'),
    ...(language ? [field('language', language)] : []),
    Buffer.from(`--${boundary}--\r\n`)
  ]);
  const headers = { 'content-type': `multipart/form-data; boundary=${boundary}`, 'content-length': String(body.length) };
  if (s.key) headers.authorization = `Bearer ${s.key}`;
  const url = /\/v1$/.test(s.baseUrl) ? `${s.baseUrl}/audio/transcriptions` : `${s.baseUrl}/v1/audio/transcriptions`;
  return { url, headers, body, boundary };
}

/** The transcript, whichever shape the local server answered with. '' rather than a throw on junk. */
export function parseTranscription(body) {
  let b = body;
  if (typeof b === 'string') {
    try { b = JSON.parse(b); } catch { return b.trim(); }
  }
  if (b && typeof b.text === 'string') return b.text.trim();
  return '';
}

/* ---------- step 2: the transcript becomes named items ---------- */

/**
 * The instruction that turns a transcript into item names.
 *
 * Only in-stock products are shown, and `match` must be copied from that list — so a model that
 * recognises "পনির" can point at Cheese, but it cannot conjure a product, a price or a quantity. The
 * substitutes for anything unmatched are also drawn from the list, which is what makes the "we don't
 * have X, but we have Y" reply possible without the model being allowed to invent Y either.
 */
export function buildVoiceOrderPrompt({ storeName = 'the shop', products = [], transcript = '' } = {}) {
  const catalog = products
    .filter((p) => p && p.stock > 0)
    .slice(0, 200)
    .map((p) => ({ name: p.name, price: p.price, unit: p.soldByWeight ? 'kg' : 'pcs', category: p.category || '' }));
  return (
    `You are the ordering assistant for ${storeName}, a small shop in India. A customer sent a voice ` +
    'message and it has been transcribed, possibly badly. It may be in English, Hindi, Bengali or a mix.\n\n' +
    `Transcript: """${clip(transcript, 1200)}"""\n\n` +
    `In-stock catalogue (JSON):\n${JSON.stringify(catalog)}\n\n` +
    'Work out what they want to order. Match each item to ONE product by meaning, not by spelling ' +
    '(for example "pyaz" or "পেঁয়াজ" is Onion), and copy the match. Respond with JSON only, in exactly ' +
    'this shape:\n' +
    '{"lang":"en|hi|bn|...","items":[{"spoken":"what they said","match":"exact name from the catalogue",' +
    '"qty":1}],"unavailable":[{"spoken":"what they said","alternatives":["name from the catalogue"]}]}\n\n' +
    'Rules, all firm:\n' +
    '- "match" and every "alternatives" name must be copied EXACTLY from the catalogue. Never invent a ' +
    'product. If nothing in the catalogue is close, leave the lists for that item empty.\n' +
    '- A product they asked for that is not in the catalogue goes in "unavailable", with up to 3 close ' +
    'substitutes from the catalogue.\n' +
    '- "qty" is a whole number of pieces, or kilograms for items sold by kg. Default it to 1.\n' +
    '- Do not state prices. They are not yours to decide.\n' +
    '- An empty "items" list is a valid answer when nothing was understood.\n' +
    '- "lang" is the language the customer spoke.\n' +
    '- Plain JSON only. No markdown, no text before or after.'
  );
}

/** The product a name points at, or null. Exact name/sku first, then a letters-only comparison. */
function matchProduct(products, ref) {
  const wanted = String(ref || '').trim();
  if (!wanted) return null;
  const lower = wanted.toLowerCase();
  const exact = products.find((p) => String(p.name).toLowerCase() === lower || (p.sku && String(p.sku).toLowerCase() === lower));
  if (exact) return exact;
  const n = norm(wanted);
  if (!n) return null;
  return (
    products.find((p) => norm(p.name) === n) ||
    products.find((p) => norm(p.sku) === n && p.sku) ||
    products.find((p) => norm(p.name).includes(n) || n.includes(norm(p.name))) ||
    null
  );
}

/**
 * The order the transcript really asks for, checked against the shelf.
 *
 * This is where the model stops and the shop starts. A `match` that names nothing becomes unavailable;
 * an item with no stock becomes unavailable; a quantity larger than the shelf is trimmed to what is
 * there and flagged as trimmed. Nothing here can produce a line for a product the shop does not sell or
 * at a price the model made up — the price always comes from the matched product.
 *
 * @returns {{ok:true, lang:string, items:object[], unavailable:{spoken:string,alternatives:{name:string,price:number}[]}[], total:number}
 *          | {ok:false, error:string}}
 */
export function parseVoiceOrder(text, { products = [], max = 30 } = {}) {
  const parsed = firstJson(text);
  if (!parsed || typeof parsed !== 'object') return { ok: false, error: 'unreadable' };

  const lang = /^[a-z]{2}$/i.test(String(parsed.lang || '')) ? String(parsed.lang).toLowerCase() : 'en';
  const sellable = products.filter((p) => p && p.stock > 0);

  const items = [];
  const unavailable = [];
  const seen = new Set();
  const missingByKey = new Map();

  const addItem = (raw) => {
    const spoken = clip(raw?.spoken ?? raw?.name ?? raw?.text, 60);
    const p = matchProduct(sellable, raw?.match ?? raw?.name ?? raw?.text);
    if (!p || seen.has(p.id)) return false;
    seen.add(p.id);
    let qty = p.soldByWeight ? num(raw?.qty) : positiveInt(raw?.qty, 1);
    if (p.soldByWeight) {
      if (qty == null || !(qty > 0) || qty > 999) qty = 1;
      qty = round3(qty);
    }
    // Asking for more than the shelf holds is not a rejection: what there is goes in the order and the
    // line is flagged with what they actually asked for, so the reply can say "you asked for 10, only 4
    // are left, added 4" rather than silently dropping it.
    const requested = qty;
    const trimmed = qty > p.stock;
    if (trimmed) qty = p.soldByWeight ? round3(p.stock) : p.stock;
    items.push({
      id: p.id,
      sku: p.sku,
      name: p.name,
      price: p.price,
      qty,
      ...(p.soldByWeight ? { weightKg: qty, pricePerKg: p.price, isWeight: true, declaredWeight: true } : {}),
      ...(spoken ? { spoken } : {}),
      ...(trimmed ? { trimmedFrom: requested } : {})
    });
    return true;
  };

  // A missing item may arrive twice: once as an item the model could not match (no substitutes named),
  // and once by the name in "unavailable" (with substitutes). They are merged by their spoken words so
  // the substitutes are not lost to whichever came first.
  const addMissing = (raw) => {
    const spoken = clip(raw?.spoken ?? raw?.name ?? raw?.text, 60);
    const key = norm(spoken);
    if (!spoken || !key) return;
    let entry = missingByKey.get(key);
    if (!entry) {
      entry = { spoken, alternatives: [] };
      missingByKey.set(key, entry);
      unavailable.push(entry);
    }
    const altSeen = new Set(entry.alternatives.map((a) => a.name));
    for (const a of Array.isArray(raw?.alternatives) ? raw.alternatives.slice(0, 6) : []) {
      const p = matchProduct(sellable, typeof a === 'string' ? a : a?.name);
      if (!p || seen.has(p.id) || altSeen.has(p.name)) continue;
      altSeen.add(p.name);
      entry.alternatives.push({ name: p.name, price: p.price });
      if (entry.alternatives.length >= 3) break;
    }
  };

  for (const raw of Array.isArray(parsed.items) ? parsed.items : []) {
    if (items.length >= max) break;
    if (!addItem(raw)) addMissing(raw);
  }
  for (const raw of Array.isArray(parsed.unavailable) ? parsed.unavailable : []) {
    addMissing(raw);
  }

  const total = round2(items.reduce((s, i) => s + i.price * i.qty, 0));
  return { ok: true, lang, items, unavailable, total };
}

/* ---------- step 3: the reply the customer reads ---------- */

const money = (n) => `₹${(Math.round(n * 100) / 100).toFixed(2)}`;

const T = {
  head: (s) => `🛒 *${s}* — here is what I heard:`,
  line: (it) => `${it.weightKg != null ? `${it.weightKg} kg` : `${it.qty} x`} ${it.name} — ${money(it.price * it.qty)}`,
  trimmed: (it) => `(You asked for ${it.trimmedFrom}, but only ${it.qty} ${it.isWeight ? 'kg' : ''} are left, so I added that much.)`.replace('  ', ' '),
  notAvail: 'Not available right now:',
  noSub: (u) => `• ${u.spoken} — sorry, we don\'t have that.`,
  sub: (u) => `• ${u.spoken} — we don\'t have it, but we have: ${u.alternatives.map((a) => `${a.name} (${money(a.price)})`).join(', ')}.`,
  total: (t) => `Total: *${money(t)}*`,
  ask: 'Write "yes" to place this order, or "cancel" to drop it.',
  noItems: 'Please send another voice note, or write the item numbers you need.',
  nothing: "Sorry, I couldn't make out any items. Please send the voice note again, or write your item numbers."
};

/**
 * The reply, built here and not by the model.
 *
 * The customer is confirming a real order, so the numbers in this message have to be the ones the shop
 * will bill — the matched product, its price and the trimmed quantity — not a sentence a model wrote
 * about them. It is written in English only: the shop wants one English bill, while the note itself is
 * still understood in whatever language it was spoken. Building it here rather than asking a model to
 * phrase it also means the reply is identical whether or not the network is up.
 */
export function buildVoiceOrderReply({ storeName = 'the shop', verdict } = {}) {
  const { items = [], unavailable = [], total = 0 } = verdict || {};
  if (!items.length && !unavailable.length) return T.nothing;

  const lines = [];
  if (items.length) {
    lines.push(T.head(storeName));
    for (const it of items) {
      lines.push(T.line(it));
      if (it.trimmedFrom != null) lines.push(T.trimmed(it));
    }
    lines.push('', T.total(total));
  } else {
    lines.push(T.head(storeName));
  }

  if (unavailable.length) {
    lines.push('', T.notAvail);
    for (const u of unavailable) {
      lines.push(u.alternatives.length ? T.sub(u) : T.noSub(u));
    }
  }

  // Only offer to confirm when there is something to confirm; if nothing matched, say so instead of
  // inviting a "yes" that would place an empty order.
  lines.push('', items.length ? T.ask : T.noItems);
  return lines.join('\n');
}
