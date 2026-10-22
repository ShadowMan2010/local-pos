/* Over-the-air updates, tested against a copy of the app rather than the real one.

   The reason this file is so careful about that: the feature it tests replaces the application directory
   it is running from. A test that let it do that to the live till would, on a bad day, delete a working
   shop. So everything here happens inside a throwaway copy, and the assertions that matter are the ones
   about what happens when an update goes wrong — because a working update is easy and a *failed* update
   is the entire reason this design exists. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import zlib from 'node:zlib';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WORK = '/tmp/opencode/ota';
// Read once, up front: every fake release in this file is built from the real updater's source.
const UPDATER_SRC = fs.readFileSync(path.join(ROOT, 'updater.js'), 'utf8');

/* ---------- a release archive, built the way GitHub builds one ---------- */

/** A .tar.gz in ustar format, with a single top-level directory, exactly as git archive produces. */
function makeTarGz(entries, topDir) {
  const blocks = [];
  for (const [name, content] of Object.entries(entries)) {
    const body = Buffer.from(content);
    const h = Buffer.alloc(512);
    h.write((topDir ? `${topDir}/${name}` : name).slice(0, 100), 0);
    h.write('000644 \0', 100);
    h.write('000000 \0', 108);
    h.write('000000 \0', 116);
    h.write(`${body.length.toString(8).padStart(11, '0')}\0`, 124);
    h.write('00000000000\0', 136);
    h.write('        ', 148); // checksum placeholder
    h.write('0', 156);          // regular file
    h.write('ustar\0', 257);
    h.write('00', 263);
    const sum = h.reduce((a, b) => a + b, 0);
    h.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148);
    blocks.push(h, body, Buffer.alloc((512 - (body.length % 512)) % 512));
  }
  blocks.push(Buffer.alloc(1024)); // end of archive
  return zlib.gulpSync ? zlib.gzipSync(Buffer.concat(blocks)) : zlib.gzipSync(Buffer.concat(blocks));
}

/**
 * A minimal but genuinely bootable release.
 *
 * It carries the updater itself, because every real release does and a release without it cannot be
 * undone. That is not a formality: an earlier version of this test shipped a release with only a
 * package.json, the install deleted the updater, and the rollback that was supposed to rescue the till
 * had nothing left to run on.
 */
function releaseFiles(ver, extra = {}) {
  return {
    'package.json': JSON.stringify({ name: 'local-pos', version: ver, type: 'module', main: 'server.js' }),
    'server.js': `console.log('version ${ver}');\n`,
    'updater.js': UPDATER_SRC,
    ...extra
  };
}

/** A throwaway copy of the app, so nothing here can touch the live till. */
/**
 * Runs a snippet in a genuinely separate Node process, against the throwaway copy.
 *
 * A separate process is the point: rollback and markHealthy are the two calls that a real update makes
 * from a *fresh start*, and running them in-process would share module state that only a real restart
 * clears. That difference is exactly what would hide a broken rollback.
 */
function runInChild(dir, body) {
  const script = `
    const u = await import('${pathToFileURL(path.join(dir, 'updater.js')).href}');
    const out = await (async () => { ${body} })();
    process.stdout.write(JSON.stringify(out ?? null));
  `;
  return JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8' }));
}

function makeAppCopy(version = '0.2.0') {
  fs.rmSync(WORK, { recursive: true, force: true });
  fs.mkdirSync(WORK, { recursive: true });
  fs.writeFileSync(path.join(WORK, 'package.json'), JSON.stringify({ name: 'local-pos', version, type: 'module' }));
  fs.writeFileSync(path.join(WORK, 'server.js'), '// v1, working\n');
  fs.writeFileSync(path.join(WORK, 'keepme.txt'), 'data that should survive an update\n');
  fs.mkdirSync(path.join(WORK, 'node_modules'), { recursive: true });
  fs.writeFileSync(path.join(WORK, 'node_modules', 'dep.txt'), 'installed dependency\n');
  fs.mkdirSync(path.join(WORK, 'data'), { recursive: true });
  fs.writeFileSync(path.join(WORK, 'data', 'orders.jsonl'), '{"id":"INV-260928-0001"}\n');
  return WORK;
}

/** Loads updater.js with its APP_DIR pointed at the copy, so it operates on the copy. */
async function loadUpdaterIn(dir) {
  // The module resolves its own directory from import.meta.url, so the copy needs a real updater.js in it.
  fs.writeFileSync(path.join(dir, 'updater.js'), UPDATER_SRC);
  const url = new URL(`file://${path.join(dir, 'updater.js')}`);
  return import(`${url.href}?t=${Date.now()}`);
}

