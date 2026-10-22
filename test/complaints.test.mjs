// A complaint has to be filed and given a reference even when the AI is missing, slow or broken —
// losing it is the one unacceptable outcome. Also checks the wording the customer gets.
import assert from 'node:assert/strict';
import test from 'node:test';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  mentionsComplaint, complaintDetail, buildComplaintPromptText, buildComplaintSavedText
} from '../whatsapp-bot.js';

const ROOT = '/home/dhruba/m3-pos';

// ---------- the wording helpers, which need no server ----------

test('recognises how people actually complain', () => {
  for (const t of [
    'the rice packet was torn', 'wrong item delivered', 'damaged', 'missing item', 'not delivered',
    'late delivery', 'I want a refund', 'bad quality', 'short weight', 'poor quality',
    'the milk had expired', 'spoiled', 'the oil is leaking', 'my order did not come',
    'not good', 'unsatisfied', 'there is a problem with my order', 'complaint',
    'চালের প্যাকেট ছিঁড়া', 'সমস্যা হয়েছে', 'খারাপ পণ্য', 'ডেলিভারি দেরি হয়েছে'
  ]) {
    assert.ok(mentionsComplaint(t), `should be recognised as a complaint: ${t}`);
  }
});

test('does not mistake ordinary ordering for a complaint', () => {
  for (const t of ['menu', 'hi', '2 rice', 'rice 5kg', 'cash', 'upi', 'name Rahim', '1234', 'yes', '']) {
    assert.equal(mentionsComplaint(t), false, `should NOT be a complaint: "${t}"`);
  }
});

test('a message with detail gives usable detail back', () => {
  assert.equal(complaintDetail('the rice packet was torn'), 'the rice packet was torn');
  assert.equal(complaintDetail('wrong item delivered'), 'wrong item delivered');
  assert.equal(complaintDetail('I want a refund for the broken oil'), 'I want a refund for the broken oil');
});

test('a bare complaint asks again instead of filing an empty row', () => {
  for (const t of ['complaint', 'hi', 'problem', 'issue', 'i have a problem', 'refund', 'damaged']) {
    assert.equal(complaintDetail(t), null, `"${t}" carries no detail and should be asked about`);
  }
});

test('the fallback reply still apologises and gives a reference', () => {
  const text = buildComplaintSavedText('CMP-0007', 'Corner Store');
  assert.match(text, /CMP-0007/, 'it quotes the reference so the shop can look it up');
  assert.match(text, /sorry/i, 'it apologises');
  assert.match(text, /call you back/i, 'it says a person will call');
  // Nothing here may commit the shop to money, since nothing checks that later.
  assert.doesNotMatch(text, /refund|replace|discount|free|₹|rs\.?\s*\d/i,
    'it must not promise money, because no code enforces that promise');
});

test('the follow-up prompt asks what happened and offers a way out', () => {
  const text = buildComplaintPromptText();
  assert.match(text, /what went wrong/i, 'it asks what happened');
  assert.match(text, /menu/i, 'it offers a way back to ordering');
});

