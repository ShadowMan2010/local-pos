// Thin wrappers around the backend endpoints in server.js

async function request(url, options) {
  const res = await fetch(url, options);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

const send = (method) => (url, body) =>
  request(url, { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
const post = send('POST');
const put = send('PUT');
const del = (url) => request(url, { method: 'DELETE' });

/* store settings */
export const getConfig = () => request('/api/config');
export const saveSetup = (payload) => post('/api/setup', payload);

/* products */
export const listProducts = () => request('/api/products');
export const createProduct = (p) => post('/api/products', p);
export const updateProduct = (id, p) => put(`/api/products/${encodeURIComponent(id)}`, p);
export const deleteProduct = (id) => del(`/api/products/${encodeURIComponent(id)}`);
export const loadDemoProducts = () => post('/api/products/demo');
export const importFirebaseProducts = () => post('/api/products/import-firebase');

/* bills */
export const newOrderId = () => post('/api/orders/next-id').then((r) => r.id);
/** -> { order, customer } — the server lowers stock and updates the customer's visit count */
export const saveOrder = (order) => post('/api/orders', order);

/* customers */
export const lookupCustomer = (phone) => request(`/api/customers/lookup?phone=${encodeURIComponent(phone)}`).then((r) => r.customer);
export const listCustomers = (q = '') => request(`/api/customers?q=${encodeURIComponent(q)}`);

/* weighing-station tickets: created at the scale, redeemed once at the till */
export const redeemWeighTicket = (code) => post(`/api/weigh/tickets/${encodeURIComponent(code)}/redeem`);

/* WhatsApp orders (unofficial — see whatsapp.js on the server) */
export const getWhatsappStatus = () => request('/api/whatsapp/status');
export const whatsappUnlink = () => post('/api/whatsapp/unlink');
export const listWaOrders = () => request('/api/whatsapp/orders');
export const acceptWaOrder = (code) => post(`/api/whatsapp/orders/${encodeURIComponent(code)}/accept`);
export const dismissWaOrder = (code) => post(`/api/whatsapp/orders/${encodeURIComponent(code)}/dismiss`);

/* deliveries: bills paid from a WhatsApp order, confirmed by the 4-digit code the customer reads out */
export const listDeliveries = () => request('/api/deliveries');
export const confirmDelivery = (id, code, by) => post(`/api/orders/${encodeURIComponent(id)}/deliver`, { code, by });
export const resendDelivery = (id) => post(`/api/orders/${encodeURIComponent(id)}/resend`);
export const newDeliveryCode = (id) => post(`/api/orders/${encodeURIComponent(id)}/new-code`);
/** Shop-side fallback when the parcel sticker can't be scanned. Starts the run like a scan does. */
export const confirmPickup = (id, by) => post(`/api/orders/${encodeURIComponent(id)}/delivery/pickup`, { by });
/** Hands a job back so it can be given to another boy. */
export const declineDelivery = (id, by) => post(`/api/orders/${encodeURIComponent(id)}/delivery/decline`, { by });
/** Points a job at a different delivery boy. Only possible while the parcel is in the shop. */
export const assignDelivery = (id, boy) => post(`/api/orders/${encodeURIComponent(id)}/delivery/assign`, { name: boy.name, phone: boy.phone });
/** The package sticker's QR, as a PNG, to print and stick on the parcel. */
export const deliveryStickerUrl = (id) => `/api/orders/${encodeURIComponent(id)}/delivery/sticker.png`;

/* delivery boys: their own WhatsApp numbers, kept in Settings */
export const listDeliveryBoys = () => request('/api/delivery-boys');
export const addDeliveryBoy = (name, phone) => post('/api/delivery-boys', { name, phone });
export const removeDeliveryBoy = (phone) => del(`/api/delivery-boys/${encodeURIComponent(phone)}`);

/* Today's sales summary + achievements */
export const getDailyStats = () => request('/api/stats/daily');

/* Reports over a date range: what sold, what it earned, day by day. Dates are YYMMDD. */
export const getRangeStats = (from, to) => request(`/api/stats/range?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`);

// A plain link, not a fetch: the browser handles the download and its own "save as" dialog.
export const exportUrl = (kind, from, to) => `/api/export/${kind}.csv?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`;
