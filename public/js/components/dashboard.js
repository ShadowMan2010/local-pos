// Module 2 — POS dashboard: top app bar + catalog + cart side sheet, wired to the barcode scanner.
import { h, icon, iconBtn, snack, toggleTheme } from '../ui.js';
import { renderCatalog } from './catalog.js';
import { renderCartPanel } from './cart-panel.js';
import { openReceiptDialog } from './receipt-dialog.js';
import { openProductsDialog } from './products-dialog.js';
import { openCustomersDialog } from './customers-dialog.js';
import { openWhatsappOrdersDialog } from './whatsapp-orders-dialog.js';
import { openDailySummaryDialog } from './daily-summary-dialog.js';
import { openReportsDialog } from './reports-dialog.js';
import { openDeliveriesDialog } from './deliveries-dialog.js';
import { openComplaintsDialog } from './complaints-dialog.js';
import { initBarcodeScanner } from '../barcode.js';
import { openCameraScanner } from '../camera-scan.js';
import { loadProducts, findBySku, getProducts } from '../products.js';
import { newOrderId, redeemWeighTicket, listWaOrders, listDeliveries, listComplaints } from '../api.js';
import { retryPendingOrders } from '../store.js';
import * as sfx from '../sfx.js';
import * as cart from '../cart.js';

const cleanups = [];
const runCleanups = () => { while (cleanups.length) cleanups.pop()(); };