// ---------- the server side ----------

  async function withServer(run, opts = {}) {
    const data = fs.mkdtempSync(path.join(os.tmpdir(), 'pos-complaint-'));
    // A port per test, not one for the file.
    //
    // Every test in this file starts its own server, and they all used the same fixed port. That worked
    // until there were enough of them to run into a server from the previous test still holding it, at
    // which point the new one fails to bind, exits, and the test fails as "other side closed" — pointing
    // at a socket rather than at anything to do with complaints. The port is only found free once, and a
    // freed port is not free by the time the next test asks for it.
    const port = await freePort();
    const srv = spawn('node', ['server.js'], {
      cwd: ROOT,
      env: {
        ...process.env,
        PORT: String(port),
        POS_DATA_DIR: data,
        POS_NO_WHATSAPP: '1',
        // A stand-in sender that records instead of sending. Nothing in this file reaches a real WhatsApp
        // account; this only exists so a message path can be exercised without one. A test that is about
        // what happens when a message *cannot* be sent turns it off, because "no connection" and "a
        // connection that works" are the two halves of that behaviour and only one can be true at a time.
        ...(opts.fakeWa === false ? {} : {
          POS_FAKE_WHATSAPP: '1',
          POS_FAKE_WHATSAPP_LOG: path.join(data, 'sent.jsonl')
        })
      },
      stdio: ['ignore', 'pipe', 'pipe']
    });
  let out = '';
  srv.stdout.on('data', (d) => { out += d; });
  srv.stderr.on('data', (d) => { out += d; });
  const base = `http://127.0.0.1:${port}`;
  const api = async (method, route, body) => {
    const res = await fetch(base + route, {
      method, headers: { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
      // `raw` as well as the parsed body, because some of these tests are about what is *absent* from a
      // response, and a key that has been quietly renamed still fails the test unless the text is read.
      const raw = await res.text();
      let json = null;
      try { json = JSON.parse(raw); } catch { json = null; }
      return { status: res.status, json, raw };
    };
  try {
    for (let i = 0; i < 120; i++) {
      try { await fetch(base + '/api/config'); break; } catch { await new Promise((r) => setTimeout(r, 100)); }
    }
    await run(api, data, () => out);
  } finally {
    srv.kill('SIGKILL');
    fs.rmSync(data, { recursive: true, force: true });
  }
}

  const t = (name, fn, opts) => test(name, () => withServer(fn, opts));

  /** Asks the operating system for a port nobody is using, then gives it straight back. */
  async function freePort() {
    const http = await import('node:http');
    const probe = http.createServer();
    await new Promise((r) => probe.listen(0, '127.0.0.1', r));
    const { port } = probe.address();
    await new Promise((r) => probe.close(r));
    return port;
  }

  /**
   * A stand-in for the AI provider, on a port the operating system picks.
   *
   * Fixed ports were fine when there was one mock. With several they collide whenever two tests run at
   * once, and a collision here is silent and nasty: one test ends up talking to another test's model, and
   * the test that was meant to prove a promise is refused passes for the wrong reason. Asking for port 0
   * lets the OS hand out a free one and returns it in `port`.
   */
  async function startMockAI(data, reply) {
    const http = await import('node:http');
    const seen = [];
    const mock = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        try { seen.push(JSON.parse(body)); } catch { seen.push({ raw: body }); }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ choices: [{ message: { content: reply(body) } }] }));
      });
    });
    await new Promise((r) => mock.listen(0, '127.0.0.1', r));
    mock.port = mock.address().port;
    mock.seen = seen;
    fs.writeFileSync(path.join(data, 'config.json'), JSON.stringify({
      storeName: 'Corner Store', ai: { apiKey: 'sk-test', baseUrl: `http://127.0.0.1:${mock.port}/api`, model: 'm' }
    }));
    return mock;
  }

  /** Files the fake sender wrote, if anything did. */
  function sentMessages(data) {
    const f = path.join(data, 'sent.jsonl');
    if (!fs.existsSync(f)) return [];
    const raw = fs.readFileSync(f, 'utf8').trim();
    return raw ? raw.split('\n').map((l) => JSON.parse(l)) : [];
  }

/* ---------- the record, which must survive anything ---------- */

t('a complaint can be filed, listed and resolved', async (api) => {
  const made = await api('POST', '/api/complaints', { phone: '9876543210', text: 'the rice packet was torn' });
  assert.equal(made.status, 201);
  const c = made.json.complaint;
  assert.match(c.id, /^CMP-\d{4}$/, 'it gets a reference number');
  assert.equal(c.status, 'open', 'a new complaint starts open');
  assert.equal(c.text, 'the rice packet was torn');
  assert.equal(c.source, 'staff');
  // The words the staff member can read out. Fixed, not generated: nothing here can be talked into
  // promising money, because there is no model in this path at all.
  assert.match(made.json.suggestedReply, /CMP-\d{4}/, 'it carries the reference to read out');
  assert.doesNotMatch(made.json.suggestedReply, /refund|replace|discount|free|₹|rs\.?\s*\d/i,
    'and it promises no money, because a spoken promise is as binding as a written one');

  const all = await api('GET', '/api/complaints');
  assert.equal(all.json.total, 1);
  assert.equal(all.json.open, 1);
  assert.equal(all.json.resolved, 0);

  const done = await api('PATCH', `/api/complaints/${c.id}`, { status: 'resolved', note: 'Replaced the packet', handledBy: 'Owner' });
  assert.equal(done.json.complaint.status, 'resolved');
  assert.equal(done.json.complaint.note, 'Replaced the packet');
  assert.ok(done.json.complaint.resolvedAt, 'resolving stamps the time');

  const after = await api('GET', '/api/complaints');
  assert.equal(after.json.open, 0, 'it drops out of the open count once resolved');
  assert.equal(after.json.resolved, 1);
});

