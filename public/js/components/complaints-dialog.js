// Customer complaints. They arrive by WhatsApp, and this is the screen that clears them: something is
// open, somebody has to deal with it, and the only record of what was done is the note left here. So a
// complaint cannot be closed without saying what happened — an unexplained "resolved" is how a shop
// ends up arguing with the same customer next week about something already settled.
//
// The note is the point of the screen. It is why this is not just a delete button.
import { h, icon, iconBtn, snack, runBusy } from '../ui.js';
import * as api from '../api.js';

const when = (iso) => new Date(iso).toLocaleString('en-IN', {
  day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit'
});

/** How a complaint reached us, in the shop's terms rather than the code's. */
const SOURCE = { whatsapp: 'WhatsApp', staff: 'Logged at the counter' };

/**
 * How serious a complaint is, in the shop's words.
 *
 * "Small" is the only one that lets the till answer the customer on its own, and the label says so
 * plainly rather than leaving it to be discovered. A shopkeeper choosing it should know exactly what they
 * are authorising, because that is the one choice here that can speak to a customer with nobody having read
 * the words. Replying by hand, in the box further down, needs no severity at all.
 */
const SEVERITY = {
  minor: 'Small — let the shop answer this one',
  major: 'Normal — I will answer this myself',
  serious: 'Serious — needs a person straight away'
};

/**
 * Where the conversation on a complaint has got to, in the shop's words.
 *
 * The important one is "went-quiet": the customer said thanks and stopped, which is not the same as the
 * problem being sorted. Saying so on the screen is the difference between a closed book and a complaint
 * that quietly rots because everyone read "no more messages" as "handled".
 */
const CONVERSATION = {
  'awaiting-shop': 'Nobody has judged this one yet — mark it "Small" if the till may answer it',
  'active': 'The till may answer this one',
  'went-quiet': 'The customer stopped writing. Nobody has fixed this yet',
  'taken-over': 'You are answering this one yourself',
  'escalated': 'A person was asked to take over'
};

/** Who said each line. 'staff' is the shopkeeper, and it is the one that matters most to read. */
const SAID_BY = { customer: 'Customer', assistant: 'Till', staff: 'You' };

/**
 * The conversation as a chat: the customer's own words first, then every line since, oldest at the top.
 *
 * The complaint's opening message is stored on the complaint itself rather than in the transcript,
 * because it arrived before there was a conversation to append to — so it is the first bubble here, and
 * a customer reading this screen sees the same thread they have on their phone.
 */
function chatThread(c) {
  const lines = [];
  if (c.text) lines.push({ from: 'customer', text: c.text, at: c.createdAt });
  for (const l of (c.transcript || [])) {
    // The opening line is sometimes also the first transcript entry, depending on which path recorded
    // it. Dropped when identical to the bubble above, so the customer's words are never shown twice.
    const last = lines[lines.length - 1];
    if (l.from === 'customer' && last?.from === 'customer' && last.text === l.text) continue;
    lines.push(l);
  }
  return h('div', { class: 'chat-thread', role: 'log', 'aria-label': `Conversation about ${c.id}` },
    ...(lines.length
      ? lines.map((l) => {
          const mine = l.from === 'staff';
          return h('div', {
            class: `chat-msg ${mine ? 'out' : 'in'}${l.from === 'assistant' ? ' till' : ''}`
          },
            h('div', { class: 'chat-who' }, SAID_BY[l.from] || l.from),
            h('div', { class: 'chat-text' }, l.text),
            l.at ? h('div', { class: 'chat-at' }, when(l.at)) : null);
        })
      : [h('div', { class: 'chat-empty body-s muted' },
          'Nothing said yet. The box below sends to the customer on WhatsApp.')]));
}

/**
 * The box the next line is typed into, laid out like the chat it belongs to.
 *
 * Enter sends and Shift+Enter is a new line, the way every chat the shopkeeper already uses behaves. The
 * words go out exactly as typed, and sending does not resolve the complaint — being answered and being
 * helped are two different things.
 */
