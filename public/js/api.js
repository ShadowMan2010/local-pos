// Thin wrappers around the backend endpoints in server.js

// The shop PIN, exchanged once for a session token. Held in sessionStorage rather than localStorage on
// purpose: a token that outlives the tab would still be sitting on a till that was left unlocked, and
// sessionStorage goes when the tab closes, which is the lifetime we actually want.
const TOKEN_KEY = 'pos.pin.token';
export const getToken = () => { try { return sessionStorage.getItem(TOKEN_KEY) || ''; } catch { return ''; } };
export const setToken = (t) => { try { t ? sessionStorage.setItem(TOKEN_KEY, t) : sessionStorage.removeItem(TOKEN_KEY); } catch { /* private mode */ } };

// Fired when the server says the PIN is needed, so one gate can cover the whole app instead of every
// screen handling a 401 itself.
const PIN_NEEDED = 'pos:pin-needed';
// Consecutive refusals, so one unlucky request is not mistaken for a session that has really ended.
let pinNeededStreak = 0;
export const onPinNeeded = (fn) => {
  window.addEventListener(PIN_NEEDED, fn);
  return () => window.removeEventListener(PIN_NEEDED, fn);
};
export const needPin = () => window.dispatchEvent(new CustomEvent(PIN_NEEDED));

async function request(url, options) {
  const token = getToken();
  // Attached to every call, including the ones that are public, because the server simply ignores it
  // where it is not needed and this way no caller can forget.
  const headers = { ...(options?.headers || {}) };
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await fetch(url, {
    ...options,
    headers,
    // Never cache an API response. Live till data must not be served from a stale copy, and this bit
    // us for real: the browser reused an early `{"pinSet":false}` after a PIN was set, so a shop that
    // had locked its till still got an unlocked one. Same reasoning as no-store for everything else.
    cache: 'no-store'
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && data?.needsPin) {
    // A stale or revoked token: throw it away so the gate asks again rather than retrying forever
    // with a token the server will never accept.
    //
    // A real revocation (the PIN was changed, or the server restarted) is answered by every single
    // request, so there is no reason to doubt it. A *single* 401 among successful ones is not the same
    // thing, and the till used to treat it as one: the dashboard polls three badges every 8-15s, so one
    // unlucky request out of hundreds - a proxy hiccup, a dropped connection on shop Wi-Fi - threw the
    // token away and dropped the PIN screen over a live cart. That is the same "very disturbing" report
    // from a different angle. So one refusal is believed, and two in a row are not: the second proves it
    // was not a blip, and by then the shopkeeper has barely noticed anything happened.
    if (pinNeededStreak++ > 0) {
      setToken('');
      needPin();
    }
  } else if (pinNeededStreak > 0) {
    pinNeededStreak = 0; // the session is working, so any earlier 401 was noise
  }
  if (!res.ok) {
    // The status is attached because callers sometimes need to tell "this server does not have that
    // endpoint" apart from "that request was refused" — e.g. a frontend feature checking whether the
    // backend supports it at all. Losing that distinction turns a version mismatch into a dead screen.
    const err = new Error(data.error || `Request failed (${res.status})`);
    err.status = res.status;
    // `needsCode` is how the lock screen learns to show the second box. It is a separate flag from
    // `needsPin` on purpose: a request refused because the session lapsed wants the whole gate, while a
    // login refused for a missing phone code wants one extra field and nothing else — showing the full
    // takeover again would wipe the PIN somebody had just typed.
    if (data?.needsCode) err.needsCode = true;
    if (data?.clockDrift) err.clockDrift = true;
    // A second factor file that exists and cannot be read closes the till. The message says what to do about
    // it, so it is shown as the server words it rather than being flattened into a wrong-code message.
    if (data?.broken) err.broken = true;
    throw err;
  }
  return data;
}

const send = (method) => (url, body) =>
  request(url, { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
const post = send('POST');
const put = send('PUT');
const patch = send('PATCH');
const del = (url) => request(url, { method: 'DELETE' });

/* store settings */
export const getConfig = () => request('/api/config');
export const saveSetup = async (payload) => {
  const r = await request('/api/setup', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload)
  });
  // Saving settings can be the moment a PIN is set. The server hands back a session for it so the
  // person who just chose the PIN is not immediately locked out by their own hand.
  if (r.token) { pinNeededStreak = 0; setToken(r.token); }
  return r;
};

/* the shop PIN */
export const getAuthStatus = () => request('/api/auth/status');
/** Exchanges the PIN for a session token and stores it. Throws with the server's own message on a
 *  wrong PIN or a lockout, so the gate can show it verbatim. */
export const login = async (pin, code) => {
  // The code is only sent when there is one. Leaving `code` out entirely on a shop with no second factor
  // matters: a body of `{ pin, code: undefined }` serialises with the key present, and the server then has
  // to tell "no code" apart from "empty code" at the exact moment somebody is locked out.
  const body = code === undefined || code === null ? { pin } : { pin, code };
  const r = await request('/api/auth/pin', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
  });
  pinNeededStreak = 0; // a good session again, so an old refusal must not count towards the next one
  setToken(r.token);
  return r;
};
export const changePin = (pin) => post('/api/auth/change-pin', { pin });

