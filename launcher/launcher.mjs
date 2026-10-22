// Starting the shop, without a terminal.
//
// This is the file a shopkeeper actually double-clicks. Everything else in this project is something the
// till does once it is running; this is the moment it comes to life, and it is the only part a shop will
// ever look at directly, so it has to behave when there is nobody technical in the room.
//
// Three things happen here, in this order, and the order is the whole design:
//
//   1. Roll back, if the last update broke the till. A shop that installed something bad should get the
//      old version back without anybody driving over, and a rollback has to be decided *before* the new
//      version gets a chance to serve a single request.
//   2. Start the server, in this same process. Not as a child. That is not tidiness: the updater restarts
//      a till by re-running `process.argv[1]`, so whatever is first in that list has to be this file. Run
//      the server as a child and an update restarts the server while the launcher sits there supervising
//      a process that no longer exists, with nothing left to notice the new one failing.
//   3. Wait until it actually answers, then trust it, then open the browser. In that order. Marking a
//      version healthy before it has served a request would disarm the rollback for a release that boots
//      and then dies on the first customer.
//
// Nothing here ever deletes data/. The application directory is replaced wholesale by an update, and the
// one thing that must outlive that is the shop's own records.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { currentVersion, markHealthy, rollbackIfPending } from '../updater.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP_DIR = path.resolve(HERE, '..');
const PORT = Number(process.env.PORT || 3000);

/* ---------- talking to the shopkeeper ---------- */

/**
 * Where the launcher's own output goes.
 *
 * Inside data/, not next to the code, and that is the entire reason: an update replaces the application
 * directory, so a log kept beside the code is a log that is deleted by the thing that went wrong — which
 * is precisely the log somebody needs. data/ is preserved by every path through the updater.
 */
const DATA_DIR = process.env.POS_DATA_DIR || path.join(APP_DIR, 'data');
const LOG_FILE = path.join(DATA_DIR, 'launcher.log');

/**
 * Writes a line to the log and to the terminal.
 *
 * The terminal is not optional. On a Mac and on Linux the shop may have launched this from a terminal
 * themselves, or a service manager may be capturing it, and swallowing the output entirely would leave a
 * developer with nothing to look at. The log is the copy that survives.
 */
function say(message) {
  const line = `[${new Date().toISOString()}] ${message}`;
  console.log(line);
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    // Capped, because a launcher that logs on every failed health check would otherwise fill a shop's
    // disk over a few months of a till being switched on and off.
    const existing = fs.existsSync(LOG_FILE) ? fs.readFileSync(LOG_FILE, 'utf8') : '';
    const kept = existing.length > 512 * 1024 ? existing.slice(-384 * 1024) : existing;
    fs.writeFileSync(LOG_FILE, kept + line + '\n');
  } catch { /* a till that cannot write its log must still start */ }
}

/**
 * A last message for a person who has no terminal, on a platform that can show one.
 *
 * Only used when the till could not start at all, which is the one case where a shopkeeper needs to be
 * told something and has nowhere to read it. Best effort by design: on a headless box there is no window
 * to put it in, and failing to show a dialog must never turn into a second failure.
 */
function tellShopkeeper(title, message) {
  say(`${title}: ${message}`);
  try {
    if (os.platform() === 'darwin') {
      spawn('osascript', ['-e', `display dialog ${JSON.stringify(message)} with title ${JSON.stringify(title)}`],
        { stdio: 'ignore', detached: true }).unref();
    } else if (os.platform() === 'win32') {
      spawn('powershell', ['-NoProfile', '-Command',
        `[System.Reflection.Assembly]::LoadWithPartialName('System.Windows.Forms')|Out-Null;`
        + `[System.Windows.Forms.MessageBox]::Show(${JSON.stringify(message)})`], { stdio: 'ignore', detached: true }).unref();
    } else if (process.env.DISPLAY) {
      spawn('zenity', ['--warning', `--title=${title}`, `--text=${message}`], { stdio: 'ignore', detached: true }).unref();
    }
  } catch { /* nothing to show it in; the log has it */ }
}

/* ---------- the port ---------- */

/** A request to the till itself. Not a browser: no window, no profile, nothing to go wrong. */
function ping(timeoutMs = 1200) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port: PORT, path: '/api/config', timeout: timeoutMs }, (res) => {
      res.resume();
      resolve(res.statusCode > 0);
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}

/**
 * Opens the till in whatever the shop already uses.
 *
 * The default browser on purpose, not a bundled one. The shop's till is a page; the browser they already
 * have open all day is the one that will have their extensions, their printer and their bookmarks, and a
 * second browser installed next to it is a second thing to break.
 */
function openTill() {
  const url = `http://localhost:${PORT}`;
  const cmd = os.platform() === 'darwin' ? ['open', [url]]
    : os.platform() === 'win32' ? ['cmd', ['/c', 'start', '', url]]
      : ['xdg-open', [url]];
  try {
    spawn(cmd[0], cmd[1], { stdio: 'ignore', detached: true }).unref();
    say(`Opened ${url}`);
  } catch (e) {
    say(`Could not open a browser by itself (${e.message}). Open ${url} yourself.`);
  }
}