function chatComposer(c, { onSent }) {
  const box = h('textarea', {
    class: 'chat-input', rows: '1', maxlength: '1000',
    placeholder: 'Type your reply…',
    'aria-label': `Your reply to the customer about complaint ${c.id}`
  });
  const send = h('button', { type: 'button', class: 'btn btn-filled chat-send' }, 'Send to customer');
  const composer = h('div', { class: 'chat-composer' }, box, send);

  // Grows with what is typed, up to a point, so a two-line answer is not typed through a slot.
  box.addEventListener('input', () => {
    box.style.height = 'auto';
    box.style.height = `${Math.min(box.scrollHeight, 120)}px`;
  });
  send.addEventListener('click', async () => {
    const text = box.value.trim();
    if (!text) { box.focus(); return; }
    send.disabled = true;
    send.textContent = 'Sending…';
    try {
      await api.sendComplaintReply(c.id, text);
      box.value = '';
      box.style.height = 'auto';
      snack('Reply sent to the customer', 3000, 'success');
      onSent?.();
    } catch (err) {
      // The server's refusal reason is the point. "WhatsApp is not connected" and "write something first"
      // need different actions, and a generic failure would hide both.
      snack(err.message, 7000, 'error');
      send.disabled = false;
      send.textContent = 'Send to customer';
    }
  });
  box.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send.click(); }
  });
  return composer;
}