t('references never collide, even after many complaints', async (api) => {
  for (let i = 0; i < 12; i++) await api('POST', '/api/complaints', { text: `complaint number ${i}` });
  const list = await api('GET', '/api/complaints');
  const ids = list.json.complaints.map((c) => c.id);
  assert.equal(new Set(ids).size, ids.length, 'every reference is unique');
});

t('a complaint is saved even with no AI configured at all', async (api, data) => {
  // No AI key is configured, so the wording path has nothing to call. The complaint must still exist.
  const made = await api('POST', '/api/complaints', { phone: '9876543210', text: 'the milk was spoiled' });
  assert.equal(made.status, 201, 'the complaint is still filed');
  const onDisk = JSON.parse(fs.readFileSync(path.join(data, 'complaints.json'), 'utf8'));
  assert.equal(onDisk.length, 1, 'it is written to disk immediately, not held in memory');
  assert.equal(onDisk[0].text, 'the milk was spoiled');
});

t('an AI key is never sent to the browser', async (api, data) => {
  // A complaint record is returned on six routes and broadcast over the socket. The key must not ride
  // along on any of them, or it ends up in the page of any machine on the shop's wifi.
  fs.writeFileSync(path.join(data, 'config.json'), JSON.stringify({
    storeName: 'Corner Store', ai: { apiKey: 'sk-secret-do-not-leak', baseUrl: 'https://example.invalid/api', model: 'm' }
  }));
  const c = (await api('POST', '/api/complaints', { phone: '9876543210', text: 'the oil was leaking' })).json.complaint;
  const seen = [
    (await api('GET', '/api/complaints')).raw,
    (await api('GET', `/api/complaints/${c.id}`)).raw,
    (await api('GET', '/api/config')).raw,
    (await api('PATCH', `/api/complaints/${c.id}`, { note: 'looking' })).raw
  ];
  for (const body of seen) {
    assert.doesNotMatch(body, /sk-secret-do-not-leak/, 'a key reached the browser');
    assert.doesNotMatch(body, /apiKey/i, 'not even the name of the key is sent');
  }
});

t('a complaint with no detail is rejected rather than stored blank', async (api) => {
  const empty = await api('POST', '/api/complaints', { text: '   ' });
  assert.equal(empty.status, 400, 'a blank complaint is refused');
  assert.equal((await api('GET', '/api/complaints')).json.total, 0, 'and nothing is stored');
});

t('a complaint links to the bill the customer last paid', async (api) => {
  const id = (await api('POST', '/api/orders/next-id')).json.id;
  await api('POST', '/api/orders', {
    id,
    items: [{ sku: 'RICE', name: 'Rice', qty: 1, price: 80 }],
    paymentMethod: 'upi',
    customer: { name: 'Rahim Uddin', phone: '9876543210' }
  });
  const made = await api('POST', '/api/complaints', { phone: '9876543210', text: 'the milk was spoiled' });
  const c = made.json.complaint;
  assert.equal(c.billId, id, 'it carries the bill number so staff can look up the order');
  assert.equal(c.customerName, 'Rahim Uddin', 'it carries the name already on file, not asked again');
});

t('status can only be one of the known values', async (api) => {
  const c = (await api('POST', '/api/complaints', { text: 'something is wrong here' })).json.complaint;
  const bad = await api('PATCH', `/api/complaints/${c.id}`, { status: 'exploded' });
  assert.equal(bad.status, 400, 'a nonsense status is refused');
  const still = (await api('GET', `/api/complaints/${c.id}`)).json.complaint;
  assert.equal(still.status, 'open', 'the complaint is left as it was');
});