/* ---------- dependencies ---------- */

/**
 * Installs the packages if they are not there yet.
 *
 * This is the part that makes the app work on a shop's machine. The release is a folder of code, and the
 * code needs the packages it imports; a shopkeeper is not going to type `npm install`, so if that step is
 * skipped this is where it happens instead — once, at the first start, with the reason said out loud
 * because a two-minute wait with no explanation is a till that looks broken.
 */
function ensureDependencies() {
  if (fs.existsSync(path.join(APP_DIR, 'node_modules', 'express'))) return true;
  say('First run: installing what the shop needs. This happens once and takes a minute.');
  const npm = os.platform() === 'win32' ? 'npm.cmd' : 'npm';
  const result = spawnSync(npm, ['install', '--omit=dev', '--no-audit', '--no-fund'], {
    cwd: APP_DIR, stdio: 'inherit', shell: os.platform() === 'win32'
  });
  if (result.status !== 0) {
    tellShopkeeper('The shop could not start',
      `Installing its packages failed. This needs an internet connection the first time.\n\n${LOG_FILE}`);
    return false;
  }
  return fs.existsSync(path.join(APP_DIR, 'node_modules', 'express'));
}

/* ---------- rollback, then hand over to the real app ---------- */

/**
 * Starts again from the current application directory, and does not come back.
 *
 * Only used after a rollback. That function replaces the application directory wholesale — the broken
 * version is moved aside and the previous one renamed into its place — so this process is now running from
 * a path that no longer holds the code it loaded at startup. Continuing in-place would mean serving a
 * rolled-back app out of a rolled-back-away directory, which is the worst of both.
 */
function relaunchAfterRollback() {
  say('Starting the version that was rolled back…');
  const self = path.join(APP_DIR, 'launcher', 'launcher.mjs');
  const child = spawn(process.execPath, [self, '--no-browser'], {
    // The marker stops the new process from trying to roll back a second time: the rollback has already
    // happened, and running it again from the restored copy would be rolling forward into the version that
    // was just found to be broken.
    env: { ...process.env, POS_ROLLBACK_DONE: '1' },
    stdio: 'inherit',
    detached: true
  });
  child.unref();
  setTimeout(() => process.exit(0), 150);
}

async function main() {
  const noBrowser = process.argv.includes('--no-browser') || process.env.POS_NO_BROWSER === '1';

  say(`LOCAL POS ${currentVersion()} starting`);

  // 1. Before anything serves a request: has the last update broken this till?
  if (process.env.POS_ROLLBACK_DONE !== '1') {
    const rollback = rollbackIfPending();
    if (rollback.rolledBack) {
      say(`Version ${rollback.from} did not start, so the previous version has been put back.`);
      relaunchAfterRollback();
      return;
    }
    if (rollback.reason && rollback.reason !== 'no-previous-copy' && rollback.reason !== 'already-healthy') {
      say(`Nothing to roll back (${rollback.reason}).`);
    }
  }

  // 2. Already running? Then this is a second double-click, and starting a second till on the same port
  //    would fail in a way that looks like a broken app. Open the shop that is already up and stop.
  if (await ping()) {
    say('The shop is already running — opening it rather than starting a second one.');
    if (!noBrowser) openTill();
    return;
  }

  if (!ensureDependencies()) {
    process.exitCode = 1;
    return;
  }

  // 3. The server, in this process. See the note at the top: argv[1] has to stay this file so that an
  //    update restarts the launcher and not just the thing it launched.
  process.argv[1] = fileURLToPath(import.meta.url);
  try {
    await import('../server.js');
  } catch (e) {
    say(`The shop could not start: ${e.message}`);
    say(e.stack || '');
    tellShopkeeper('The shop could not start',
      `Something went wrong starting the till.\n\n${e.message}\n\nThe full log is in ${LOG_FILE}`);
    process.exitCode = 1;
    return;
  }

  // 4. Healthy means it answered, not that it was launched. Anything less and a release that boots and
  //    then dies on the first customer would be marked good and never rolled back.
  const deadline = Date.now() + 45000;
  while (Date.now() < deadline) {
    if (await ping()) {
      const trust = markHealthy();
      say(`The shop is up on port ${PORT}.`);
      if (trust.firstBootAfterUpdate) {
        say(`Update to ${currentVersion()} worked and has been kept.`);
      }
      if (!noBrowser) openTill();
      return;
    }
    await new Promise((r) => setTimeout(r, 400));
  }

  say('The shop started but never answered. See the log for why.');
  tellShopkeeper('The shop did not start', `It started but never answered.\n\nThe log is in ${LOG_FILE}`);
  process.exitCode = 1;
}

main().catch((e) => {
  say(`The launcher itself failed: ${e.message}`);
  say(e.stack || '');
  process.exitCode = 1;
});
