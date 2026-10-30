// Persistent WebSocket connection to the /ws-admin hub.
//
// The server uses this channel to push events that the till should react to immediately:
//   • 'complaint'           — a new or updated customer complaint
//   • 'wa-order-name'       — a WhatsApp order's customer name has been filled in
//   • 'wa-payment-proof'    — a customer sent a UPI screenshot over WhatsApp
//   • 'upi-auto-confirmed'  — the Android payment watcher matched a bank notification to a pending bill
//
// Each server event is re-dispatched as a CustomEvent on `window`:
//   window.addEventListener('pos:admin', (e) => { const { type, ...rest } = e.detail; … });
//
// Components that want a specific type filter by e.detail.type. Nothing outside this module talks
// to the socket directly, so reconnect logic and buffering are in one place.

const RECONNECT_DELAY_MS = 3000;

let ws = null;
let reconnectTimer = null;

function connect() {
  if (ws && (ws.readyState === WebSocket.CONNECTING || ws.readyState === WebSocket.OPEN)) return;

  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${proto}://${location.host}/ws-admin`);

  ws.addEventListener('message', (e) => {
    let msg;
    try { msg = JSON.parse(e.data); } catch { return; }
    window.dispatchEvent(new CustomEvent('pos:admin', { detail: msg }));
  });

  ws.addEventListener('close', () => {
    ws = null;
    if (reconnectTimer) return;
    reconnectTimer = setTimeout(() => { reconnectTimer = null; connect(); }, RECONNECT_DELAY_MS);
  });

  ws.addEventListener('error', () => {
    // 'close' fires after 'error', so reconnect is handled there.
  });
}

/** Subscribe to all admin-channel events. Returns an unsubscribe function. */
export function onAdminEvent(handler) {
  const listener = (e) => handler(e.detail);
  window.addEventListener('pos:admin', listener);
  return () => window.removeEventListener('pos:admin', listener);
}

// Connect as soon as this module is imported.
connect();