t('nonsense severities are refused rather than quietly stored', async (api) => {
  // Severity is the gate on whether the assistant may speak to a customer at all. A typo stored as
  // "minro" is not a typo the shop sees — it is a complaint that silently never gets answered.
  const c = (await api('POST', '/api/complaints', { text: 'the packet is torn' })).json.complaint;
  const bad = await api('PATCH', `/api/complaints/${c.id}`, { severity: 'minro' });
  assert.equal(bad.status, 400, 'a misspelled severity is refused rather than accepted');
  const still = (await api('GET', `/api/complaints/${c.id}`)).json.complaint;
  assert.equal(still.severity, 'major', 'and the complaint keeps the severity it arrived with');

  for (const ok of ['minor', 'major', 'serious']) {
    const good = await api('PATCH', `/api/complaints/${c.id}`, { severity: ok });
    assert.equal(good.status, 200, `"${ok}" is a real severity and must be accepted`);
    assert.equal(good.json.complaint.severity, ok);
  }
});

/* ---------- the conversation state the shop drives ---------- */

t('a new complaint starts with the assistant switched off', async (api) => {
  const c = (await api('POST', '/api/complaints', { phone: '9876543210', text: 'the rice packet was torn' })).json.complaint;
  assert.equal(c.severity, 'major', 'a complaint nobody has judged starts as needing a person');
  assert.equal(c.aiState, 'awaiting-shop', 'so the assistant is not answering it');
  assert.equal(c.aiTurns, 0, 'and it has not had a turn');
  assert.deepEqual(c.transcript, [], 'with nothing said');
  assert.equal(c.aiEscalation, null, 'and nobody has been dragged off a job');
  assert.equal(c.aiEscalatedAt, null);
});

t('marking a complaint minor is what turns the assistant on', async (api) => {
  const c = (await api('POST', '/api/complaints', { phone: '9876543210', text: 'the rice packet was torn' })).json.complaint;
  const on = await api('PATCH', `/api/complaints/${c.id}`, { severity: 'minor' });
  assert.equal(on.json.complaint.aiState, 'active', 'the shop judged it minor, so it may be answered');
  // And raising it again takes it straight back off, because a customer getting angry is the exact
  // moment this matters.
  const off = await api('PATCH', `/api/complaints/${c.id}`, { severity: 'serious' });
  assert.equal(off.json.complaint.aiState, 'awaiting-shop', 'raising it stops the assistant again');
});

t('closing a complaint takes it off the assistant as well', async (api) => {
  const c = (await api('POST', '/api/complaints', { text: 'the rice packet was torn' })).json.complaint;
  await api('PATCH', `/api/complaints/${c.id}`, { severity: 'minor' });
  const done = await api('PATCH', `/api/complaints/${c.id}`, { status: 'resolved', note: 'done', handledBy: 'Owner' });
  assert.equal(done.json.complaint.aiState, 'awaiting-shop', 'a closed complaint is not answered again');
  assert.equal(done.json.complaint.status, 'resolved');
});

t('the complaint list carries the reason it was handed over, so the shop can read it', async (api) => {
  // The list route is what the till actually draws. If it dropped the escalation reason, the shop would
  // see a complaint with a flag and no explanation, and would have to open each one to find out.
  const c = (await api('POST', '/api/complaints', { phone: '9876543210', text: 'the rice packet was torn' })).json.complaint;
  const one = (await api('GET', '/api/complaints')).json.complaints.find((x) => x.id === c.id);
  for (const field of ['aiState', 'aiTurns', 'aiEscalation', 'aiEscalatedAt', 'transcript', 'severity']) {
    assert.ok(field in one, `the list is missing ${field}`);
  }
});

