// Renders the WhatsApp order bill as a PNG: store name, the itemised order, the total, and — when
// the customer is paying by UPI — a scannable UPI QR code.
//
// Deliberately separate from whatsapp.js (the connection) and whatsapp-bot.js (message text), the
// same split the rest of the WhatsApp code uses: this file turns an order into an image and nothing
// else, so it can be rendered and eyeballed without a WhatsApp connection.
import QRCode from 'qrcode';
import sharp from 'sharp';

const money = (n) => `Rs ${(Math.round(n * 100) / 100).toFixed(2)}`;

/** XML-escape: product names come from the shop's own catalogue, but they are still free text. */
const xml = (s) => String(s).replace(/[<>&'"]/g, (c) => (
  { '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' }[c]
));

/**
 * upi://pay link with the amount filled in. Kept byte-for-byte compatible with the POS's own
 * payment.js so a customer scanning either QR lands in the same UPI app with the same amount.
 * encodeURIComponent, not URLSearchParams: UPI apps read "+" literally.
 */
export function upiPayload({ vpa, storeName, total, code }) {
  const q = (k, v) => `${k}=${encodeURIComponent(v)}`;
  return `upi://pay?${[
    q('pa', vpa),
    q('pn', storeName),
    q('am', Number(total).toFixed(2)),
    q('cu', 'INR'),
    q('tn', `Bill ${code}`)
  ].join('&')}`;
}

const W = 720;
const PAD = 40;
const QR_SIZE = 300;

/**
 * @param {{
 *   storeName: string,
 *   code: string,
 *   items: {name: string, price: number, qty: number}[],
 *   total: number,
 *   phone?: string,
 *   method: 'upi'|'cash',
 *   upiVpa?: string
 * }} bill
 * @returns {Promise<Buffer>} PNG bytes
 */
export async function buildBillImage(bill) {
  const { storeName, code, items, total, phone, method, upiVpa } = bill;
  const wantsQr = method === 'upi' && Boolean(upiVpa);
  const hasWeight = items.some((i) => i.isWeight);

  // One row per line item, wrapped onto extra lines when the name is long. The amount is
  // right-aligned at a fixed x, so the name gets a hard character budget: 20 chars plus a "N x "
  // prefix is measured to stay clear of the widest realistic amount ("Rs 99999.99") even for
  // wide uppercase glyphs, so the two columns can never overlap.
  const AMT_X = W - PAD;
  const NAME_MAX = 20;
  const rows = [];
  let y = 0;
  for (const it of items) {
    // A weight line reads "2 kg x Rice"; its price is already per kg, so the amount is the same
    // price x qty calculation as a piece line.
    const label = it.isWeight ? `${it.weightKg} kg` : String(it.qty);
    const name = String(it.name);
    const parts = [];
    for (let i = 0; i < name.length; i += NAME_MAX) parts.push(name.slice(i, i + NAME_MAX));
    parts.forEach((part, i) => {
      rows.push({ x: PAD, y, text: i === 0 ? `${label} x ${part}` : `    ${part}`, size: 24 });
      y += 34;
    });
    rows.push({ x: AMT_X, y: y - 34, text: money(it.price * it.qty), size: 24, anchor: 'end' });
  }

  const itemBlockH = y;
  const weightNoteH = hasWeight ? 34 : 0;
  const qrTop = PAD + 150 + itemBlockH + weightNoteH + 40;
  const height = wantsQr
    ? qrTop + QR_SIZE + 150
    : PAD + 150 + itemBlockH + weightNoteH + 40 + 90;

  const parts = [];
  parts.push(`<rect width="${W}" height="${height}" fill="#ffffff"/>`);
  parts.push(`<rect x="0" y="0" width="${W}" height="8" fill="#6750a4"/>`);
  parts.push(`<text x="${PAD}" y="${PAD + 44}" font-size="34" font-weight="700" fill="#1b1b1f">${xml(storeName)}</text>`);
  parts.push(`<text x="${AMT_X}" y="${PAD + 44}" font-size="24" text-anchor="end" fill="#49454f">${xml(code)}</text>`);

  const sub = new Date().toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' });
  parts.push(`<text x="${PAD}" y="${PAD + 76}" font-size="20" fill="#49454f">${xml(sub)}${phone ? ' · ' + xml(phone) : ''}</text>`);
  parts.push(`<line x1="${PAD}" y1="${PAD + 100}" x2="${AMT_X}" y2="${PAD + 100}" stroke="#e0e0e0" stroke-width="2"/>`);

  for (const r of rows) {
    parts.push(`<text x="${r.x}" y="${PAD + 150 + r.y}" font-size="${r.size}" fill="#1b1b1f"${r.anchor ? ` text-anchor="${r.anchor}"` : ''}>${xml(r.text)}</text>`);
  }

  const totalY = PAD + 150 + itemBlockH + 8;
  parts.push(`<line x1="${PAD}" y1="${totalY - 26}" x2="${AMT_X}" y2="${totalY - 26}" stroke="#e0e0e0" stroke-width="2"/>`);
  parts.push(`<text x="${PAD}" y="${totalY + 14}" font-size="28" font-weight="700" fill="#1b1b1f">Total</text>`);
  parts.push(`<text x="${AMT_X}" y="${totalY + 14}" font-size="28" font-weight="700" text-anchor="end" fill="#1b1b1f">${xml(money(total))}</text>`);

  // Never present a customer-declared weight as final: the shop re-weighs on the scale.
  if (hasWeight) {
    parts.push(`<text x="${PAD}" y="${totalY + 48}" font-size="19" fill="#8a5a00">Weight is an estimate - it will be re-weighed at the counter.</text>`);
  }

  if (wantsQr) {
    parts.push(`<text x="${W / 2}" y="${qrTop - 14}" font-size="24" text-anchor="middle" fill="#1b1b1f">Scan &amp; pay with any UPI app</text>`);
    // White quiet zone so the QR still scans against the page background.
    parts.push(`<rect x="${W / 2 - QR_SIZE / 2 - 12}" y="${qrTop - 8}" width="${QR_SIZE + 24}" height="${QR_SIZE + 24}" fill="#ffffff"/>`);
    parts.push(`<text x="${W / 2}" y="${qrTop + QR_SIZE + 44}" font-size="20" text-anchor="middle" fill="#49454f">${xml(upiVpa)}</text>`);
    parts.push(`<text x="${W / 2}" y="${qrTop + QR_SIZE + 76}" font-size="20" text-anchor="middle" fill="#49454f">Then send "paid" to the shop</text>`);
  } else {
    const cashY = totalY + (hasWeight ? 86 : 70);
    parts.push(`<text x="${W / 2}" y="${cashY}" font-size="26" text-anchor="middle" fill="#1b1b1f">Cash — please pay at the counter</text>`);
  }

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${height}">${parts.join('')}</svg>`;
  const base = sharp(Buffer.from(svg));

  if (!wantsQr) return base.png().toBuffer();

  // Composited rather than embedded as a data URI: librsvg's data-URI image support varies, and
  // sharp's composite path is the same one the POS already relies on for thumbnails.
  const qr = await QRCode.toBuffer(upiPayload({ vpa: upiVpa, storeName, total, code }), {
    type: 'png',
    width: QR_SIZE,
    margin: 0,
    errorCorrectionLevel: 'M'
  });
  return base
    .composite([{ input: qr, top: Math.round(qrTop), left: Math.round(W / 2 - QR_SIZE / 2) }])
    .png()
    .toBuffer();
}
