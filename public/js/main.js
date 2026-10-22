// Boot: if the store is not configured yet -> Setup wizard, otherwise -> the shop PIN, then the dashboard.
import { initTheme, dismissBoot } from './ui.js';
import * as sfx from './sfx.js';
import { getConfig } from './api.js';
import { cacheConfig, loadCachedConfig } from './store.js';
import { renderSetupWizard } from './components/setup-wizard.js';
import { renderDashboard } from './components/dashboard.js';
import { pinIsSet, hasValidSession, showPinGate, initPinGate, hidePinGate } from './pin-gate.js';

const root = document.getElementById('app');
let rendered = false;

function showSetup(existing = null) {
  document.title = 'Set up your store';
  rendered = false;
  renderSetupWizard(root, {
    existing,
    onDone: showDashboard,
    onCancel: existing ? () => showDashboard(existing) : null
  });
}

function showDashboard(config) {
  document.title = `${config.storeName} · POS`;
  rendered = true;
  renderDashboard(root, { config, onOpenSettings: () => showSetup(config) });
}

async function boot() {
  initTheme();
  // Browsers will not make a sound until the page has been touched. This is the one place that can
  // guarantee the first touch is noticed, whichever screen it happens on, so every later sound works
  // without each component having to remember to ask.
  for (const evt of ['pointerdown', 'keydown', 'touchstart']) {
    window.addEventListener(evt, () => sfx.primeAudio(), { once: true, passive: true });
  }
  // Covers the whole app: any request that comes back 401 with needsPin raises the gate again, so a
  // token that expires mid-shift locks the till again instead of failing silently screen by screen.
  initPinGate();

  let config = null;
  try {
    const res = await getConfig();
    config = res.configured ? res.config : null;
    if (config) cacheConfig(config);
  } catch {
    config = loadCachedConfig(); // server unreachable: open with the last known config
  }

  if (!config) return showSetup();

  // A shop with no PIN configured gets straight in — this is opt-in, and until somebody sets one in
  // Settings the till behaves exactly as it always has. Checking first means a PIN-protected shop
  // never flashes the dashboard at somebody before the lock screen covers it.
  // A tab that already holds a good session goes straight in. This is what keeps a reload from asking for
  // the PIN again: the token is in sessionStorage, which is meant to outlive a reload, so the session is
  // still real and re-asking was pure friction. `&&` rather than two separate checks, because the common
  // case — a shop with no PIN at all — should cost one request rather than two.
  if (await pinIsSet() && !(await hasValidSession())) {
    return showPinGate(() => { if (!rendered) showDashboard(config); });
  }
  showDashboard(config);
}

boot().finally(dismissBoot);

// A module that fails to load throws before boot() is ever called, so the splash would sit over an empty
// page with nothing on the page to explain it. The inline deadline in index.html covers the seven-second
// case; this covers the instant one, where an error is caught but the splash is still up.
window.addEventListener('error', dismissBoot, { once: true });