/* the second factor */

/** Starts enrolment and returns { secret, url } — the link is what gets scanned. */
export const beginTwoFactor = (account) => post('/api/auth/2fa/begin', { account });
/** Confirms a phone with a code from it, and returns the backup codes. Shown exactly once. */
export const confirmTwoFactor = (code) => post('/api/auth/2fa/confirm', { code });
export const newBackupCodes = (code) => post('/api/auth/2fa/backup-codes', { code });
export const disableTwoFactor = (code) => post('/api/auth/2fa/disable', { code });
export const signOut = () => { pinNeededStreak = 0; setToken(''); needPin(); };

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
export const whatsappRelink = () => post('/api/whatsapp/relink');
export const whatsappToggle = () => post('/api/whatsapp/toggle');
export const listWaOrders = () => request('/api/whatsapp/orders');
export const acceptWaOrder = (code) => post(`/api/whatsapp/orders/${encodeURIComponent(code)}/accept`);
export const dismissWaOrder = (code) => post(`/api/whatsapp/orders/${encodeURIComponent(code)}/dismiss`);

/* deliveries: bills paid from a WhatsApp order, confirmed by the 4-digit code the customer reads out */
export const listDeliveries = () => request('/api/deliveries');
export const confirmDelivery = (id, code, by, photo) => post(`/api/orders/${encodeURIComponent(id)}/deliver`, { code, by, photo: photo || null });
/**
 * Uploads the handover picture and returns the stored path. Kept separate from the confirmation so
 * a photo can be filed against a bill that turns out to still be out for delivery, and so the
 * confirmation itself stays a small JSON call that cannot fail halfway through a large upload.
 * Sent as raw bytes rather than multipart: the server only ever accepts one image file here, and
 * the browser can put a File straight into the body with no encoding step in between.
 */
export const uploadDeliveryPhoto = (id, file) => request(`/api/orders/${encodeURIComponent(id)}/delivery-photo`, {
  method: 'POST',
  headers: { 'content-type': file.type || 'image/jpeg' },
  body: file
});
export const resendDelivery = (id) => post(`/api/orders/${encodeURIComponent(id)}/resend`);
export const newDeliveryCode = (id) => post(`/api/orders/${encodeURIComponent(id)}/new-code`);
/** Shop-side fallback when the parcel sticker can't be scanned. Starts the run like a scan does. */
export const confirmPickup = (id, by) => post(`/api/orders/${encodeURIComponent(id)}/delivery/pickup`, { by });
/** Hands a job back so it can be given to another boy. */
export const declineDelivery = (id, by) => post(`/api/orders/${encodeURIComponent(id)}/delivery/decline`, { by });
/** Points a job at a different delivery boy. Only possible while the parcel is in the shop. */
export const assignDelivery = (id, boy) => post(`/api/orders/${encodeURIComponent(id)}/delivery/assign`, { name: boy.name, phone: boy.phone });
/**
 * The package sticker's QR, fetched as a picture and handed back as an object URL.
 *
 * This used to be a plain path used straight in an <img src>. That is the one thing an <img> cannot do:
 * it carries no shop PIN, and the sticker route is behind the gate like everything else, so the browser
 * asked for it without a token, got a 401, and the shop was shown an empty box where the QR should be.
 * That is why "the pickup QR code is not working" - the code was fine and the decoder was fine; the
 * picture simply never arrived, and nothing on the sticker said why.
 *
 * Fetched here instead so the PIN travels with the request, and returned as a blob URL so it can still go
 * straight into an <img> and straight to the printer. Deliberately *not* made a public route: the QR
 * encodes the pickup token, which is what lets a delivery boy collect a parcel, so leaving it open would
 * hand that token to anything on the shop's Wi-Fi.
 */
