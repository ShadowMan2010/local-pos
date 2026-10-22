// Module 3 — bill preview, 58/80 mm thermal printing and the dual-QR payment flow.
import { h, icon, money, snack, qrDataUrl } from '../ui.js';
import * as sfx from '../sfx.js';
import { preparePayment, displayCustomerName } from '../payment.js';
import { pushToDisplay } from '../display-link.js';
import { saveOrder, listDeliveryBoys } from '../api.js';
import { getPaper, setPaper, addPendingOrder } from '../store.js';

const fmtDate = (iso) => new Date(iso).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' });
const hr = () => h('div', { class: 'rc-hr' });
const row = (a, b, cls = '') => h('div', { class: `rc-row ${cls}`.trim() }, h('span', {}, a), h('span', {}, b));

/** Plain, monochrome-friendly receipt markup. Used for the preview and (cloned) for printing. */
export function buildReceipt(order, config, { qrSrc = null, paid = false, method = '' } = {}) {
  return h('div', { class: 'rc' },
    h('div', { class: 'rc-center' },
      h('img', { class: 'rc-logo', src: 'logo.png', alt: '' }),
      h('div', { class: 'rc-title' }, config.storeName),
      config.address && h('div', {}, config.address),
      config.phone && h('div', {}, `Ph: ${config.phone}`)),
    hr(),
    row('Bill', order.id),
    row('Date', fmtDate(order.createdAt)),
    order.customer && [
      hr(),
      order.customer.name && row('Customer', order.customer.name),
      order.customer.phone && row('Phone', order.customer.phone),
      order.visitNo && row('Visit no.', `#${order.visitNo}`)
    ],
    hr(),
    order.items.map((it) => [
      h('div', { class: 'rc-item' }, it.name),
      it.weightKg
        ? row(`${it.weightKg.toFixed(3)} kg`, it.price.toFixed(2))
        : row(`${it.qty} x ${it.price.toFixed(2)}`, (it.qty * it.price).toFixed(2))
    ]),
    hr(),
    row('Subtotal', order.subtotal.toFixed(2)),
    order.discount > 0 && row('Discount', `-${order.discount.toFixed(2)}`),
    row('TOTAL', money(order.total), 'rc-total'),
    hr(),
    paid
      ? h('div', { class: 'rc-center rc-strong' }, `PAID (${method.toUpperCase()})`)
      : qrSrc && h('div', { class: 'rc-qr' },
          h('div', { class: 'rc-center rc-strong' }, 'SCAN TO PAY'),
          h('img', { src: qrSrc, alt: 'Payment QR code' }),
          h('div', { class: 'rc-center' }, `Amount ${money(order.total)}`)),
    hr(),
    h('div', { class: 'rc-center' }, 'Thank you! Visit again.')
  );
}

/** Clone the receipt into #print-root, set the paper size, and open the print dialog. */
export function printReceipt(receiptNode, paper) {
  const root = document.getElementById('print-root');
  root.replaceChildren(receiptNode.cloneNode(true));
  document.body.dataset.paper = paper;

  let style = document.getElementById('page-size');
  if (!style) { style = document.createElement('style'); style.id = 'page-size'; document.head.append(style); }
  style.textContent = `@page { size: ${paper}mm auto; margin: 0; }`; // @page cannot use CSS variables

  document.body.classList.add('printing');
  const done = () => {
    document.body.classList.remove('printing');
    root.replaceChildren();
    window.removeEventListener('afterprint', done);
  };
  window.addEventListener('afterprint', done);
  window.print();
}

/**
 * @param {{config:object, order:object, onPaid:(order:object, saved:boolean)=>void}} opts
 * `saved` is true when the server stored the bill (and lowered the stock itself).
 */
