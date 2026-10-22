// Pure message-building and order-parsing logic for the WhatsApp bot. No network code here on
// purpose — this file has no dependency on the WhatsApp connection, so it can be tested on its
// own. whatsapp.js (the actual connection, using Baileys) calls into these functions.

const money = (n) => `₹${(Math.round(n * 100) / 100).toFixed(2)}`;
const roundKg = (n) => Math.round(n * 1000) / 1000;

// Words a customer may type instead of the English command. The English word is always accepted; the
// Bengali ones are kept because a Bengali-speaking customer may type the word they know, and the bot
// answers in English regardless. The bot's own messages never advertise them.
const CMD = {
  menu: ['menu', 'মেনু', 'তালিকা'],
  cancel: ['cancel', 'বাতিল'],
  yes: ['yes', 'y', 'ha', 'haa', 'হ্যাঁ', 'হ্যা', 'জি'],
  cash: ['cash', 'no', 'n', 'ক্যাশ', 'না'],
  upi: ['upi', 'gpay', 'googlepay', 'phonepe', 'phonepe', 'paytm', 'যপি'],
  skip: ['skip', 'na', 'nahi', 'none', 'no name', '-', 'x', 'নাই', 'এড়িয়ে', 'নাম নেই', 'কিছু না'],
  // Only used to opt somebody out of the announcements the shop sends now and then. Nothing here
  // advertises it; the announcement itself says how to stop receiving them.
  stop: ['stop', 'unsubscribe', 'optout', 'opt out']
};

/** True when the customer's message means the given command, in either script. */
export const isCmd = (text, cmd) => CMD[cmd].includes(String(text ?? '').trim().toLowerCase());

/** True when the customer is asking not to be sent announcements any more. */
export const isOptOut = (text) => isCmd(text, 'stop');

/**
 * Products a customer can order over WhatsApp: anything in stock. Items sold by weight are
 * included — the customer declares how many kilos they want and the shop confirms the real weight
 * on the scale at the counter, so the declared weight is an estimate until then.
 */
export function sellableCatalog(products) {
  return products.filter((p) => p.stock > 0);
}

export function buildCatalogText(storeName, products) {
  const list = sellableCatalog(products);
  if (!list.length) return `🙏 ${storeName}\n\nSorry, there are no items available to order right now. Please try again a little later.`;
  const lines = list.map((p, i) => `${i + 1}. ${p.name} — ${money(p.price)}${p.soldByWeight ? '/kg' : ''}`);
  // The kg example has to name the item's real position in THIS list, or it silently points the
  // customer at whatever product happens to sit at that number today.
  const firstWeightAt = list.findIndex((p) => p.soldByWeight);
  const hasWeight = firstWeightAt !== -1;
  return [
    `🛒 *${storeName}*`,
    ...lines,
    '',
    'To order, write the item numbers separated by commas.',
    'Example: 1,1,3  (means 2 of item 1, 1 of item 3)',
    'Or: 1x2, 3x1  (item 1: 2, item 3: 1)',
    ...(hasWeight ? [
      '',
      'Items sold by weight (per kg): after the item number, write "x" and then the kilos.',
      `Example: ${firstWeightAt + 1}x1.5  (means 1.5 kg of ${list[firstWeightAt].name})`
    ] : []),
    '',
    'Write "menu" to see this list again, or "cancel" to cancel your order.',
    // The one line that makes the complaint feature findable. Everything else about it works on
    // natural language, but a customer who does not know they can complain will never find out, and
    // this is the only place they are told.
    `Problem with an order? Just write what happened, or write "complain".`,
    'Write "help" to see everything I understand.'
  ].join('\n');
}

/**
 * Parses a customer's reply against the current catalogue.
 *
 * Note the two different shapes a weighed item takes, both of which are correct for where they are
 * used — do not "fix" one to match the other:
 *   - the parsed order (this function's output, saved to wa-orders.json, drawn on the bill) stores
 *     `price` as the per-kg rate and `qty` as the kg, so `price * qty` is the line total;
 *   - a cart line (public/js/cart.js) stores `price` as the line total with `qty` of 1, because
 *     that is the shape cart totals and the checkout expect of a weighed line.
 * @returns {{ok:true, items:{id:string,sku:string,name:string,price:number,qty:number}[], total:number}
 *          | {ok:false, error:string}}
 */
