// Cart state (framework-free, no DOM). Components subscribe and re-render on change.
// waCode is the WhatsApp order (WA-…) this sale came from, so the server knows to start a delivery
// and message the customer once the bill is paid. Null for a sale started at the till.
const state = { items: new Map(), rule: { type: 'percent', value: 0 }, waCode: null };
const listeners = new Set();

const round2 = (n) => Math.round(n * 100) / 100;

export function totals() {
  const items = [...state.items.values()];
  const subtotal = round2(items.reduce((s, i) => s + i.price * i.qty, 0));
  const raw = state.rule.type === 'percent'
    ? (subtotal * Math.min(state.rule.value, 100)) / 100
    : Math.min(state.rule.value, subtotal);
  const discountAmount = round2(raw);
  return {
    subtotal,
    discountAmount,
    total: Math.max(0, round2(subtotal - discountAmount)),
    count: items.reduce((s, i) => s + i.qty, 0)
  };
}

export function snapshot() {
  return { items: [...state.items.values()].map((i) => ({ ...i })), rule: { ...state.rule }, waCode: state.waCode, ...totals() };
}

const emit = () => { const s = snapshot(); listeners.forEach((fn) => fn(s)); };

export function subscribe(fn) {
  listeners.add(fn);
  fn(snapshot());
  return () => listeners.delete(fn);
}

/** @returns {{ok:boolean, reason?:string}} */
export function addItem(product, qty = 1) {
  const key = product.sku;
  const cur = state.items.get(key);
  const next = (cur?.qty || 0) + qty;
  if (next > product.stock) return { ok: false, reason: 'stock' };
  state.items.set(key, { ...product, key, qty: next });
  emit();
  return { ok: true };
}

/**
 * Adds a one-off "sold by weight" line from a redeemed weighing-station ticket. Each ticket is its
 * own line (never merged with another): re-scanning the same ticket is rejected by the server.
 */
export function addWeightLine(ticket) {
  const key = `wt:${ticket.code}`;
  state.items.set(key, {
    key, sku: ticket.sku, name: ticket.name, price: ticket.price, qty: 1,
    weightKg: ticket.weightKg, pricePerKg: ticket.pricePerKg, isWeight: true
  });
  emit();
}

/**
 * Adds a "sold by weight" line a customer declared over WhatsApp (e.g. "2 kg rice"). Unlike a
 * ticket line, this weight is only the customer's claim, so it stays editable: the cashier types
 * in whatever the scale actually reads via setWeightKg, and the line re-prices itself.
 * @returns {{ok:boolean, reason?:string}}
 */
export function addDeclaredWeightLine(product, kg) {
  const weightKg = Math.round(kg * 1000) / 1000;
  if (!(weightKg > 0)) return { ok: false, reason: 'weight' };
  if (weightKg > product.stock) return { ok: false, reason: 'stock' };
  const key = `waw:${product.sku}`;
  state.items.set(key, {
    key, sku: product.sku, name: product.name,
    price: round2(product.price * weightKg), qty: 1, // a weighed line is qty 1 of a line total
    weightKg, pricePerKg: product.price, isWeight: true, declaredWeight: true, stock: product.stock
  });
  emit();
  return { ok: true };
}

/**
 * Corrects a declared weight to the real scale reading. Ticket lines are immutable — their weight
 * came off the scale — so this refuses anything that isn't a declared line.
 * @returns {{ok:boolean, reason?:string}}
 */
export function setWeightKg(key, kg) {
  const it = state.items.get(key);
  if (!it || !it.isWeight || !it.declaredWeight) return { ok: false, reason: 'not-declared' };
  const weightKg = Math.round(Number(kg) * 1000) / 1000;
  if (!(weightKg > 0)) return { ok: false, reason: 'weight' };
  const cap = it.stock ?? Infinity;
  if (weightKg > cap) return { ok: false, reason: 'stock' };
  it.weightKg = weightKg;
  it.price = round2(it.pricePerKg * weightKg);
  emit();
  return { ok: true };
}

export function setQty(key, qty) {
  const it = state.items.get(key);
  if (!it || it.isWeight) return; // a weighed line's quantity is fixed by the ticket
  if (qty <= 0) state.items.delete(key);
  else it.qty = Math.min(qty, it.stock);
  emit();
}

export function removeItem(key) { state.items.delete(key); emit(); }

export function setDiscount(type, value) {
  state.rule = { type: type === 'flat' ? 'flat' : 'percent', value: Math.max(0, Number(value) || 0) };
  emit();
}

export function clear() {
  state.items.clear();
  state.rule = { type: state.rule.type, value: 0 };
  state.waCode = null;
  emit();
}

/**
 * Notes that this sale is the WhatsApp order `code`, so paying the bill messages the customer that
 * it is out for delivery. Called when a pending order is loaded into the cart.
 */
export function setWhatsAppOrder(code) {
  state.waCode = code || null;
  emit();
}
