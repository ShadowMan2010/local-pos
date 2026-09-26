// Module 2 — POS dashboard: top app bar + catalog + cart side sheet, wired to the barcode scanner.
import { h, icon, iconBtn, snack, toggleTheme } from '../ui.js';
import { renderCatalog } from './catalog.js';
import { renderCartPanel } from './cart-panel.js';
import { openReceiptDialog } from './receipt-dialog.js';
import { openProductsDialog } from './products-dialog.js';
import { openCustomersDialog } from './customers-dialog.js';
import { openWhatsappOrdersDialog } from './whatsapp-orders-dialog.js';
import { openDailySummaryDialog } from './daily-summary-dialog.js';
import { openDeliveriesDialog } from './deliveries-dialog.js';
import { initBarcodeScanner } from '../barcode.js';
import { openCameraScanner } from '../camera-scan.js';
import { loadProducts, findBySku, getProducts } from '../products.js';
import { newOrderId, redeemWeighTicket, listWaOrders, listDeliveries } from '../api.js';
import { retryPendingOrders } from '../store.js';
import * as cart from '../cart.js';

const cleanups = [];
const runCleanups = () => { while (cleanups.length) cleanups.pop()(); };

export function renderDashboard(root, { config, onOpenSettings }) {
  runCleanups(); // when returning from Settings, drop the old listeners
  document.body.classList.remove('cart-open');

  /* ---------- top app bar ---------- */
  const statusText = h('span', {}, 'Online');
  const status = h('span', { class: 'badge', role: 'status' }, h('i', { class: 'dot' }), statusText);
  const syncStatus = () => {
    const on = navigator.onLine;
    status.classList.toggle('offline', !on);
    statusText.textContent = on ? 'Online' : 'Offline';
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
  const waBtn = h('button', {
    type: 'button', class: 'icon-btn', 'aria-label': 'WhatsApp orders', title: 'WhatsApp orders',
    onclick: () => openWhatsappOrdersDialog({ panel, onChange: refreshWaBadge })
  }, icon('chat'), waBadge);
  const delBadge = h('span', { class: 'nav-badge', hidden: true }, '0');
  const delBtn = h('button', {
    type: 'button', class: 'icon-btn', 'aria-label': 'Out for delivery', title: 'Out for delivery',
    onclick: () => openDeliveriesDialog({ onChange: refreshDeliveryBadge })
  }, icon('local_shipping'), delBadge);
  const cameraBtn = iconBtn('qr_code_scanner', () => openCameraScanner({ title: 'Scan barcode or weighing ticket', onResult: handleScan }), 'Scan with camera');
  const summaryBtn = iconBtn('emoji_events', () => openDailySummaryDialog(), "Today's sales");
  const themeBtn = iconBtn('contrast', toggleTheme, 'Toggle light / dark mode');
  const settingsBtn = iconBtn('settings', () => { runCleanups(); onOpenSettings(); }, 'Store settings');

  const bar = h('header', { class: 'app-bar' },
    icon('storefront'),
    h('h1', { class: 'title-l app-title' }, config.storeName), // store name comes from the saved configuration
    status, modeChip,
    h('span', { class: 'spacer' }),
    productsBtn, customersBtn, waBtn, delBtn, cameraBtn, summaryBtn, themeBtn, cartToggle, settingsBtn);

  /* ---------- catalog + cart ---------- */
  const catalog = renderCatalog({ onAdd: addProduct, onScan: (code) => handleScan(code) });
  const panel = renderCartPanel({ onCheckout: checkout, onClose: () => document.body.classList.remove('cart-open') });
  cleanups.push(panel.destroy);
  cleanups.push(cart.subscribe((s) => {
    cartBadge.textContent = s.count;
    cartBadge.hidden = s.count === 0;
  }));

  const scrim = h('div', { class: 'scrim', onclick: () => document.body.classList.remove('cart-open') });
  root.replaceChildren(bar, h('div', { class: 'shell' }, catalog.el, panel.el), scrim);

  /* ---------- data ---------- */
  const reloadProducts = () => loadProducts().then((list) => catalog.setProducts(list));
  reloadProducts().catch((err) => snack(`Could not load products: ${err.message}`, 6000));
  // bills that could not be saved earlier (for example the Wi-Fi dropped) are sent again now
  retryPendingOrders().then((n) => { if (n) { snack(`${n} earlier ${n === 1 ? 'bill was' : 'bills were'} saved on the server`, 4000); reloadProducts().catch(() => {}); } });

  // WhatsApp orders (if the feature is set up): a small badge, checked every few seconds
  async function refreshWaBadge() {
    try {
      const { orders } = await listWaOrders();
      waBadge.textContent = orders.length;
      waBadge.hidden = orders.length === 0;
    } catch { /* WhatsApp not set up, or the server is briefly unreachable — leave the badge as-is */ }
  }
  refreshWaBadge();
  const waPoll = setInterval(refreshWaBadge, 8000);
  cleanups.push(() => clearInterval(waPoll));

  // Orders handed to a delivery boy and not yet confirmed: badge + poll on the same rhythm
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
        snack(`Added: ${ticket.name} (${ticket.weightKg.toFixed(3)} kg)`, 2200);
      } catch (err) { snack(err.message, 4000); }
      return;
    }
    const p = findBySku(code);
    if (!p) return snack(`No product with SKU ${code}`);
    const r = cart.addItem(p);
    if (r.ok) { snack(`Added: ${p.name}`, 1600); catalog.flash(p.sku); }
    else snack(`${p.name}: no more stock`);
  }

  const stopScanner = initBarcodeScanner(handleScan);
  cleanups.push(stopScanner);

  /* ---------- actions ---------- */
  function addProduct(p) {
    const r = cart.addItem(p);
    if (!r.ok) snack(`Only ${p.stock} of ${p.name} in stock`);
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
          reloadProducts().catch(() => snack('Could not refresh stock from the server'));
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