t('there is no route that sends a reply without the shop in the loop', async () => {
  // The one-shot button is gone, and the test that matters is that the route is gone with it. A leftover
  // endpoint would still be one POST away from saying something to a customer that nobody read.
  const src = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
  assert.doesNotMatch(src, /auto-reply/, 'the one-shot send route is still there');
  assert.doesNotMatch(src, /canAutoSend/, 'and its permission check is still there');
  assert.doesNotMatch(src, /autoSendApproved/, 'and its approval flag is still there');
  // The route the shop can still use is the one that only ever attaches a suggestion.
  assert.match(src, /api\/complaints\/:id\/suggest/, 'the shop keeps the read-only suggestion');
});

/* ---------- the AI wording, against a stand-in provider ---------- */
// A real key is not needed to prove the wiring: this stands up a local server that answers like the
// OpenAI-compatible endpoint, so the whole path is exercised — request shape, parsing, timeout and
// the fallback — without sending a customer's complaint anywhere.

t('the provider supplies the wording for a suggestion, and the model is told the rules', async (api, data) => {
  let seen = null;
  const mock = await startMockAI(data, (body) => {
    seen = JSON.parse(body);
    return JSON.stringify({
      summary: 'Rice packet arrived torn', category: 'damaged', severity: 'low',
      suggestion: 'Check the packet and call the customer today',
      noteDraft: 'Called the customer and offered a replacement packet from stock', needsHuman: false
    });
  });
  try {
    const c = (await api('POST', '/api/complaints', { phone: '9876543210', text: 'the rice packet was torn' })).json.complaint;
    const r = await api('POST', `/api/complaints/${c.id}/suggest`);
    assert.equal(r.status, 200);
    assert.equal(r.json.suggestion.severity, 'low', 'the model grades the complaint low');
    assert.equal(r.json.suggestion.needsHuman, false);
    assert.equal(r.json.suggestion.source, 'ai', 'and the shop is told it did not write this itself');
    assert.equal(mock.seen.length, 1, 'the provider was called once');
    assert.equal(seen.model, 'm', 'the configured model is used');
    const system = seen.messages.find((m) => m.role === 'system').content;
    assert.match(system, /You are advising only\./, 'the model is told it only advises');
    assert.match(system, /cannot promise, issue or authorise any money/i, 'and cannot commit money');
    assert.match(system, /needsHuman.*true whenever money is involved/is, 'and that money always means a person');
    assert.match(system, /when in doubt, true/i, 'and that it should default to asking for a person');
    // JSON only, because the screen parses it. A model answering in prose must not be half-accepted.
    assert.equal(seen.response_format.type, 'json_object');
    const user = seen.messages.find((m) => m.role === 'user').content;
    assert.match(user, /the rice packet was torn/, 'the complaint text is sent so it can be advised on');
    // The bill is what the owner looks up to act on it, so the model has to know it too.
    assert.match(user, new RegExp(c.billId || 'not known'), 'and which bill it was');
    // The complaint itself must not depend on any of this.
    assert.equal((await api('GET', '/api/complaints')).json.total, 1, 'the complaint is stored regardless');
    // And a suggestion is still only a suggestion.
    const after = (await api('GET', `/api/complaints/${c.id}`)).json.complaint;
    assert.equal(after.status, 'open', 'asking for advice does not resolve anything');
    assert.match(after.suggestion.suggestion, /call the customer/i, 'it is attached for staff to read');
  } finally {
    mock.close();
  }
});

t('a suggestion for a resolved complaint is refused', async (api, data) => {
  const mock = await startMockAI(data, () => '{}');
  try {
    const c = (await api('POST', '/api/complaints', { phone: '9876543210', text: 'the oil was leaking' })).json.complaint;
    await api('PATCH', `/api/complaints/${c.id}`, { status: 'resolved', note: 'done', handledBy: 'Owner' });
    const r = await api('POST', `/api/complaints/${c.id}/suggest`);
    assert.equal(r.status, 400, 'a closed complaint is not worth asking about');
    assert.equal(mock.seen.length, 0, 'and the provider is not even called');
  } finally {
    mock.close();
  }
});

