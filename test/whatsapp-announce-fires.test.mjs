/* Feature: the shop's announcement fires itself exactly once.
   This is the one behaviour the pure tests cannot reach, and the one a shop would most regret getting
   wrong: a customer list is real people, and a bug here either spams them or forgets them. So this
   runs a real server against a throwaway data dir and a stand-in WhatsApp that records what it was
   asked to send, and proves three things — the saved customers get it, somebody who opted out does
   not, and a restart does not send it a second time. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { killPort } from './browser.mjs';

const PORT = 4983;
const DIR = '/tmp/opencode/fwaannounce';
const BASE = `http://localhost:${PORT}`;
const LOG = path.join(DIR, 'sent.jsonl');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const ENV = {
  ...process.env,
  PORT: String(PORT),
  POS_DATA_DIR: DIR,
  POS_NO_WHATSAPP: '1',
  POS_FAKE_WHATSAPP: '1',
  POS_FAKE_WHATSAPP_STATUS: JSON.stringify({ connected: true }),
  POS_FAKE_WHATSAPP_LOG: LOG,
  POS_ANNOUNCE: '1',
  POS_ANNOUNCE_DELAY_MS: '300',
  POS_ANNOUNCE_GAP_MS: '15'
};

function startServer() {
  const srv = spawn('node', ['server.js'], { env: ENV, stdio: ['ignore', 'pipe', 'pipe'] });
  const logs = [];
  srv.stdout.on('data', (d) => logs.push(d.toString()));
  srv.stderr.on('data', (d) => logs.push(d.toString()));
  srv.logs = logs;
  return srv;
}

async function ready(srv) {
  for (let i = 0; ; i++) {
    try { const r = await fetch(`${BASE}/api/auth/status`); if (r.ok) { await r.text(); return; } } catch {}
    if (i > 80) throw new Error('server never became ready\n' + srv.logs.join(''));
    await sleep(250);
  }
}

const sentLines = () => (fs.existsSync(LOG) ? fs.readFileSync(LOG, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);

test('the announcement reaches saved customers once, never the opted-out, never twice', async () => {
  killPort(PORT);
  fs.rmSync(DIR, { recursive: true, force: true });
  fs.mkdirSync(DIR, { recursive: true });
  fs.writeFileSync(path.join(DIR, 'customers.json'), JSON.stringify({
    '9876543210': { phone: '9876543210', name: 'Rina', visits: 2 },
    '9123456780': { phone: '9123456780', name: 'Amit', visits: 1 }
  }));
  fs.writeFileSync(path.join(DIR, 'announcements.json'), JSON.stringify({ optOut: { '9876543210': true } }));

  let srv = startServer();
  try {
    await ready(srv);
    // Wait for the send to happen (the delay is 300 ms, so this is generous).
    for (let i = 0; i < 20 && sentLines().length < 1; i++) await sleep(200);
    const sent = sentLines();
    assert.equal(sent.length, 1, `expected exactly one message, got ${sent.length}\n${JSON.stringify(sent)}`);
    assert.equal(sent[0].phone, '9123456780', 'the other customer, not the one who opted out');
    assert.match(sent[0].text, /voice note/i);

    const state = JSON.parse(fs.readFileSync(path.join(DIR, 'announcements.json'), 'utf8'));
    assert.ok(state.voiceOrdering?.sentAt, 'the send is recorded as done');
    assert.deepEqual(state.voiceOrdering.sent, ['9123456780']);

    // Restart against the same data dir: the record on disk must stop a second send.
    srv.kill();
    await sleep(400);
    srv = startServer();
    await ready(srv);
    await sleep(1200);
    assert.equal(sentLines().length, 1, 'a restart must not send the announcement again');
  } finally {
    srv.kill();
    await sleep(200);
    killPort(PORT);
  }
});
