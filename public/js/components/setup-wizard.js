// Module 1 — first-time configuration form (also used for Settings -> edit).
import { h, icon, snack, qrDataUrl } from '../ui.js';
import { saveSetup, getWhatsappStatus, whatsappUnlink, listDeliveryBoys, addDeliveryBoy, removeDeliveryBoy } from '../api.js';
import { cacheConfig } from '../store.js';

function field({ name, label, value = '', type = 'text', placeholder, hint, required, full, inputmode }) {
  return h('div', { class: full ? 'full' : '' },
    h('label', { class: 'm3-field' },
      h('input', { name, type, value, placeholder: placeholder || ' ', required, inputmode, autocomplete: 'off', spellcheck: 'false' }),
      h('span', {}, label + (required ? ' *' : ''))
    ),
    hint && h('small', { class: 'field-hint' }, hint)
  );
}

function section(iconName, title, subtitle, ...body) {
  return h('section', { class: 'm3-card' },
    h('div', { class: 'card-head' }, icon(iconName),
      h('div', {}, h('h2', { class: 'title-m' }, title), h('p', { class: 'body-m muted' }, subtitle))),
    ...body
  );
}

// Settings-only: the delivery boys' own WhatsApp numbers. A message from one of these numbers is
// read as a delivery update rather than a new customer order, so this list is what makes that work.
function deliveryBoySection() {
  const list = h('ul', { class: 'boy-list' });
  const nameIn = h('input', { type: 'text', placeholder: 'Name', maxlength: '40', autocomplete: 'off' });
  const phoneIn = h('input', { type: 'tel', inputmode: 'numeric', placeholder: '10-digit WhatsApp number', maxlength: '16', autocomplete: 'off' });
  const addBtn = h('button', { type: 'button', class: 'btn btn-filled' }, 'Add');

  async function load() {
    try {
      const { boys } = await listDeliveryBoys();
      list.replaceChildren(...(boys.length
        ? boys.map((b) => h('li', { class: 'boy-row' },
            h('span', { class: 'title-s' }, b.name),
            h('span', { class: 'body-m muted' }, b.phone),
            h('button', {
              type: 'button', class: 'btn btn-text',
              onclick: async () => {
                if (!confirm(`Remove ${b.name} from the delivery list?`)) return;
                try { await removeDeliveryBoy(b.phone); load(); } catch (err) { snack(err.message, 4000); }
              }
            }, 'Remove')))
        : [h('li', { class: 'body-m muted' }, 'No delivery boys yet. Without one, WhatsApp orders cannot be charged.')]));
    } catch (err) {
      list.replaceChildren(h('li', { class: 'body-m muted' }, err.message));
    }
  }

  async function add() {
    const name = nameIn.value.trim();
    const phone = phoneIn.value.trim();
    if (!name || !phone) return snack('Enter the name and the WhatsApp number');
    addBtn.disabled = true;
    try {
      await addDeliveryBoy(name, phone);
      nameIn.value = ''; phoneIn.value = '';
      load();
    } catch (err) { snack(err.message, 5000); }
    finally { addBtn.disabled = false; }
  }
  addBtn.addEventListener('click', add);
  for (const el of [nameIn, phoneIn]) el.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); add(); } });

  const card = section('local_shipping', 'Delivery boys',
    'Their own WhatsApp numbers. When you charge a WhatsApp order you pick one, he gets the job and a 4-digit code, and he confirms the handover by sending that code back from his WhatsApp.',
    list,
    h('div', { class: 'boy-add' },
      h('label', { class: 'm3-field compact' }, nameIn, h('span', {}, 'Name')),
      h('label', { class: 'm3-field compact' }, phoneIn, h('span', {}, 'WhatsApp number')),
      addBtn));

  load();
  return card;
}

// Settings-only: shows the WhatsApp connection status, and the pairing QR code when it needs one.
// This is a live status, not a form field, so it isn't part of the <form> that "Save" submits.
function whatsappSection() {
  const statusText = h('p', { class: 'body-m muted' }, 'Checking…');
  const qrWrap = h('div', { class: 'wa-qr-wrap' });
  const unlinkBtn = h('button', {
    type: 'button', class: 'btn btn-text', hidden: true,
    onclick: async () => {
      if (!confirm('Unlink this WhatsApp number? A new QR code will be needed to reconnect.')) return;
      try { await whatsappUnlink(); snack('Unlinked. Restart the POS server, then scan a new QR code here.', 6000); }
      catch (err) { snack(err.message, 5000); }
    }
  }, 'Unlink this number');

  const card = section('chat', 'WhatsApp orders (beta)',
    'Customers can message your shop\'s own WhatsApp number to order. Unofficial feature — see the README before turning it on.',
    statusText, qrWrap, unlinkBtn);

  let timer;
  async function poll() {
    try {
      const s = await getWhatsappStatus();
      if (!card.isConnected) return; // the settings page was closed while that request was in flight
      if (!s.available) {
        statusText.textContent = 'Not set up yet — run "npm install" on the server computer and restart it to turn this on.';
        qrWrap.replaceChildren();
        unlinkBtn.hidden = true;
      } else if (s.connected) {
        statusText.textContent = `Connected — linked to ${s.phone || 'a WhatsApp number'}.`;
        qrWrap.replaceChildren();
        unlinkBtn.hidden = false;
      } else if (s.qr) {
        statusText.textContent = 'On the shop\'s phone: WhatsApp → Linked devices → Link a device, then scan this:';
        qrWrap.replaceChildren(h('img', { class: 'wa-qr', alt: 'WhatsApp pairing QR code', src: qrDataUrl(s.qr, 240) }));
        unlinkBtn.hidden = true;
      } else {
        statusText.textContent = 'Starting…';
        qrWrap.replaceChildren();
        unlinkBtn.hidden = true;
      }
    } catch {
      statusText.textContent = 'Could not check WhatsApp status.';
    }
    timer = setTimeout(poll, 3000);
  }
  poll();
  return card;
}

