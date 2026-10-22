// Module 1 — first-time configuration form (also used for Settings -> edit).
import { h, icon, snack, qrDataUrl, runBusy, busy, copyText } from '../ui.js';
import * as sfx from '../sfx.js';
import { saveSetup, changePin, getConfig, getWhatsappStatus, whatsappUnlink, whatsappRelink, whatsappToggle, listDeliveryBoys, addDeliveryBoy, removeDeliveryBoy, getAuthStatus, beginTwoFactor, confirmTwoFactor, disableTwoFactor, newBackupCodes, getAiStatus, saveAiConfig, clearAiConfig, getVoiceStatus, saveVoiceConfig, getLicense, saveLicenseKey, clearLicenseKey } from '../api.js';
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
              onclick: async (e) => {
                if (!confirm(`Remove ${b.name} from the delivery list?`)) return;
                await runBusy(e.currentTarget, async () => {
                  try { await removeDeliveryBoy(b.phone); load(); } catch (err) { snack(err.message, 4000, 'error'); }
                });
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
    if (!name || !phone) return snack('Enter the name and the WhatsApp number', 3200, 'warn');
    addBtn.disabled = true;
    try {
      await addDeliveryBoy(name, phone);
      nameIn.value = ''; phoneIn.value = '';
      load();
    } catch (err) { snack(err.message, 5000, 'error'); }
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

/* ---------- AI: Gemini / OpenRouter ---------- */
// The key is typed here and stored on the server, which strips it from every response (publicView). So
// this card can only ever show *whether* a key exists — never the key itself — and an empty box means
// "keep the one already saved", so re-saving the model cannot wipe the key.
function aiSection() {
  const statusText = h('p', { class: 'body-m muted' }, 'Checking…');

  const providerSel = h('select', { name: 'aiProvider', class: 'm3-select' },
    h('option', { value: '' }, 'Detect from the key'),
    h('option', { value: 'gemini' }, 'Gemini'),
    h('option', { value: 'openrouter' }, 'OpenRouter'));

  const keyField = field({
    name: 'aiKey', label: 'API key', type: 'password', full: true,
    hint: 'Paste a Gemini API key (starts with AIza). Leave empty to keep the key already saved.'
  });
  const modelField = field({
    name: 'aiModel', label: 'Model (optional)', full: true, placeholder: 'gemini-3.6-flash',
    hint: 'Blank uses the default for the provider.'
  });

  const saveBtn = h('button', { type: 'button', class: 'btn btn-filled' }, icon('save'), ' Save key');
  const clearBtn = h('button', { type: 'button', class: 'btn btn-text' }, icon('delete_outline'), ' Clear key');
  const keyInput = keyField.querySelector('input');
  const modelInput = modelField.querySelector('input');

  const paint = (s) => {
    statusText.textContent = s.configured
      ? `On — using ${s.provider}${s.model ? ` / ${s.model}` : ''}.`
      : 'Off — no key saved yet.';
    keyInput.placeholder = s.configured ? '(saved — leave empty to keep)' : ' ';
    providerSel.value = s.declared || '';
    clearBtn.hidden = !s.configured;
  };

  async function load() {
    try { paint(await getAiStatus()); }
    catch { statusText.textContent = 'Could not read the AI status.'; }
  }
  load();

  saveBtn.onclick = async () => {
    await runBusy(saveBtn, async () => {
      // Read the fields directly: this card is a <section>, not a <form>, so FormData cannot be built
      // from it. (FormData only accepts an HTMLFormElement and throws on anything else, which silently
      // swallowed every save before this was noticed.)
      const r = await saveAiConfig({
        provider: providerSel.value,
        apiKey: keyInput.value.trim(),
        model: modelInput.value.trim()
      });
      keyInput.value = ''; // the key is never kept in the DOM after it is saved
      paint(r);
      snack('AI key saved');
    });
  };

  clearBtn.onclick = async () => {
    if (!confirm('Remove the saved AI key? Photo-to-products, bill reading and AI replies will stop working.')) return;
    await runBusy(clearBtn, async () => {
      paint(await clearAiConfig());
      snack('AI key cleared');
    });
  };

  return section('auto_awesome', 'Gemini AI',
    'Lets the shop read a photo into products, read a bill, and understand customer messages in any language. Replies go out in English. The key is kept on this computer and is never sent to the browser.',
    statusText,
    h('div', { class: 'ai-form' }, providerSel, keyField, modelField),
    h('div', { class: 'ai-actions' }, saveBtn, clearBtn));
}

/* ---------- voice ordering: heard by Gemini ---------- */
// Same idea as the AI key: the Whisper address lives on the server and only `enabled` reaches the
// browser. The switch is the gate — the whole voice flow stays dark until the shop turns it on. Voice
// notes are heard by Gemini, whose key is already set above; the Whisper fields are only a fallback for
// a shop that runs its own server, so they are folded away and never shown to the ordinary shopkeeper.
function voiceSection() {
  const statusText = h('p', { class: 'body-m muted' }, 'Checking…');

  const enableLabel = h('label', { class: 'm3-check-row' },
    h('input', { type: 'checkbox', name: 'voiceEnabled', class: 'm3-check' }),
    h('span', {}, 'Turn on voice ordering'));

  const baseField = field({
    name: 'voiceBase', label: 'Whisper address', full: true, placeholder: 'http://127.0.0.1:8000',
    hint: 'Where your own Whisper server listens. Only used when no Gemini key is set.'
  });
  const modelField = field({
    name: 'voiceModel', label: 'Whisper model name', full: true, placeholder: 'whisper-1',
    hint: 'Blank uses whisper-1.'
  });

  const saveBtn = h('button', { type: 'button', class: 'btn btn-filled' }, icon('save'), ' Save');
  const enableInput = enableLabel.querySelector('input');
  const baseInput = baseField.querySelector('input');
  const modelInput = modelField.querySelector('input');

  // Folded away by default: most shops hear voice notes with the Gemini key and never need this. It stays
  // out of the way until a shop is actually running its own Whisper server, in which case the fields they
  // typed deserve to be on screen.
  const advanced = h('details', { class: 'm3-advanced' },
    h('summary', {}, 'Use a local Whisper server instead'),
    h('p', { class: 'body-m muted' }, 'Only for a shop that runs its own Whisper server and wants the audio to stay on this machine. Gemini is used whenever a key is set.'),
    baseField,
    modelField);

  const paint = (s) => {
    statusText.textContent = !s.enabled
      ? 'Off — customers can still type their order.'
      : s.engine === 'gemini'
        ? 'On — voice notes are heard with your Gemini key.'
        : s.engine === 'whisper'
          ? `On — listening at ${s.baseUrl}.`
          : 'On — but add a Gemini key above (or set up a Whisper server) so voice notes can be heard.';
    enableInput.checked = !!s.enabled;
    advanced.open = s.engine === 'whisper';
    baseInput.value = s.baseUrl || '';
    modelInput.value = s.model || '';
  };

  async function load() {
    try { paint(await getVoiceStatus()); }
    catch { statusText.textContent = 'Could not read the voice status.'; }
  }
  load();

  saveBtn.onclick = async () => {
    await runBusy(saveBtn, async () => {
      // Read the fields directly: this card is a <section>, not a <form>, so FormData cannot be built
      // from it and would throw before the request was sent.
      const r = await saveVoiceConfig({
        enabled: enableInput.checked,
        baseUrl: baseInput.value.trim(),
        model: modelInput.value.trim()
      });
      paint(r);
      snack('Voice ordering saved');
    });
  };

  return section('mic', 'Voice ordering (WhatsApp)',
    'A customer sends a WhatsApp voice note with what they need, and it becomes a real order. It is heard with your Gemini key.',
    statusText,
    enableLabel,
    advanced,
    h('div', {}, saveBtn));
}

/* ---------- Pro licence ---------- */
// The one place a shop enters a key. The key is a signed string they were given when they paid; it is
// checked on this machine, with no internet needed, so a shop with a flaky connection is never locked
// out of what it bought. Everything the shop can do without a key stays working — this card only adds
// the paid extras, and says in plain words what those are.
function licenseSection() {
  const statusText = h('p', { class: 'body-m muted', 'data-license-status': '' }, 'Checking…');
  const benefits = h('ul', { class: 'license-benefits' });
  const keyField = field({
    name: 'licenseKey', label: 'Licence key', type: 'text', full: true,
    placeholder: 'Paste the key you were sent',
    hint: 'One long key, usually two parts separated by a dot. It is checked here and nothing is sent to us.'
  });
  const keyInput = keyField.querySelector('input');
  const saveBtn = h('button', { type: 'button', class: 'btn btn-filled' }, icon('key'), ' Activate');
  const clearBtn = h('button', { type: 'button', class: 'btn btn-text', hidden: true }, icon('logout'), ' Remove licence');

  const paint = (s) => {
    const active = s.valid && s.type !== 'community';
    if (!active && s.reason === 'expired') {
      statusText.textContent = `Expired on ${new Date(s.expiresAt).toLocaleDateString()}. Enter a renewed key to turn Pro back on. Core features still work.`;
    } else if (!active && s.reason === 'signature') {
      statusText.textContent = 'The key on this till is not valid. Enter the key from your purchase again.';
    } else if (active) {
      const until = s.expiresAt ? ` until ${new Date(s.expiresAt).toLocaleDateString()}` : '';
      statusText.textContent = `Pro active${until}.`;
    } else {
      statusText.textContent = 'Community edition — core features only. Enter a key to unlock Pro.';
    }
    clearBtn.hidden = !active;
    keyInput.placeholder = active ? '(active — paste a new key to replace)' : 'Paste the key you were sent';
    benefits.replaceChildren(
      h('li', { class: 'body-m' }, active
        ? 'Pro features are unlocked on this till.'
        : `Pro adds: ${(s.premiumFeatures || []).map((f) => f.replace(/_/g, ' ')).join(', ')}.`),
      h('li', { class: 'body-m muted' }, `Need a key? Write to ${s.contact || 'us'}.`)
    );
  };

  async function load() {
    try { paint(await getLicense()); }
    catch { statusText.textContent = 'Could not read the licence status.'; }
  }
  load();

  saveBtn.onclick = async () => {
    const key = keyInput.value.trim();
    if (!key) return snack('Paste the licence key first', 3000, 'error');
    await runBusy(saveBtn, async () => {
      try {
        paint(await saveLicenseKey(key));
        keyInput.value = '';
        snack('Licence activated');
        // Whether AI and voice cards are even shown depends on the licence, so the whole screen is
        // reloaded rather than left half-updated.
        setTimeout(() => location.reload(), 900);
      } catch (err) { snack(err.message, 6000, 'error'); }
    });
  };

  clearBtn.onclick = async () => {
    if (!confirm('Remove the licence key? Pro features will stop working. Core features are unaffected.')) return;
    await runBusy(clearBtn, async () => {
      try {
        paint(await clearLicenseKey());
        snack('Licence removed');
        setTimeout(() => location.reload(), 900);
      } catch (err) { snack(err.message, 5000, 'error'); }
    });
  };

  return section('workspace_premium', 'Local POS Pro',
    'Unlock AI catalog scanning, voice ordering and WhatsApp automation. Core billing, inventory and reports stay free.',
    statusText,
    benefits,
    keyField,
    h('div', { class: 'ai-actions' }, saveBtn, clearBtn));
}

// Settings-only: shows the WhatsApp connection status, and the pairing QR code when it needs one.
// This is a live status, not a form field, so it isn't part of the <form> that "Save" submits.
function whatsappSection() {
  // data-wa-status is a test hook, and earns its place. This paragraph is the only thing standing between a
  // shop and an hour of a support call, and the bug it reports — "Starting…" forever, after the phone had
  // already unlinked the device — was invisible to every test in the suite because nothing could find this
  // element to read it. A named hook is what let a browser test assert on what the shop actually sees.
  const statusText = h('p', { class: 'body-m muted', 'data-wa-status': '' }, 'Checking…');
  const qrWrap = h('div', { class: 'wa-qr-wrap' });
  const unlinkBtn = h('button', {
    type: 'button', class: 'btn btn-text', hidden: true,
      onclick: async (e) => {
        if (!confirm('Unlink this WhatsApp number? A new QR code will be needed to reconnect.')) return;
        await runBusy(e.currentTarget, async () => {
          try { await whatsappUnlink(); snack('Unlinked. Start the bot again to link a new number.', 6000); }
          catch (err) { snack(err.message, 5000, 'error'); }
        });
      }
  }, 'Unlink this number');

  // Both buttons are built once and then moved around, never rebuilt.
  //
  // The poll runs every three seconds, and it used to build a fresh button on every pass. A loading
  // indicator lives on a button, so a button that is replaced mid-action loses it: the spinner would appear
  // for one tick and then vanish while the request was still running, which is worse than having no spinner
  // at all because it looks like the action finished. Reusing the same node means the indicator survives the
  // poll, and the poll also knows to leave the message alone while an action is in flight.
  const relinkBtn = h('button', {
    type: 'button', class: 'btn btn-filled', 'data-wa-relink': '',
    onclick: (e) => relink(e.currentTarget)
  }, 'Link this number again');

  const toggleBtn = h('button', {
    type: 'button', class: 'btn btn-tonal', 'data-wa-toggle': '', hidden: true,
    onclick: async (e) => {
      // The label is fixed up front from the state we last saw, and the server decides the direction. A
      // client that picked the URL itself would get it wrong whenever its idea of the current state was
      // even one poll out of date.
      const btn = e.currentTarget;
      await runBusy(btn, async () => {
        acting = true;
        try {
          const r = await whatsappToggle();
          btn.textContent = r.enabled ? 'Stop the bot' : 'Start the bot';
          // The poll picks up the real state; nudging the message here means the screen reacts on the tap
          // rather than up to three seconds later.
          statusText.textContent = r.enabled ? 'Starting the bot…' : 'The bot is stopped. Orders are not being received.';
        } catch (err) {
          snack(err.message, 5000, 'error');
        } finally {
          acting = false;
        }
      });
    }
  }, 'Start the bot');

  const card = section('chat', 'WhatsApp orders (beta)',
    'Customers can message your shop\'s own WhatsApp number to order. Unofficial feature — see the README before turning it on.',
    statusText, qrWrap, h('div', { class: 'wa-card-actions' }, toggleBtn, unlinkBtn));

  /**
   * Puts the bot back into pairing, from the screen where the problem is visible.
   *
   * Restarting the server is the other way to do this and it is the wrong instruction to give: the person
   * reading this is in a browser on the till, and being told to restart the machine they are trying to reach
   * the till from is how a settings screen becomes something people stop opening.
   */
  async function relink(btn) {
    busy(btn, true);
    acting = true;
    statusText.textContent = 'Getting a new code to scan…';
    try {
      await whatsappRelink();
      // The next poll brings the QR. Saying so beats leaving the old message up next to a button that
      // appears to have done nothing.
      statusText.textContent = 'Scan the code below on the shop\'s phone: WhatsApp → Linked devices → Link a device.';
    } catch (err) {
      statusText.textContent = err.message;
    } finally {
      // Released whether it worked or not. A failed relink on a flaky connection is the common case, and
      // a button stuck spinning is the one state a shop cannot retry out of.
      busy(btn, false);
      acting = false;
    }
  }

  let timer;
  // Set while a button action is in flight, so the poll does not overwrite the message the action just
  // wrote. The status is still fetched and the buttons still move; only the text is left alone.
  let acting = false;
  async function poll() {
    try {
      const s = await getWhatsappStatus();
      if (!card.isConnected) return; // the settings page was closed while that request was in flight
      toggleBtn.hidden = !s.available;
      if (s.available && s.enabled === false) {
        // Stopped on purpose. This branch is what stops the exact bug this card was rewritten for: a bot
        // the shop turned off is not connected, shows no QR, and would otherwise land in the "Starting…"
        // branch and promise a connection that nobody asked for.
        //
        // Written as `else if` below rather than an early return, because this function ends by scheduling
        // the next poll: returning from here would quietly stop the card updating altogether, and the
        // status would freeze on whatever it last said.
        if (!acting) statusText.textContent = 'The bot is stopped, so WhatsApp orders are not being received.';
        qrWrap.replaceChildren();
        unlinkBtn.hidden = true;
        if (!toggleBtn.dataset.busy) toggleBtn.textContent = 'Start the bot';
      } else if (!s.available) {
        if (!acting) statusText.textContent = 'Not set up yet — run "npm install" on the server computer and restart it to turn this on.';
        qrWrap.replaceChildren();
        unlinkBtn.hidden = true;
      } else if (s.connected) {
        if (!acting) statusText.textContent = `Connected — linked to ${s.phone || 'a WhatsApp number'}.`;
        qrWrap.replaceChildren();
        unlinkBtn.hidden = false;
        if (!toggleBtn.dataset.busy) toggleBtn.textContent = 'Stop the bot';
      } else if (s.loggedOut) {
        // Its own branch, and the reason it exists: the phone revoked this device, so nothing will connect
        // on its own. Folding this into the "Starting…" case below is what left the shop staring at a
        // message that never changed and no way to tell whether to wait or do something.
        if (!acting) {
          statusText.textContent =
            'This number was unlinked from the phone, so orders are not being received. On the shop\'s phone: ' +
            'WhatsApp → Linked devices, remove the old one, then link again by pressing below.';
        }
        qrWrap.replaceChildren(relinkBtn);
        unlinkBtn.hidden = true;
        if (!toggleBtn.dataset.busy) toggleBtn.textContent = 'Stop the bot';
      } else if (s.qr) {
        if (!acting) statusText.textContent = 'On the shop\'s phone: WhatsApp → Linked devices → Link a device, then scan this:';
        qrWrap.replaceChildren(h('img', { class: 'wa-qr', alt: 'WhatsApp pairing QR code', src: qrDataUrl(s.qr, 240) }));
        unlinkBtn.hidden = true;
        if (!toggleBtn.dataset.busy) toggleBtn.textContent = 'Stop the bot';
      } else {
        if (!acting) statusText.textContent = 'Starting…';
        qrWrap.replaceChildren();
        unlinkBtn.hidden = true;
        if (!toggleBtn.dataset.busy) toggleBtn.textContent = 'Stop the bot';
      }
    } catch {
      if (!acting) statusText.textContent = 'Could not check WhatsApp status.';
    }
    timer = setTimeout(poll, 3000);
  }
  poll();
  return card;
}

/**
 * The list of backup codes, shown once and deliberately awkward to dismiss.
 *
 * This is the only screen in the app a shopkeeper sees exactly once, immediately after enrolling a phone,
 * and never again. A layout mistake here is therefore invisible to every manual pass and to any test that
 * only drives the ordinary screens — so it is a module-level export rather than a closure, which lets the
 * test render the real markup and measure it. That is also why the dismiss handler is a parameter: with it
 * passed in, this function does not depend on anything inside the wizard and can be called on its own.
 *
 * @param {string[]} codes
 * @param {() => void} [onDismiss]
 */
export function backupCodesPanel(codes, onDismiss) {
  return h('div', { class: 'field-grid', style: 'gap:10px' },
    h('div', { class: 'body-m', style: 'grid-column:1/-1;color:var(--md-error)' },
      'Write these down now. This is the only time they are shown, and they are the way back in if the ' +
      'phone is lost. Each one works once.'),
    // Each code is its own element in a grid, rather than one string of newlines inside a div.
    //
    // That is the actual bug this replaces. `codes.join('\n')` relies on the browser honouring those
    // newlines as line breaks, which it only does for `white-space: pre`, and this div set none — so the
    // ten codes arrived as one continuous run that wrapped wherever it happened to reach the edge. For
    // something a shopkeeper has to copy onto paper by hand and read back months later, that is the
    // worst possible presentation: no way to spot a misread digit, and no way to copy one code alone.
    h('div', {
      class: 'body-m',
      style: 'grid-column:1/-1;display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:8px;' +
             'font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:1rem;letter-spacing:.06em;' +
             'line-height:1.4;background:var(--md-surface-container,#EEEFE7);padding:16px;border-radius:8px'
    }, codes.map((c) => h('code', {
      'data-backup-code': '',
      // Kept selectable and unbreakable as a unit, so one code can be read out or copied on its own.
      style: 'white-space:nowrap;padding:8px 10px;border-radius:6px;background:var(--md-surface-container-lowest,#fff);' +
             'text-align:center;box-shadow:inset 0 0 0 1px var(--md-outline,#8884)'
    }, c))),
    h('div', { class: 'body-s muted', style: 'grid-column:1/-1' },
      'Keep them on paper somewhere that is not the counter.'),
    h('div', { style: 'grid-column:1/-1' },
      h('button', { type: 'button', class: 'btn btn-filled', onclick: () => onDismiss?.() },
        'I have written them down')));
  }

/**
 * Shows the address other devices should use to reach this POS server.
 *
 * This is here, and shown plainly, because of the single most common way a shop loses an afternoon:
 * someone types "localhost:3000" into a phone, gets nothing, and concludes the POS is broken. It is not -
 * localhost means the phone itself. Everything on this card is an address to type somewhere *else*, which
 * is the whole reason it is spelled out rather than left to the terminal output on the machine running
 * the server.
 *
 * Rendered from the live server rather than from the saved config, because the address changes when the
 * shop changes Wi-Fi or plugs in Ethernet, and a stored one would go stale and quietly send the customer
 * display to a machine that no longer answers. Each line is copyable because the usual next step is
 * typing it into a phone, and typing it by hand off a screen is exactly the error this card prevents.
 *
 * Empty state matters here too: a server on a cable with no address at all is a real situation (network
 * not up yet, or a container with no host networking), and "no address" is a different problem from a
 * wrong one, so it is stated rather than left as an empty box.
 */
function networkSection() {
  const rows = h('div', { class: 'field-grid' });

  const netLine = (label, value, note) => h('div', { class: 'net-row' },
    h('div', { class: 'net-row-txt' },
      h('div', { class: 'body-m muted' }, label),
      h('div', { class: 'net-addr' }, value),
      note && h('small', { class: 'field-hint' }, note)),
    h('button', { type: 'button', class: 'btn btn-outlined', onclick: () => copyText(value, `${label} copied`) },
      icon('content_copy'), 'Copy'));

  const paint = (net) => {
    const addrs = net?.addresses || [];
    if (!addrs.length) {
      rows.replaceChildren(h('p', { class: 'body-m', style: 'grid-column:1/-1;color:var(--md-error)' },
        'No network address found. This machine is not on a network, so no other device can reach the POS. Check the Wi-Fi or cable, then reopen Settings.'));
      return;
    }
    /* More than one address is normal, not an error: Wi-Fi and Ethernet together gives two, and the
       phone is only ever on one of them. Both are listed rather than guessing which is "the" one. */
    const lines = addrs.map((ip, i) =>
      netLine(addrs.length > 1 ? `POS address ${i + 1}` : 'POS address', `http://${ip}:${net.port}`,
        addrs.length > 1 && i === 0 ? 'Wi-Fi or Ethernet' : null));
    lines.push(netLine('Customer display', net.displayUrl, 'Open this on the screen facing the customer.'));
    lines.push(netLine('Weighing station', net.weighUrl, 'Opens full screen with the loading splash.'));
    rows.replaceChildren(...lines);
  };

  /* A missing `network` block and an empty `addresses` list are different faults and are reported as
     such. An empty list means the machine is genuinely off the network. No `network` block at all means
     the server answering is older than this screen — the till keeps its previous session token and its
     config call still succeeds, so the old server answered perfectly and the only honest thing to say is
     that it needs restarting. Saying "check the Wi-Fi" there would send a shopkeeper to unplug a cable
     that is plugged in correctly, because that is the obvious reading of the wrong message. */
  getConfig().then((d) => {
    if (!d || !d.network) {
      rows.replaceChildren(h('p', { class: 'body-m', style: 'grid-column:1/-1;color:var(--md-error)' },
        'This server is running an older version that does not report its address. Restart the POS server and reopen Settings.'));
      return;
    }
    paint(d.network);
  }).catch(() => {
    rows.replaceChildren(h('p', { class: 'body-m', style: 'grid-column:1/-1;color:var(--md-error)' },
      'Could not read this server\'s address. Check the till is still connected, then reopen Settings.'));
  });

  return section('lan', 'This shop\'s network address',
    'Type these into the other device — a phone, a tablet, or the customer display screen. "localhost" only means the computer you are on.',
    rows);
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

  /**
   * Changing the PIN is a separate action from saving the settings, and deliberately so: it signs out
   * every till, including this one. Somebody who thinks their PIN has leaked should not have to also
   * remember to press Save afterwards, and should not be able to change it by accident while editing
   * an address.
   */
  async function onChangePin() {
    const next = prompt('New shop PIN (4 to 10 digits). Every till will be signed out, including this one.');
    if (next === null) return;
    if (!/^\d{4,10}$/.test(next.trim())) return snack('Use 4 to 10 digits', 3200, 'warn');
    const again = prompt('Type it once more to be sure.');
    if (again === null) return;
    if (again.trim() !== next.trim()) return snack('Those did not match, so nothing was changed', 3200, 'warn');
    try {
      await changePin(next.trim());
      // The server signed us out too, so the till is locked again. That is the honest outcome: if the
      // old PIN was compromised, the new one should be proved by being typed.
      snack('PIN changed. Enter the new PIN to carry on.', 5000);
      location.reload();
    } catch (err) {
      snack(err.message, 6000, 'error');
    }
  }

  /* ---------- the second factor ---------- */

  // The three steps are one screen with a changing body rather than a wizard of its own, because the owner
  // is standing at the till in front of a customer queue and setup has to be finishable in under a minute.
  // Each step ends with something the phone confirms, so a mistake is caught here rather than at 9pm.
  let twoFactorOn = false;
  const twoFactorBody = h('div', { style: 'grid-column:1/-1' });

/** Asks for a code, and runs an action with it. Used for turning it off and for new backup codes. */
function askForCode(what, run) {
  const input = h('input', {
    class: '', type: 'text', inputmode: 'numeric', autocomplete: 'one-time-code',
    maxlength: '6', placeholder: '000000', 'aria-label': `Code from your phone to ${what}`
  });
  const err = h('p', { class: 'body-s', style: 'color:var(--md-error);min-height:18px;margin:4px 0 0' });
  // Input first, then the label: `.m3-field input:focus + span` is the rule that floats the label, and it
  // only matches that order. The other way round the label lies across the code being typed.
  const form = h('form', { class: 'm3-field', style: 'width:min(320px,80vw)' },
    input, h('span', {}, `Code from your phone to ${what}`), err);
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    err.textContent = '';
    try {
      await run(input.value.trim());
    } catch (e2) {
      err.textContent = e2.message;
      input.value = '';
      input.focus();
    }
  });
  form.append(h('button', { type: 'submit', class: 'btn btn-filled' }, 'Confirm'));
  return form;
}