/* ---------- version comparison ---------- */

test('a newer release is recognised and an older or equal one is not offered', async () => {
  const { compareVersions } = await import('../updater.js');
  for (const [a, b, want] of [
    ['1.0.1', '1.0.0', 1], ['1.0.0', '1.0.1', -1], ['v1.2.0', 'v1.1.9', 1],
    ['1.0.10', '1.0.9', 1], ['2.0.0', '1.99.99', 1], ['1.0.0', '1.0.0', 0],
    ['1.0.0', '1.0.0.1', -1]
  ]) {
    assert.equal(compareVersions(a, b), want, `${a} against ${b}`);
  }
});

test('a pre-release is older than the finished version it leads to', async () => {
  // Otherwise a shop running 1.0.0 would be invited back down to 1.0.0-beta1 on every check.
  const { compareVersions } = await import('../updater.js');
  assert.equal(compareVersions('1.0.0-beta', '1.0.0'), -1, 'a beta is not newer than the release');
  assert.equal(compareVersions('1.0.0', '1.0.0-beta'), 1, 'and the release is newer than its beta');
  assert.equal(compareVersions('1.0.0-alpha', '1.0.0-beta'), -1, 'alpha before beta');
});

test('a version this cannot read is refused rather than guessed at', async () => {
  // Guessing here is how a till ends up installing something over a working shop.
  const { compareVersions } = await import('../updater.js');
  for (const bad of ['', 'latest', 'main', 'v', '1.2', null, undefined, {}]) {
    assert.equal(compareVersions(bad, '1.0.0'), null, `"${bad}" must not compare`);
    assert.equal(compareVersions('1.0.0', bad), null, `"${bad}" must not compare as the current one`);
  }
});

/* ---------- the update check ---------- */

test('the check offers a newer published release and refuses a draft or prerelease', async () => {
  const dir = makeAppCopy('0.2.0');
  const u = await loadUpdaterIn(dir);

  const fakeFetch = (body) => async () => ({ ok: true, status: 200, json: async () => body });
  const real = globalThis.fetch;

  try {
    globalThis.fetch = fakeFetch({ tag_name: 'v0.3.0', body: 'Faster bills', published_at: '2026-09-28T00:00:00Z' });
    const newer = await u.checkForUpdate();
    assert.equal(newer.current, '0.2.0', 'it knows what is running');
    assert.equal(newer.latest, '0.3.0', 'and what is published');
    assert.equal(newer.updateAvailable, true, 'a newer version is offered');

    globalThis.fetch = fakeFetch({ tag_name: 'v0.2.0' });
    assert.equal((await u.checkForUpdate()).updateAvailable, false, 'the same version is not an update');

    globalThis.fetch = fakeFetch({ tag_name: 'v0.1.0' });
    assert.equal((await u.checkForUpdate()).updateAvailable, false, 'an older version is never offered');

    globalThis.fetch = fakeFetch({ tag_name: 'v0.3.0', draft: true });
    const draft = await u.checkForUpdate();
    assert.equal(draft.updateAvailable, false, 'a draft is not for shops');
    assert.match(draft.error || '', /not published/i, 'and it says why');

    globalThis.fetch = fakeFetch({ tag_name: 'v0.3.0', prerelease: true });
    assert.equal((await u.checkForUpdate()).updateAvailable, false, 'a prerelease is not for shops');

    globalThis.fetch = async () => { throw new Error('no network in the shop'); };
    const offline = await u.checkForUpdate();
    assert.equal(offline.updateAvailable, false, 'no network means no update, not a crash');
    assert.ok(offline.error, 'and the shop is told why');
  } finally {
    globalThis.fetch = real;
  }
});

/* ---------- installing, and the happy path ---------- */

