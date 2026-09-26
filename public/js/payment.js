// Payment QR logic (UPI, using the shop's own UPI ID from Settings).
//   config.qrMode === 'receipt'          -> QR is printed under the thermal bill
//   config.qrMode === 'external-display' -> QR is pushed to the customer screen (Raspberry Pi)
// Payment is confirmed by the cashier ("UPI received"): a plain UPI QR does not report back to the POS.
import { pushToDisplay } from './display-link.js';

/** upi://pay link with the bill amount filled in. encodeURIComponent, not URLSearchParams: UPI apps read "+" literally. */
function upiLink(config, order) {
  const q = (k, v) => `${k}=${encodeURIComponent(v)}`;
  return `upi://pay?${[
    q('pa', config.upiVpa),
    q('pn', config.storeName),
    q('am', order.total.toFixed(2)),
    q('cu', 'INR'),
    q('tn', `Bill ${order.id}`)
  ].join('&')}`;
}

/** @returns {{ qr: {payload, imageUrl}, display: {ok, clients}|null }} */
export async function preparePayment(config, order) {
  if (!config.upiVpa) throw new Error('Add your UPI ID in Settings to show a payment QR');
  const qr = { id: null, payload: upiLink(config, order), imageUrl: null };
  let display = null;
  if (config.qrMode === 'external-display') {
    display = await pushToDisplay(config.displayUrl, {
      type: 'payment',
      storeName: config.storeName,
      orderId: order.id,
      amount: order.total,
      qrPayload: qr.payload,
      qrImageUrl: qr.imageUrl
    });
  }
  return { qr, display };
}