function renderTwoFactor() {
  twoFactorBody.replaceChildren();
  if (twoFactorOn) {
    twoFactorBody.append(
      h('div', { class: 'body-m', style: 'grid-column:1/-1' },
        'The till asks for a code from your phone as well as the PIN. Whoever has the PIN still cannot ' +
        'open the till without your phone.'),
      h('div', { style: 'grid-column:1/-1;display:flex;gap:10px;flex-wrap:wrap' },
        h('button', { type: 'button', class: 'btn btn-outlined', onclick: () => renderNewCodes() },
          'New backup codes'),
        h('button', { type: 'button', class: 'btn btn-outlined', onclick: () => renderTwoFactorOff() },
          'Turn this off')));
    return;
  }

  const qr = h('div', { style: 'grid-column:1/-1;display:flex;gap:16px;align-items:center;flex-wrap:wrap' });
  const instructions = h('div', { class: 'body-s muted', style: 'flex:1;min-width:180px' },
    'Install Google Authenticator or any authenticator app on your phone, then choose "add account" ' +
    'and scan this with it.');

  twoFactorBody.append(
    h('div', { class: 'body-m muted', style: 'grid-column:1/-1' },
      'Strongly recommended. The PIN alone is four digits, which is only 10,000 guesses. With a code from ' +
      'your phone as well, a guess stops at the PIN and the till stays shut.'),
    qr, instructions);
  qr.append(h('button', {
    type: 'button', class: 'btn btn-filled', onclick: async (e) => {
      // currentTarget, not target: the click can land on the text inside the button, and disabling that
      // text node's parent (or nothing) is how a button ends up stuck disabled after a failed scan.
      await runBusy(e.currentTarget, async () => {
        try {
          const { url } = await beginTwoFactor('owner');
          // Drawn by the same renderer as the payment QR, so a shop with one already working needs no
          // second scanner app and no new habit.
          qr.replaceChildren(
            h('img', { src: qrDataUrl(url), alt: 'Scan with your authenticator app', width: '196', height: '196' }),
            h('div', { class: 'body-s muted', style: 'max-width:196px;word-break:break-all' },
              'Cannot scan? Type this into the app: ', h('code', { style: 'font-size:.85em' }, url.split('secret=')[1]?.split('&')[0] || ''))
          );
          renderTwoFactorConfirm();
        } catch (e2) {
          snack(e2.message, 5000, 'error');
        }
      });
    }
  }, 'Show the code to scan'));
}