export function openComplaintsDialog({ onChange } = {}) {
  const dlg = h('dialog', { class: 'm3-dialog products-dialog' });
  const list = h('ul', { class: 'pm-list' });
  const sub = h('p', { class: 'field-hint', style: 'margin:0 16px 12px' }, 'Loading…');

  /** The button pattern used across the till: show the M3 loading indicator, never lose the error. */
  const action = (label, title, fn) => {
    const btn = h('button', { type: 'button', class: 'btn btn-text', title, onclick: async () => {
      await runBusy(btn, async () => {
        try { await fn(); } catch (err) { snack(err.message, 6000, 'error'); }
      });
    } }, label);
    return btn;
  };

  const row = (c) => {
    const open = c.status === 'open';
    const who = c.customerName || c.phone || 'Walk-in customer';

    // Built first and filled in after, so the Resolve handler can add its note box here without
    // referring to a variable that does not exist yet.
    const actions = h('div', { class: 'wa-actions' });

    /* ---- how serious, and may the shop answer it itself ---- */
    //
    // This is the control that decides whether the till may speak to this customer at all, so it sits
    // above the actions rather than buried under them. It only appears while the complaint is open: once
    // it is resolved, how serious it turned out to be is history, and a dropdown that changes a closed
    // record is just a way to get it wrong.
    let severity = SEVERITY[c.severity] ? c.severity : 'major';
    if (open) {
      const pick = h('select', {
        class: '', 'aria-label': `How serious complaint ${c.id} is`,
        onchange: async (e) => {
          const wanted = e.target.value;
          // Changed back immediately, so a refusal leaves the screen showing the truth rather than a
          // value the server rejected and the browser still believes in.
          e.target.value = severity;
          e.target.disabled = true;
          try {
            await api.setComplaintSeverity(c.id, wanted);
            severity = wanted;
            e.target.value = wanted;
            load();
          } catch (err) {
            snack(err.message, 6000, 'error');
          } finally {
            e.target.disabled = false;
          }
        }
      }, Object.entries(SEVERITY).map(([v, label]) =>
        h('option', { value: v, selected: v === severity }, label)));
      actions.append(h('div', { class: 'code-row severity-row' },
        h('span', { class: 'body-s muted' }, 'How serious'), pick));
    }

    // Where the conversation stands, said plainly. On a screen whose job is clearing a backlog, the one
    // line a shopkeeper should never have to guess at is whether anyone has answered this person yet.
    if (open && CONVERSATION[c.aiState]) {
      actions.append(h('div', { class: 'body-s muted', style: 'margin:2px 0' },
        c.aiState === 'escalated' && c.escalationText
          ? `${CONVERSATION[c.aiState]} — ${c.escalationText}`
          : CONVERSATION[c.aiState]));
    }

    /* ---- what the AI advised, kept separate from what anybody can send ---- */
    //
    // The advice is here because it is useful, not because it can be sent. There is no button that sends
    // it. A shopkeeper who wants the customer to hear something reads it, then types their own answer in
    // the box below — which is what they would do with their own phone anyway, and the only version where
    // somebody actually decided the words.
    const aiBox = h('div', { class: 'code-row ai-row' });
    const showAi = (sug) => {
      aiBox.replaceChildren();
      if (sug) {
        aiBox.append(
          h('div', { class: 'body-s' }, `AI suggests: ${sug.suggestion}`),
          // Labelled for what it is, because "Reply would be:" on a screen that also has a reply box is
          // exactly the sort of line somebody copies by mistake into a message to a customer.
          h('div', { class: 'body-s muted', style: 'margin-top:2px' },
            `Note for the record: “${sug.noteDraft}”`),
          sug.needsHuman
            ? h('div', { class: 'body-s', style: 'color:var(--md-error);margin-top:2px' },
                'The AI says a person should handle this one')
            : null);
      }
      aiBox.append(h('div', { class: 'wa-actions' },
        action(sug ? 'Ask the AI again' : 'Ask the AI what to do', 'Get advice on this complaint', async () => {
          const r = await api.suggestComplaint(c.id);
          if (!r.suggestion) snack(r.reason || 'No AI available — sort this one out by hand', 5000);
          else { showAi(r.suggestion); snack('AI advice ready to read', 2500, 'success'); }
        })));
    };
    actions.append(aiBox);
    if (open) showAi(c.suggestion);

    /* ---- the conversation, as a chat ---- */
    //
    // This used to be a bare textarea under a list of "Already said:" lines, which split the job in two:
    // reading what the customer wrote was one place, answering it was another. Now the thread and the box
    // are one screen — what was said, oldest at the top, and the box you type the next line into, exactly
    // like the chat app the customer is using. Anything sent goes to them on WhatsApp as typed, and does
    // not resolve the complaint: being answered and being helped are two different things.
    actions.append(chatThread(c));
    if (open) actions.append(chatComposer(c, { onSent: load }));

    // Resolving opens an inline note box rather than a window.prompt: a prompt one-liner is a bad
    // place to ask for the one piece of information the whole screen exists to record.
    let noteBox = null;
    const resolveBtn = action('Resolve', 'Close this complaint and record what was done', async () => {
      const note = h('input', {
        class: '', type: 'text', maxlength: '300', placeholder: ' ',
        'aria-label': `What was done about complaint ${c.id}`
      });
      // .m3-field is what actually styles a text box in this app, and it wants the label as a sibling
      // after the input (the CSS floats it on focus with `input:focus + span`).
      const noteField = h('div', { class: 'm3-field' }, note, h('span', {}, 'What did you do?'));
      const send = h('button', { type: 'button', class: 'btn btn-filled' }, 'Save');
      const cancel = h('button', { type: 'button', class: 'btn btn-text' }, 'Cancel');
      // note-row is a stable hook for this box, so it can be found without guessing: the page has
      // other .m3-field inputs on it, and matching one of those instead would type a note into the
      // wrong box entirely.
      noteBox = h('div', { class: 'code-row note-row' }, noteField, send, cancel);
      note.focus();

      const close = () => { noteBox?.remove(); noteBox = null; };
      cancel.onclick = close;
      note.onkeydown = (e) => { if (e.key === 'Enter') send.click(); if (e.key === 'Escape') close(); };
      send.onclick = async () => {
        const text = note.value.trim();
        // Required on purpose. The complaint can be reopened, but a blank "resolved" tells the next
        // person nothing about whether the customer was actually helped.
        if (text.length < 3) return snack('Write what was done, even one line — this is the record', 5000);
        send.disabled = true;
        send.textContent = 'Saving…';
        try {
          await api.resolveComplaint(c.id, text, 'shop');
          snack(`${c.id} marked resolved`, 2500, 'success');
          close();
          load();
        } catch (err) {
          snack(err.message, 6000, 'error');
          send.disabled = false;
          send.textContent = 'Save';
        }
      };
      actions.append(noteBox);
    });

    actions.append(
      open ? resolveBtn : action('Reopen', 'Put this back on the open list', async () => {
        await api.reopenComplaint(c.id);
        snack(`${c.id} reopened`, 2500, 'success');
        load();
      }),
      c.phone ? h('a', {
        class: 'btn btn-text', target: '_blank', rel: 'noopener',
        href: `https://wa.me/${String(c.phone).replace(/\D/g, '').replace(/^(0)/, '')}?text=${encodeURIComponent(`Regarding complaint ${c.id}: `)}`,
        title: `Open WhatsApp chat with ${c.phone} and the complaint reference ready to paste`
      }, 'Reply') : null);

    return h('li', { class: 'pm-row' },
      h('div', { class: 'thumb' }, icon(open ? 'report_problem' : 'task_alt')),
      h('div', { class: 'pm-main' },
        h('div', { class: 'title-s' }, who),
        h('div', { class: 'body-s', style: `color:${open ? 'var(--md-error)' : 'var(--md-primary)'}` },
          open ? 'Open — waiting to be sorted out' : 'Resolved'),
        // The customer's own words, never reworded: this is the thing that has to be read back to them.
        h('div', { class: 'body-s', style: 'margin-top:2px' }, `“${c.text}”`),
        h('div', { class: 'body-s muted' },
          `${c.id} · ${when(c.createdAt)} · ${SOURCE[c.source] || c.source}`),
        // The bill matters more than anything else here, because a replacement or a refund has to land
        // on the right bill and the customer will quote the number.
        c.billId
          ? h('div', { class: 'body-s muted' }, `Bill ${c.billId}${c.billTotal != null ? ` · ₹${c.billTotal}` : ''}`)
          : h('div', { class: 'body-s muted' }, 'No bill on file for this number'),
        // A WhatsApp complaint that is still open and has no reply of any kind is the one that turns
        // into a bad review, so it is called out on the row.
        c.source === 'whatsapp' && !c.repliedAt && open
          ? h('div', { class: 'body-s', style: 'color:var(--md-error);margin-top:2px' },
              'The customer has not been told anything yet — reply on WhatsApp')
          : null,
        c.note
          ? h('div', { class: 'body-s muted', style: 'margin-top:2px' },
              `Resolved: ${c.note}${c.handledBy ? ` (${c.handledBy})` : ''}${c.resolvedAt ? ` · ${when(c.resolvedAt)}` : ''}`)
          : null,
        // What the shop said in the customer's name, and when. An automatic reply is still the shop
        // speaking, so it is on the row rather than only in the audit log — this is the line somebody
        // reads when a customer rings to say they were told something they were not.
        c.autoSendSentAt
          ? h('div', { class: 'body-s muted', style: 'margin-top:2px' },
              `Answered automatically ${when(c.autoSendSentAt)}: “${c.autoSendText}”`)
          : null,
        actions));
  };

  async function load() {
    try {
      const { complaints, open } = await api.listComplaints();
      sub.textContent = open
        ? `${open} open${complaints.length - open ? ` · ${complaints.length - open} resolved` : ''}`
        : 'Nothing open.';
      // Told every time the list changes, so the badge on the app bar keeps step with the screen.
      onChange?.();
      if (!complaints.length) {
        return list.replaceChildren(h('li', { class: 'cart-empty' }, icon('check_circle'),
          h('p', { class: 'body-l' }, 'No complaints.'),
          h('p', { class: 'body-m' }, 'They arrive here when a customer sends a problem on WhatsApp.')));
      }
      // Open first, newest first inside each group. Whatever landed while the shop was busy is the
      // part that ages badly, so it is what you see when this opens.
      const sorted = [...complaints].sort((a, b) =>
        (a.status === b.status ? String(b.createdAt).localeCompare(String(a.createdAt)) : a.status === 'open' ? -1 : 1));
      list.replaceChildren(...sorted.map(row));
    } catch (err) {
      list.replaceChildren(h('li', { class: 'cart-empty' }, h('p', { class: 'body-m' }, err.message)));
    }
  }

  dlg.append(
    h('div', { class: 'dlg-head' },
      h('h2', { class: 'title-l' }, 'Complaints'), h('span', { class: 'spacer' }),
      iconBtn('close', () => dlg.close(), 'Close')),
    h('p', { class: 'field-hint', style: 'margin:0 16px 4px' },
      'Customers send a problem on WhatsApp and it lands here. Nothing is deleted — closing one ' +
      'records what was done, so there is an answer if the same complaint comes back.'),
    sub,
    list);
  dlg.addEventListener('close', () => dlg.remove());

  document.body.append(dlg);
  dlg.showModal();
  load();
}