export async function deliveryStickerImage(id) {
  const token = getToken();
  const res = await fetch(`/api/orders/${encodeURIComponent(id)}/delivery/sticker.png`, {
    cache: 'no-store',
    headers: token ? { authorization: `Bearer ${token}` } : {}
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    if (res.status === 401 && data?.needsPin) needPin();
    throw new Error(data.error || `Could not load the sticker (${res.status})`);
  }
  return URL.createObjectURL(await res.blob());
}

/* delivery boys: their own WhatsApp numbers, kept in Settings */
export const listDeliveryBoys = () => request('/api/delivery-boys');
export const addDeliveryBoy = (name, phone) => post('/api/delivery-boys', { name, phone });
export const removeDeliveryBoy = (phone) => del(`/api/delivery-boys/${encodeURIComponent(phone)}`);

/**
 * Customer complaints, which arrive by WhatsApp and are cleared on this screen.
 * `status` is 'open' or 'resolved'; the note is what the shop actually did, so it is kept with the
 * complaint and shown in the history rather than being thrown away.
 */
export const listComplaints = (status = '') =>
  request(`/api/complaints${status ? `?status=${encodeURIComponent(status)}` : ''}`);
/** -> { complaint, suggestedReply } — filing by hand also returns wording to read out or send. */
export const addComplaint = (phone, text) => post('/api/complaints', { phone, text });
// The server spells the field `handledBy`; sending `by` would be accepted and silently dropped.
export const resolveComplaint = (id, note, by) =>
  patch(`/api/complaints/${encodeURIComponent(id)}`, { status: 'resolved', note, handledBy: by });
export const reopenComplaint = (id) => patch(`/api/complaints/${encodeURIComponent(id)}`, { status: 'open' });

/**
 * How serious the shop thinks a complaint is: 'minor', 'major' or 'serious'.
 *
 * Only 'minor' can ever be answered by the till without a person reading it, and the server checks that
 * again along with the customer's own words, the AI's own opinion and the wording of the reply itself.
 */
export const setComplaintSeverity = (id, severity) =>
  patch(`/api/complaints/${encodeURIComponent(id)}`, { severity });
/** Asks what should be done about a complaint. Advise only — the server has no path from it to money. */
export const suggestComplaint = (id) =>
  post(`/api/complaints/${encodeURIComponent(id)}/suggest`, {});
/**
 * Sends the reply now, without a person reading it first.
 *
 * Deliberately not fire-and-forget: a refusal comes back as an error with the reason, and the reason is
 * shown rather than swallowed. The most useful thing this screen can tell somebody is *why* the till
 * would not answer a customer, and that is worth interrupting them for.
 */
/* Sends a reply the shop wrote itself to the customer, on WhatsApp.
 *
 * Goes out exactly as typed. The words are not screened — the rules about money and promises are there to
 * stop a model inventing them, and the owner deciding to promise a refund is a decision, not a slip. */
export const sendComplaintReply = (id, text) =>
  post(`/api/complaints/${encodeURIComponent(id)}/reply`, { text });

/* Today's sales summary + achievements */
export const getDailyStats = () => request('/api/stats/daily');

/* Reports over a date range: what sold, what it earned, day by day. Dates are YYMMDD. */
export const getRangeStats = (from, to) => request(`/api/stats/range?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`);

// A plain link, not a fetch: the browser handles the download and its own "save as" dialog.
export const exportUrl = (kind, from, to) => `/api/export/${kind}.csv?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`;

/* AI (Gemini / OpenRouter). The key is typed here and stored on the server; publicView() strips it, so
 * the browser only ever learns `configured`/`provider`/`model`, never the key itself. An empty apiKey
 * means "keep the one already saved" — re-saving the model must not wipe the key. */
export const getAiStatus = () => request('/api/ai/status');
export const saveAiConfig = (cfg) => post('/api/ai/config', cfg);
export const clearAiConfig = () => post('/api/ai/config', { clear: true });

/**
 * A photo of a shelf, a stack of packets or a supplier's list, read into DRAFT products.
 *
 * Nothing is saved here — the model's reading is only ever a suggestion, and every field is shown to
 * the shop to check before it becomes a real product. Sent as raw image bytes rather than multipart,
 * the same way the delivery photo is, because the server takes the file straight into the body.
 * -> Promise<Array<draft>>
 */
export const scanProducts = (blob) => request('/api/ai/scan-products', {
  method: 'POST', headers: { 'content-type': blob.type || 'image/jpeg' }, body: blob
}).then((r) => r.products || []);

/* Voice ordering (speech-to-text). Same idea as the AI key: the Whisper address and any STT key live on
 * the server and never leave it; only `enabled` and the engine name are ever sent to the browser. */
export const getVoiceStatus = () => request('/api/voice/status');
export const saveVoiceConfig = (cfg) => post('/api/voice/config', cfg);