export function parseOrder(products, text) {
  const list = sellableCatalog(products);
  if (!list.length) return { ok: false, error: 'no-catalog' };
  const tokens = String(text ?? '').split(',').map((t) => t.trim()).filter(Boolean);
  if (!tokens.length) return { ok: false, error: 'empty' };
  if (tokens.length > 40) return { ok: false, error: 'too-many' };

  const qtyByIndex = new Map(); // 1-based menu position -> total qty (or kg) requested
  for (const tok of tokens) {
    // The number after "x" is a piece count for a normal item and a weight in kg for a weight item,
    // so it may be fractional (0.5 kg) — but only for weight items.
    const m = /^(\d+)\s*(?:[xX*]\s*(\d+(?:\.\d{1,3})?))?$/.exec(tok);
    if (!m) return { ok: false, error: `bad-token:${tok}` };
    const idx = Number(m[1]);
    if (idx < 1 || idx > list.length) return { ok: false, error: `bad-index:${tok}` };
    const p = list[idx - 1];
    const want = m[2] !== undefined ? Number(m[2]) : 1;
    if (p.soldByWeight) {
      if (!(want > 0) || want > 999) return { ok: false, error: `bad-qty:${tok}` };
      qtyByIndex.set(idx, roundKg((qtyByIndex.get(idx) || 0) + want));
    } else {
      if (!Number.isInteger(want) || want < 1 || want > 999) return { ok: false, error: `bad-qty:${tok}` };
      qtyByIndex.set(idx, (qtyByIndex.get(idx) || 0) + want);
    }
  }

  const items = [];
  for (const [idx, qty] of qtyByIndex) {
    const p = list[idx - 1];
    // A declared weight is checked against stock in kg, but it stays an estimate: the shop
    // re-weighs at the counter, so declaredWeight marks the line as one the cashier must confirm.
    if (p.soldByWeight) {
      if (qty > p.stock) return { ok: false, error: `stock:${p.name}` };
      items.push({ id: p.id, sku: p.sku, name: p.name, price: p.price, qty, weightKg: qty, pricePerKg: p.price, isWeight: true, declaredWeight: true });
    } else {
      if (qty > p.stock) return { ok: false, error: `stock:${p.name}` };
      items.push({ id: p.id, sku: p.sku, name: p.name, price: p.price, qty });
    }
  }
  const total = Math.round(items.reduce((s, i) => s + i.price * i.qty, 0) * 100) / 100;
  return { ok: true, items, total };
}

export function buildOrderSummaryText(order) {
  const lines = order.items.map((i) => (i.isWeight
    ? `${i.weightKg} kg x ${i.name} — ${money(i.pricePerKg)}/kg = ${money(i.weightKg * i.pricePerKg)}`
    : `${i.qty} x ${i.name} — ${money(i.price * i.qty)}`));
  const weighed = order.items.some((i) => i.isWeight);
  return [
    'Your order:',
    ...lines,
    '',
    `Total: *${money(order.total)}*`,
    ...(weighed ? ['', 'For loose items sold by weight, the kilos above are an estimate. We will weigh them at the counter and bill the exact weight.'] : []),
    '',
    'If everything is correct, write "yes" to confirm your order, or "cancel" to cancel it.'
  ].join('\n');
}

/** Sent right after the customer confirms, before we know how they want to pay. */
export function buildPaymentPromptText(storeName, orderCode, total) {
  return [
    `✅ Order (${orderCode}) received — ${money(total)}`,
    '',
    'How would you like to pay? Write "upi" or "cash".'
  ].join('\n');
}

/** Caption on the bill image. Kept short — WhatsApp truncates long captions. */
export const buildBillCaptionText = (orderCode, method) =>
  method === 'upi'
    ? `Bill ${orderCode} — scan the QR to pay`
    : `Bill ${orderCode} — cash, pay at the counter`;

export const buildUpiUnavailableText = () =>
  'Sorry, online payment is not available at the moment. Please pay cash at the counter. Thank you!';

/* ---------- payment screenshots ---------- */
// After the bot sends a bill with a UPI QR, the customer pays in their UPI app and sends a
// screenshot of the payment. It is filed against their most recent order so the shop can check the
// money arrived, and the customer is told it got there — a screenshot that vanishes into silence
// reads as "the shop ignored my payment".

/** Sent when a payment screenshot was received and filed against an order. */
export const buildPaymentProofSavedText = () =>
  '✅ Thank you! I have passed your payment screenshot to the shop. They will confirm your order shortly.';

/** Sent when an image arrived but no order could be found to attach it to. */
export const buildNoOrderForProofText = () =>
  'I can only keep a payment screenshot for an order. Write "menu" to place an order, and send the screenshot here after your bill.';

/** Sent when the image itself could not be downloaded or read. */
export const buildPaymentProofUnreadableText = () =>
  'Sorry, I could not open that image. Please send the payment screenshot again.';

/** Confirms somebody who asked not to receive the shop's announcements any more. */
export const buildOptOutText = () =>
  'Done — you will not get announcement messages from us again. Write "menu" any time to place an order.';

