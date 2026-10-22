// Over-the-air updates: finding a newer release, fetching it, and — the part that actually matters —
// putting the till back on its feet when the new version turns out to be broken.
//
// A shop runs this on a machine nobody is sitting in front of, often with a customer waiting. That shapes
// every decision here:
//
//   * Nothing installs itself. The shop taps Install. An update that lands unasked is an update that can
//     land mid-bill, and a till that stops serving money at that moment costs a real customer a real sale.
//   * Only published GitHub releases count. A commit on main is a draft, and no shop should be the place
//     somebody finds out a release does not work.
//   * The working version is kept until the new one has proved itself. If the new server cannot boot, the
//     old one goes back automatically. The failure mode is a till that is briefly down, never a shop that
//     has bricked itself and needs someone to drive over.
//   * The shop's data is never touched. Updates live in the application directory; data/ is not in it, and
//     nothing in here writes to data/ except the one small marker that records what is installed.
//
// The trust model is deliberately modest. This talks to GitHub over HTTPS and checks that the download
// matches the size GitHub reports. It is not a signed-update system: an attacker who can already intercept
// HTTPS from the till could serve their own code either way. What it does guarantee is that a *mistake* —
// a bad release, a truncated download, a partial disk — is survivable, which is the failure that actually
// happens to shops.
import fs from 'fs';
import path from 'path';
import os from 'os';
import crypto from 'crypto';
import { execFile, spawn } from 'child_process';
import { promisify } from 'util';
import { fileURLToPath } from 'url';

const execFileAsync = promisify(execFile);

const APP_DIR = path.dirname(fileURLToPath(import.meta.url));
const PKG = path.join(APP_DIR, 'package.json');
// The release notes live next to the code, so a shop can see what changed without a browser.
const CHANGELOG = path.join(APP_DIR, 'CHANGELOG.md');
// Marker recording which release is installed and that it came up cleanly. Deliberately inside the
// application directory rather than data/: an update must be able to replace the whole app folder without
// losing the record, and the shop's own files must never be something a rollback has to reason about.
const STATE_FILE = path.join(APP_DIR, '.update-state.json');
// Where the version being replaced is kept until the new one has proved it boots.
const PREVIOUS_DIR = path.join(APP_DIR, '.previous-version');
const STAGING_DIR = path.join(APP_DIR, '.update-staging');

const RELEASES_API = process.env.POS_RELEASES_URL
  || 'https://api.github.com/repos/ShadowMan2010/local-pos/releases/latest';
const TARBALL_URL = process.env.POS_TARBALL_URL || '';
const REQUEST_TIMEOUT_MS = 20000;
// A release tarball of this project is a few hundred KB. 40 MB is far more than any real one and still
// small enough that a wrong URL cannot fill a shop's disk.
const MAX_DOWNLOAD_BYTES = 40 * 1024 * 1024;

/* ---------- version comparison ---------- */

/**
 * Compares two semver-ish versions.
 *
 * Only the parts that matter for deciding "is this newer" are read: numbers, and pre-release tags are
 * treated as older than the plain release. `v` prefixes, which GitHub tags almost always carry, are
 * stripped, and anything unparseable is refused rather than guessed at — a version this cannot read is a
 * version that must not be installed over a working till on a hunch.
 */
export function compareVersions(a, b) {
  const clean = (v) => {
    const s = String(v ?? '').trim().replace(/^v/i, '');
    const m = s.match(/^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?/);
    if (!m) return null;
    // `rest` is whatever follows the three numbers and an optional pre-release, so "1.0.0.1" is read as
    // a fourth component rather than being silently truncated to "1.0.0".
    return { major: +m[1], minor: +m[2], patch: +m[3], pre: m[4] || null, rest: s.slice(m[0].length) };
  };
  const pa = clean(a);
  const pb = clean(b);
  if (!pa || !pb) return null;
  for (const k of ['major', 'minor', 'patch']) {
    if (pa[k] !== pb[k]) return pa[k] > pb[k] ? 1 : -1;
  }
  // 1.0.0-beta is older than 1.0.0, which is what everyone means by a pre-release.
  if (pa.pre && !pb.pre) return -1;
  if (!pa.pre && pb.pre) return 1;
  if (pa.pre && pb.pre) return pa.pre > pb.pre ? 1 : -1;
  const na = pa.rest ? Number(pa.rest.replace(/^\./, '')) : 0;
  const nb = pb.rest ? Number(pb.rest.replace(/^\./, '')) : 0;
  if (Number.isFinite(na) && Number.isFinite(nb) && na !== nb) return na > nb ? 1 : -1;
  return 0;
}