t('a suggestion that reads like a promise is flagged for a person, whatever the model claimed', async (api, data) => {
  // The model is told it cannot offer money, and it does it anyway. Cheap to be wrong here — a human looks
  // at it. The other way round is a ₹50 credit one tap from happening because the model was confident.
  const mock = await startMockAI(data, () => JSON.stringify({
    summary: 'Customer wants a refund', category: 'other', severity: 'low',
    suggestion: 'Offer a Rs 50 credit for the inconvenience', noteDraft: 'Gave a credit', needsHuman: false
  }));
  try {
    const c = (await api('POST', '/api/complaints', { phone: '9876543210', text: 'the packet was torn' })).json.complaint;
    const r = await api('POST', `/api/complaints/${c.id}/suggest`);
    assert.equal(r.status, 200, 'the suggestion is still shown, because hiding it just means retyping it');
    assert.equal(r.json.suggestion.needsHuman, true, 'but it is marked as needing a person');
    assert.match(r.json.suggestion.suggestion, /Rs 50 credit/i, 'and the words are still visible to the owner');
  } finally {
    mock.close();
  }
});

t('a model that returns nothing usable is treated as no suggestion at all', async (api, data) => {
  // JSON is requested, but a model can still answer in prose, or with a JSON object that has no advice in
  // it. Both have to come back as "nothing", which the shop reads as "sort this one out by hand" — not as
  // a crash and not as an empty suggestion it might render as though it were advice.
  for (const reply of ['I am sorry but I cannot help with that.', '```json\n{}\n```', 'not json at all']) {
    const mock = await startMockAI(data, () => reply);
    try {
      const c = (await api('POST', '/api/complaints', { phone: '9876543210', text: 'the oil was leaking' })).json.complaint;
      const r = await api('POST', `/api/complaints/${c.id}/suggest`);
      assert.equal(r.status, 200, `"${reply.slice(0, 20)}" is not an error worth stopping the shop for`);
      assert.equal(r.json.suggestion, null, `"${reply.slice(0, 20)}" was not read as a suggestion`);
      assert.match(r.json.reason, /by hand/i);
    } finally {
      mock.close();
    }
  }
});

t('an unreachable provider leaves the shop able to work by hand', async (api, data) => {
  // Pointed at a port with nothing on it. The complaint exists, the route says so in words the owner can
  // read, and the till carries on — which is exactly how the shop worked before any of this existed.
  fs.writeFileSync(path.join(data, 'config.json'), JSON.stringify({
    storeName: 'Corner Store', ai: { apiKey: 'sk-test', baseUrl: 'http://127.0.0.1:1/api', model: 'm' }
  }));
  const c = (await api('POST', '/api/complaints', { phone: '9876543210', text: 'the oil was leaking' })).json.complaint;
  const r = await api('POST', `/api/complaints/${c.id}/suggest`);
  assert.equal(r.status, 200, 'a dead AI is not an error worth stopping the shop for');
  assert.equal(r.json.suggestion, null);
  assert.match(r.json.reason, /by hand/i, 'and the shop is told what to do instead');
  assert.equal((await api('GET', `/api/complaints/${c.id}`)).json.complaint.status, 'open', 'still open');
});

t('a suggestion with no advice in it is refused, rather than shown as advice', async (api, data) => {
  // A well-formed object that contains no recommendation is the shape a model produces when it has been
  // asked for a field it did not want to fill in. Rendering that as a suggestion would put an empty box
  // in front of the owner and look as though the shop had already thought about it.
  const mock = await startMockAI(data, () => JSON.stringify({ summary: 'Oil leaking', category: 'quality' }));
  try {
    const c = (await api('POST', '/api/complaints', { phone: '9876543210', text: 'the oil can was leaking' })).json.complaint;
    const r = await api('POST', `/api/complaints/${c.id}/suggest`);
    assert.equal(r.json.suggestion, null, 'an object with no suggestion in it is not a suggestion');
    assert.match(r.json.reason, /by hand/i, 'and the shop is told to do it themselves');
  } finally {
    mock.close();
  }
});

