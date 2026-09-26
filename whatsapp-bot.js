// Pure message-building and order-parsing logic for the WhatsApp bot. No network code here on
// purpose — this file has no dependency on the WhatsApp connection, so it can be tested on its
// own. whatsapp.js (the actual connection, using Baileys) calls into these functions.

const money = (n) => `₹${(Math.round(n * 100) / 100).toFixed(2)}`;
const roundKg = (n) => Math.round(n * 1000) / 1000;

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
    'Write "menu" to see this list again, or "cancel" to cancel your order.'
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

export const buildHelpText = () => 'I did not understand that 🙏 Write "menu" to see the item list.';
