// POS -> customer display (Raspberry Pi Zero 2W or any small screen).
//
// Transport: HTTP POST from the POS to /api/display/push; the display page listens on a WebSocket
// (/ws) and is updated instantly.
//   * baseUrl empty  -> use this same server as the hub (Pi just opens  http://<pos-ip>:3000/display.html)
//   * baseUrl set    -> POST to that address instead (e.g. http://192.168.1.60:3000 when the Pi runs its own server.js)
//
// Note: if the POS is opened over https, browsers block http:// calls to the Pi (mixed content).
// Keep the POS and the display on plain http inside the shop's LAN.

import { getToken, needPin } from './api.js';

/** msg: { type:'preparing'|'payment'|'paid'|'idle', storeName, orderId?, amount?, qrPayload?, qrImageUrl? } */
export async function pushToDisplay(baseUrl, msg) {
  const url = `${(baseUrl || '').replace(/\/$/, '')}/api/display/push`;
  /* The shop PIN has to travel with this push, and that is the whole reason for the extra few lines.

     /api/display/push is behind the same gate as every other /api route, because anyone who can push
     can put a fake payment QR on the customer screen. But this call was made with a bare `fetch`, which
     carries no session token, so once a shop set a PIN every push came back 401 and the cashier saw
     "Customer display did not accept the update (401)" at the moment they pressed Charge. It read like
     the second screen was broken; the second screen was fine, the request simply arrived unrecognised.

     Sending the token fixes it without opening the route, which is deliberate: making it public would
     let anything on the shop's Wi-Fi overwrite what the customer is looking at. A 401 is also treated as a
     real signal rather than swallowed — if the session has genuinely expired, needPin() puts the gate back
     up so the next attempt retries with a fresh token instead of failing forever. */
  const token = getToken();
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(msg)
  });
  if (!res.ok) {
    if (res.status === 401) {
      const data = await res.json().catch(() => ({}));
      if (data?.needsPin) needPin();
      throw new Error(data.error || 'Customer display did not accept the update (401)');
    }
    throw new Error(`Customer display did not accept the update (${res.status})`);
  }
  return res.json(); // { ok:true, clients:<screens connected> }
}

export const showIdle = (baseUrl, storeName) => pushToDisplay(baseUrl, { type: 'idle', storeName });

export async function displayStatus(baseUrl) {
  const token = getToken();
  const res = await fetch(`${(baseUrl || '').replace(/\/$/, '')}/api/display/status`, {
    cache: 'no-store',
    headers: token ? { authorization: `Bearer ${token}` } : {}
  });
  if (!res.ok) {
    if (res.status === 401) needPin();
    throw new Error('Display status unavailable');
  }
  return res.json();
}