t('changing the shop name or UPI ID does not delete the AI key', async (api, data) => {
  fs.writeFileSync(path.join(data, 'config.json'), JSON.stringify({
    storeName: 'Corner Store',
    ai: { apiKey: 'sk-keep-me', baseUrl: 'https://example.invalid/api', model: 'm' }
  }));
  // Re-running setup is how a shop fixes a wrong UPI ID, and it must not cost them the AI key.
  await api('POST', '/api/setup', { storeName: 'Renamed Store', upiVpa: 'new@bank' });
  const saved = JSON.parse(fs.readFileSync(path.join(data, 'config.json'), 'utf8'));
  assert.equal(saved.ai.apiKey, 'sk-keep-me', 'the AI key survived');
  assert.equal(saved.storeName, 'Renamed Store', 'the shop name was still updated');
  assert.equal(saved.upiVpa, 'new@bank', 'the UPI ID was still updated');
  const pub = (await api('GET', '/api/config')).json;
  assert.ok(!('apiKey' in (pub.ai || {})), 'and it is still not sent to the browser');
});

/* ---------- replying to a customer from the till ---------- */

t('the shop can reply to a customer in its own words', async (api, data) => {
  // The thing the shopkeeper actually wants: read the complaint, type an answer, send it. The words go
  // out as typed, including the ones the assistant would never be allowed to say.
  const c = (await api('POST', '/api/complaints', { phone: '9876543210', text: 'the rice packet was torn' })).json.complaint;
  await api('PATCH', `/api/complaints/${c.id}`, { severity: 'minor' });

  const reply = 'I have sent a new packet and refunded the Rs 80 on the rice.';
  const r = await api('POST', `/api/complaints/${c.id}/reply`, { text: reply });
  assert.equal(r.status, 200);
  assert.equal(r.json.sent, true, 'the customer was answered');

  const sent = sentMessages(data);
  assert.equal(sent.length, 1, 'exactly one message went out, to the number on the complaint');
  assert.match(JSON.stringify(sent), /9876543210/);
  assert.match(JSON.stringify(sent), /refunded the Rs 80/,
    'and it is the owner\'s own wording, money and all, because a person decided it');

  const after = r.json.complaint;
  assert.equal(after.transcript.length, 1, 'it is on the record');
  assert.equal(after.transcript[0].from, 'staff');
  assert.equal(after.transcript[0].text, reply);
  assert.equal(after.aiState, 'taken-over', 'and the assistant stops talking over the shopkeeper');
  assert.equal(after.status, 'open', 'while the complaint stays open until somebody resolves it');
  assert.ok(after.repliedAt, 'and it is stamped that the customer was answered');
});

t('a reply that could not be sent leaves no trace of having been sent', async (api, data) => {
  // WhatsApp is off for this one, so there is no connection to send through.
  const c = (await api('POST', '/api/complaints', { phone: '9876543210', text: 'the rice packet was torn' })).json.complaint;
  const r = await api('POST', `/api/complaints/${c.id}/reply`, { text: 'I have sent a new packet.' });
  assert.equal(r.status, 502, 'a dead WhatsApp is reported, not swallowed');
  assert.equal(r.json.sent, false, 'and it says plainly that nothing was sent');

  // The important part: a failed send must not leave a record claiming the customer was answered.
  const after = (await api('GET', `/api/complaints/${c.id}`)).json.complaint;
  assert.deepEqual(after.transcript, [], 'nothing was written to the transcript');
  assert.equal(after.repliedAt, null, 'and it does not claim the customer was replied to');
  assert.equal(after.aiState, 'awaiting-shop', 'and it does not switch the assistant off either');
  assert.equal(sentMessages(data).length, 0, 'and no message was recorded as going anywhere');
}, { fakeWa: false });

