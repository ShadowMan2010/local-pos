// Weighing-station kiosk: pick a loose item, key in its weight, and show a QR ticket for the
// counter POS to scan. There is no real scale wired in yet — weight is typed in by whoever is
// standing at the scale; the "Generate ticket" step is where a real scale's reading would go
// instead of the keypad.
import { h, icon, iconBtn, money, snack, qrDataUrl } from '../ui.js';
import * as sfx from '../sfx.js';
import { openCameraScanner } from '../camera-scan.js';
import * as api from '../weigh-api.js';

/**
 * The full screen button for the app bar.
 *
 * Returns nothing where fullscreen is unavailable, so the caller can leave the button out entirely rather
 * than showing somebody a control that cannot work. iPhone Safari is the case that matters: it has no
 * Fullscreen API for a page at all (only for video), so `fullscreenEnabled` is false there and the button
 * is simply absent. An installed copy already covers that case on its own — see the manifest.
 *
 * The whole document goes fullscreen rather than just the weighing area, and that is deliberate. Going
 * fullscreen on an inner element hides everything outside it, which on this screen means hiding the app bar
 * and with it the only control that can undo the fullscreen: a tablet stuck in fullscreen with no way back
 * is a tablet somebody has to power-cycle.
 */
function fullscreenBtn() {
  if (!document.fullscreenEnabled) return null;

  const btn = iconBtn('fullscreen', toggle, 'Full screen');
  btn.dataset.weighFullscreen = '';

  async function toggle() {
    try {
      if (document.fullscreenElement) {
        await document.exitFullscreen();
      } else {
        await document.documentElement.requestFullscreen();
        // Landscape only works from inside fullscreen on most browsers, which is why it is attempted here
        // and not on load. A phone propped up at a scale is meant to be read sideways, and it is held that
        // way by the manifest on launch; this keeps it true for a fullscreen entered by hand.
        // Not every browser allows the lock, and none of them require it, so a refusal is not an error.
        try { await screen.orientation?.lock('landscape'); } catch { /* not permitted here */ }
      }
    } catch (err) {
      // Requesting fullscreen outside a user gesture is refused, and so is a second request while one is
      // already settling. Neither is worth a dialog; the button stays as it was.
      console.warn('Fullscreen was refused:', err.message);
    }
  }

  // The browser can leave fullscreen without being asked — the Escape key, the home gesture, the browser's
  // own exit — so the icon cannot just be whatever the last click set it to.
  document.addEventListener('fullscreenchange', () => {
    const on = !!document.fullscreenElement;
    const next = icon(on ? 'fullscreen_exit' : 'fullscreen');
    btn.replaceChildren(...next.childNodes);
    btn.setAttribute('aria-label', on ? 'Leave full screen' : 'Full screen');
    btn.title = on ? 'Leave full screen' : 'Full screen';
  });

  return btn;
}