/** Step two: prove the phone works before the second factor is switched on. */
function renderTwoFactorConfirm() {
  const input = h('input', {
    class: '', type: 'text', inputmode: 'numeric', autocomplete: 'one-time-code',
    maxlength: '6', placeholder: '000000', 'aria-label': 'Code from your phone'
  });
  const err = h('p', { class: 'body-s', style: 'color:var(--md-error);min-height:18px;margin:4px 0 0' });
  // Input first, then the label: `.m3-field input:focus + span` is the rule that floats the label, and it
  // only matches that order. The other way round the label lies across the code being typed.
  const form = h('form', { class: 'm3-field', style: 'width:min(320px,80vw)' },
    input, h('span', {}, 'Type the code your app is showing'), err);
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    err.textContent = '';
    try {
      // Only now is the second factor on. Confirming first is what stops a phone that was set up wrongly
      // — a wrong clock, an app that scans but does not count — being discovered at the next shift
      // rather than here, where it costs ten seconds.
      const { backupCodes } = await confirmTwoFactor(input.value.trim());
      twoFactorOn = true;
      twoFactorBody.replaceChildren(h('div', { class: 'field-grid', style: 'gap:10px' }, backupCodesPanel(backupCodes, renderTwoFactor)));
      snack('Second factor is on', 2500, 'success');
    } catch (e2) {
      err.textContent = e2.message;
      input.value = '';
      input.focus();
    }
  });
  form.append(h('button', { type: 'submit', class: 'btn btn-filled' }, 'Turn it on'));
  twoFactorBody.append(h('div', { style: 'grid-column:1/-1' }, form));
}

