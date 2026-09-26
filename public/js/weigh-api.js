// Talks to the main POS server's API. Configurable because the weighing station is often its own
// small computer next to the scale, on the same shop network as the till — not the same device.
const KEY = 'm3weigh.serverBase';

export const getServerBase = () => (localStorage.getItem(KEY) || location.origin).replace(/\/$/, '');
export const setServerBase = (url) => localStorage.setItem(KEY, (url || location.origin).replace(/\/$/, ''));

async function request(path, options) {
  let res;
  try { res = await fetch(getServerBase() + path, options); }
  catch { throw new Error('Could not reach the POS server — check the address and that both devices are on the same Wi-Fi'); }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

export const listProducts = () => request('/api/products');
export const createTicket = (sku, weightKg) =>
  request('/api/weigh/tickets', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sku, weightKg }) });