export function renderSetupWizard(root, { existing, onDone, onCancel }) {
  const c = existing || {};
  let mode = c.qrMode || 'receipt';

  const displayBox = h('div', { class: 'field-grid', hidden: mode !== 'external-display' },
    field({
      name: 'displayUrl', label: 'Customer display address', value: c.displayUrl || '', full: true, inputmode: 'url',
      placeholder: 'http://192.168.1.60:3000',
      hint: 'Leave empty to use this POS server as the hub (the Pi opens /display.html from it).'
    })
  );

  const choice = (value, title, desc) =>
    h('label', { class: 'choice' },
      h('input', { type: 'radio', name: 'qrMode', value, checked: mode === value, onchange: () => { mode = value; displayBox.hidden = mode !== 'external-display'; } }),
      h('div', {}, h('div', { class: 'title-m' }, title), h('div', { class: 'body-m muted' }, desc))
    );

  const submitBtn = h('button', { type: 'submit', class: 'btn btn-filled btn-lg' }, icon('check'), 'Save and open POS');

  const form = h('form', { class: 'setup-form', onsubmit: submit },
    section('storefront', 'Store identity', 'Shown on the top bar and on every bill.',
      h('div', { class: 'field-grid' },
        field({ name: 'storeName', label: 'Store name', value: c.storeName, placeholder: 'Amar Do-Tolar Bazaar', required: true, full: true }),
        field({ name: 'address', label: 'Store address', value: c.address, full: true }),
        field({ name: 'phone', label: 'Contact number', value: c.phone, type: 'tel', inputmode: 'tel', full: true })
      )),

    section('payments', 'UPI payment', 'Your shop\'s UPI ID. Customers scan a QR made from it, with the bill amount filled in.',
      h('div', { class: 'field-grid' },
        field({
          name: 'upiVpa', label: 'UPI ID', value: c.upiVpa, full: true, placeholder: 'shopname@bank',
          hint: 'For example the UPI ID shown in your GPay for Business app. When the money arrives, tap "UPI received" on the bill.'
        })
      )),

    section('qr_code_2', 'Payment QR display', 'Where should the customer see the payment QR?',
      h('div', { class: 'choice-list' },
        choice('receipt', 'Print QR code directly on thermal bill receipt', 'The QR sits under the totals on the printed bill.'),
        choice('external-display', 'Push payment QR code to external customer display', 'Raspberry Pi Zero 2W or any secondary small screen on the local network.'),
        displayBox
      )),

    h('div', { class: 'setup-actions' },
      onCancel && h('button', { type: 'button', class: 'btn btn-text', onclick: onCancel }, 'Cancel'),
      submitBtn)
  );

  root.replaceChildren(
    h('main', { class: 'setup-page' },
      h('header', { class: 'setup-head' },
        h('div', { class: 'logo' }, icon('storefront')),
        h('div', {},
          h('h1', { class: 'headline-m' }, existing ? 'Store settings' : 'Set up your store'),
          h('p', { class: 'body-l muted' }, existing ? 'Update your details and integrations.' : 'Enter your store details once — you can change them later from Settings.'))),
      form,
      existing && whatsappSection(),
      existing && deliveryBoySection())
  );

  async function submit(e) {
    e.preventDefault();
    const v = Object.fromEntries(new FormData(form).entries());
    const t = (k) => String(v[k] ?? '').trim();

    if (t('qrMode') === 'external-display' && t('displayUrl') && !/^https?:\/\//i.test(t('displayUrl'))) {
      snack('Display address must start with http:// or https://');
      return;
    }
    const payload = {
      storeName: t('storeName'), address: t('address'), phone: t('phone'),
      upiVpa: t('upiVpa'),
      qrMode: t('qrMode') || 'receipt',
      displayUrl: t('displayUrl')
    };

    submitBtn.disabled = true;
    try {
      const { config } = await saveSetup(payload);
      cacheConfig(config);
      snack('Saved');
      onDone(config);
    } catch (err) {
      snack(err.message);
      submitBtn.disabled = false;
    }
  }
}