function renderNewCodes() {
  twoFactorBody.replaceChildren(
    h('div', { class: 'body-m muted', style: 'grid-column:1/-1' },
      'This replaces the old codes, so anything written on the card you have now stops working.'),
    askForCode('get new backup codes', async (code) => {
      const { backupCodes } = await newBackupCodes(code);
      twoFactorBody.replaceChildren(h('div', { class: 'field-grid', style: 'gap:10px' }, backupCodesPanel(backupCodes, renderTwoFactor)));
      snack('New backup codes — write them down', 3000, 'warn');
    }));
}

function renderTwoFactorOff() {
  twoFactorBody.replaceChildren(
    h('div', { class: 'body-m muted', style: 'grid-column:1/-1' },
      'The till will go back to asking for the PIN on its own. Worth remembering that the PIN is four ' +
      'digits, so anybody who watches somebody enter it can get in.'),
    askForCode('turn this off', async (code) => {
      await disableTwoFactor(code);
      twoFactorOn = false;
      renderTwoFactor();
      snack('Second factor is off', 2500, 'warn');
    }));
}

getAuthStatus().then((s) => {
  twoFactorOn = Boolean(s?.twoFactor);
  renderTwoFactor();
}).catch(() => renderTwoFactor());

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

  networkSection(),

  // Security section. Shown on first run to set one, and on later visits to change it — but only
  // through its own button, because the field below must never re-submit the existing PIN on every
  // settings save (the server ignores it once one is set, but an ignored secret in a form is a trap
  // for whoever maintains this next).
  section('lock', 'Till lock', 'A PIN asked for at the start of every shift.',
    h('div', { class: 'field-grid' },
      h('div', { class: 'body-m muted', style: 'grid-column:1/-1' },
        c.pinSet
          ? 'A shop PIN is set. The till asks for it on every new tab, and everything to do with money, customers and reports is behind it. Change it below if you think it has leaked — changing it signs out every other till.'
          : 'No PIN yet. Without one, anything on your Wi-Fi can open this till, change your UPI ID, and read your customers. Set one now — it takes a few seconds and needs remembering once.'),
      c.pinSet
        ? h('div', { style: 'grid-column:1/-1' },
            h('button', { type: 'button', class: 'btn btn-outlined', onclick: onChangePin }, icon('key'), 'Change PIN'))
        : field({
            name: 'pin', label: 'New shop PIN', type: 'password', inputmode: 'numeric',
            full: true, placeholder: '4 to 10 digits',
            hint: 'Pick something short enough to type at the till but not a birthday. It cannot be recovered if forgotten.'
          }),
    )),
  // Its own section rather than a field in the one above: turning on a second factor is a decision about
  // how the shop opens each morning, and it needs a phone and two minutes. Burying it in the settings
  // form would mean it gets switched on without being read, or never at all.
  //
  // Only offered once a PIN exists, because the second factor is checked on top of it — a code with
  // nothing to be a second factor to would just be the only factor, in a slower form.
  c.pinSet
    ? section('shield', 'Second factor', 'Ask for a code from your phone as well as the PIN.',
        h('div', { class: 'field-grid' }, twoFactorBody))
    : null,

  section('volume_up', 'Notification sounds', 'A short tone when something needs you.',
    h('div', { class: 'field-grid' },
      h('div', { class: 'body-m muted', style: 'grid-column:1/-1' },
        'Different noises mean different things: a rising chime when a bill is paid, a falling one when something is refused, and a repeated note when a WhatsApp order or complaint arrives on its own. There is a mute button in the top bar for the middle of a busy shift.'),
      h('div', { style: 'grid-column:1/-1;display:flex;gap:10px;flex-wrap:wrap' },
        h('button', {
          type: 'button', class: 'btn btn-outlined', onclick: (e) => {
            const on = !sfx.isEnabled();
            sfx.setEnabled(on);
            e.currentTarget.replaceChildren(icon(on ? 'volume_up' : 'volume_off'), on ? ' Sounds on' : ' Sounds off');
            // Playing it is the only honest confirmation that the sound actually works on this
            // machine - some till hardware has no speaker at all, and nobody should have to guess.
            if (on) sfx.play('success');
          }
        }, icon(sfx.isEnabled() ? 'volume_up' : 'volume_off'), sfx.isEnabled() ? ' Sounds on' : ' Sounds off'),
        h('button', { type: 'button', class: 'btn btn-text', onclick: () => sfx.play('paid', { force: true }) },
          icon('payments'), ' Preview the paid chime'),
        h('button', { type: 'button', class: 'btn btn-text', onclick: () => sfx.setLevel(sfx.level() === 'low' ? 'normal' : 'low') },
          icon('tune'), ` Volume: ${sfx.level()}`)),
      h('div', { class: 'body-s muted', style: 'grid-column:1/-1' },
        'The customer screen (display.html) is a separate device with its own setting. Add ?sound=off to its address to silence it.')
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
    existing && aiSection(),
    existing && voiceSection(),
    existing && licenseSection(),
    existing && whatsappSection(),
    existing && deliveryBoySection())
);