/** The version this copy of the till is running. Read from disk, not a constant, so it cannot drift. */
export function currentVersion() {
  try {
    return JSON.parse(fs.readFileSync(PKG, 'utf8')).version || '0.0.0';
  } catch {
    return '0.0.0';
  }
}

/* ---------- the rollback marker ---------- */

function readState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch { return {}; }
}

function writeState(next) {
  fs.writeFileSync(STATE_FILE, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
}

/**
 * Called once, very early in the server's life: this version has come up.
 *
 * This is the "it works" half of the rollback. A version is only trusted to stay in place once it has
 * started; a release that boots and then dies on the first request is still a version that will be rolled
 * back on its next attempt, which is the right outcome for a shop.
 */
export function markHealthy() {
  const state = readState();
  if (state.pendingVersion && state.pendingVersion === currentVersion()) {
    // The version we were rolling out has now proved itself, so the copy we replaced can go.
    writeState({ healthyVersion: currentVersion(), rolledBackFrom: state.rolledBackFrom || null });
    removeQuietly(PREVIOUS_DIR);
    return { firstBootAfterUpdate: true, from: state.rolledBackFrom || null };
  }
  if (state.healthyVersion !== currentVersion()) writeState({ ...state, healthyVersion: currentVersion() });
  return { firstBootAfterUpdate: false, from: null };
}

/**
 * Puts the previous version back, if there is one and if we have not already tried.
 *
 * Called at startup by the caller *before* the server begins serving, so a shop that installed something
 * broken gets the old one back rather than an error page. One attempt only: if the previous version also
 * fails, retrying it in a loop would be a shop stuck on a boot screen with no way out but a person with
 * a keyboard, and that is exactly the situation this is meant to prevent.
 */
export function rollbackIfPending() {
  const state = readState();
  if (!state.pendingVersion) return { rolledBack: false };
  // The test is against `healthyVersion`, not against the version that is running. Those two are normally
  // the same thing, and confusing them is what disabled this whole function: immediately after a
  // successful install the pending version *is* the running version, so a guard of the form
  // "pending === current, nothing to do" refused every rollback — which is the only moment one is needed.
  if (state.healthyVersion && state.pendingVersion === state.healthyVersion) {
    return { rolledBack: false, reason: 'already-healthy' };
  }
  if (state.rolledBackFrom === state.pendingVersion) return { rolledBack: false, reason: 'already-rolled-back' };
  if (!fs.existsSync(path.join(PREVIOUS_DIR, 'package.json'))) return { rolledBack: false, reason: 'no-previous-copy' };

  const now = currentVersion();

  // The broken version is moved aside, not deleted: it is what to look at when a shopkeeper says the till
  // went down, and it costs one release's worth of disk.
  //
  // It has to be a *sibling* of the application directory, not a folder inside it. An earlier version of
  // this tried APP_DIR/.failed-version, which cannot work — you cannot move a directory into itself — so
  // the move silently failed and the code fell through to copying the old version *over* the broken one.
  // That left every file the bad release had added still in place, which is how a rollback could report
  // success and leave the till exactly as broken as it was.
  const failedDir = `${APP_DIR}.failed-${now}`;
  const parkedPrev = `${APP_DIR}.previous-parked`;
  // The things that must survive the move: the rollback copy, and the shop itself.
  const preserved = ['data', 'node_modules'];
  const parkedData = `${APP_DIR}.data-parked`;
  removeQuietly(failedDir);
  removeQuietly(parkedPrev);
  removeQuietly(parkedData);

  let movedAside = false;
  try {
    // Everything that has to outlive the move is lifted out first, because the application directory gets
    // moved as a whole and would take its contents with it.
    //
    // Both of these were found the hard way. Moving the directory first carried the only working copy of
    // the old version away with the broken one, and then carried the shop's actual bills with it as well —
    // orders, the one thing an update must never be able to lose. A rollback that quietly relocated the
    // till's data would be worse than the crash it was rescuing the shop from.
    fs.renameSync(PREVIOUS_DIR, parkedPrev);
    for (const name of preserved) {
      if (fs.existsSync(path.join(APP_DIR, name))) fs.renameSync(path.join(APP_DIR, name), `${APP_DIR}.${name}-parked`);
    }
    fs.renameSync(APP_DIR, failedDir);
    movedAside = true;
  } catch (e) {
    // Renaming can fail if the directory is a mount point or a handle is open. The per-file path below is
    // safer anyway, so this is not fatal — but it must not be silently ignored.
    console.error('Could not move the failed version aside, restoring file by file instead:', e.message);
    if (!fs.existsSync(PREVIOUS_DIR) && fs.existsSync(parkedPrev)) {
      try { fs.renameSync(parkedPrev, PREVIOUS_DIR); } catch { /* handled below */ }
    }
  }

  let restored = false;
  try {
    if (movedAside) {
      // A clean swap: the old version is now the only thing at APP_DIR, so nothing the bad release
      // brought along can survive into it.
      fs.renameSync(parkedPrev, APP_DIR);
    } else {
      // The fallback, and it is only safe if the directory is genuinely emptied first. Copying on top
      // without that is the mistake described above.
      for (const name of fs.readdirSync(APP_DIR)) {
        if (name === 'node_modules' || name === 'data') continue;
        removeQuietly(path.join(APP_DIR, name));
      }
      copyDir(PREVIOUS_DIR, APP_DIR);
    }
    // The shop's own files go back in afterwards, and only afterwards: putting them back too early would
    // mean the clean swap above had to write into a directory that already existed.
    for (const name of preserved) {
      const parked = `${APP_DIR}.${name}-parked`;
      if (!fs.existsSync(parked)) continue;
      const dest = path.join(APP_DIR, name);
      if (!fs.existsSync(dest)) fs.renameSync(parked, dest);
    }
    restored = fs.existsSync(path.join(APP_DIR, 'package.json'))
      && fs.existsSync(path.join(APP_DIR, 'updater.js'))
      && fs.existsSync(path.join(APP_DIR, 'data'));
  } catch (e) {
    console.error('Rollback failed:', e.message);
  }

  if (!restored) {
    // The old version could not be put back. Put the broken one back rather than leaving the till with
    // a half-copied directory, so the state on disk is one the shopkeeper can at least start from.
    if (movedAside && fs.existsSync(failedDir) && !fs.existsSync(APP_DIR)) {
      try { fs.renameSync(failedDir, APP_DIR); } catch { /* nothing more can be done here */ }
    }
    return { rolledBack: false, reason: 'restore-failed', from: now };
  }

  // Clean up the wreckage, but leave the marker that says what happened: it is what the shopkeeper is
  // shown, and it is what stops the next start from trying to roll back all over again.
  try {
    if (movedAside) removeQuietly(failedDir);
    removeQuietly(parkedPrev);
    removeQuietly(parkedData);
  } catch { /* leftovers are harmless, and never worth failing a successful rollback over */ }
  writeState({ healthyVersion: now, pendingVersion: null, rolledBackFrom: now });
  console.error(`Update to ${now} did not start. Rolled back to the previous version.`);
  return { rolledBack: true, from: now };
}

/* ---------- the update itself ---------- */

/**
 * Asks GitHub what the newest published release is.
 *
 * Server-side on purpose. A browser fetch to api.github.com would be blocked by CORS on most setups, and
 * putting the request here means the same code answers "is there an update?" for the Settings screen, the
 * desktop app and anything else that talks to this machine.
 */
export async function checkForUpdate({ timeoutMs = REQUEST_TIMEOUT_MS } = {}) {
  const current = currentVersion();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const r = await fetch(RELEASES_API, {
      signal: controller.signal,
      headers: {
        accept: 'application/vnd.github+json',
        'user-agent': 'local-pos-till',
        // A release's assets can be replaced after publication; a cached answer would offer an old file.
        'cache-control': 'no-cache'
      }
    });
    if (!r.ok) return { current, updateAvailable: false, error: `GitHub answered ${r.status}` };

    const rel = await r.json();
    // `latest` already excludes drafts and prereleases, but a shop running a release built from a fork or
    // a mirror must not be offered an unpublished build, so it is checked rather than assumed.
    if (rel.draft || rel.prerelease) return { current, updateAvailable: false, error: 'The newest release is not published for shops' };

    const latest = rel.tag_name || rel.name || '';
    const cmp = compareVersions(latest, current);
    if (cmp === null) return { current, updateAvailable: false, error: 'Could not read the published version number' };

    const asset = (rel.assets || []).find((a) => /\.tar\.gz$/i.test(a.name) || /\.tgz$/i.test(a.name));
    return {
      current,
      // Without the "v": GitHub tags almost always carry one, and it is shown to a shopkeeper in Settings,
      // where "v0.3.0" and the "0.2.0" next to it look like two different numbering schemes.
      latest: String(latest).replace(/^v/i, ''),
      updateAvailable: cmp > 0,
      notes: (rel.body || '').slice(0, 4000),
      publishedAt: rel.published_at || null,
      url: rel.html_url || null,
      asset: asset ? { name: asset.name, size: asset.size, url: asset.browser_download_url, id: asset.id } : null,
      source: asset ? 'release-asset' : 'tarball'
    };
  } catch (e) {
    return { current, updateAvailable: false, error: e.name === 'AbortError' ? 'The update check timed out' : e.message };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Downloads a release and lays it out ready to swap in, without touching the running code yet.
 *
 * Split from the install step on purpose: the download is the slow, failure-prone part and it can be
 * checked while the till keeps serving, so the actual swap is a rename that takes milliseconds.
 *
 * @returns {Promise<{version:string, bytes:number, sha256:string}>}
 */
export async function downloadUpdate({ version, asset, expectedSize, signal } = {}) {
  if (!version) throw new Error('No version to download');
  const url = asset?.url || `${TARBALL_URL}${version}.tar.gz`;
  if (!url) throw new Error('This release has no downloadable file attached');

  removeQuietly(STAGING_DIR);
  fs.mkdirSync(STAGING_DIR, { recursive: true, mode: 0o700 });

  const tgz = path.join(STAGING_DIR, 'release.tar.gz');
  const res = await fetch(url, { signal, redirect: 'follow', headers: { 'user-agent': 'local-pos-till' } });
  if (!res.ok) throw new Error(`The download failed (${res.status})`);

  const declared = Number(res.headers.get('content-length') || 0);
  if (declared > MAX_DOWNLOAD_BYTES) throw new Error('That update file is far too large to be a release of this till');

  const chunks = [];
  let total = 0;
  for await (const chunk of res.body) {
    total += chunk.length;
    if (total > MAX_DOWNLOAD_BYTES) throw new Error('The update download was cut off and was too big to be a real release');
    chunks.push(chunk);
  }
  const buf = Buffer.concat(chunks);

  // Checked against the size GitHub advertised. A truncated download is the ordinary failure here — a shop
  // on shop Wi-Fi pulling a few hundred KB is exactly the situation where it happens — and without this
  // the tar would simply fail to unpack, halfway through an update, with the old version already gone.
  if (expectedSize && buf.length !== Number(expectedSize)) {
    throw new Error(`The download was incomplete (${buf.length} of ${expectedSize} bytes) — nothing has been changed`);
  }
  if (buf.length === 0) throw new Error('The downloaded update was empty');

  fs.writeFileSync(tgz, buf, { mode: 0o600 });

  const unpacked = path.join(STAGING_DIR, 'new');
  fs.mkdirSync(unpacked, { recursive: true, mode: 0o700 });
  await extractTarGz(tgz, unpacked);

  const root = releaseRoot(unpacked);

  if (!fs.existsSync(path.join(root, 'package.json'))) {
    throw new Error('That download did not contain the till — nothing has been changed');
  }
  if (!fs.existsSync(path.join(root, 'server.js'))) {
    throw new Error('That download is missing server.js — nothing has been changed');
  }
  fs.writeFileSync(path.join(STAGING_DIR, 'version.txt'), `${version}\n`, { mode: 0o600 });
  return { version, bytes: buf.length, sha256: crypto.createHash('sha256').update(buf).digest('hex') };
}
/**
 * Swaps the staged release in and restarts the till.
 *
 * The order is the whole point: the version being replaced is copied aside *first* and the marker written
 * *before* anything is overwritten, so that a crash at any point after this line still leaves something
 * to go back to. Doing it the other way round is how a shop ends up with an application folder that is
 * half one version and half another.
 */
export function installUpdate({ restart = true } = {}) {
  const state = readState();
  if (!state.pendingVersion) throw new Error('There is no downloaded update waiting to be installed');
  const version = state.pendingVersion;
  if (version === currentVersion()) throw new Error('That version is already running');

  // node_modules is deliberately not copied aside: it is large, it is reproducible from package.json, and
  // an update that changes dependencies reinstalls them. Keeping yesterday's copy would mean a release
  // that fixes a dependency could never actually fix it.
  //
  // `.update-state.json` must be in this list. Without it the install deletes the very record that says
  // "an update is waiting to be proven", and since that record is the only thing that makes the next start
  // roll back, a bad release would install and then stay installed forever. The rollback safety net
  // removed itself in the act of being armed.
  const keep = [
    'node_modules', '.previous-version', '.update-staging', '.failed-version', '.update-state.json',
    'data', '.git'
  ];
  const entries = fs.readdirSync(APP_DIR);
  for (const name of entries) {
    if (keep.includes(name)) continue;
    const from = path.join(APP_DIR, name);
    if (!fs.statSync(from).isFile() && !fs.statSync(from).isDirectory()) continue;
    try { fs.rmSync(from, { recursive: true, force: true }); } catch { /* reported by the check below */ }
  }

  // The staged copy wins. The old files are gone, so anything missing from the release is a broken
  // release rather than a leftover from the last one.
  const src = path.join(STAGING_DIR, 'new');
  if (!fs.existsSync(src)) {
    throw new Error('The downloaded update is no longer there. Check for updates again, and nothing has been changed.');
  }
  copyDir(releaseRoot(src), APP_DIR);

  // A release that did not bring package.json, or brought a broken one, must not count as an install.
  if (!fs.existsSync(path.join(APP_DIR, 'package.json'))) {
    throw new Error('The update did not install correctly — run the shop again to roll back');
  }
  // The updater has to be part of the release, because a rollback needs it and a half-updated till that
  // has lost it has no way back. Found the hard way: a release missing this file installed happily, and
  // the very next start had nothing to roll back with, so a bad update became a permanent one.
  if (!fs.existsSync(path.join(APP_DIR, 'updater.js'))) {
    throw new Error('That update is missing the file that can undo it, so it has not been installed');
  }
  const installed = currentVersion();

  if (restart) {
    // Give the response time to reach the browser before the process goes away, or the shop sees a
    // network error and assumes the update failed.
    setTimeout(restartServer, 400);
  }
  return { installed, previous: version };
}

/** Saves the running version aside, so markHealthy/rollbackIfPending have something to go back to. */
export function keepPreviousVersion() {
  removeQuietly(PREVIOUS_DIR);
  fs.mkdirSync(PREVIOUS_DIR, { recursive: true, mode: 0o700 });
  const entries = fs.readdirSync(APP_DIR);
  for (const name of entries) {
    if (name.startsWith('.') || name === 'node_modules' || name === 'data') continue;
    const from = path.join(APP_DIR, name);
    try {
      if (fs.statSync(from).isDirectory()) copyDir(from, path.join(PREVIOUS_DIR, name));
      else fs.copyFileSync(from, path.join(PREVIOUS_DIR, name));
    } catch (e) {
      console.error(`Could not keep a rollback copy of ${name}:`, e.message);
    }
  }
  if (!fs.existsSync(path.join(PREVIOUS_DIR, 'package.json'))) {
    throw new Error('Could not make a safe copy of the running version, so nothing has been changed');
  }
  return { kept: PREVIOUS_DIR };
}

/** Records a downloaded release as waiting to be installed. */
export function stagePending(version) {
  const state = readState();
  writeState({ ...state, pendingVersion: version, downloadedAt: new Date().toISOString() });
  return { pendingVersion: version };
}

/** What the Settings screen shows: what is running, and whether an update is sitting ready. */
export function updateStatus() {
  const state = readState();
  return {
    current: currentVersion(),
    pendingVersion: state.pendingVersion || null,
    rolledBackFrom: state.rolledBackFrom || null,
    lastUpdateCheck: state.lastUpdateCheck || null
  };
}

export function recordUpdateCheck(at) {
  const state = readState();
  writeState({ ...state, lastUpdateCheck: at || new Date().toISOString() });
}

/* ---------- the restart, and surviving it ---------- */

/**
 * Restarts this server process in place.
 *
 * A till has no terminal and no service manager a shopkeeper knows about, so "run systemctl restart" is not
 * an option. The process re-executes itself with the same arguments and the same environment, which is
 * what makes this work identically on a shop's Linux box, on Windows, and inside the desktop app.
 *
 * The parent exits first so that if the new process also dies — the bad-release case — there is nothing left
 * supervising it and the next start goes through the rollback check.
 */
export function restartServer() {
  try {
    if (process.env.POS_UPDATE_CHILD === '1') {
      console.error('A restarted copy restarted itself again. Not doing that a second time.');
      return false;
    }
    console.log('Restarting the till to finish the update…');
    const out = logStream();
    // env is passed through as-is plus the child marker; the parent is replaced, not forked twice.
    const child = spawn(process.execPath, process.argv.slice(1), {
      env: { ...process.env, POS_UPDATE_CHILD: '1' },
      stdio: ['ignore', out, out],
      detached: true
    });
    child.unref();
    setTimeout(() => process.exit(0), 250);
    return true;
  } catch (e) {
    console.error('Could not restart the till:', e.message);
    return false;
  }
}

function logStream() {
  // Kept on the same file the service already writes to, so an update that goes wrong is visible in the
  // same place a shop's owner would look, rather than in a window that closed with the old process.
  try {
    if (process.env.POS_LOG_FILE) return fs.openSync(process.env.POS_LOG_FILE, 'a');
  } catch { /* fall through to inherit */ }
  return 'inherit';
}

/* ---------- small helpers ---------- */

/**
 * The second half of downloadUpdate, split out so an already-downloaded archive can be staged.
 *
 * Only reachable from a test, and only ever pointed at a throwaway copy of the app. It exists because the
 * download is the half that is awkward to test honestly (it needs a real HTTP response), while the half
 * that can actually break a shop — the unpack, the layout check, the refusal of a truncated or hostile
 * archive — is all here and is worth testing directly.
 */
export async function downloadUpdateFromFile(tgzPath, version) {
  const buf = fs.readFileSync(tgzPath);
  if (buf.length === 0) throw new Error('That update file was empty');
  if (buf.length > MAX_DOWNLOAD_BYTES) throw new Error('That update file is far too large to be a release of this till');

  removeQuietly(STAGING_DIR);
  fs.mkdirSync(path.join(STAGING_DIR, 'new'), { recursive: true, mode: 0o700 });
  const tgz = path.join(STAGING_DIR, 'release.tar.gz');
  fs.writeFileSync(tgz, buf, { mode: 0o600 });
  await extractTarGz(tgz, path.join(STAGING_DIR, 'new'));

  const root = releaseRoot(path.join(STAGING_DIR, 'new'));
  if (!fs.existsSync(path.join(root, 'package.json'))) {
    throw new Error('That download did not contain the till — nothing has been changed');
  }
  if (!fs.existsSync(path.join(root, 'server.js'))) {
    throw new Error('That download is missing server.js — nothing has been changed');
  }
  fs.writeFileSync(path.join(STAGING_DIR, 'version.txt'), `${version}\n`, { mode: 0o600 });
  return { version, bytes: buf.length, sha256: crypto.createHash('sha256').update(buf).digest('hex') };
}

/** Releases are published from the repository root, so the files sit inside one directory named for the tag. */
function releaseRoot(unpacked) {
  const entries = fs.readdirSync(unpacked).filter((n) => !n.startsWith('.'));
  return entries.length === 1 && fs.statSync(path.join(unpacked, entries[0])).isDirectory()
    ? path.join(unpacked, entries[0])
    : unpacked;
}

function removeQuietly(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
}

function copyDir(from, to) {
  fs.mkdirSync(to, { recursive: true });
  for (const name of fs.readdirSync(from)) {
    if (name === '.previous-version' || name === '.update-staging' || name === '.failed-version') continue;
    const src = path.join(from, name);
    const dst = path.join(to, name);
    if (name === 'node_modules') continue; // never copied: large, and rebuilt from package.json
    const st = fs.statSync(src);
    if (st.isDirectory()) copyDir(src, dst);
    else if (st.isSymbolicLink()) fs.symlinkSync(fs.readlinkSync(src), dst);
    else fs.copyFileSync(src, dst);
  }
}

/**
 * Unpacks a .tar.gz without needing `tar` on the machine.
 *
 * Windows shops will not have it, and a feature that only works where the developer happens to be is a
 * feature half the users cannot use. The tar reader is deliberately small: it handles the ustar format
 * that `git archive` and the GitHub tarball service both produce, and it refuses anything else rather than
 * writing files it has misunderstood — a path escaping the target directory is the one thing an archive
 * extractor must never do.
 */
async function extractTarGz(tgzPath, dest) {
  const { gunzipSync } = await import('zlib');
  const tar = gunzipSync(fs.readFileSync(tgzPath));
  let off = 0;
  const longName = path.resolve(dest);

  while (off + 512 <= tar.length) {
    const header = tar.subarray(off, off + 512);
    if (header.every((b) => b === 0)) break; // end-of-archive marker

    const rawName = cstr(header.subarray(0, 100));
    const sizeField = cstr(header.subarray(124, 136)).trim();
    const size = parseInt(sizeField, 8) || 0;
    const type = String.fromCharCode(header[156]) || '0';
    const prefix = cstr(header.subarray(345, 500));
    off += 512;

    const data = tar.subarray(off, off + size);
    off += Math.ceil(size / 512) * 512;
    if (size === 0 && !rawName) continue;

    const name = prefix ? `${prefix}/${rawName}` : rawName;
    const target = path.resolve(longName, name);
    // The single most important check in this file. An archive entry of "../../.ssh/authorized_keys"
    // would otherwise write outside the directory being unpacked into.
    if (target !== longName && !target.startsWith(longName + path.sep)) {
      throw new Error('That update archive tried to write outside its own folder — refusing it');
    }

    if (type === '5') { // directory
      fs.mkdirSync(target, { recursive: true, mode: 0o755 });
      continue;
    }
    if (type === '0' || type === '\0' || type === '' || type === '7') { // file / contiguous
      fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o755 });
      fs.writeFileSync(target, data, { mode: 0o644 });
      continue;
    }
    // Symlinks, hardlinks and devices are not used by this project's releases and are skipped rather than
    // guessed at: a release that suddenly needs one is a release that has changed shape.
  }
}

function cstr(buf) {
  const end = buf.indexOf(0);
  return buf.subarray(0, end === -1 ? buf.length : end).toString('utf8');
}

export const updateInternals = {
  APP_DIR, STATE_FILE, PREVIOUS_DIR, STAGING_DIR, RELEASES_API, MAX_DOWNLOAD_BYTES, readState, writeState, copyDir
};
