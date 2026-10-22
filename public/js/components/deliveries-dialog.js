// Bills paid from a WhatsApp order that are still moving. A delivery takes two scans: the delivery
// boy picks the parcel up from the shop by photographing the sticker on the package, and only then is
// the customer told it is out for delivery and sent the 4-digit code that closes the job at the door.
// The code is never shown here, because typing what you can already see would prove nothing.
import { h, icon, iconBtn, money, snack, runBusy } from '../ui.js';
import * as api from '../api.js';

const STATUS = {
  packed: { label: 'Packed — waiting for pickup', tone: 'var(--md-primary)' },
  out: { label: 'Out for delivery', tone: 'var(--md-tertiary)' }
};

/**
 * Opens a small window with the package sticker and sends it straight to the printer. It is a plain
 * document rather than part of the till so what comes out of the printer is only the sticker — none of
 * the shop's own screens or buttons. The image comes from the server, so it is the same on every
 * till and a boy has to scan this exact code.
 *
 * The picture is fetched first, with the shop PIN, and only then is the window written. That order is
 * the whole point: the QR cannot be loaded by the <img> itself (a browser sends no PIN on an image
 * request), and a sticker window that opened with an empty box in it printed a blank label that the
 * delivery boy then could not scan — with nothing to say the code had never loaded. If the fetch fails
 * the window is never opened, so the shop gets the reason on screen instead of a useless piece of paper.
 */
async function printSticker(d) {
  let stickerUrl;
  try {
    stickerUrl = await api.deliveryStickerImage(d.id);
  } catch (e) {
    snack(e.message || 'Could not load the sticker QR', 6000);
    return false;
  }
  const win = window.open('', '_blank', 'width=420,height=560');
  if (!win) {
    URL.revokeObjectURL(stickerUrl);
    snack('Your browser blocked the sticker window — allow pop-ups for this page', 6000);
    return false;
  }
  win.document.write(`<!doctype html><html><head><title>Sticker ${d.id}</title><style>
    @page { margin: 8mm; }
    body { font: 13px/1.4 system-ui, sans-serif; margin: 0; padding: 16px; color: #000; }
    .wrap { border: 2px dashed #000; border-radius: 10px; padding: 14px; text-align: center; }
    h1 { font-size: 17px; margin: 0 0 2px; }
    .sub { font-size: 12px; color: #444; margin: 0 0 10px; }
    img { width: 250px; height: 250px; }
    .bill { font-size: 15px; font-weight: 700; margin: 8px 0 2px; }
    .foot { font-size: 11px; color: #444; margin-top: 8px; }
    @media print { .noprint { display: none; } }
  </style></head><body>
    <div class="wrap">
      <h1>${STATUS[d.status]?.label || 'Delivery'} sticker</h1>
      <p class="sub">Stick this on the package</p>
      <img src="${stickerUrl}" alt="Package pickup QR code">
      <p class="bill">${d.id}</p>
      <p class="sub">${d.customer?.name || d.customer?.phone || 'Walk-in customer'} · ${d.itemCount} ${d.itemCount === 1 ? 'item' : 'items'}</p>
      <p class="foot">The delivery boy sends a photo of this code to collect the parcel.</p>
    </div>
    <p class="noprint"><button onclick="window.print()">Print</button></p>
  </body></html>`);
  win.document.close();
  win.focus();
  // Printed from the loaded image rather than on a timer: a timer measured from the window opening
  // races the download, and on a slow shop connection it fired first and printed an empty sticker.
  const img = win.document.querySelector('img');
  const go = () => setTimeout(() => { try { win.print(); } catch { /* the button is there if the popup was blocked */ } }, 100);
  if (img?.complete) go();
  else img?.addEventListener('load', go, { once: true });
  // Revoked only once the window is closed: doing it immediately would break the image in the popup,
  // and leaving it leaks the blob for as long as the tab is open, which on a long shift is a lot.
  win.addEventListener('pagehide', () => URL.revokeObjectURL(stickerUrl), { once: true });
  return true;
}