t('a reply is refused for the reasons it should be', async (api) => {
  const c = (await api('POST', '/api/complaints', { phone: '9876543210', text: 'the rice packet was torn' })).json.complaint;

  const blank = await api('POST', `/api/complaints/${c.id}/reply`, { text: '   ' });
  assert.equal(blank.status, 400, 'an empty box is not sent');

  const missing = await api('POST', '/api/complaints/CMP-9999/reply', { text: 'hello' });
  assert.equal(missing.status, 404, 'a complaint that does not exist is not replied to');

  // A complaint filed at the counter with no number has nobody to send to, and guessing is worse than
  // refusing: a wrong number is somebody else's phone.
  const noPhone = (await api('POST', '/api/complaints', { text: 'a customer told me at the counter' })).json.complaint;
  const unreachable = await api('POST', `/api/complaints/${noPhone.id}/reply`, { text: 'hello' });
  assert.equal(unreachable.status, 400, 'a complaint with no number cannot be messaged');
  assert.match(unreachable.json.error, /no phone number/i);

  await api('PATCH', `/api/complaints/${c.id}`, { status: 'resolved', note: 'done', handledBy: 'Owner' });
  const closed = await api('POST', `/api/complaints/${c.id}/reply`, { text: 'hello' });
  assert.equal(closed.status, 400, 'a resolved complaint is not replied to behind the shop\'s back');
});

t('replying to a customer needs the till PIN, like everything else that speaks for the shop', async () => {
  // The whole point of the gate. A till left signed in must not be able to put words in the shop's mouth
  // to a customer, and the cheapest way to be sure is that this route inherits the same middleware as
  // every other one rather than being trusted to remember it.
  const src = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
  assert.match(src, /app\.use\(requirePin\(savedPin\)\)/, 'the PIN covers the whole API');
  const before = src.indexOf("app.post('/api/complaints/:id/reply'");
  assert.ok(before > 0, 'the reply route exists');
  assert.ok(before > src.indexOf('app.use(requirePin(savedPin))'),
    'and is registered after it, so the middleware is already in front of it');
});

t('the assistant is taken off a complaint the moment the shop answers it', async (api) => {
  // Stated at the server level because the state lives on the record: if a shopkeeper replies and the bot
  // carries on, the customer gets two answers, one of them from a machine, and the shop loses the thread.
  const src = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
  assert.match(src, /complaintConversation\.staffSaid\(c, text\)/,
    'a sent reply is written through the conversation, not straight onto the record');
  const conv = fs.readFileSync(path.join(ROOT, 'complaint-conversation.js'), 'utf8');
  assert.match(conv, /aiState === AI_STATE\.TAKEN_OVER/, 'which is what stops the assistant');
});

/* ---------- a complaint must never be able to take the till down ---------- */

t('a bill still goes through when WhatsApp cannot be reached', async (api, data) => {
  // WhatsApp is switched off for this whole file, so every sale below is also a test that the till does
  // not care. A bill that is accepted, written to disk and served is the only thing that matters here.
  await api('POST', '/api/products', { sku: 'RICE', name: 'Rice', price: 80, stock: 10 });
  const id = (await api('POST', '/api/orders/next-id')).json.id;
  const order = await api('POST', '/api/orders', {
    id,
    items: [{ sku: 'RICE', name: 'Rice', qty: 2, price: 80 }],
    paymentMethod: 'upi',
    customer: { name: 'New Customer', phone: '9000000001' }
  });
  assert.equal(order.status, 201, 'the bill is taken');
  assert.equal(order.json.order.id, id, 'and it is the bill that was asked for');

  // The order is durable, not just accepted: a bill that vanishes on the next restart is not a sale.
  // There is no list-orders route, so this reads what the till actually wrote to disk.
  const saved = fs.readdirSync(data).filter((f) => f.startsWith('orders'));
  assert.ok(saved.length, 'the order was written to disk');
  const onDisk = fs.readFileSync(path.join(data, saved[0]), 'utf8');
  assert.ok(onDisk.includes(id), 'and the bill number is in it');
});

t('the till is still serving after a message fails', async (api) => {
  // A different customer, so the welcome path runs a second time, and then an ordinary request. The point
  // is the process is still there afterwards.
  await api('POST', '/api/products', { sku: 'RICE', name: 'Rice', price: 80, stock: 10 });
  const id = (await api('POST', '/api/orders/next-id')).json.id;
  await api('POST', '/api/orders', {
    id,
    items: [{ sku: 'RICE', name: 'Rice', qty: 1, price: 80 }],
    paymentMethod: 'upi',
    customer: { name: 'Another New One', phone: '9000000002' }
  });
  const after = await api('GET', '/api/config');
  assert.equal(after.status, 200, 'the till answered normally afterwards');
});
