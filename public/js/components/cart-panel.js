// Module 2 — cart side sheet: line items, quantity controls, discount calculator, live total.
import { h, icon, iconBtn, money, snack } from '../ui.js';
import * as cart from '../cart.js';
import { normPhone, findCustomer } from '../customers.js';

export function renderCartPanel({ onCheckout, onClose }) {
  let discountType = 'percent';

  const title = h('h2', { class: 'title-l' }, 'Current sale');
  const countChip = h('span', { class: 'chip-static' }, '0 items');
  // Shown only for a sale loaded from a WhatsApp order, so the cashier knows charging it will text
  // the customer that the order is out for delivery.
  const waChip = h('span', { class: 'chip-static', hidden: true, title: 'This sale came from a WhatsApp order' },
    icon('chat'), h('span', {}, ''));
  const list = h('ul', { class: 'cart-list' });
  const sums = h('div', {});
  const totalEl = h('div', { class: 'headline-m' }, money(0));
  const checkoutBtn = h('button', { type: 'button', class: 'btn btn-filled btn-lg btn-block', onclick: onCheckout }, icon('point_of_sale'), 'Charge');

  /* ----- customer (optional): phone + name; a known phone fills the name in and shows the visit count ----- */
  let known = null;      // the saved customer for the phone number currently typed
  let autoName = '';     // the name we filled in ourselves (so we never overwrite something the cashier typed)
  let lookupTimer;
  const hint = h('div', { class: 'field-hint cust-hint', role: 'status' });
  const phoneInput = h('input', { type: 'tel', inputmode: 'numeric', placeholder: ' ', autocomplete: 'off', maxlength: '16', oninput: onPhone });
  const nameInput = h('input', { type: 'text', placeholder: ' ', autocomplete: 'off', maxlength: '60' });

  function onPhone() {
    clearTimeout(lookupTimer);
    known = null;
    const raw = phoneInput.value.trim();
    const phone = normPhone(raw);
    if (!phone) {
      hint.textContent = raw.replace(/\D/g, '').length >= 10 ? 'That does not look like a valid mobile number' : '';
      return;
    }
    hint.textContent = 'Checking…';
    lookupTimer = setTimeout(async () => {
      const c = await findCustomer(phone);
      if (normPhone(phoneInput.value) !== phone) return; // the number was changed while we were looking
      known = c;
      if (c) {
        if (!nameInput.value.trim() || nameInput.value === autoName) { nameInput.value = c.name; autoName = c.name; }
        hint.textContent = `Returning customer · ${c.visits} ${c.visits === 1 ? 'visit' : 'visits'} so far`;
      } else {
        hint.textContent = 'New customer — saved with this bill';
      }
    }, 250);
  }

  const discountInput = h('input', {
    type: 'number', min: '0', step: 'any', inputmode: 'decimal', placeholder: '0',
    oninput: () => cart.setDiscount(discountType, discountInput.value)
  });
  const segOption = (value, label, checked) =>
    h('label', {},
      h('input', { type: 'radio', name: 'discount-type', value, checked, onchange: () => { discountType = value; cart.setDiscount(discountType, discountInput.value); } }),
      label);

  const el = h('aside', { class: 'cart-sheet', 'aria-label': 'Shopping cart' },
    h('div', { class: 'cart-head' }, title, countChip, waChip, h('span', { class: 'spacer' }),
      iconBtn('delete_sweep', () => cart.clear(), 'Clear cart'),
      iconBtn('close', onClose, 'Close cart', 'close-sheet')),
    list,
    h('div', { class: 'cart-foot' },
      h('div', { class: 'cust-row' },
        h('label', { class: 'm3-field compact' }, phoneInput, h('span', {}, 'Phone')),
        h('label', { class: 'm3-field compact' }, nameInput, h('span', {}, 'Name'))),
      hint,
      h('div', { class: 'discount-row' },
        h('label', { class: 'm3-field compact' }, discountInput, h('span', {}, 'Discount')),
        h('div', { class: 'seg', role: 'radiogroup', 'aria-label': 'Discount type' }, segOption('percent', '%', true), segOption('flat', '₹', false))),
      sums,
      h('div', { class: 'sum-total' }, h('span', { class: 'title-m' }, 'Total'), totalEl),
      checkoutBtn)
  );

  /**
   * A weight off a weighing-station ticket is already the scale's reading, so it is shown as fixed.
   * A weight the customer declared over WhatsApp is only their claim, so it gets a box to type the
   * real reading into, plus a chip so the cashier knows this line still needs checking.
   */
  const weightCell = (it) => {
    if (!it.declaredWeight) return h('span', { class: 'chip-static' }, icon('scale'), 'Weighed');
    const input = h('input', {
      class: 'kg-input', type: 'number', min: '0.01', step: '0.01', inputmode: 'decimal',
      value: String(it.weightKg), 'aria-label': `Weight in kg for ${it.name}`,
      onchange: (e) => {
        const r = cart.setWeightKg(it.key, e.target.value);
        if (!r.ok) {
          e.target.value = String(it.weightKg); // snap back to the last good weight
          snack(r.reason === 'stock' ? `Only ${it.stock} kg of ${it.name} left in stock` : 'Enter a weight above zero', 4000, 'warn');
        }
      }
    });
    return h('div', { class: 'kg-cell' },
      h('label', { class: 'kg-wrap' }, input, h('span', {}, 'kg')),
      h('span', {
        class: 'chip-static warn',
        title: 'The customer declared this weight on WhatsApp — type in what your scale shows'
      }, icon('scale'), 'Check'));
  };

  const row = (it) =>
    h('li', { class: 'cart-item' },
      h('div', { class: 'ci-main' },
        h('div', { class: 'title-s' }, it.name),
        h('div', { class: 'body-s muted' },
          it.isWeight ? `${it.weightKg.toFixed(3)} kg × ${money(it.pricePerKg)}/kg` : `${money(it.price)} each`)),
      it.isWeight
        ? weightCell(it)
        : h('div', { class: 'stepper' },
            iconBtn('remove', () => cart.setQty(it.key, it.qty - 1), 'Decrease quantity', 'sm'),
            h('span', { class: 'qty' }, it.qty),
            iconBtn('add', () => cart.setQty(it.key, it.qty + 1), 'Increase quantity', 'sm')),
      h('div', { class: 'ci-total title-s' }, money(it.price * it.qty)),
      iconBtn('close', () => cart.removeItem(it.key), `Remove ${it.name}`, 'sm'));

  const sumRow = (label, value) => h('div', { class: 'sum-row body-m' }, h('span', {}, label), h('span', {}, value));

  /* Motion, decided by what actually changed rather than by a timer.
     This list is rebuilt from scratch on every render, so the rows that should animate have to be worked
     out here: `seenKeys` holds what the last render produced, and a row animates only if its key was not
     in it. Without that, adding one item would slide all of them in again, and nudging a quantity would
     re-animate the entire sale — on a ten-line basket that is visible jank on the screen the cashier is
     looking at while they work. */
  const seenKeys = new Set();
  /* Whether this is the very first render. It has to be tracked as its own flag rather than inferred from
     `seenKeys.size`, because the set is also empty after the till opens on an empty basket — and inferring
     from it silently swallowed the animation for the first item added to an empty cart, which is the single
     most common way a line ever enters this list. */
  let firstRender = true;
  let wasEmpty = null;
  let lastTotal = '';

  const unsubscribe = cart.subscribe((s) => {
    const keys = new Set(s.items.map((it) => it.key));
    const rows = s.items.length
      ? s.items.map((it) => {
          const el = row(it);
          // First render populates the set without animating, so opening the till does not play an
          // entrance for a sale that is already in progress.
          if (!firstRender && !seenKeys.has(it.key)) el.classList.add('is-new');
          return el;
        })
      : [(() => { const el = h('li', { class: 'cart-empty' }, icon('shopping_basket'), h('p', { class: 'body-l' }, 'The cart is empty.'), h('p', { class: 'body-m' }, 'Tap "Add to cart" or scan a barcode.')); if (wasEmpty === false) el.classList.add('enter'); return el; })()];
    list.replaceChildren(...rows);
    seenKeys.clear();
    for (const k of keys) seenKeys.add(k);
    wasEmpty = s.items.length === 0;
    firstRender = false;
    countChip.textContent = `${s.count} ${s.count === 1 ? 'item' : 'items'}`;
    waChip.hidden = !s.waCode;
    if (s.waCode) waChip.lastChild.textContent = ` From ${s.waCode}`;
    sums.replaceChildren(...[
      sumRow('Subtotal', money(s.subtotal)),
      s.discountAmount > 0 && sumRow(s.rule.type === 'percent' ? `Discount (${s.rule.value}%)` : 'Discount', `− ${money(s.discountAmount)}`)
    ].filter(Boolean));
    /* Only when the figure itself changed, so a discount being typed into character by character nudges the
       total as it moves and nothing at all happens while the cart sits idle. The class is removed before it
       is re-added, because re-adding an animation to an element that already has it does nothing. */
    const total = money(s.total);
    if (total !== lastTotal) {
      if (lastTotal && typeof totalEl.animate === 'function') {
        totalEl.classList.remove('total-changed');
        void totalEl.offsetWidth;
        totalEl.classList.add('total-changed');
      }
      lastTotal = total;
    }
    totalEl.textContent = total;
    checkoutBtn.disabled = s.items.length === 0;
    if (s.rule.value === 0 && document.activeElement !== discountInput) discountInput.value = '';
  });

  return {
    el,
    destroy: () => { clearTimeout(lookupTimer); unsubscribe(); },
    /** @returns {{error:string}|{phone:string, name:string, visits:number}} phone is '' for a walk-in with no number */
    getCustomer() {
      const raw = phoneInput.value.trim();
      const phone = raw ? normPhone(raw) : '';
      if (raw && !phone) return { error: 'Enter a valid 10-digit mobile number, or clear the phone box' };
      return { phone: phone || '', name: nameInput.value.trim(), visits: known?.visits || 0 };
    },
    focusPhone: () => phoneInput.focus(),
    /** Prefills phone + name (used when a WhatsApp order is loaded into the cart) and looks the number up. */
    setCustomer(phone, name) {
      phoneInput.value = phone || '';
      nameInput.value = name || '';
      autoName = '';
      if (phone) onPhone(); else hint.textContent = '';
    },
    clearCustomer() {
      clearTimeout(lookupTimer);
      phoneInput.value = ''; nameInput.value = ''; hint.textContent = '';
      known = null; autoName = '';
    }
  };
}