export function openDeliveriesDialog({ onChange } = {}) {
  const dlg = h('dialog', { class: 'm3-dialog products-dialog' });
  const list = h('ul', { class: 'pm-list' });

  const action = (label, title, fn) => {
    const btn = h('button', { type: 'button', class: 'btn btn-text', title, onclick: async () => {
      // The label is left in place and only made invisible by CSS, so the button keeps its width and there
      // is no text to save and restore. The old version swapped the label for an ellipsis, which lost the
      // button's own name for the duration and left a row of identical "…" buttons with nothing to tell
      // them apart.
      await runBusy(btn, async () => {
        try { await fn(); } catch (err) { snack(err.message, 5000, 'error'); }
      });
    } }, label);
    return btn;
  };

  const row = (d) => {
    const packed = d.status === 'packed';
    const items = d.items.map((i) => (i.isWeight ? `${i.weightKg} kg ${i.name}` : `${i.qty} x ${i.name}`)).join(', ');
    const when = new Date(d.outAt || d.packedAt).toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit' });
    const who = d.customer?.name || d.customer?.phone || 'Walk-in customer';
    const boy = d.boy?.name || 'nobody yet';
    const status = STATUS[d.status] || { label: d.status, tone: 'var(--md-primary)' };

    const codeInput = h('input', {
      class: 'code-input', type: 'text', inputmode: 'numeric', maxlength: '4', placeholder: '••••',
      'aria-label': `Delivery code for bill ${d.id}`,
      onkeydown: (e) => { if (e.key === 'Enter') submit(d, codeInput, deliveredBtn, photoFile); }
    });
    const deliveredBtn = h('button', { type: 'button', class: 'btn btn-filled', onclick: () => submit(d, codeInput, deliveredBtn, photoFile) }, 'Delivered');

    const stickerBtn = action('Sticker', 'Print the package sticker with the QR the delivery boy scans to collect this parcel',
      // Awaited, and the success message only after it resolves. It used to fire the snackbar straight
      // away, so a sticker that failed to load still told the shop it was printing — and the boy turned
      // up with nothing to scan.
      async () => {
        const ok = await printSticker(d);
        if (ok) snack(`Sticker for ${d.id} — stick it on the package`, 3000);
      });

    // While the parcel is in the shop the useful actions are about getting a boy to take it. Once it
    // has left, the only thing left is closing the handover, so the code box replaces them.
    const packedActions = [
      stickerBtn,
      action('Picked up', 'Shop-side fallback: mark the parcel collected without the sticker scan. The customer is told it is out for delivery either way.', async () => {
        const r = await api.confirmPickup(d.id, d.boy?.name || 'shop');
        snack(r.notified ? `${d.id} out for delivery — the customer has been sent the code` : `${d.id} picked up, but the customer could NOT be messaged — tell them by hand`, 6000, r.notified ? 'success' : 'error');
        load(); onChange?.();
      }),
      action('Give to another boy', 'Hand this job to a different delivery boy while it is still in the shop', async () => {
        const { boys } = await api.listDeliveryBoys();
        if (!boys?.length) return snack('No delivery boys are set up — add one in Settings', 5000);
        const pick = prompt(`Give bill ${d.id} to which delivery boy?\n\n${boys.map((b, i) => `${i + 1}. ${b.name} (${b.phone})`).join('\n')}\n\nType the number:`);
        if (pick === null) return;
        const boy = boys[Number(pick.trim()) - 1];
        if (!boy) return snack('That is not one of the delivery boys', 4000);
        const r = await api.assignDelivery(d.id, boy);
        snack(r.jobSent ? `Job sent to ${boy.name}` : `Assigned to ${boy.name}, but the message did NOT go out — tell him by hand`, 5000, r.jobSent ? 'success' : 'error');
        load();
      }),
      action('Hand back', 'Nobody can take this one. Takes it off the list so it can be sorted out.',
        async () => {
          if (!confirm(`Hand bill ${d.id} back?\n\nIt leaves the delivery list. The customer has only been told it is being packed.`)) return;
          await api.declineDelivery(d.id, d.boy?.name || 'shop');
          snack(`${d.id} handed back`, 2500, 'success');
          load();
        })
    ];

    // The code is what closes a delivery, so it stays the main action. The photo beside it is
    // optional: the shop keeps it as evidence when the till is handed one, but nobody is stopped
    // from closing a real handover because a camera would not cooperate.
    let photoFile = null;
    const photoInput = h('input', {
      type: 'file', accept: 'image/*', capture: 'environment', class: 'proof-input',
      'aria-label': `Handover photo for bill ${d.id}`,
      onchange: (e) => { photoFile = e.target.files?.[0] || null; }
    });
    const photoBtn = h('button', {
      type: 'button', class: 'btn btn-outlined',
      title: 'Optional: attach a photo of the handover as proof',
      onclick: () => photoInput.click()
    }, 'Photo');

    const outActions = [
      h('div', { class: 'code-row' }, codeInput, deliveredBtn, photoBtn, photoInput),
      action('Resend', 'Send the handover code to the customer again', async () => {
        const r = await api.resendDelivery(d.id);
        snack(r.notified ? 'Code sent to the customer again' : 'Could not send — check WhatsApp is linked', 5000, r.notified ? 'success' : 'error');
        load();
      }),
      action('New code', 'Issue a new code and text it to the customer only. The old one stops working. Use when the code may be known to someone it should not be.', async () => {
        if (!confirm(`Give bill ${d.id} a new delivery code?\n\nThe customer is texted the new code. The old one stops working.`)) return;
        const r = await api.newDeliveryCode(d.id);
          snack(r.notified ? 'New code sent to the customer. The old code no longer works.'
            : 'Could not send — check WhatsApp is linked', 5000, r.notified ? 'success' : 'error');

        load();
      })
    ];

    // A failed send means the customer never got the message, so someone has to pass it on by hand.
    const notSent = (!d.notified || !d.jobSent) && d.status === 'out';

    return h('li', { class: 'pm-row' },
      h('div', { class: 'thumb' }, icon(packed ? 'inventory_2' : 'local_shipping')),
      h('div', { class: 'pm-main' },
        h('div', { class: 'title-s' }, `${who} · ${money(d.total)}`),
        h('div', { class: 'body-s', style: `color:${status.tone}` }, status.label),
        h('div', { class: 'body-s muted' }, items),
        h('div', { class: 'body-s muted' },
          `${d.id} · ${d.itemCount} ${d.itemCount === 1 ? 'item' : 'items'} · ${packed ? 'packed' : 'out'} at ${when} · with ${boy}`),
        // Only a parcel still sitting in the shop needs a sticker. Saying so on a bill that is
        // already out with a boy would be a false alarm about something that no longer matters.
        (packed && !d.hasSticker)
          ? h('div', { class: 'body-s', style: 'color:var(--md-error);margin-top:2px' },
              'No package sticker on this bill — it was billed before stickers existed, so mark it picked up by hand')
          : null,
        notSent
          ? h('div', { class: 'body-s', style: 'color:var(--md-error);margin-top:2px' },
              `Code not sent${!d.notified ? ' to the customer' : ''}${!d.jobSent ? ' to the delivery boy' : ''} — pass it on by hand`)
          : null,
        packed
          ? h('div', { class: 'code-row' }, ...packedActions)
          : h('div', { class: 'wa-actions' }, ...outActions)));
  };

  async function submit(d, codeInput, btn, photoFile) {
    const code = codeInput.value.trim();
    if (!/^\d{4}$/.test(code)) return snack('Type the 4-digit code the customer reads out', 4000);
    btn.disabled = true;
    btn.textContent = 'Saving…';
    try {
      // The photo goes up first and separately. If the code then turns out to be wrong, the bill is
      // still out for delivery and the file is simply unused — a far smaller problem than a
      // half-finished handover where the photo saved but the confirmation did not.
      let photo = null;
      if (photoFile) {
        const up = await api.uploadDeliveryPhoto(d.id, photoFile);
        photo = up.url;
      }
      await api.confirmDelivery(d.id, code, d.boy?.name || 'shop', photo);
      snack(photo ? `Bill ${d.id} marked delivered, with the handover photo` : `Bill ${d.id} marked delivered`, 2500, 'success');
      load();
      onChange?.();
    } catch (err) {
      snack(err.message, 5000, 'error');
      btn.disabled = false;
      btn.textContent = 'Delivered';
      codeInput.select();
    }
  }

    async function load() {
      list.replaceChildren(h('li', { class: 'cart-empty' }, h('p', { class: 'body-m' }, 'Loading…')));
      try {
        const { deliveries, recentDelivered } = await api.listDeliveries();
        const packed = deliveries.filter((d) => d.status === 'packed').length;
        const kids = deliveries.length ? deliveries.map(row) : [h('li', { class: 'cart-empty' }, icon('check_circle'),
          h('p', { class: 'body-l' }, 'Nothing on delivery.'),
          h('p', { class: 'body-m' }, 'WhatsApp orders appear here once their bill is charged.'))];
        list.replaceChildren(...kids);
        // Recently finished jobs sit under the live ones. A delivery closed by code alone is listed
        // with a dashed "no photo" marker rather than a thumbnail, so the shop can see at a glance
        // which handovers have no picture behind them if a customer later disputes one.
        if (recentDelivered?.length) {
          list.append(h('li', { class: 'body-s muted', style: 'padding:14px 0 2px' }, 'Recently delivered'),
            ...recentDelivered.map((d) => h('li', { class: 'pm-row' },
              d.proofPhoto
                ? h('a', { href: d.proofPhoto, target: '_blank', rel: 'noopener', title: `Open the handover photo for ${d.id}` },
                    h('img', { class: 'proof-thumb', src: d.proofPhoto, alt: `Handover photo for bill ${d.id}`, loading: 'lazy' }))
                : h('div', { class: 'proof-none', title: 'No handover photo was attached to this delivery' }, 'no photo'),
              h('div', { class: 'pm-main' },
                h('div', { class: 'title-s' }, `${d.customer?.name || d.customer?.phone || 'Walk-in customer'} · ${money(d.total)}`),
                h('div', { class: 'body-s muted' }, `${d.id} · ${d.itemCount} ${d.itemCount === 1 ? 'item' : 'items'}`),
                h('div', { class: 'body-s muted' },
                  `Delivered ${new Date(d.deliveredAt).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' })}${d.confirmedBy ? ` · by ${d.confirmedBy}` : ''}`)))));
        }
        if (deliveries.length) {

        dlg.querySelector('.dlg-sub')?.remove();
        dlg.querySelector('.field-hint')?.replaceChildren(
          h('span', {}, packed
            ? `${packed} packed in the shop — print the sticker and wait for the delivery boy to scan it.`
            : 'Ask the customer for the 4-digit code we sent them, then type it to confirm the handover.'));
      }
    } catch (err) {
      list.replaceChildren(h('li', { class: 'cart-empty' }, h('p', { class: 'body-m' }, err.message)));
    }
  }

  dlg.append(
    h('div', { class: 'dlg-head' },
      h('h2', { class: 'title-l' }, 'On delivery'), h('span', { class: 'spacer' }),
      iconBtn('close', () => dlg.close(), 'Close')),
    h('p', { class: 'field-hint', style: 'margin:0 16px 12px' },
      'Print the package sticker, then the delivery boy collects the parcel by sending a photo of it. ' +
      'That is when the customer is told it is out for delivery and sent the code for the door.'),
    list);
  dlg.addEventListener('close', () => dlg.remove());

  document.body.append(dlg);
  dlg.showModal();
  load();
}
