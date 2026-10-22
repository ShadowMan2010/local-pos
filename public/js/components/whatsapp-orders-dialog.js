// Pending orders that came in over WhatsApp. "Load into cart" hands the item off to the normal
// checkout flow (today's live prices and stock apply) rather than trying to bill it directly —
// that way every other rule (stock limits, discounts, payment, receipt) stays in one place.
import { h, icon, iconBtn, money, snack } from '../ui.js';
import * as api from '../api.js';
import { getProducts } from '../products.js';
import * as cart from '../cart.js';

export function openWhatsappOrdersDialog({ panel, onChange }) {
  const dlg = h('dialog', { class: 'm3-dialog products-dialog' });
  const list = h('ul', { class: 'pm-list' });

  const row = (o) => {
    const lines = o.items.map((i) => (i.isWeight ? `${i.weightKg} kg ${i.name} (declared)` : `${i.qty} x ${i.name}`)).join(', ');
    const time = new Date(o.createdAt).toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit' });
    // The name the customer gave over WhatsApp, so the cashier can see who it is before loading it.
    const who = o.name ? `${o.name} · ${o.phone}` : `${o.phone} · no name given`;
    // The customer's UPI screenshot, if they sent one. A link rather than a thumbnail: the proof is
    // read for the amount and the UPI reference, which is unreadable at list size.
    const proof = o.paymentProof?.url
      ? h('a', { class: 'wa-proof', href: o.paymentProof.url, target: '_blank', rel: 'noopener noreferrer' },
        icon('receipt_long'), 'Payment screenshot received')
      : null;
    return h('li', { class: 'pm-row' },
      h('div', { class: 'thumb' }, icon('chat')),
      h('div', { class: 'pm-main' },
        h('div', { class: 'title-s' }, `${who} · ${money(o.total)}`),
        h('div', { class: 'body-s muted' }, lines),
        h('div', { class: 'body-s muted' }, `${o.code} · ${time}`),
        proof),
      h('div', { class: 'wa-actions' },
        h('button', { type: 'button', class: 'btn btn-text', onclick: () => dismiss(o) }, 'Dismiss'),
        h('button', { type: 'button', class: 'btn btn-tonal', onclick: () => loadIntoCart(o) }, 'Load into cart')));
  };

  async function load() {
    list.replaceChildren(h('li', { class: 'cart-empty' }, h('p', { class: 'body-m' }, 'Loading…')));
    try {
      const { orders } = await api.listWaOrders();
      list.replaceChildren(...(orders.length
        ? orders.map(row)
        : [h('li', { class: 'cart-empty' }, icon('chat'), h('p', { class: 'body-l' }, 'No WhatsApp orders waiting.'))]));
    } catch (err) {
      list.replaceChildren(h('li', { class: 'cart-empty' }, h('p', { class: 'body-m' }, err.message)));
    }
  }

  async function dismiss(o) {
    try { await api.dismissWaOrder(o.code); onChange(); load(); }
    catch (err) { snack(err.message, 4000, 'error'); }
  }

  async function loadIntoCart(o) {
    let added = 0, skipped = [], needWeigh = 0;
    for (const it of o.items) {
      const p = getProducts().find((x) => x.id === it.id) || getProducts().find((x) => x.sku === it.sku);
      if (!p) { skipped.push(`${it.name} (no longer sold)`); continue; }
      if (it.isWeight) {
        // The kg here is what the customer claimed, not a scale reading, so it lands as an
        // editable line the cashier has to confirm. Re-checked against live stock, and a product
        // that has since been switched to per-piece pricing is skipped rather than mis-billed.
        if (!p.soldByWeight) { skipped.push(`${it.name} (no longer sold by weight)`); continue; }
        const r = cart.addDeclaredWeightLine(p, it.weightKg);
        if (r.ok) { added++; needWeigh++; } else skipped.push(`${it.name} (${r.reason === 'stock' ? `only ${p.stock} kg left` : 'bad weight'})`);
        continue;
      }
      if (p.soldByWeight) { skipped.push(`${it.name} (now sold by weight — weigh it)`); continue; }
      const r = cart.addItem(p, it.qty);
      if (r.ok) added++; else skipped.push(`${it.name} (only ${p.stock} left)`);
    }
    panel.setCustomer(o.phone, o.name || '');
    cart.setWhatsAppOrder(o.code); // paying this bill texts the customer that it's out for delivery
    try { await api.acceptWaOrder(o.code); } catch { /* not fatal — the order still lands in the cart */ }
    onChange();
    dlg.close();
    const notes = [];
    if (skipped.length) notes.push(`Couldn't add: ${skipped.join(', ')}`);
    if (needWeigh) notes.push(`${needWeigh} weighed item(s) — type the real weight from your scale`);
    snack(notes.length ? `Added ${added} item(s). ${notes.join('. ')}` : 'WhatsApp order added to the cart',
      needWeigh || skipped.length ? 7000 : 2500);
  }

  dlg.append(
    h('div', { class: 'dlg-head' },
      h('h2', { class: 'title-l' }, 'WhatsApp orders'), h('span', { class: 'spacer' }),
      iconBtn('close', () => dlg.close(), 'Close')),
    list);
  dlg.addEventListener('close', () => dlg.remove());

  document.body.append(dlg);
  dlg.showModal();
  load();
}