/* ---------- announcements ---------- */
/**
 * The one-off message the shop sends its saved customers about voice ordering. Voice notes are
 * translated to an order read back for confirmation, so the message says what a customer should
 * actually do (press the microphone) rather than naming the feature.
 *
 * Kept as a builder (not a bare string) because it is stored on disk in the send log, and because
 * the shop name has to be in it — an announcement that does not say who it is from looks like spam.
 */
export function buildAnnouncementText(storeName) {
  const store = String(storeName || 'Our shop');
  return [
    `📣 *${store}* now takes orders by *voice note* on WhatsApp!`,
    '',
    'Just hold the microphone and say what you need — for example "2 kg rice and a packet of milk".',
    'I will write it down and read it back for you to confirm before billing.',
    '',
    'You can still type your order the usual way — write "menu" to see the items.',
    '',
    'Reply "stop" if you would rather not get messages like this again.'
  ].join('\n');
}

/**
 * The phone numbers an announcement should go to: every saved customer, minus anyone who has asked
 * to stop. Kept pure and here rather than inline in server.js so the two ways this goes wrong —
 * a customer being messaged twice, or somebody who said "stop" being messaged anyway — are testable
 * without a WhatsApp account.
 *
 * Numbers are normalised to their 10 digits and de-duplicated, because customers.json is keyed by
 * number but may carry older entries in other shapes.
 *
 * @param {Record<string, unknown>} customers the customers file, keyed by phone
 * @param {Record<string, unknown>} optOut phone -> true for anyone who asked to stop
 * @returns {string[]} sorted 10-digit numbers
 */
export function announcementRecipients(customers = {}, optOut = {}) {
  const seen = new Set();
  for (const key of Object.keys(customers || {})) {
    const d = String(key ?? '').replace(/\D/g, '');
    if (d.length !== 10) continue;      // not an Indian mobile number we can actually send to
    if (optOut?.[d]) continue;          // they asked us to stop
    seen.add(d);
  }
  return [...seen].sort();
}

export const buildWelcomeText = (storeName) =>
  `🙏 Welcome to ${storeName}!\n\nWrite "menu" on this WhatsApp number to start your order.`;

/**
 * Sent the moment a WhatsApp order's bill is charged. The 4-digit code is how the delivery is
 * confirmed: the customer reads it out, the delivery boy types it into the till, and only then does
 * the order count as delivered. That stops an order being marked delivered without the goods
 * actually reaching the customer.
 * @param {{code:string, itemCount:number, orderId:string}} d
 */
/**
 * Sent to the customer the moment the bill is charged. Deliberately says nothing about the delivery
 * yet: the parcel is still in the shop, and a boy who never collects it should not have already told
 * the customer it is on its way. No QR and no code go out at this point either.
 * @param {{orderId:string, itemCount:number, boyName?:string}} d
 */
export function buildPackedText(storeName, d) {
  const n = d.itemCount;
  return [
    `📦 ${storeName} — your order (${d.orderId}) has been billed and is being packed.`,
    '',
    `Your order has ${n} ${n === 1 ? 'item' : 'items'}.`,
    ...(d.boyName ? ['', `${d.boyName} will collect it from the shop and bring it to you.`] : []),
    '',
    'We will message you as soon as it leaves the shop for delivery. Thank you! 🙏'
  ].join('\n');
}

/**
 * Sent with the handover QR picture (as its caption), and on its own as a fallback when the picture
 * could not be sent. The two have to differ: as a caption there really is a QR code above it, but in
 * the fallback there is not, and telling a customer to show a code they cannot see is worse than
 * sending no picture at all.
 * @param {{orderId:string, itemCount:number, code:string, boyName?:string, boyPhone?:string}} d
 * @param {{hasQr?:boolean}} [opts]
 */
export function buildOutForDeliveryText(storeName, d, { hasQr = false } = {}) {
  const n = d.itemCount;
  const how = hasQr
    ? [
        'Show the QR code above to the delivery boy when your order arrives — he just sends it back to us and your order is marked delivered.',
        '',
        `No QR reader handy? Just tell him this code instead: *${d.code}*`
      ]
    : [`When your order arrives, please tell the delivery boy this code: *${d.code}*`];
  return [
    `🛵 ${storeName} — your order (${d.orderId}) is out for delivery.`,
    '',
    `Your order has ${n} ${n === 1 ? 'item' : 'items'}.`,
    // Naming the boy is worth doing: the customer knows who to expect and can ask for him by name
    // instead of describing an unnamed rider to whoever opens the door.
    ...(d.boyName ? ['', `*${d.boyName}* is bringing it to you${d.boyPhone ? ` (${d.boyPhone})` : ''}.`] : []),
    '',
    ...how,
    '',
    'Please keep the code to yourself — it is what proves the order reached you.',
    '',
    'Thank you! 🙏'
  ].join('\n');
}


