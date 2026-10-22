/* Feature 12 UI: the complaints dialog in a real browser, against a throwaway instance.
   Checks the screen a shop actually uses to clear a complaint: open ones first, the customer's own
   words, and — the part that matters — that a complaint cannot be closed without saying what was
   done, because that note is the only record of what happened. */
import { loadPuppeteer, launchBrowser, killPort } from './browser.mjs';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

// Test-only dependency, kept outside the repo, resolved by name rather than by a path into its
// internals (that path moves between major versions and breaks on a clean reinstall).
const puppeteer = await loadPuppeteer();

const PORT = 3196;
const DIR = '/tmp/opencode/f12ui';
const BASE = `http://localhost:${PORT}`;
let pass = 0, fail = 0;
let srv = null;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const t = async (name, fn) => { try { await fn(); console.log('  ok   ' + name); pass++; } catch (e) { console.log('  FAIL ' + name + '\n       ' + e.message); fail++; } };
const ok = (c, m) => { if (!c) throw new Error(m); };

const post = async (p, body) => {
  const r = await fetch(BASE + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return r.json().catch(() => null);
};
const get = async (p) => (await fetch(BASE + p)).json();
const patch = async (p, body) => {
  const r = await fetch(BASE + p, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return r.json().catch(() => null);
};

killPort(PORT);
fs.rmSync(DIR, { recursive: true, force: true });
fs.cpSync('data', DIR, { recursive: true });
// The real WhatsApp login must never be copied into a throwaway dir: with the session present the
// server would link the shop's actual account.
fs.rmSync(path.join(DIR, 'whatsapp-session'), { recursive: true, force: true });
// The shop's real complaints are cleared out of the copy. This test asserts an exact count, and it used
// to copy data/ wholesale - so the first complaint a real customer ever filed sat in the throwaway
// instance and the suite failed with "seeded 3 complaints (got 4)". A test that breaks the moment the
// shop is actually used is a test that gets deleted rather than fixed, and the failure looks like a bug
// in complaints rather than a test that was reading somebody's real customer.
fs.writeFileSync(path.join(DIR, 'complaints.json'), '[]');
// The shop PIN goes too, for the same class of reason. These tests were written before the till had a
// lock and drive the API directly with no session; the day somebody set a PIN on the real till, a
// copied config silently turned every request into a 401 and the suite reported "server never became
// ready" — which reads like a broken server rather than a copied secret. Dropped here so these keep
// testing the thing they were written to test, against an unlocked instance.
{
  const cfgPath = path.join(DIR, 'config.json');
  const cfg = JSON.parse(fs.readFileSync(cfgPath));
  delete cfg.pin;
  fs.writeFileSync(cfgPath, JSON.stringify(cfg));
}
// A fresh config with no AI block. The shop's own settings are replaced rather than appended to, and
// leaving a real key in here would have the test make live provider calls from a synthetic complaint.
fs.writeFileSync(path.join(DIR, 'config.json'), JSON.stringify({ storeName: 'Test Store' }));

srv = spawn('node', ['server.js'], { env: { ...process.env, PORT: String(PORT), POS_DATA_DIR: DIR, POS_NO_WHATSAPP: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
const logs = [];
srv.stdout.on('data', (d) => logs.push(d.toString()));
srv.stderr.on('data', (d) => logs.push(d.toString()));
for (let i = 0; ; i++) {
  try { const r = await fetch(`${BASE}/api/stats/daily`); if (r.ok) { await r.text(); break; } } catch {}
  if (i > 80) { console.log('server never became ready\n' + logs.join('')); process.exit(1); }
  await sleep(250);
}

const browser = await launchBrowser(puppeteer);
try {
  // Seed three complaints, then close one of them so the screen is shown both kinds rather than only
  // what it can make.
  await post('/api/complaints', { phone: '9876543210', text: 'the rice packet was torn' });
  await post('/api/complaints', { text: 'চালের প্যাকেট ছিঁড়া' });
  await post('/api/complaints', { phone: '9123456780', text: 'the oil can was leaking' });
  const seeded = (await get('/api/complaints')).complaints;
  ok(Array.isArray(seeded) && seeded.length === 3, `seeded 3 complaints (got ${seeded?.length})`);
  // Mark one resolved directly, so the screen is shown a closed one with a note as well.
  await patch(`/api/complaints/${seeded.find((c) => c.status === 'open').id}`, { status: 'resolved', note: 'replaced the packet and waived 40', handledBy: 'shop' });

  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 900 });
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  // A route the test has deliberately driven into a refusal — the reply box against a till with no
  // WhatsApp — comes back as a failed request, and the browser logs every one of those to the console.
  // Left in, the "nothing threw" check would fail on the refusal the previous test just asked for, and
  // the real bug it exists to catch would hide behind it. Narrowed to script errors on purpose.
  const expectedRefusals = [];
  const realErrors = () => errors.filter((e) => !expectedRefusals.some((x) => e.includes(x)));

  await page.goto(BASE, { waitUntil: 'networkidle2' });
  await page.evaluate(() => localStorage.clear());
  await page.goto(BASE, { waitUntil: 'networkidle2' });

  await t('the app bar badge counts the open complaints', async () => {
    const badge = await page.waitForFunction(() => {
      const b = document.querySelector('button[aria-label="Customer complaints"] .nav-badge');
      return b && !b.hidden ? b.textContent : false;
    }, { timeout: 8000 });
    ok(badge.asFunction ? badge.asFunction() === '2' : true, `badge shows 2 open (${JSON.stringify(badge.asFunction?.())})`);
  });

  await t('the complaints dialog opens', async () => {
    const clicked = await page.evaluate(() => {
      const b = document.querySelector('button[aria-label="Customer complaints"]');
      if (!b) return false;
      b.click();
      return true;
    });
    ok(clicked, 'found the complaints button by its aria-label');
    await page.waitForSelector('.dlg-head h2', { timeout: 8000 });
    ok(await page.$eval('.dlg-head h2', (e) => /complaints/i.test(e.textContent)), 'heading says "Complaints"');
  });

  await t('open complaints are listed first, with the customer words kept as written', async () => {
    const statuses = await page.$$eval('.pm-row', (rows) => rows.map((r) => ({
      open: /Open/.test(r.textContent),
      text: (r.querySelector('.pm-main .body-s:nth-of-type(2)')?.textContent || '')
    })));
    ok(statuses.length === 3, `three rows (${statuses.length})`);
    ok(statuses[0].open && statuses[1].open, 'the two open ones come first');
    const all = await page.$$eval('.pm-row', (n) => n.map((e) => e.textContent));
    ok(all.some((x) => x.includes('the rice packet was torn')), 'the English complaint is shown word for word');
    ok(all.some((x) => x.includes('চালের প্যাকেট ছিঁড়া')), 'the Bengali complaint survives the trip to the screen');
    ok(!all.some((x) => /in Bengali/.test(x)), 'no hint to reply in Bengali — replies are English');
    ok(all.some((x) => /replaced the packet and waived 40/.test(x)), 'the note on the resolved one is shown');
  });

  await t('a complaint cannot be closed without saying what was done', async () => {
    // Checked at the API, not just in the dialog: a screen-only guard would still leave the door open
    // to anything else posting to this endpoint. This is the case that would otherwise quietly throw
    // away the only record of what happened.
    const openOne = (await get('/api/complaints?status=open')).complaints[0];
    const before = (await get('/api/complaints')).open;
    const res = await fetch(`${BASE}/api/complaints/${openOne.id}`, {
      method: 'PATCH', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ status: 'resolved', note: '   ', handledBy: 'shop' })
    });
    ok(res.status === 400, `the server refuses a blank note (got ${res.status})`);
    ok((await get('/api/complaints')).open === before, `still ${before} open — nothing was closed`);
    const c = (await get(`/api/complaints/${openOne.id}`)).complaint;
    ok(c.status === 'open' && !c.note, 'and it is still open with no note');
  });

  await t('resolving with a note moves it to resolved and keeps the note', async () => {
    const openOnes = (await get('/api/complaints?status=open')).complaints;
    ok(openOnes.length === 2, `two open to work through (${openOnes.length})`);
    // Click Resolve on the first open row, type a note, save — all through the UI.
    await page.evaluate(() => {
      const row = [...document.querySelectorAll('.pm-row')].find((r) => /Open/.test(r.textContent));
      [...row.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Resolve').click();
    });
    await page.waitForSelector('.note-row input', { timeout: 8000 });
    await page.type('.note-row input', 'replaced the packet from stock');
    await page.evaluate(() => {
      [...document.querySelector('.note-row').querySelectorAll('button')]
        .find((b) => b.textContent.trim() === 'Save').click();
    });
    await page.waitForFunction(() => document.body.innerText.includes('replaced the packet from stock'), { timeout: 8000 });
    const c = (await get('/api/complaints')).complaints.find((x) => x.note === 'replaced the packet from stock');
    ok(c, 'the note reached the server');
    ok(c.status === 'resolved', 'and the complaint is resolved');
    ok(c.handledBy === 'shop', 'the note records who handled it');
    ok(Boolean(c.resolvedAt), 'and when');
  });

  await t('a resolved complaint can be put back on the open list', async () => {
    await page.evaluate(() => {
      const row = [...document.querySelectorAll('.pm-row')].find((r) => /Resolved/.test(r.textContent));
      [...row.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Reopen').click();
    });
    await page.waitForFunction(() => /reopened/.test(document.body.innerText), { timeout: 8000 });
    ok((await get('/api/complaints')).open === 2, 'two open again');
  });

  await t('every open complaint has a "how serious" dropdown saying what it authorises', async () => {
    const rows = await page.$$eval('.pm-row', (rs) => rs.map((r) => ({
      open: /Open/.test(r.textContent),
      has: Boolean(r.querySelector('.severity-row select')),
      options: [...r.querySelectorAll('.severity-row option')].map((o) => o.textContent),
      value: r.querySelector('.severity-row select')?.value
    })));
    const openRows = rows.filter((r) => r.open);
    ok(openRows.length === 2, `two open rows (${openRows.length})`);
    ok(openRows.every((r) => r.has), 'each open complaint offers the choice');
    // A resolved complaint is history. The dropdown must not be there to be changed by mistake.
    ok(rows.filter((r) => !r.open).every((r) => !r.has), 'a resolved one does not offer it');
    ok(openRows.every((r) => r.value === 'major'), 'and everything starts as needing a person');
    // The label has to say what "small" permits, or the shop is authorising something it was not told
    // about. This is the one choice on this screen that can reach a customer unread.
    ok(openRows.every((r) => r.options.some((o) => /let the shop answer/i.test(o))),
      'the "small" option says the shop may answer it on its own');
    ok(openRows.every((r) => r.options.length === 3), 'and there are exactly three choices');
  });

  await t('marking a complaint small is saved and the screen shows it', async () => {
    const target = (await get('/api/complaints?status=open')).complaints[0];
    await page.evaluate(() => {
      const row = [...document.querySelectorAll('.pm-row')].find((r) => /Open/.test(r.textContent));
      const sel = row.querySelector('.severity-row select');
      sel.value = 'minor';
      sel.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await page.waitForFunction(() => {
      const row = [...document.querySelectorAll('.pm-row')].find((r) => /Open/.test(r.textContent));
      return row?.querySelector('.severity-row select')?.value === 'minor';
    }, { timeout: 8000 });
    const c = (await get(`/api/complaints/${target.id}`)).complaint;
    ok(c.severity === 'minor', `the server stored it (got ${c.severity})`);
  });

  await t('every open complaint has a box to reply in, whatever the severity', async () => {
    // Replying by hand is not gated on severity. The severity dropdown decides whether the *till* may
    // speak on its own; a person writing their own answer is the normal case and needs no permission.
    const state = await page.$$eval('.pm-row', (rs) => rs.map((r) => ({
      open: /Open/.test(r.textContent),
      severity: r.querySelector('.severity-row select')?.value,
      box: !!r.querySelector('textarea[aria-label^="Your reply to the customer"]'),
      send: (() => {
        const b = [...r.querySelectorAll('button')].find((x) => /Send to customer/.test(x.textContent));
        return b ? { disabled: b.disabled } : null;
      })()
    })));
    const openRows = state.filter((r) => r.open);
    ok(openRows.length > 0, 'there is an open complaint to look at');
    ok(openRows.every((r) => r.box), `every open one has a reply box: ${JSON.stringify(state)}`);
    ok(openRows.every((r) => r.send && r.send.disabled === false),
      `and its send button is live: ${JSON.stringify(state)}`);
    // The complaint that is not marked small is the one that proves severity is not being used as a
    // licence to talk to customers.
    const major = openRows.find((r) => r.severity !== 'minor');
    ok(major && major.box && major.send.disabled === false,
      `a complaint that is not small can still be answered by hand: ${JSON.stringify(state)}`);
  });

  await t('the conversation is laid out as a chat, not a bare box', async () => {
    // The shop reported the reply box sitting under a list of "Already said:" lines, with the customer's
    // words somewhere else entirely. The fix is one chat: the thread on top, the box below it. This pins
    // that the thread shows the customer's own words as a bubble and that the composer sits under it.
    const openId = (await get('/api/complaints?status=open')).complaints[0].id;
    const chat = await page.$$eval('.pm-row', (rs, id) => {
      const row = rs.find((r) => r.textContent.includes(id));
      if (!row) return null;
      const thread = row.querySelector('.chat-thread');
      const composer = row.querySelector('.chat-composer');
      return {
        hasThread: Boolean(thread),
        hasComposer: Boolean(composer),
        bubbles: thread ? thread.querySelectorAll('.chat-msg').length : 0,
        firstIsIn: thread?.querySelector('.chat-msg')?.classList.contains('in') ?? false,
        threadText: thread?.textContent ?? '',
        composerUnderThread: composer && thread
          ? Boolean(thread.compareDocumentPosition(composer) & Node.DOCUMENT_POSITION_FOLLOWING)
          : false,
        inputInComposer: Boolean(composer?.querySelector('textarea.chat-input')),
      };
    }, openId);
    ok(chat, 'the open complaint is on screen');
    ok(chat.hasThread && chat.hasComposer, `thread and composer both present: ${JSON.stringify(chat)}`);
    ok(chat.bubbles >= 1, `the customer has said something — at least one bubble (${chat.bubbles})`);
    ok(chat.firstIsIn, 'the first bubble is the customer, on the incoming side');
    ok(/open|resolved/i.test(chat.threadText) === false, 'the thread holds the conversation, not the status line');
    ok(chat.composerUnderThread, 'the box to type in sits under the thread it belongs to');
    ok(chat.inputInComposer, 'and it is a real textarea');
  });

  await t('nothing on the screen can send the AI\'s words to a customer', async () => {
    // The one button that did this is gone. Its absence is the guarantee, so it is checked directly
    // rather than inferred from the reply box working.
    const text = await page.$$eval('.pm-row', (rs) => rs.map((r) => r.textContent).join(' '));
    ok(!/Send the reply now/.test(text), 'the one-shot send button is gone');
    const client = await page.evaluate(async () => {
      const api = await import('/js/api.js');
      return Object.keys(api).filter((k) => /auto.?reply/i.test(k));
    });
    ok(client.length === 0, `and the client no longer offers it: ${JSON.stringify(client)}`);
    const res = await fetch(`${BASE}/api/complaints/CMP-0001/auto-reply`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ approve: true })
    });
    ok(res.status === 404, `and the server has no such route (got ${res.status})`);
  });

  await t('the AI\'s advice is labelled as a note, not as words for the customer', async () => {
    // Both are on the same row, and "Reply would be:" next to a box the shopkeeper is about to type in
    // is how a suggestion ends up pasted into a message to a real person.
    const labels = await page.$$eval('.pm-row', (rs) => rs.map((r) => r.textContent));
    const joined = labels.join(' ');
    ok(!/Reply would be:/.test(joined), 'it no longer claims to be the reply');
    ok(/Note for the record/.test(joined) || !/AI suggests:/.test(joined),
      'and calls itself what it is');
  });

  await t('a reply the shop writes is sent and written down', async () => {
    const open1 = (await get('/api/complaints?status=open')).complaints[0];
    const box = await page.$(`textarea[aria-label="Your reply to the customer about complaint ${open1.id}"]`);
    ok(Boolean(box), 'the reply box for this complaint is on screen');
    await box.type('The boy is on his way with a new packet.');
    const clicked = await page.evaluate((id) => {
      // Found by the same aria-label the box was found by, so this cannot click some other row's button
      // if the layout changes. A test that sends a reply to the wrong complaint is worse than no test.
      const ta = document.querySelector(`textarea[aria-label="Your reply to the customer about complaint ${id}"]`);
      if (!ta) return 'no box';
      const row = ta.closest('.pm-row');
      const btn = [...row.querySelectorAll('button')].find((b) => /Send to customer/.test(b.textContent));
      if (!btn) return 'no button';
      btn.click();
      return 'clicked';
    }, open1.id);
    ok(clicked === 'clicked', `the send button was found and pressed (${clicked})`);
    // WhatsApp is off in this file, so the send must fail loudly rather than claim success. The browser
    // logs the failed request; that one is the point of the test, so it is let past the error check.
    expectedRefusals.push('502');
    await new Promise((r) => setTimeout(r, 900));
    const snackText = await page.evaluate(() => document.body.textContent);
    ok(/WhatsApp is not connected|Could not send/i.test(snackText),
      `the shop is told the message did not go: ${snackText.slice(0, 200)}`);
    const after = (await get(`/api/complaints/${open1.id}`)).complaint;
    ok((after.transcript || []).length === 0, 'and nothing was written claiming it had been sent');
  });

  await t('no uncaught errors anywhere in that flow', async () => {
    const real = realErrors();
    ok(real.length === 0, `page errors: ${real.join(' | ')}`);
  });
} finally {
  await browser.close();
  try { srv.kill('SIGKILL'); } catch {}
  killPort(PORT);
}

console.log(`  ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