test('a good release installs and leaves the shop\'s data and dependencies alone', async () => {
  const dir = makeAppCopy('0.2.0');
  const u = await loadUpdaterIn(dir);

  // Stage the release exactly as downloadUpdate would.
  const gz = makeTarGz(releaseFiles('0.3.0', { 'CHANGELOG.md': '# 0.3.0\n' }), 'local-pos-0.3.0');
  const stageNew = path.join(u.updateInternals.STAGING_DIR, 'new', 'local-pos-0.3.0');
  fs.mkdirSync(stageNew, { recursive: true });
  fs.writeFileSync(path.join(stageNew, 'release.tar.gz.tmp'), 'x');
  fs.rmSync(path.join(stageNew, 'release.tar.gz.tmp'));
  // Unpack through the real reader so the test uses the same code as production.
  fs.writeFileSync(path.join(u.updateInternals.STAGING_DIR, 'release.tar.gz'), gz);
  fs.copyFileSync(path.join(u.updateInternals.STAGING_DIR, 'release.tar.gz'), path.join(dir, 'rel.tgz'));
  await u.downloadUpdateFromFile?.(path.join(dir, 'rel.tgz'), '0.3.0');

  u.stagePending('0.3.0');
  u.keepPreviousVersion();
  const r = u.installUpdate({ restart: false });
  assert.equal(r.installed, '0.3.0', 'the new version is running');

  assert.ok(fs.existsSync(path.join(dir, 'CHANGELOG.md')), 'the release brought its own files');
  // The two things that must never be lost or reverted by an update.
  assert.equal(fs.readFileSync(path.join(dir, 'data', 'orders.jsonl'), 'utf8').trim(),
    '{"id":"INV-260928-0001"}', 'the shop\'s bills are untouched');
  assert.ok(fs.existsSync(path.join(dir, 'node_modules', 'dep.txt')), 'installed dependencies are kept, not wiped');
});

/* ---------- the part that matters: a bad release ---------- */

test('installing leaves behind the note that the new version is still on probation', async () => {
  // This is the bug that quietly disarmed the entire feature.
  //
  // The install replaces the application directory. If it also removes the file recording "an update is
  // waiting to be proven", then the next start finds no pending update, concludes everything is fine, and
  // a broken release becomes permanent — with a rollback function sitting right there that never runs.
  // The test asserts the marker survives the install, because a rollback that cannot remember it needs
  // rolling back.
  const dir = makeAppCopy('0.2.0');
  const u = await loadUpdaterIn(dir);
  const gz = makeTarGz(releaseFiles('0.3.0'), 'local-pos-0.3.0');
  fs.writeFileSync(path.join(dir, 'rel.tgz'), gz);
  await u.downloadUpdateFromFile(path.join(dir, 'rel.tgz'), '0.3.0');
  u.stagePending('0.3.0');
  u.keepPreviousVersion();
  u.installUpdate({ restart: false });

  const stateFile = path.join(dir, '.update-state.json');
  assert.ok(fs.existsSync(stateFile), 'the pending-update marker still exists after installing');
  const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  assert.equal(state.pendingVersion, '0.3.0', 'and it still names the version awaiting proof');
});

test('a release that does not start is rolled back, automatically, without a person', async () => {
  const dir = makeAppCopy('0.2.0');
  const u = await loadUpdaterIn(dir);

  // 1. Keep the working version aside and install 0.3.0 over it.
  u.stagePending('0.3.0');
  u.keepPreviousVersion();
  const gz = makeTarGz(releaseFiles('0.3.0'), 'local-pos-0.3.0');
  fs.writeFileSync(path.join(dir, 'rel.tgz'), gz);
  await u.downloadUpdateFromFile(path.join(dir, 'rel.tgz'), '0.3.0');
  u.installUpdate({ restart: false });
  assert.equal(u.currentVersion(), '0.3.0', 'the bad release is now the running code');

  // 2. 0.3.0 crashes on startup instead of serving. A fresh process asks the updater what to do, and the
  //    answer has to be "go back", with nobody present to press anything.
  //
  //    The child imports the updater *before* asking it to roll back, and that ordering is not fussiness:
  //    a real rollback moves the application directory out from under the running code, so anything that
  //    imported it afterwards would be reading a file that is no longer there. Node has already loaded
  //    the module by then, which is exactly what happens in production.
  const out = runInChild(dir, 'return { rolledBack: u.rollbackIfPending().rolledBack, version: u.currentVersion() };');
  assert.equal(out.rolledBack, true, 'the till put the old version back by itself');
  assert.equal(out.version, '0.2.0', 'and it is the version that was working before');

  // 3. The shop's data survived the whole thing — the rollback moves directories around, and the orders
  //    are the one thing in there that cannot be recreated if they get left behind.
  assert.ok(fs.existsSync(path.join(dir, 'data')), 'the data folder is back where it belongs');
  assert.equal(fs.readFileSync(path.join(dir, 'data', 'orders.jsonl'), 'utf8').trim(),
    '{"id":"INV-260928-0001"}', 'no bills were lost rolling back');

  // 4. And nothing was left lying about next to the app, where it would confuse the next update.
  const strays = fs.readdirSync(path.dirname(dir)).filter((n) => n.startsWith('ota.'));
  assert.deepEqual(strays, [], 'no temporary folders were left behind');

  // 5. A version that does come up clears the pending marker, so the next boot is trusted.
  fs.rmSync(path.join(dir, '.previous-version'), { recursive: true, force: true });
  const h = runInChild(dir, 'const r = u.markHealthy(); return { ...r, state: u.updateStatus() };');
  assert.equal(h.state.pendingVersion, null, 'the update is no longer pending');
  assert.equal(h.state.rolledBackFrom, '0.3.0', 'and the shop can be told what went wrong');
});