async function submit(e) {
  e.preventDefault();
  const v = Object.fromEntries(new FormData(form).entries());
  const t = (k) => String(v[k] ?? '').trim();

  if (t('qrMode') === 'external-display' && t('displayUrl') && !/^https?:\/\//i.test(t('displayUrl'))) {
    snack('Display address must start with http:// or https://', 3200, 'warn');
    return;
  }
  const payload = {
    storeName: t('storeName'), address: t('address'), phone: t('phone'),
    upiVpa: t('upiVpa'),
    qrMode: t('qrMode') || 'receipt',
    displayUrl: t('displayUrl')
  };
  // Only sent when a new PIN is actually being set. Once one exists the server ignores this field, so
  // sending an empty string every time would be harmless but misleading to read later.
  if (t('pin')) payload.pin = t('pin');

  submitBtn.disabled = true;
  try {
    const { config } = await saveSetup(payload);
    cacheConfig(config);
    // Said out loud rather than left to be discovered later. This bit a real shop: the browser was
    // serving the new screen while the server behind it was still an older build that quietly threw
    // the PIN away, so the wizard reported "Saved" and the PIN was never set. If a PIN was asked for
    // and the server did not end up with one, that is exactly what happened.
    if (payload.pin && !config.pinSet) {
      snack('Saved, but the shop PIN did not stick. Restart the POS and set it again.', 8000);
    } else {
      snack('Saved');
    }
    onDone(config);
  } catch (err) {
    snack(err.message);
    submitBtn.disabled = false;
  }
}
}

