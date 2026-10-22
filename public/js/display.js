// Customer-facing screen. Open http://<pos-ip>:3000/display.html on the Raspberry Pi (kiosk mode).
import { h, money, qrDataUrl } from './ui.js';
import * as sfx from './sfx.js';

const stage = document.getElementById('stage');
let storeName = '';
let customerName = '';   // the name on this sale's bill, or '' for a walk-in
let last = { type: 'idle' };
let online = false;      // is the WebSocket to the till actually up?
let msg = { type: 'idle' }; // last frame from the till, replayed to a screen that connects later

// This screen has no keyboard, no pointer (the cursor is hidden) and no snackbar, so sound is the only
// channel it has for "something happened". It is kept to one sound - the payment chime - because the
// customer is standing in front of it, and a screen facing a queue that beeps at every state change is
// worse than a silent one.
//
// Two practical caveats, both handled rather than hidden:
//   1. Browsers block audio until the page has been interacted with, and a kiosk screen may never be
//      touched at all. sfx.primeAudio() below listens for the first interaction of any kind, so a shop
//      that taps the screen once at the start of the day gets the chime for the rest of it.
//   2. This may be a different device from the till, with its own localStorage, so the till's mute
//      button cannot reach it. Turning it off here is done in the URL: /display.html?sound=off. That
//      also makes it a per-screen setting, which is right: the shop may want the chime on the customer
//      screen and off behind the counter.
const soundOff = new URLSearchParams(location.search).get('sound') === 'off';
if (soundOff) sfx.setEnabled(false);
for (const evt of ['pointerdown', 'keydown', 'touchstart']) {
  window.addEventListener(evt, () => sfx.primeAudio(), { once: true, passive: true });
}

fetch('/api/config').then((r) => r.json()).then((d) => {
  storeName = d.config?.storeName || storeName;
  render(last);
}).catch(() => {});

function render(msg) {
  last = msg;
  if (msg.storeName) storeName = msg.storeName;
  /* Taken from every message, and a message without the key means "no name" rather than "leave it as it
     was". Keeping the previous value on a missing key looks harmless until a frame that was never about
     that customer is pushed without one, and the screen greets the next person in the queue by name.
     Every push the till makes carries the field explicitly, including as an empty string, so nothing
     depends on the key being absent. */
  customerName = msg.customerName || '';

  if (msg.type === 'preparing') {
    /* Shown between the cashier pressing Charge and the QR arriving.
       The amount is already known when this is pushed, so the customer reads what they owe while the QR is
       still being built rather than looking at a spinner with nothing on it. The placeholder holds the same
       space the QR will take, so the screen does not jump when the real one lands — on a customer-facing
       screen, text moving under a person's eyes is worse than a moment's wait.

       No sound. The customer is mid-transaction and this is the least interesting thing that can happen;
       the chime still means exactly one thing, which is a payment landing. */
    stage.replaceChildren(h('div', { class: 'd-wrap' },
      h('div', { class: 'title-l muted' }, storeName),
      nameLine(),
      h('div', { class: 'title-m muted' }, 'Amount to pay'),
      h('div', { class: 'd-amount' }, money(msg.amount)),
      h('div', { class: 'd-qr d-qr-wait' },
        h('span', { class: 'progress d-spinner', role: 'status', 'aria-label': 'Preparing the payment code' })),
      h('div', { class: 'title-m muted' }, 'Getting your QR code…')
    ));
  } else if (msg.type === 'payment') {
    let src = msg.qrImageUrl;
    try { if (msg.qrPayload) src = qrDataUrl(msg.qrPayload, 360); } catch (e) { console.error(e); }
    stage.replaceChildren(h('div', { class: 'd-wrap' },
      h('div', { class: 'title-l muted' }, storeName),
      nameLine(),
      h('div', { class: 'title-m muted' }, 'Amount to pay'),
      h('div', { class: 'd-amount' }, money(msg.amount)),
      h('div', { class: 'd-qr' }, src ? h('img', { src, alt: 'Scan to pay' }) : h('p', { class: 'title-m' }, 'QR unavailable')),
      h('div', { class: 'title-m' }, 'Scan with any UPI app to pay'),
      h('div', { class: 'body-m muted' }, `Bill ${msg.orderId || ''}`)
    ));
  } else if (msg.type === 'paid') {
    // Sound on the arrival of the message rather than on the timer, so a chime always means a payment
    // just landed. Nothing for 'payment': the customer is mid-scan at that moment and a noise would
    // only distract from the thing they are meant to be looking at.
    sfx.play('paid');
    stage.replaceChildren(h('div', { class: 'd-wrap' },
      h('span', { class: 'material-symbols-rounded d-icon' }, 'check_circle'),
      h('div', { class: 'headline-m' }, paymentHeading(msg)),
      h('div', { class: 'title-m muted' }, 'Thank you! Visit again.'),
      nameLine()
    ));
  } else {
    stage.replaceChildren(h('div', { class: 'd-wrap' },
      h('span', { class: 'material-symbols-rounded d-icon' }, 'storefront'),
      h('div', { class: 'display-s' }, storeName || 'Welcome'),
      h('div', { class: 'title-m muted' }, 'Welcome!')
    ));
  }
}

/* The customer's name, when the bill has one.
   Shown on the QR frame and the thank-you, and skipped entirely for a walk-in rather than left blank:
   an empty line above the amount would shift the layout for the majority of sales to accommodate the
   minority that have a name. */
/* The thank-you says how it was paid when the till said so. A customer who handed over notes wants to
   see "Cash" confirmed on the screen facing them - it is the moment they find out the till recorded the
   method they used, and "Payment received" alone leaves them unsure. Unknown or missing falls back to the
   plain wording rather than guessing. */
const PAID_WORDS = { cash: 'Cash received', upi: 'Payment received', card: 'Card payment received' };
function paymentHeading(msg) {
  return PAID_WORDS[String(msg.method || '').toLowerCase()] || 'Payment received';
}

function nameLine() { return customerName ? h('div', { class: 'd-name' }, customerName) : null; }

function connect() {
  const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
  ws.onopen = () => { online = true; drawOffline(); };
  ws.onmessage = (e) => {
    // Any message proves the link, so it clears the "not connected" mark before it is drawn - otherwise
    // a payment that arrived while the banner was up would be rendered under a sign saying it could not.
    try { msg = JSON.parse(e.data); } catch (err) { console.error(err); return; }
    online = true;
    render(msg);
  };
  ws.onclose = () => { online = false; drawOffline(); setTimeout(connect, 2000); }; // auto-reconnect
  ws.onerror = () => ws.close();
}

/* A small mark saying the screen has lost the till, shown over whatever is already on screen.
   Not a full-screen takeover: the last frame stays visible underneath, because a shop's display screen
   getting knocked off the network mid-queue should still show the customer the amount they owe rather
   than blank out entirely. Replaced by the next message that arrives, and gone within one reconnect
   cycle on its own. Deliberately silent - a customer cannot act on it, and a sound aimed at them about
   an internal problem is noise, not information. */
function drawOffline() {
  document.body.classList.toggle('d-offline', !online);
  let mark = document.getElementById('d-net');
  if (online) { mark?.remove(); return; }
  if (!mark) {
    mark = h('div', { id: 'd-net', class: 'd-net', role: 'status' },
      h('span', { class: 'progress', 'aria-hidden': 'true' }), h('span', {}, 'Reconnecting to the till…'));
    document.body.append(mark);
  }
}

render(last);
connect();