test('rolling back is attempted once, never in a loop', async () => {
  // A loop here would be a boot screen with no way out but a person with a keyboard — the exact situation
  // the rollback exists to avoid.
  const dir = makeAppCopy('0.2.0');
  const u = await loadUpdaterIn(dir);
  const gz = makeTarGz(releaseFiles('0.3.0'), 'local-pos-0.3.0');
  fs.writeFileSync(path.join(dir, 'rel.tgz'), gz);
  await u.downloadUpdateFromFile(path.join(dir, 'rel.tgz'), '0.3.0');
  u.stagePending('0.3.0');
  u.keepPreviousVersion();
  u.installUpdate({ restart: false });
  const first = runInChild(dir, 'return u.rollbackIfPending();');
  assert.equal(first.rolledBack, true, 'the first attempt restores the old version');

  const second = runInChild(dir, 'return u.rollbackIfPending();');
  assert.equal(second.rolledBack, false, 'the second attempt does nothing');
});

test('a download that is cut off is refused before anything is replaced', async () => {
  // The common real failure: a shop on shop Wi-Fi pulling a few hundred KB. A truncated tar must not be
  // half-installed over a working till.
  const dir = makeAppCopy('0.2.0');
  const u = await loadUpdaterIn(dir);
  const gz = makeTarGz(releaseFiles('0.3.0'), 'local-pos-0.3.0');

  const real = globalThis.fetch;
  try {
    let sent = false;
    globalThis.fetch = async () => {
      if (sent) throw new Error('should not download twice');
      sent = true;
      return {
        ok: true, status: 200,
        headers: { get: () => String(gz.length) },
        body: (async function* () { yield gz.subarray(0, Math.floor(gz.length / 2)); })()
      };
    };
    await assert.rejects(
      () => u.downloadUpdate({ version: '0.3.0', expectedSize: gz.length }),
      /incomplete/i,
      'a short download is refused'
    );
  } finally {
    globalThis.fetch = real;
  }

  assert.equal(u.currentVersion(), '0.2.0', 'the running version was never touched');
  assert.ok(!fs.existsSync(path.join(dir, 'server.js.bak')), 'and no half-installed copy was left behind');
});

test('an archive that tries to write outside its own folder is refused', async () => {
  // The one thing a tar extractor must never allow. Without this check a release could write anywhere the
  // till's user can, which for a shop's till is the whole machine.
  const dir = makeAppCopy('0.2.0');
  const u = await loadUpdaterIn(dir);
  const evil = makeTarGz({ '../../escaped.txt': 'should never be written' }, 'local-pos-0.3.0');

  const real = globalThis.fetch;
  try {
    globalThis.fetch = async () => ({
      ok: true, status: 200,
      headers: { get: () => String(evil.length) },
      body: (async function* () { yield evil; })()
    });
    await assert.rejects(() => u.downloadUpdate({ version: '0.3.0' }), /outside|escape/i, 'path traversal is refused');
  } finally {
    globalThis.fetch = real;
  }
  assert.ok(!fs.existsSync(path.join(path.dirname(dir), 'escaped.txt')), 'nothing was written outside the folder');
});

/* ---------- a whole update, end to end ---------- */

test('a full update runs on a throwaway copy of the app without touching the real one', async () => {
  // The test that would have caught an updater that wrote to its own directory instead of the copy it
  // was pointed at: it hashes the real app before and after.
  const before = fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8');
  const beforeServer = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');

  const dir = makeAppCopy('0.2.0');
  const u = await loadUpdaterIn(dir);
  u.stagePending('0.3.0');
  u.keepPreviousVersion();
  const gz = makeTarGz(releaseFiles('0.3.0'), 'local-pos-0.3.0');
  fs.writeFileSync(path.join(dir, 'rel.tgz'), gz);
  await u.downloadUpdateFromFile(path.join(dir, 'rel.tgz'), '0.3.0');
  u.installUpdate({ restart: false });

  assert.equal(u.currentVersion(), '0.3.0', 'the copy is on the new version');
  assert.equal(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'), before, 'the real app is untouched');
  assert.equal(fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8'), beforeServer, 'by every single byte');
  assert.ok(!fs.existsSync(path.join(ROOT, '.previous-version')), 'no rollback folder was made in the real app');
  assert.ok(!fs.existsSync(path.join(ROOT, '.update-staging')), 'and no staging folder either');
});
