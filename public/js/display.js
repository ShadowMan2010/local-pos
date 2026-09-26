// Customer-facing screen. Open http://<pos-ip>:3000/display.html on the Raspberry Pi (kiosk mode).
import { h, money, qrDataUrl } from './ui.js';

const stage = document.getElementById('stage');
let storeName = '';
let last = { type: 'idle' };

fetch('/api/config').then((r) => r.json()).then((d) => {
  storeName = d.config?.storeName || storeName;
  render(last);
}).catch(() => {});

function render(msg) {
  last = msg;
  if (msg.storeName) storeName = msg.storeName;

  if (msg.type === 'payment') {
    let src = msg.qrImageUrl;
    try { if (msg.qrPayload) src = qrDataUrl(msg.qrPayload, 360); } catch (e) { console.error(e); }
    stage.replaceChildren(h('div', { class: 'd-wrap' },
      h('div', { class: 'title-l muted' }, storeName),
      h('div', { class: 'title-m muted' }, 'Amount to pay'),
      h('div', { class: 'd-amount' }, money(msg.amount)),
      h('div', { class: 'd-qr' }, src ? h('img', { src, alt: 'Scan to pay' }) : h('p', { class: 'title-m' }, 'QR unavailable')),
      h('div', { class: 'title-m' }, 'Scan with any UPI app to pay'),
      h('div', { class: 'body-m muted' }, `Bill ${msg.orderId || ''}`)
    ));
  } else if (msg.type === 'paid') {
    stage.replaceChildren(h('div', { class: 'd-wrap' },
      h('span', { class: 'material-symbols-rounded d-icon' }, 'check_circle'),
      h('div', { class: 'headline-m' }, 'Payment received'),
      h('div', { class: 'title-m muted' }, 'Thank you! Visit again.')
    ));
  } else {
    stage.replaceChildren(h('div', { class: 'd-wrap' },
      h('span', { class: 'material-symbols-rounded d-icon' }, 'storefront'),
      h('div', { class: 'display-s' }, storeName || 'Welcome'),
      h('div', { class: 'title-m muted' }, 'Welcome!')
    ));
  }
}

function connect() {
  const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
  ws.onmessage = (e) => { try { render(JSON.parse(e.data)); } catch (err) { console.error(err); } };
  ws.onclose = () => setTimeout(connect, 2000); // auto-reconnect
  ws.onerror = () => ws.close();
}

render(last);
connect();