export function openReceiptDialog({ config, order, onPaid }) {
  const displayMode = config.qrMode === 'external-display';
  let paper = getPaper();
  let qrSrc = null;
  let paid = false;
  let method = '';

  const paperEl = h('div', { class: 'paper' });
  const statusEl = h('div', { class: 'pay-status' });
  const dlg = h('dialog', { class: 'm3-dialog' });

  const drawReceipt = () => {
    paperEl.dataset.paper = paper;
    paperEl.replaceChildren(buildReceipt(order, config, { qrSrc, paid, method }));
  };
    const setStatus = (kind, text) => {
      statusEl.className = `pay-status ${kind === 'error' || kind === 'ok' ? kind : ''}`.trim();
      statusEl.replaceChildren(
        kind === 'progress' ? h('span', { class: 'progress' }) : icon(kind === 'error' ? 'error' : 'check_circle'),
        h('span', { class: 'body-m' }, text));
      // Only failures are announced here. 'ok' is used both for "the QR is ready" and for "the money is
      // in", and only one of those is worth interrupting a shop for - the other is the normal run-up to
      // it. The payment sound is played by markPaid, at the moment the sale actually closes.
      if (kind === 'error') sfx.play('error');
    };


  async function startPayment() {
    setStatus('progress', displayMode ? 'Sending QR to the customer display…' : 'Generating payment QR…');
    try {
      const { qr, display } = await preparePayment(config, order);
      if (!displayMode) {
        qrSrc = qr.payload ? qrDataUrl(qr.payload, 240) : qr.imageUrl;
        drawReceipt();
        setStatus('ok', 'Payment QR is on the bill. Print it, then confirm payment.');
      } else if (display?.clients === 0) {
        setStatus('error', 'QR sent, but no customer display is connected. Open /display.html on the Pi.');
      } else {
        setStatus('ok', 'QR is showing on the customer display. Confirm once the customer has paid.');
      }
    } catch (err) {
      setStatus('error', err.message);
    }
  }

  async function markPaid(m) {
    paid = true; method = m;
    Object.assign(order, { status: 'paid', paymentMethod: m, paidAt: new Date().toISOString() });
    // Only meaningful for a WhatsApp order: the server mints the code and messages this boy.
    if (isDelivery && deliveryBoy) order.deliveryBoy = deliveryBoy;
    drawReceipt();
    setStatus('ok', `Paid by ${m}. Saving the bill…`);
    payBtns.forEach((b) => { b.disabled = true; });
    closeBtn.textContent = 'New sale';

    // the server stores the bill, lowers stock and adds one to the customer's visit count
    let saved = false;
    try {
      const res = await saveOrder(order);
      saved = true;
      if (res.order?.customer) order.customer = res.order.customer; // the server's copy has the saved name
      if (res.order?.visitNo) order.visitNo = res.order.visitNo;
      drawReceipt();
      setStatus('ok', `Paid by ${m}. Bill saved.`);
    } catch (err) {
      addPendingOrder(order);
      setStatus('error', `Paid by ${m}, but the server could not save the bill. It is kept on this device and will be sent again.`);
    }
    /* The thank-you on the customer screen, which is the only part of a sale the customer actually gets
       to see the end of. It is pushed before onPaid() so the two screens agree even if saving the bill
       was slow, and its failure is swallowed on purpose: the money is already taken and the bill is
       already saved, so an unreachable customer display is not something to report as a failed sale at
       the counter. The cashier is told separately, by the note below the till's own status line. */
    if (displayMode) {
      const thanks = {
        type: 'paid',
        storeName: config.storeName,
        amount: order.total,
        method: m,
        customerName: displayCustomerName(order)
      };
      pushToDisplay(config.displayUrl, thanks)
        .then(() => setTimeout(() => pushToDisplay(config.displayUrl, { type: 'idle', storeName: config.storeName }).catch(() => {}), 4000))
        .catch(() => snack('Bill saved, but the customer display did not confirm it', 5000, 'warn'));
    }
    onPaid(order, saved);
  }

  const paperSeg = h('div', { class: 'seg', role: 'radiogroup', 'aria-label': 'Paper width' },
    ...['58', '80'].map((w) =>
      h('label', {},
        h('input', { type: 'radio', name: 'paper', value: w, checked: paper === w, onchange: () => { paper = w; setPaper(w); drawReceipt(); } }),
        `${w} mm`)));

  /* A bill that came from a WhatsApp order is a delivery, so the till has to say who is taking it.
     The server refuses the sale without a valid boy, and the choice is what gets texted to him. */
  const isDelivery = Boolean(order.waCode);
  let deliveryBoy = null;
  const boyBox = h('div', { class: 'boy-pick' });
  const syncPayButtons = () => {
    for (const b of payBtns) b.disabled = isDelivery && !deliveryBoy;
  };
  if (isDelivery) {
    boyBox.append(h('div', { class: 'body-s muted' }, 'Loading delivery boys…'));
    listDeliveryBoys().then(({ boys }) => {

      if (!boys.length) {
        boyBox.replaceChildren(h('div', { class: 'body-s', style: 'color:var(--md-error)' },
          'No delivery boy yet. Add his WhatsApp number in Settings → Delivery boys, then reopen this bill.'));
        return;
      }
      if (boys.length === 1) deliveryBoy = boys[0]; // the usual case: one boy, no tapping needed
      const opts = boys.map((b) => h('label', { class: 'choice' },
        h('input', {
          type: 'radio', name: 'delivery-boy', value: b.phone, checked: deliveryBoy?.phone === b.phone,
          onchange: () => { deliveryBoy = b; syncPayButtons(); }
        }),
        h('span', {}, `${b.name} · ${b.phone}`)));
      boyBox.replaceChildren(
        h('div', { class: 'body-s muted', style: 'margin-bottom:8px' },
          'Who is delivering? He gets the job and the 4-digit code on his WhatsApp.'),
        ...opts);
      syncPayButtons();
    }).catch((err) => boyBox.replaceChildren(h('div', { class: 'body-s', style: 'color:var(--md-error)' }, err.message)));
  }

  const cashBtn = h('button', { type: 'button', class: 'btn btn-tonal', onclick: () => markPaid('cash') }, icon('payments'), 'Cash received');
  const upiBtn = h('button', { type: 'button', class: 'btn btn-filled', onclick: () => markPaid('upi') }, icon('qr_code_2'), 'UPI received');
  const payBtns = [cashBtn, upiBtn];
  const closeBtn = h('button', { type: 'button', class: 'btn btn-text', onclick: () => dlg.close() }, 'Back to cart');
  syncPayButtons(); // a delivery can't be charged until a boy is picked

  dlg.append(
    h('div', { class: 'dlg-head' }, h('h2', { class: 'title-l' }, 'Bill preview'), h('span', { class: 'body-m muted' }, order.id)),
    h('div', { class: 'dlg-body' },
      h('div', { class: 'preview-col' }, paperEl),
      h('div', { class: 'action-col' },
        isDelivery ? boyBox : null,
        h('div', {}, h('div', { class: 'body-s muted', style: 'margin-bottom:8px' }, 'Paper width'), paperSeg),
        statusEl,
        h('button', { type: 'button', class: 'btn btn-outlined', onclick: () => printReceipt(paperEl.firstElementChild, paper) }, icon('print'), 'Print bill'),
        h('button', { type: 'button', class: 'btn btn-outlined', onclick: startPayment }, icon('refresh'), displayMode ? 'Resend QR to display' : 'Regenerate QR'),
        upiBtn, cashBtn, closeBtn))
  );

  dlg.addEventListener('close', () => {
    if (!paid && displayMode) pushToDisplay(config.displayUrl, { type: 'idle', storeName: config.storeName }).catch(() => {});
    dlg.remove();
  });

  drawReceipt();
  document.body.append(dlg);
  dlg.showModal();
  startPayment();
}