export function renderDashboard(root, { config, onOpenSettings }) {
  runCleanups(); // when returning from Settings, drop the old listeners
  document.body.classList.remove('cart-open');

  /* ---------- top app bar ---------- */
  let wasOnline = null;
  const statusText = h('span', {}, 'Online');
  const status = h('span', { class: 'badge', role: 'status' }, h('i', { class: 'dot' }), statusText);
  const syncStatus = () => {
    const on = navigator.onLine;
    status.classList.toggle('offline', !on);
    statusText.textContent = on ? 'Online' : 'Offline';
    // Losing the network is the one infrastructure failure that stops a till taking money, so it is
    // worth a sound rather than a small grey word. Only on the way down: coming back online is already
    // followed by the pending-bill resend message, and two sounds for one event is one too many.
    // `wasOnline` starts as null so the first call, which just reports the state the page loaded in,
    // does not count as a change and set off an error tone on a perfectly healthy till.
    if (wasOnline === true && !on) sfx.play('error');
    wasOnline = on;
  };

  window.addEventListener('online', syncStatus);
  window.addEventListener('offline', syncStatus);
  cleanups.push(() => { window.removeEventListener('online', syncStatus); window.removeEventListener('offline', syncStatus); });
  syncStatus();

  const modeChip = h('span', { class: 'chip-static mode-chip' },
    config.qrMode === 'external-display' ? 'QR: customer display' : 'QR: on receipt');

  const cartBadge = h('span', { class: 'nav-badge', hidden: true }, '0');
  const cartToggle = h('button', {
    type: 'button', class: 'icon-btn cart-toggle', 'aria-label': 'Open cart',
    onclick: () => document.body.classList.add('cart-open')
  }, icon('shopping_cart'), cartBadge);

  const productsBtn = iconBtn('inventory_2', () => openProductsDialog({ config, onChange: () => catalog.refresh() }), 'Manage products');
  const customersBtn = iconBtn('groups', () => openCustomersDialog(), 'Customers');
  const waBadge = h('span', { class: 'nav-badge', hidden: true }, '0');
  // Last counts the badges held, so a poll can tell "something arrived" from "it was already like
  // that". Null until the first poll lands, which is how the existing backlog stays quiet on open.
  let lastWaCount = null;
  let lastOpenComplaints = null;
  const waBtn = h('button', {
    type: 'button', class: 'icon-btn', 'aria-label': 'WhatsApp orders', title: 'WhatsApp orders',
    onclick: () => openWhatsappOrdersDialog({ panel, onChange: refreshWaBadge })
  }, icon('chat'), waBadge);
  const delBadge = h('span', { class: 'nav-badge', hidden: true }, '0');
  const delBtn = h('button', {
    type: 'button', class: 'icon-btn', 'aria-label': 'Out for delivery', title: 'Out for delivery',
    onclick: () => openDeliveriesDialog({ onChange: refreshDeliveryBadge })
  }, icon('local_shipping'), delBadge);
  // Complaints sit next to deliveries on purpose: both are work a customer is waiting on, and both
  // arrive on their own from WhatsApp rather than being something the shop has to go and look for.
  const cpxBadge = h('span', { class: 'nav-badge', hidden: true }, '0');
  const cpxBtn = h('button', {
    type: 'button', class: 'icon-btn', 'aria-label': 'Customer complaints', title: 'Customer complaints',
    onclick: () => openComplaintsDialog({ onChange: refreshComplaintBadge })
  }, icon('report_problem'), cpxBadge);
  const cameraBtn = iconBtn('qr_code_scanner', () => openCameraScanner({ title: 'Scan barcode or weighing ticket', onResult: handleScan }), 'Scan with camera');
  const summaryBtn = iconBtn('emoji_events', () => openDailySummaryDialog(), "Today's sales");
  const reportsBtn = iconBtn('bar_chart', () => openReportsDialog(), 'Reports and CSV export');
  const themeBtn = iconBtn('contrast', toggleTheme, 'Toggle light / dark mode');

  // Sound sits next to light/dark: both are "this till is too loud / too bright for me right now"
  // settings, and both are one tap. Two stops, not a trip through Settings, because a shopkeeper who
  // has to go looking for a mute switch will simply put up with the noise.
  const soundBtn = h('button', {
    type: 'button', class: 'icon-btn sound-btn', 'aria-label': 'Turn notification sounds off', title: 'Turn notification sounds off'
  });
  const toggleMute = (btn) => {
    const nowOn = !sfx.isEnabled();
    sfx.setEnabled(nowOn);
    paintSoundBtn(btn);
    // No confirmation when muting - that would be the last thing you hear. Playing the sound back
    // when unmuting is what proves the switch did something, and leaves no way to end up unsure
    // whether the till is muted.
    if (nowOn) sfx.play('success');
  };
  const paintSoundBtn = (btn) => {
    const on = sfx.isEnabled();
    const what = on ? 'Turn notification sounds off' : 'Turn notification sounds on';
    btn.replaceChildren(icon(on ? 'volume_up' : 'volume_off'));
    btn.setAttribute('aria-label', what);
    btn.setAttribute('title', what);
    btn.setAttribute('aria-pressed', String(on));
  };
  soundBtn.addEventListener('click', () => toggleMute(soundBtn));
  paintSoundBtn(soundBtn);

  const settingsBtn = iconBtn('settings', () => { runCleanups(); onOpenSettings(); }, 'Store settings');

  const bar = h('header', { class: 'app-bar' },
    icon('storefront'),
    h('h1', { class: 'title-l app-title' }, config.storeName), // store name comes from the saved configuration
    status, modeChip,
    h('span', { class: 'spacer' }),
    productsBtn, customersBtn, waBtn, delBtn, cpxBtn, cameraBtn, summaryBtn, reportsBtn, themeBtn, soundBtn, cartToggle, settingsBtn);

  /* ---------- catalog + cart ---------- */
  const catalog = renderCatalog({ onAdd: addProduct, onScan: (code) => handleScan(code) });
  const panel = renderCartPanel({ onCheckout: checkout, onClose: () => document.body.classList.remove('cart-open') });
  cleanups.push(panel.destroy);
  cleanups.push(cart.subscribe((s) => {
    // Re-trigger the pop by removing and re-adding the class. Setting the same value again does not
    // restart an animation, so without this the badge would pop once when the till opens and then never
    // again — which is the opposite of when it is worth popping.
    cartBadge.classList.remove('pop');
    cartBadge.textContent = s.count;
    cartBadge.hidden = s.count === 0;
    if (s.count) void cartBadge.offsetWidth;
    cartBadge.classList.add('pop');
  }));

  const scrim = h('div', { class: 'scrim', onclick: () => document.body.classList.remove('cart-open') });
  root.replaceChildren(bar, h('div', { class: 'shell' }, catalog.el, panel.el), scrim);

  /* ---------- data ---------- */
  const reloadProducts = () => loadProducts().then((list) => catalog.setProducts(list));
  reloadProducts().catch((err) => snack(`Could not load products: ${err.message}`, 6000));
  // bills that could not be saved earlier (for example the Wi-Fi dropped) are sent again now
  retryPendingOrders().then((n) => { if (n) { snack(`${n} earlier ${n === 1 ? 'bill was' : 'bills were'} saved on the server`, 4000, 'success'); reloadProducts().catch(() => {}); } });

  // WhatsApp orders (if the feature is set up): a small badge, checked every few seconds
  // A WhatsApp order arriving is the single most important thing a till can be told about: it is a
  // customer waiting to pay, and it arrives when nobody is looking at the screen. The badge is polled
  // every 8s, so `shouldAnnounce` is what keeps that from turning into a machine-gun of chimes - it
  // compares against the last count it saw, so only a genuine increase makes a sound and the backlog
  // that was already waiting when the page opened stays silent.
  async function refreshWaBadge() {
    try {
      const { orders } = await listWaOrders();
      if (sfx.shouldAnnounce(lastWaCount, orders.length)) sfx.play('alert');
      lastWaCount = orders.length;
      waBadge.textContent = orders.length;
      waBadge.hidden = orders.length === 0;
    } catch { /* WhatsApp not set up, or the server is briefly unreachable — leave the badge as-is */ }
  }
  refreshWaBadge();
  const waPoll = setInterval(refreshWaBadge, 8000);
  cleanups.push(() => clearInterval(waPoll));

  // Bills out for delivery are polled but deliberately silent. They only ever go *down* on their own,
  // and a bill leaving is a thing the shop already knows about. A sound every time a rider's photo
  // arrives would be noise with no news in it.
  async function refreshDeliveryBadge() {
    try {
      const { deliveries } = await listDeliveries();
      delBadge.textContent = deliveries.length;
      delBadge.hidden = deliveries.length === 0;
    } catch { /* leave the badge as-is */ }
  }
  refreshDeliveryBadge();
  const delPoll = setInterval(refreshDeliveryBadge, 12000);
  cleanups.push(() => clearInterval(delPoll));

  // Complaints sound, unlike deliveries, because a complaint arriving is a customer who is unhappy and
  // waiting. That is worth interrupting for.
  async function refreshComplaintBadge() {
    try {
      const { open } = await listComplaints();
      if (sfx.shouldAnnounce(lastOpenComplaints, open)) sfx.play('warn');
      lastOpenComplaints = open;
      cpxBadge.textContent = open;
      cpxBadge.hidden = !open;
    } catch { /* leave the badge as-is */ }
  }
  refreshComplaintBadge();
  const cpxPoll = setInterval(refreshComplaintBadge, 15000);
  cleanups.push(() => clearInterval(cpxPoll));

  /* ---------- barcode / QR scanning (USB scanner, or a phone/webcam camera) ---------- */
  // A weighing-station ticket looks like WT + 8 hex characters; anything else is a product SKU.
  const isWeighTicket = (code) => /^WT[0-9A-F]{6,}$/i.test(code);

  async function handleScan(code) {
    if (document.querySelector('dialog[open]')) return; // ignore scans while a bill is open
    code = code.trim();
    if (isWeighTicket(code)) {
      try {
        const { ticket } = await redeemWeighTicket(code);
        cart.addWeightLine(ticket);
        snack(`Added: ${ticket.name} (${ticket.weightKg.toFixed(3)} kg)`, 2200, 'add');
      } catch (err) { snack(err.message, 4000, 'error'); }
      return;
    }
    const p = findBySku(code);
    if (!p) return snack(`No product with SKU ${code}`, 3200, 'warn');
    const r = cart.addItem(p);
    if (r.ok) { snack(`Added: ${p.name}`, 1600, 'add'); catalog.flash(p.sku); }
    else snack(`${p.name}: no more stock`, 3200, 'warn');
  }

  const stopScanner = initBarcodeScanner(handleScan);
  cleanups.push(stopScanner);

  /* ---------- actions ---------- */
  function addProduct(p) {
    const r = cart.addItem(p);
    if (!r.ok) snack(`Only ${p.stock} of ${p.name} in stock`, 3200, 'warn');
  }

  let checkingOut = false;
  async function checkout() {
    const s = cart.snapshot();
    if (!s.items.length || checkingOut) return;

    const customer = panel.getCustomer();
    if (customer.error) { snack(customer.error, 4000); panel.focusPhone(); return; }

    checkingOut = true;
    let id;
    try { id = await newOrderId(); } // the server hands out bill numbers so two phones never repeat one
    catch (err) { snack(`Could not reach the POS server: ${err.message}`, 5000); checkingOut = false; return; }
    checkingOut = false;

    const order = {
      id,
      createdAt: new Date().toISOString(),
      items: s.items.map(({ id, sku, name, price, qty, weightKg }) => ({ id, sku, name, price, qty, weightKg })),
      subtotal: s.subtotal,
      discount: s.discountAmount,
      discountRule: s.rule,
      // set when this sale was loaded from a WhatsApp order: tells the server to start a delivery
      // and message the customer once the bill is paid
      waCode: s.waCode || undefined,
      total: s.total,
      status: 'pending',
      // shown on the bill; the server adds the final visit number when the bill is paid
      customer: customer.phone || customer.name ? { name: customer.name, phone: customer.phone } : null,
      visitNo: customer.phone ? customer.visits + 1 : null
    };
    openReceiptDialog({
      config, order,
      onPaid: (paidOrder, saved) => {
        cart.clear();
        panel.clearCustomer();
        document.body.classList.remove('cart-open');
        if (saved) {
          // the server lowered the stock itself; fetch the fresh numbers (other phones may have sold too)
          reloadProducts().catch(() => snack('Could not refresh stock from the server', 3200, 'error'));
        } else {
          // the server never got this bill: lower the stock on this screen so it is not sold twice
          for (const it of paidOrder.items) {
            const p = getProducts().find((x) => x.sku === it.sku);
            if (p) p.stock = Math.max(0, p.stock - (it.weightKg ?? it.qty));
          }
          catalog.refresh();
        }
      }
    });
  }
}