/**
 * Sent to the delivery boy when a WhatsApp order's bill is charged. It carries the customer's number
 * so he can call ahead, and it starts with collecting the parcel: he scans the sticker on the package
 * at the shop, and only that scan tells the customer the order is on its way. Only later, at the
 * door, does he need the customer to read out their code — and he is deliberately never told it
 * himself, so an order can't be closed at pickup without the goods actually reaching the customer.
 * @param {{orderId:string, customer:string, items:string, total:number}} d
 */
export function buildDeliveryJobText(storeName, d) {
  return [
    `🛵 New delivery — ${storeName}`,
    '',
    `Bill: *${d.orderId}*`,
    `Customer: ${d.customer}`,
    `Items: ${d.items}`,
    `Amount: *${money(d.total)}*`,
    '',
    '1. Come to the shop and send me a photo of the QR sticker on the package.',
    '   That is when the customer is told the order is out for delivery.',
    '2. At the customer\'s door, get the 4-digit code from them and send me that.',
    '',
    'Cannot take this one? Reply "can\'t" and the shop will give it to somebody else.',
    '',
    "The customer's number is here too, in case you want to call ahead."
  ].join('\n');
}

/** The boy scanned the package sticker at the shop. */
export function buildPickupOkText(orderId, notified) {
  return [
    `✅ Collected — bill *${orderId}*.`,
    '',
    notified
      ? 'The customer has now been told it is out for delivery, and sent the code you will need at the door.'
      : 'The customer could not be messaged. Tell the shop before you go — they will send it again.',
    '',
    'Take it to the customer and send me the 4-digit code they give you.'
  ].join('\n');
}

/** The sticker was scanned again for a parcel that is already with a boy. */
export function buildPickupAlreadyText(orderId) {
  return `You already collected bill *${orderId}*. Take it to the customer and send me the 4-digit code they give you.`;
}

/**
 * The customer tried to hand over their code for a parcel that is still sitting in the shop. Without
 * this the shop could mark an order delivered for goods nobody has collected.
 */
export function buildNotPickedUpText(orderId) {
  return [
    `Not yet — bill *${orderId}* is still in the shop.`,
    '',
    'First send me a photo of the QR sticker on the package, then get the code from the customer at the door.'
  ].join('\n');
}

/** Nothing was actually assigned to him, so "can't" is not a decline of anything. */
export const buildDeliveryBoyNothingToDeclineText = () =>
  'You have no parcels waiting at the shop right now. Send a photo of the QR sticker on a package, or the 4-digit code a customer gives you.';

/** The boy handed the job back, so the cashier can give it to somebody else. */
export const buildDeliveryDeclinedText = (storeName, orderId) =>
  `👍 Job *${orderId}* handed back to ${storeName}. They will give it to another delivery boy. Thank you!`;

/**
 * Sent once the delivery boy has entered the code, so the customer has a receipt of the fact. It
 * names him too: if anything is wrong with the order the customer can say who handed it over, which
 * is the first thing the shop would otherwise have to ask.
 * @param {{orderId:string, boyName?:string}} d
 */
export function buildDeliveredText(storeName, d) {
  return [
    `✅ ${storeName} — your order (${d.orderId}) has been delivered.`,
    ...(d.boyName ? ['', `Delivered by *${d.boyName}*.`] : []),
    '',
    'Your order is now complete. If there is any problem at all, please talk to us. Thank you! 🙏'
  ].join('\n');
}

/** Sent to the customer when the shop issues a replacement code, so the old one is no longer valid. */
export function buildNewCodeText(storeName, d) {
  return [
    `🔄 ${storeName} — new delivery code for your order (${d.orderId}).`,
    '',
    `Show this *${d.code}* code to the delivery boy and the order will be marked "delivered".`,
    'The previous code no longer works.',
    // The rider may have changed since the first message — the boy on this run is the one the
    // customer will actually meet at the door, so the name is repeated with the new code.
    ...(d.boyName ? ['', `*${d.boyName}* will bring it to you.`] : []),
    '',
    'Thank you! 🙏'
  ].join('\n');
}

/* ---------- what a delivery boy gets back ---------- */

/** The code matched an order that was out. */
export const buildDeliveryOkText = (orderId) =>
  `✅ ${orderId} — delivery confirmed. We have let the customer know. Thank you!`;

/** The code is not any order that is currently out. */
export const buildDeliveryBadCodeText = () =>
  '⚠️ That code does not match any order. Please check with the customer and send the correct number. Thank you.';

/** The code matched, but that order was already handed over earlier. */
export const buildDeliveryAlreadyText = (orderId, at) =>
  `${orderId} was already delivered (${at}). It cannot be marked again.`;

/** Too many wrong codes in a row — the brute-force guard has locked him out for a few minutes. */
export const buildDeliveryLockedText = (mins) =>
  `⏳ Too many wrong codes. Please wait ${mins} minute${mins === 1 ? '' : 's'} and try again, or check the code with the customer.`;

