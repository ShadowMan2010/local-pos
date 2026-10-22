/* Starting and stopping the WhatsApp bot from settings, without restarting the server.

   The reason this needs tests at all: the switch has to be genuinely reversible, and there are two ways to
   get that wrong that both look fine from the outside. One is stopping by unlinking — telling WhatsApp to
   drop the device — which leaves a shop that meant to pause for the evening having to scan a QR in the
   morning. The other is reporting a deliberate stop as a revoked device, which tells a shop their number
   has been compromised when the shop pressed Stop itself.

   The state machine lives inside the module against a real socket, so what is pinned here is the part that
   can be reached without one: the status shape the screen reads, and the route that decides the direction
   of the switch. The socket-level behaviour is asserted by reading the code that runs. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { killPort } from './browser.mjs';

const PORT = 3196;
const DIR = '/tmp/opencode/fwastop';
const BASE = `http://localhost:${PORT}`;
const PIN = '4821';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const post = async (p, body, token) => {
  const r = await fetch(BASE + p, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  return { status: r.status, body: await r.json().catch(() => null) };
};
const get = async (p, token) => {
  const r = await fetch(BASE + p, { headers: token ? { authorization: `Bearer ${token}` } : {} });
  return r.json();
};

killPort(PORT);
fs.rmSync(DIR, { recursive: true, force: true });
fs.mkdirSync(DIR, { recursive: true });
const srv = spawn('node', ['server.js'], {
  env: {
    ...process.env, PORT: String(PORT), POS_DATA_DIR: DIR,
    POS_NO_WHATSAPP: '1', POS_FAKE_WHATSAPP: '1'
  },
  stdio: ['ignore', 'pipe', 'pipe']
});
const logs = [];
srv.stdout.on('data', (d) => logs.push(d.toString()));
srv.stderr.on('data', (d) => logs.push(d.toString()));
for (let i = 0; ; i++) {
  try { const r = await fetch(`${BASE}/api/auth/status`); if (r.ok) { await r.text(); break; } } catch {}
  if (i > 80) { console.log('server never became ready\n' + logs.join('')); process.exit(1); }
  await sleep(250);
}

let token;
try {
  await post('/api/setup', { storeName: 'Stop Test', upiVpa: '', pin: PIN });
  ({ body: { token } } = await post('/api/auth/pin', { pin: PIN }));
  assert.ok(token, 'could not sign in to the throwaway server');

  await test('the status says the bot is on before anyone touches the switch', async () => {
    const s = await get('/api/whatsapp/status');
    assert.equal(s.enabled, true, 'a freshly started bot should report itself enabled');
  });

  await test('starting and stopping the bot is behind the PIN gate', async () => {
    // Anyone who can reach the till's network can turn a shop's order line off. That is a denial of
    // trade, and it is exactly as sensitive as the rest of settings.
    const r = await post('/api/whatsapp/toggle');
    assert.equal(r.status, 401, `an unauthenticated toggle returned ${r.status}, not 401`);
    assert.equal(r.body.needsPin, true, 'the refusal should say it wants the PIN');
  });

  await test('one press stops the bot, and the status says so', async () => {
    const r = await post('/api/whatsapp/toggle', undefined, token);
    assert.equal(r.status, 200, `the toggle refused: ${JSON.stringify(r.body)}`);
    assert.equal(r.body.enabled, false, 'the route reports the bot still enabled after stopping it');
    const s = await get('/api/whatsapp/status');
    assert.equal(s.enabled, false, 'the status a shop reads still says the bot is on');
  });

  await test('a stopped bot is not reported as connected, and not as starting either', async () => {
    // The distinction the whole card was rewritten for. A stopped bot is not connected and shows no QR, so
    // without `enabled` it lands in the "Starting…" branch and promises a connection nobody asked for.
    const s = await get('/api/whatsapp/status');
    assert.equal(s.connected, false);
    assert.equal(s.loggedOut, false, 'a deliberate stop must not look like a revoked device');
  });

  await test('the same button brings the bot back', async () => {
    const r = await post('/api/whatsapp/toggle', undefined, token);
    assert.equal(r.body.enabled, true, 'the second press did not start the bot again');
    const s = await get('/api/whatsapp/status');
    assert.equal(s.enabled, true, 'the status still says the bot is stopped');
  });

  await test('presses in between are still the right way round', async () => {
    for (const want of [false, true, false, true]) {
      const r = await post('/api/whatsapp/toggle', undefined, token);
      assert.equal(r.body.enabled, want, `a press should have left enabled=${want}`);
    }
  });

  await test('stopping keeps the linked number, which unlinking would destroy', async () => {
    // The distinction the implementation rests on: stop() ends the socket, unlink() deletes the session
    // files and asks WhatsApp to drop the device. A shop that pauses the bot for the evening must not wake
    // up to a QR code.
    const src = fs.readFileSync('whatsapp.js', 'utf8');
    const stopBody = src.slice(src.indexOf('async stop()'), src.indexOf('async unlink()'));
    assert.ok(!/\blogout\(/.test(stopBody), 'stop() must not call logout() — that unlinks the device');
    assert.ok(/\.end\(/.test(stopBody), 'stop() should close the socket with end()');
  });

  await test('a stop is never mistaken for the phone revoking the device', async () => {
    // The close event fires for a deliberate stop exactly as it does for a network drop. Reading it as a
    // revoke would set loggedOut and tell the shop its number had been removed from the phone.
    const src = fs.readFileSync('whatsapp.js', 'utf8');
    const close = src.slice(src.indexOf("update.connection === 'close'"), src.indexOf("messages.upsert"));
    const guard = close.indexOf('if (stopped)');
    const revoke = close.indexOf('outcome.loggedOut');
    assert.ok(guard > -1, 'the close handler does not check whether the shop stopped the bot on purpose');
    assert.ok(guard < revoke,
      'the deliberate-stop check comes after the revoke check, so a Stop would still be reported as a revoke');
  });

  await test('a reconnect timer that fires after Stop does not bring the bot back', async () => {
    // Pressing Stop during a slow connect: the attempt finishes afterwards, fires its close event, and
    // would otherwise schedule a reconnect 3s later. The bot would then be back on, with nothing on screen
    // explaining it.
    const src = fs.readFileSync('whatsapp.js', 'utf8');
    const connect = src.slice(src.indexOf('function connect()'), src.indexOf('sock.ev.on'));
    assert.ok(/if \(stopped\) return;/.test(connect),
      'connect() does not re-check whether the shop has stopped the bot');
  });
} finally {
  srv?.kill();
  killPort(PORT);
  fs.rmSync(DIR, { recursive: true, force: true });
}
