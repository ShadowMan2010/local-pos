// Boot: if the store is not configured yet -> Setup wizard, otherwise -> POS dashboard.
import { initTheme } from './ui.js';
import { getConfig } from './api.js';
import { cacheConfig, loadCachedConfig } from './store.js';
import { renderSetupWizard } from './components/setup-wizard.js';
import { renderDashboard } from './components/dashboard.js';

const root = document.getElementById('app');

function showSetup(existing = null) {
  document.title = 'Set up your store';
  renderSetupWizard(root, {
    existing,
    onDone: showDashboard,
    onCancel: existing ? () => showDashboard(existing) : null
  });
}

function showDashboard(config) {
  document.title = `${config.storeName} · POS`;
  renderDashboard(root, { config, onOpenSettings: () => showSetup(config) });
}

async function boot() {
  initTheme();
  let config = null;
  try {
    const res = await getConfig();
    config = res.configured ? res.config : null;
    if (config) cacheConfig(config);
  } catch {
    config = loadCachedConfig(); // server unreachable: open with the last known config
  }
  config ? showDashboard(config) : showSetup();
}

boot();