/** He sent a photo but no readable QR code was in it — usually a blurry shot or the wrong image. */
export const buildDeliveryNoQrText = () =>
  '📷 I could not read a delivery code in that photo. Please send a clear, close-up picture of the QR code, or type the 4-digit code instead.';

/** The QR was read fine, but it belongs to no order that is still out for delivery. */
export const buildDeliveryBadQrText = () =>
  '⚠️ That QR code does not match any order that is still out for delivery. Please check with the customer.';

/**
 * Pulls a delivery code out of a delivery boy's message. People don't type a bare number every
 * time, so "8510", "done 8510" and "code is 8510" all have to work, but a 4-digit run that is part
 * of a longer number must never match — otherwise the customer's own phone number in the text
 * could be read as a code. Returns null unless there is exactly one candidate, so a message with
 * two numbers is asked to be sent plainly rather than guessed at.
 */
export const readDeliveryCode = (text) => {
  const found = [...String(text ?? '').matchAll(/(?:^|\D)(\d{4})(?!\d)/g)].map((m) => m[1]);
  return found.length === 1 ? found[0] : null;
};

/** Asked once the customer has confirmed the order, so the bill can carry a real name. */
export const buildNamePromptText = (storeName) =>
  `What name should we write on the bill? Please type it.\n\n(Or send "skip" if you would rather not say.)`;

const NAME_SKIP_WORDS = ['skip', 'na', 'nahi', 'none', '-', 'x', 'no name'];
const NAME_PAYMENT_WORDS = ['cash', 'no', 'n', 'upi', 'gpay', 'phonepe', 'paytm'];

/**
 * A customer the shop already knows is no longer asked their name, so they need a way to fix it
 * without cancelling and starting again.
 *
 * The phrase is required on purpose. Reading any unrecognised message as a name would mean a typo —
 * "casg" for "cash" — silently becomes the name on a printed bill and on the customer's record, and
 * that is much worse than having to ask.
 * -> { name: string } or null when the message is not a name change
 */
export function parseNameCommand(text) {
  // The capture is open-ended and cut afterwards, so a long name is truncated rather than making the
  // whole message unrecognised. "to" is optional because "change name to X" is how people say it.
  const m = /^(?:please\s+)?(?:change|update|set|correct)?\s*(?:my\s+)?name(?:\s+is)?(?:\s+to)?\s*[:\-]?\s+(.+)$/i
    .exec(text.trim());
  if (!m) return null;
  // The payment words are not names; "name: upi" is someone changing the subject, not their name.
  if (NAME_PAYMENT_WORDS.includes(m[1].trim().toLowerCase())) return null;
  return { name: m[1].trim().replace(/\s+/g, ' ').slice(0, 40) };
}

/** Confirms a name the customer has just corrected. */
export const buildNameChangedText = (name) =>
  `Thank you, ${name}. I have updated the name on your orders.\n\nWrite "menu" to see the item list.`;

/* ---------- complaints ---------- */
// How a customer actually complains, in the words people really use — including the ones that are
// not the word "complaint" at all. Missing these means the message falls through to "I did not
// understand that", which is the worst possible answer to someone who is already annoyed.
const COMPLAINT_WORDS = [
  'complain', 'complaint', 'complaints', 'problem', 'issue', 'wrong item', 'wrong item delivered',
  'damaged', 'broken', 'torn', 'leaking', 'missing item', 'not delivered', 'late delivery',
  'refund', 'bad quality', 'not good', 'unsatisfied', 'dissatisfied', 'poor quality',
  'short weight', 'less quantity', 'wrong quantity', 'expired', 'spoiled', 'rotten', 'no delivery',
  'did not come', 'didnt come', 'not working', 'faulty', 'wrong', 'mix up', 'mismatched',
  // Bengali. Enumerated words can never cover a whole language, so this list leans on the terms that
  // carry the complaint itself rather than trying to be complete.
  'অভিযোগ', 'সমস্যা', 'খারাপ', 'ভাঙা', 'ছিঁড়া', 'ছেঁড়া', 'নষ্ট', 'ফেরত', 'টাকা ফেরত', 'ডেলিভারি',
  'দেরি', 'সময়মতো', 'আসেনি', 'পাঠানো হয়নি', 'ভুল', 'কম', 'পরিবর্তন'
];

/**
 * Word order is the thing a fixed list cannot survive.
 *
 * "bad quality" is in the list above, but the ways people actually write are "the quality is very bad",
 * "quality is not good" and "this quality is poor" - none of which contain the listed phrase, so all
 * three fell through to the order parser and the customer was told the bot did not understand. That is
 * the worst possible answer to somebody who is already unhappy, and it is the complaint that was
 * reported from the live shop.
 *
 * These patterns are written to catch the meaning wherever the words fall, rather than one fixed
 * spelling. They are deliberately written to need a complaint-ish word *and* a topic word, so that an
 * order line ("2 rice", "1 kg oil") cannot match: a bare noun on its own is never enough.
 */
