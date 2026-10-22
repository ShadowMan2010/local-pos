// Payment QR logic (UPI, using the shop's own UPI ID from Settings).
//   config.qrMode === 'receipt'          -> QR is printed under the thermal bill
//   config.qrMode === 'external-display' -> QR is pushed to the customer screen (Raspberry Pi)
// Payment is confirmed by the cashier ("UPI received"): a plain UPI QR does not report back to the POS.
import { pushToDisplay } from './display-link.js';

/**
 * The name to put on the customer display, or '' for a walk-in.
 *
 * Exported rather than re-derived at each call site because the name has to agree across every frame the
 * customer sees - preparing, QR, paid. A screen that greets one frame and not the next looks like two
 * different sales, and the till writes this key into four separate pushes already.
 *
 * Trimmed and length-capped at the boundary: the till can hold a long or padded name, and the customer
 * screen is a fixed panel. Letting a 60-character name through wraps onto a third line and shoves the
 * QR down, which is the one thing on that screen that must not move.
 */
export const displayCustomerName = (order) => String(order?.customer?.name || '').trim().slice(0, 28);

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
    /* The customer screen is told the sale is starting *before* the QR is built and sent, not at the same
       time. Two reasons, one of them about the customer rather than about the code.

       The obvious one is that `upiLink` and the push are a round trip, and until they finish the display is
       still showing the previous sale's idle page. That gap is short, but it is also exactly the moment the
       customer looks up from the counter, because the cashier just pressed Charge in front of them. A screen
       that has not changed is the one response that reads as broken.

       The other is that the amount is already known. `order.total` exists before any of this runs, so the
       display can show the real figure during the wait rather than a generic spinner. By the time the
       payment state arrives the customer has already read what they owe.

       Failures here are swallowed on purpose: this push is a courtesy, and a display that is not connected
       must not stop the cashier taking the payment. The QR push that follows reports its own failure. */
    const customerName = displayCustomerName(order);
    try {
      await pushToDisplay(config.displayUrl, {
        type: 'preparing',
        storeName: config.storeName,
        orderId: order.id,
        amount: order.total,
        customerName
      });
    } catch { /* the display may not be reachable; the real push below will say so */ }

    display = await pushToDisplay(config.displayUrl, {
      type: 'payment',
      storeName: config.storeName,
      orderId: order.id,
      amount: order.total,
      customerName,
      qrPayload: qr.payload,
      qrImageUrl: qr.imageUrl
    });
  }
  return { qr, display };
}
