// POS -> customer display (Raspberry Pi Zero 2W or any small screen).
//
// Transport: HTTP POST from the POS to /api/display/push; the display page listens on a WebSocket
// (/ws) and is updated instantly.
//   * baseUrl empty  -> use this same server as the hub (Pi just opens  http://<pos-ip>:3000/display.html)
//   * baseUrl set    -> POST to that address instead (e.g. http://192.168.1.60:3000 when the Pi runs its own server.js)
//
// Note: if the POS is opened over https, browsers block http:// calls to the Pi (mixed content).
// Keep the POS and the display on plain http inside the shop's LAN.

/** msg: { type:'payment'|'paid'|'idle', storeName, orderId?, amount?, qrPayload?, qrImageUrl? } */
export async function pushToDisplay(baseUrl, msg) {
  const url = `${(baseUrl || '').replace(/\/$/, '')}/api/display/push`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(msg)
  });
  if (!res.ok) throw new Error(`Customer display did not accept the update (${res.status})`);
  return res.json(); // { ok:true, clients:<screens connected> }
}

export const showIdle = (baseUrl, storeName) => pushToDisplay(baseUrl, { type: 'idle', storeName });

export async function displayStatus(baseUrl) {
  const res = await fetch(`${(baseUrl || '').replace(/\/$/, '')}/api/display/status`);
  if (!res.ok) throw new Error('Display status unavailable');
  return res.json();
}
