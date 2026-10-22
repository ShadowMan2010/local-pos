/**
 * Shared browser-test bootstrap.
 *
 * The UI tests used to resolve puppeteer-core out of /tmp/opencode/uitest, which is a temporary
 * directory: after the shop's machine rebooted, every browser test in this repo stopped being able to
 * start, with a MODULE_NOT_FOUND that says nothing about the POS. Nothing in the repository recorded
 * that the tests needed a browser harness, so there was no way to tell what was missing or how to get
 * it back.
 *
 * So the harness lives somewhere that survives a reboot, the lookup is explicit about its options, and
 * a missing harness explains itself instead of printing a stack trace.
 *
 * Setup, once:
 *   mkdir -p ~/.cache/m3pos-uitest && cd ~/.cache/m3pos-uitest && npm init -y && npm i puppeteer-core
 * Chrome itself is already installed at /usr/bin/google-chrome on this machine; CHROME_BIN overrides it.
 */
import { createRequire } from 'node:module';
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const HOME = os.homedir();

/** Where a puppeteer-core install may live, best first. */
const CANDIDATES = [
  process.env.UI_TEST_DEPS,
  path.join(HOME, '.cache', 'm3pos-uitest'),
  // In case it is ever added to the project's own devDependencies.
  path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'node_modules'),
].filter(Boolean);

const CHROME_CANDIDATES = [
  process.env.CHROME_BIN,
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/snap/bin/chromium',
].filter(Boolean);

function explain(what, tried, how) {
  return new Error(
    `Cannot find ${what}.\n` +
    `Looked in:\n${tried.map((t) => `  - ${t}`).join('\n')}\n\n` +
    `${how}\n` +
    'This is a test-harness problem, not a problem with the POS.'
  );
}

/** Returns the puppeteer-core module, or throws something a human can act on. */
export async function loadPuppeteer() {
  for (const dir of CANDIDATES) {
    if (!fs.existsSync(path.join(dir, 'node_modules'))) continue;
    try {
      const require = createRequire(path.join(dir, 'noop.js'));
      return (await import(require.resolve('puppeteer-core'))).default;
    } catch { /* an install without puppeteer-core in it; try the next one */ }
  }
  throw explain(
    'puppeteer-core (needed to drive a real browser for the UI tests)',
    CANDIDATES,
    'To install it, run:\n' +
    '  mkdir -p ~/.cache/m3pos-uitest && cd ~/.cache/m3pos-uitest && npm init -y && npm i puppeteer-core'
  );
}

/** Returns a path to a Chrome/Chromium binary, or throws something a human can act on. */
export function chromePath() {
  for (const bin of CHROME_CANDIDATES) {
    if (fs.existsSync(bin)) return bin;
  }
  throw explain(
    'a Chrome or Chromium binary (needed to run the UI tests)',
    CHROME_CANDIDATES,
    'Install Google Chrome, or point CHROME_BIN at a browser you already have:\n' +
    '  CHROME_BIN=/path/to/chrome node test/sfx-ui.mjs'
  );
}

/**
 * Launches Chrome for a test run, and closes it no matter how the test ends.
 *
 * `--autoplay-policy=no-user-gesture-required` is on because the sound tests count oscillators rather
 * than trying to hear them, and without it Chrome keeps a context suspended until a real gesture -
 * which would make every assertion about sound fail for a reason that has nothing to do with the app.
 */
export async function launchBrowser(puppeteer) {
  return puppeteer.launch({
    executablePath: chromePath(),
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--autoplay-policy=no-user-gesture-required'],
  });
}

/**
 * Kills whatever is listening on a port, so a test server left behind by an earlier run does not make
 * the next run fail with a port-in-use error.
 *
 * The self-check matters: a previous version of these helpers had no guard, and on a machine where the
 * test process happened to be the listener, a test would kill itself and report a mystery.
 */
export function killPort(port) {
  // `fuser` and `lsof` are not both always present, so this is deliberately tolerant.
  for (const cmd of [`fuser -k ${port}/tcp`, `lsof -ti:${port} -sTCP:LISTEN`]) {
    let out = '';
    try { out = execSync(cmd, { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim(); } catch { continue; }
    for (const pid of out.split(/\s+/).filter(Boolean)) {
      const n = Number(pid);
      if (!n || n === process.pid) continue;
      try { process.kill(n, 'SIGKILL'); } catch {}
    }
    return;
  }
}