const COMPLAINT_PATTERNS = [
  // Quality, said the natural way round.
  /\b(quality|product|service|behaviour|behavior|packing|packaging|item|items|goods)\b[^.?!]{0,25}\b(bad|poor|low|terrible|awful|horrible|not good|not ok|not up to|not up|below standard|not proper|not right)\b/,
  /\b(bad|poor|low|terrible|awful|horrible|worst)\b[^.?!]{0,25}\b(quality|product|service|packing|behaviour|behavior|condition)\b/,
  // Unhappiness, said any of the usual ways.
  /\b(not|wasn'?t|isn'?t|never|don'?t)\s+(happy|satisfied|pleased|impressed)\b/,
  /\b(very|really|so|too|extremely|quite|very much)\s+(bad|poor|disappointed|disappointing|upset|angry|unhappy|frustrated|unacceptable)\b/,
  /\bdisappointed\b/,
  // Rude or poor treatment - one of the most common reasons anyone writes in at all.
  /\b(rude|unpolite|impolite|misbehaved|misbehave|unhelpful|argument|argued|fought|shouted|abusive|cheating)\b/,
  // Money: no change, short change, overcharged, wrong amount.
  /\b(no|not|did ?n[o']?t|never)\s+(give|gave|give back|return|returned|hand|handed|send|send back)\b[^.?!]{0,30}\b(change|money|cash|note|notes|coin|coins|rupees)\b/,
  /\b(overcharged|over charge|extra charge|charged extra|charged more|wrong amount|less money|short change|extra change|extra money)\b/,
  // Missing, wrong, short or extra items - the everyday phrasing, not just "missing item". The nouns
  // all take an optional plural, because "only 2 packets came" is the same complaint as "missing item"
  // and a \b after a singular noun silently fails to match the plural.
  /\b(missing|lost|without|no|not|less|fewer|extra|additional|different|wrong|incorrect|only)\b[^.?!]{0,25}\b(items?|pieces?|qtys?|quantit(?:y|ies)|kg|kgs|kilo|kilos|grams?|g|gm|bags?|parcels?|packages?|packets?|products?|goods?|pieces?)\b/,
  /\b(wrong|incorrect|different|not the same|not matching|mismatch)\b[^.?!]{0,30}\b(items?|products?|orders?|deliver(?:y|ies)|address|names?|quantit(?:y|ies)|amount|bills?)\b/,
  // Short weight, which is a different complaint from a short count and is worth filing on its own.
  /\b(short|less|fewer|under|not enough|insufficient|only|just)\b[^.?!]{0,25}\b(weight|weighed|weigh|kg|kgs|kilo|kilos|quantit(?:y|ies)|qty|amount|grams?|g|gm)\b/,
  // A weight or count that does not match what was asked for: "only 900g not 1kg", "2kg but I paid
  // for 5kg". Written this way because the numbers are the complaint, and neither is a listed word.
  /\b(only|just|not|less|short|instead)\b[^.?!]{0,30}\b\d+\s*(g|gm|kg|kgs|kilo|kilos|gram|grams|pcs|pieces|items?)\b/,
  // Late, or not delivered at all. "Arrived" and "reach" are in here alongside "come" and "delivered"
  // because that is how most people actually phrase it, and the misspellings are deliberate: nobody
  // types carefully while standing at a counter waiting for their order.
  /\b(late|delay|delayed|delaying|taking too long|took too long|not come|never came|did not come|didn'?t come|not received|did not receive|didn'?t receive|not recieve|not recieved|never received|still not|not delivered|never delivered|no delivery|nothing came|not arrive|never arrive|did not arrive|didn'?t arrive|not arrived|never arrived|has not arrived|hasn'?t arrived|not reached|never reached|still waiting)\b/,
  // Broken, spoiled, expired - and the everyday ways people describe it.
  /\b(rotten|spoiled|spoilt|expired|expiry|leaking|leaked|melted|rusty|corroded|mouldy|moldy|insect|insects|bug|bugs|worm|worms|cockroach|flies|dirty|dusty|already opened|open packet|tampered)\b/,
  // Fake or a duplicate of something else.
  /\b(fake|duplicate|duplicated|copy|imitation|nothing like|not original|not genuine)\b/,
  /\bwaste\s+(of\s+)?(my\s+)?(money|time)\b/,
  // Asking for something back, however they put it. "Change" is deliberately not in the return group:
  // "you did not give me change" is a money complaint and is caught above, while bare "change" is
  // also a perfectly ordinary word in an order.
  /\b(money back|refund|return the money|give me (my )?money back|compensate|compensation|exchange|replace|replacement)\b/,
  /\b(i want to|i'?d like to|can i|please|want to|need to|will you)\s*(return|send back|give back|take back|replace|exchange|refund)\b/,
  /\breturn\s+(the|this|that|my)?\s*(item|items|product|products|order|goods|parcel|package|packet)\b/,
  // A quantity that does not match what was paid for: "2kg but I paid for 5kg". The "but" comes
  // first, so the pattern has to allow the complaint word to sit anywhere in the clause.
  /\bbut\b[^.?!]{0,35}\b(paid|pay|gave|given|ordered|booked|should|supposed)\b[^.?!]{0,25}\b\d+\s*(kg|kgs|g|gm|gram|grams|rupees|rs)\b/,
  // The person who turned up with the order.
  /\b(delivery boy|delivery man|deliverer|rider|courier|agent|delivery)\b[^.?!]{0,35}\b(rude|late|drank|ate|took|stole|refuse|refused|left|didn'?t|did not|not come|never came|wrong|damaged|broken|was not|not there)\b/,
];

/**
 * Whether a message is a customer raising a problem with an order.
 *
 * Only used when the customer is not mid-order, so a legitimate order line can never be mistaken for
 * a complaint: "2 rice" and "rice was broken" are different lengths and shapes, and a bare product
 * name on its own is not in this list.
 */
export function mentionsComplaint(text) {
  const t = text.trim().toLowerCase();
  if (!t || t.length > 400) return false;
  if (COMPLAINT_WORDS.some((w) => t.includes(w))) return true;
  return COMPLAINT_PATTERNS.some((re) => re.test(t));
}

// Messages that announce a problem without describing one. Listing these beats trying to measure
// "enough information" by counting words: counting either keeps vague ones ("i have a problem") or
// throws away real ones, because the words that carry the meaning are ordinary English words.
const VAGUE_COMPLAINTS = new Set([
  'complaint', 'complaints', 'problem', 'issue', 'problems', 'issues', 'refund', 'bad', 'damaged',
  'broken', 'torn', 'wrong', 'poor', 'not good', 'not ok', 'not okay', 'bad quality', 'poor quality',
  'help', 'urgent', 'please', 'hello', 'hi', 'hey',
  'i have a problem', 'i have a complaint', 'i have an issue', 'i have a problem with my order',
  'there is a problem', 'there is an issue', 'there is a problem with my order',
  'problem with my order', 'issue with my order', 'order problem', 'delivery problem',
  // "wrong item", "missing item" and "short weight" are deliberately NOT here: they name the problem,
  // so they are worth filing on their own rather than sending the customer another question.
  'সমস্যা', 'সমস্যা হয়েছে', 'অভিযোগ', 'অভিযোগ আছে', 'সাহায্য', 'ফেরত', 'খারাপ'
]);

/**
 * Decides whether a complaint message says enough to file, and returns the text to file.
 *
 * The message stored is always the customer's own words. An earlier version stripped the trigger words
 * out before saving, which turned "I want a refund for the broken oil" into "I want a for the oil" —
 * useless to whoever has to act on it, and nonsense for the AI writing the reply. The trigger words
 * are now only used to recognise a complaint, never to rewrite it.
 *
 * @returns {string|null} the text to file, or null when it is too vague and the customer must be asked
 */
export function complaintDetail(text) {
  const original = text.trim().slice(0, 500);
  if (!original) return null;
  // Compared loosely: case, spacing and trailing punctuation are not the complaint.
  //
  // \p{M} has to be allowed through, and this is not a detail: Bengali, Hindi, Arabic and most other
  // scripts build words from combining marks, and those marks are not letters. Stripping everything
  // that is not a letter or digit silently cuts "সমস্যা" down to "সমস য", so every Bengali complaint
  // would fail to match and be treated as a vague one forever.
  const plain = original.toLowerCase().replace(/[^\p{L}\p{N}\p{M}\s]/gu, ' ').replace(/\s+/g, ' ').trim();
  if (!plain) return null;
  if (VAGUE_COMPLAINTS.has(plain)) return null;
  // A single word is a trigger, not a description. Two or more is something to act on.
  if (plain.split(' ').filter(Boolean).length < 2) return null;
  return original;
}

/**
 * Decides what should happen to an incoming message, for complaint purposes only.
 *
 * Exported and used by whatsapp.js rather than the condition being written inline there, because that
 * condition is the whole feature. It used to be inline, untested, and broken in the only way that
 * matters: a customer wrote "complain" and was told the bot did not understand, and nothing noticed,
 * because the tests called the helpers and never the routing. One function that both the handler and
 * the tests call cannot drift away from them.
 *
 * @param {string} text what the customer wrote
 * @param {string} step which step of the order flow they are on
 * @returns {{kind:'none'}|{kind:'file',detail:string}|{kind:'ask'}|{kind:'later'}}
 */
export function complaintRoute(text, step) {
  if (!mentionsComplaint(text)) return { kind: 'none' };
  // While they are confirming, naming or paying, the complaint is not acted on: a half-built order
  // must not be lost to a complaint, and "the packet was torn" contains words that parse as order
  // items. It used to be dropped silently here, so at the payment screen those words were read as an
  // order line instead. Saying "finish first, then tell me" is the difference between a fix and a
  // second problem.
  if (['confirming', 'naming', 'payment'].includes(step)) return { kind: 'later' };
  const detail = complaintDetail(text);
  return detail ? { kind: 'file', detail } : { kind: 'ask' };
}

/** Said when a customer complains part-way through paying, so the complaint is held, not dropped. */
export const buildComplainLaterText = () =>
  'Finish paying first, then tell me what happened with your order and I will pass it to the shop.';

/** Asked when a customer complains but has not yet said what about. */
export const buildComplaintPromptText = () => [
  `I am sorry to hear that. Please tell us what went wrong and we will get it sorted out.`,
  ``,
  `You can write it all in one message — for example "the rice packet was torn".`,
  ``,
  `Write "menu" if you would rather carry on with your order.`
].join('\n');

/** Sent when the AI could not be reached, so the customer still gets a reference to quote. */
export const buildComplaintSavedText = (id, storeName) => [
  `We are sorry about this, and we have noted it down.`,
  ``,
  `Your complaint reference is ${id}. Please keep it — ${storeName || 'the shop'} can look it up straight away.`,
  ``,
  `${storeName || 'The shop'} will call you back shortly to sort it out.`
].join('\n');

/**
 * Reads the customer's answer to the name question. The reply is free text, but two kinds of
 * message have to be taken out before it can be read as a name: the payment words (someone typing
 * "cash" is telling us how to pay, not that their name is Cash) and the ways people decline to give
 * one. Names go on a printed bill and are looked up on every later visit, so they are squashed to
 * single spaces and cut to a sensible length.
 * -> { name: string ('' when skipped), isPayment: bool }
 */
export function parseNameReply(text) {
  const lower = text.trim().toLowerCase();
  if (NAME_PAYMENT_WORDS.includes(lower)) return { name: '', isPayment: true };
  if (NAME_SKIP_WORDS.includes(lower)) return { name: '', isPayment: false };
  return { name: text.trim().replace(/\s+/g, ' ').slice(0, 40), isPayment: false };
}

/** Shown when a delivery boy messages anything that is not a code. */
export const buildDeliveryBoyHelpText = () => [
  'You are registered as a delivery boy.',
  '',
  'To collect a parcel from the shop, send a photo of the QR sticker on the package.',
  'To finish a delivery, write the 4-digit code the customer gives you at the door.',
  'Reply "menu" to see this again.'
].join('\n');

export const buildCancelledText = () => 'Your order has been cancelled. Write "menu" to start a new one.';

// Two different messages that used to be the same string, which is why somebody typing "help" was
// told the bot had not understood them.
export const buildHelpText = (storeName = 'the shop') => [
  `🛒 *${String(storeName || 'the shop')}*`,
  '',
  'Here is everything I understand:',
  '• "menu" — the item list',
  '• "1,1,3" or "2x1.5" — order items (number, or number x kilos for loose items)',
  '• "yes" — confirm your order',
  '• "upi" or "cash" — how you want to pay',
  '• "cancel" — cancel the order you are making',
  '• "complain" — report a problem with an order, then tell me what happened',
  '• "name Rahim" — change the name on your order',
  '',
  'You can also send a voice note saying what you need — I will write it down and read it back to you.',
  '',
  'If you pay by UPI, send a screenshot of the payment here after your bill so the shop can check it received.',
  '',
  'To report a problem, just write what happened in your own words — you do not need any special word.'
].join('\n');
export const buildNotUnderstoodText = () => 'I did not understand that 🙏 Write "menu" to see the item list.';

/* ---------- voice notes ---------- */

/**
 * Sent the moment a voice note arrives, before the transcript is ready. Speech-to-text plus the model
 * take a few seconds, and a customer who just spoke into their phone needs to know it landed rather
 * than assume it failed and send it three more times.
 */
export const buildVoiceListeningText = () => '🎤 One moment — I am listening to your voice note…';

/** Said when the shop has not switched voice ordering on. The written flow still works, and is named. */
export const buildVoiceOffText = () =>
  'I am sorry, voice ordering is not switched on here yet. Please write your item numbers, or write "menu".';

/** Said when the voice note could not be read at all — it could not be fetched, or yielded no words. */
export const buildVoiceUnclearText = () =>
  'Sorry, I could not make out that voice note. Please try again, or write your items and I will take the order.';