export function renderWeighStation(root) {
  let items = [];

  function openServerSettings() {
    const input = h('input', { type: 'text', value: api.getServerBase(), placeholder: 'http://192.168.1.10:3000' });
    const dlg = h('dialog', { class: 'm3-dialog' });
    dlg.append(
      h('div', { class: 'dlg-head' }, h('h2', { class: 'title-l' }, 'Main POS server'), h('span', { class: 'spacer' }), iconBtn('close', () => dlg.close(), 'Close')),
      h('div', { class: 'pm-fields' },
        h('p', { class: 'body-m muted' }, 'Only change this if the weighing station is a different computer from the till. Leave it as-is if this page is running on the till itself.'),
        h('label', { class: 'm3-field' }, input, h('span', {}, 'POS server address'))),
      h('div', { class: 'pm-foot' },
        h('span', { class: 'spacer' }),
        h('button', {
          type: 'button', class: 'btn btn-filled',
          onclick: () => { api.setServerBase(input.value.trim()); dlg.close(); load(); }
        }, 'Save')));
    dlg.addEventListener('close', () => dlg.remove());
    document.body.append(dlg);
    dlg.showModal();
  }

  const bar = h('header', { class: 'app-bar' },
    icon('scale'),
    h('h1', { class: 'title-l app-title' }, 'Weighing station'),
    h('span', { class: 'spacer' }),
    // null where fullscreen is unavailable, and the spread drops it rather than putting an empty gap there.
    ...[fullscreenBtn(), iconBtn('settings', openServerSettings, 'Server settings')].filter(Boolean));

  const stage = h('div', { class: 'weigh-stage' });
  root.replaceChildren(bar, stage);

  const tile = (p) => h('button', { type: 'button', class: 'weigh-tile', onclick: () => pickItem(p) },
    p.emoji ? h('span', { class: 'emoji' }, p.emoji) : icon('scale'),
    h('div', { class: 'title-m' }, p.name),
    h('div', { class: 'body-m muted' }, `${money(p.price)}/kg`));

  function showPicker() {
    stage.replaceChildren(
      h('div', { class: 'weigh-toolbar' },
        h('button', { type: 'button', class: 'btn btn-tonal', onclick: scanItem }, icon('barcode_scanner'), 'Scan item barcode')),
      items.length
        ? h('div', { class: 'weigh-grid' }, ...items.map(tile))
        : h('p', { class: 'empty body-l' },
            'No items are marked "Sold by weight" yet. In the till, open Products, edit (or add) an item, and turn on "Sold by weight".'));
  }

  function scanItem() {
    openCameraScanner({
      title: 'Scan the item barcode',
      onResult: (code) => {
        const p = items.find((x) => x.sku === code.trim());
        if (!p) return snack(`No "sold by weight" item with SKU ${code}`, 4000);
        pickItem(p);
      }
    });
  }

  function pickItem(p) {
    let weight = '';
    const amountEl = h('span', {}, '0.000');
    const display = h('div', { class: 'weigh-amount' }, amountEl, h('span', { class: 'body-l' }, ' kg'));
    const priceLine = h('div', { class: 'weigh-price' }, money(0));
    const redraw = () => {
      const kg = Number(weight) || 0;
      amountEl.textContent = kg.toFixed(3);
      priceLine.textContent = money(kg * p.price);
    };
    const key = (label, onPress) => h('button', { type: 'button', class: 'weigh-key', onclick: onPress }, label);
    const keys = [
      ...'123456789'.split('').map((d) => key(d, () => { weight += d; redraw(); })),
      key('.', () => { if (!weight.includes('.')) { weight += weight ? '.' : '0.'; redraw(); } }),
      key('0', () => { weight += '0'; redraw(); }),
      key('⌫', () => { weight = weight.slice(0, -1); redraw(); })
    ];

    stage.replaceChildren(
      h('div', { class: 'weigh-toolbar' },
        h('button', { type: 'button', class: 'btn btn-text', onclick: showPicker }, icon('arrow_back'), 'Back')),
      h('div', { class: 'weigh-entry' },
        h('div', { class: 'title-l' }, p.name),
        h('div', { class: 'body-m muted' }, `${money(p.price)} per kg — put the packet on the scale, then type its weight`),
        display, priceLine,
        h('div', { class: 'weigh-keypad' }, ...keys),
        h('button', { type: 'button', class: 'btn btn-filled btn-lg btn-block', onclick: () => makeTicket(p, Number(weight)) },
          icon('qr_code_2'), 'Generate ticket')));
  }

  async function makeTicket(p, weightKg) {
    if (!(weightKg > 0)) return snack('Type the weight first', 3000, 'warn');
    try {
      const { ticket } = await api.createTicket(p.sku, weightKg);
      showTicket(ticket);
    } catch (err) { snack(err.message, 5000, 'error'); }
  }

  function showTicket(t) {
    let qrSrc = '';
    try { qrSrc = qrDataUrl(t.code, 420); } catch (err) { snack(err.message, 6000, 'error'); }
    // This station has no till screen and often nothing in earshot, and the weighing happens while the
    // shopkeeper is looking at the scale rather than the screen. The ticket appearing is exactly the
    // moment worth saying out loud: the customer is waiting with their phone out for a code to scan,
    // and the entire purpose of the ticket is that they have it.
    sfx.play('success');
    stage.replaceChildren(
      h('div', { class: 'weigh-ticket' },
        h('div', { class: 'title-l' }, t.name),
        h('div', { class: 'body-l' }, `${t.weightKg.toFixed(3)} kg × ${money(t.pricePerKg)}/kg`),
        h('div', { class: 'headline-m' }, money(t.price)),
        qrSrc && h('img', { class: 'weigh-qr', src: qrSrc, alt: 'Ticket QR code' }),
        h('div', { class: 'body-m muted' }, `Code ${t.code} — show this screen to the cashier`),
        h('button', { type: 'button', class: 'btn btn-filled btn-lg', onclick: showPicker }, icon('point_of_sale'), 'Next customer')));
  }

  async function load() {
    stage.replaceChildren(h('p', { class: 'empty body-l' }, 'Loading items…'));
    try {
      const { products } = await api.listProducts();
      items = products.filter((p) => p.soldByWeight);
      showPicker();
    } catch (err) {
      stage.replaceChildren(
        h('p', { class: 'empty body-l' }, err.message),
        h('div', { class: 'weigh-toolbar' }, h('button', { type: 'button', class: 'btn btn-tonal', onclick: openServerSettings }, icon('settings'), 'Server address')));
    }
  }

  load();
}
