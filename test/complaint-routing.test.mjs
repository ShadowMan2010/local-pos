// The complaint feature has to be reachable from the chat, not just correct in its helpers.
//
// This exists because a customer wrote "complain" to the live bot and was told it did not understand
// the message, and every test still passed. The reason: the tests exercised the helper functions
// (mentionsComplaint, complaintDetail) and never the decision that connects an incoming message to
// them, so the feature could be completely unreachable and the suite would be green.
//
// These tests call complaintRoute() — the same function whatsapp.js calls — so the routing and the
// tests cannot drift apart. They also pin the menu and help wording, because a feature nobody is told
// about is the same as a feature that does not exist.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  complaintRoute, mentionsComplaint, complaintDetail,
  buildCatalogText, buildHelpText, buildNotUnderstoodText, buildComplainLaterText
} from '../whatsapp-bot.js';

test('"complain" reaches the complaint flow instead of the did-not-understand fallback', () => {
  // The exact message that failed in production.
  assert.equal(complaintRoute('complain', 'idle').kind, 'ask',
    'a bare "complain" must ask what happened, never fall through to "did not understand"');
  assert.equal(complaintRoute('Complain', 'idle').kind, 'ask', 'case does not matter');
  assert.equal(complaintRoute('  complain  ', 'idle').kind, 'ask', 'nor does whitespace');
  assert.equal(complaintRoute('complain', 'cart').kind, 'ask', 'nor which non-order step they are on');
});

test('a complaint that says what happened is filed with the customer words intact', () => {
  const r = complaintRoute('the rice packet was torn', 'idle');
  assert.equal(r.kind, 'file');
  assert.equal(r.detail, 'the rice packet was torn', 'stored exactly as written, not reworded');
  assert.equal(complaintRoute('wrong item delivered', 'idle').detail, 'wrong item delivered');
  assert.equal(complaintRoute('I want a refund for the broken oil', 'idle').detail,
    'I want a refund for the broken oil');
});

test('Bengali complaints are recognised and keep their script', () => {
  assert.equal(complaintRoute('অভিযোগ', 'idle').kind, 'ask', 'the Bengali word for complaint works');
  const r = complaintRoute('চালের প্যাকেট ছিঁড়া', 'idle');
  assert.equal(r.kind, 'file');
  assert.equal(r.detail, 'চালের প্যাকেট ছিঁড়া', 'Bengali text survives intact, combining marks and all');
  assert.equal(complaintRoute('ডেলিভারি আসেনি', 'idle').kind, 'file', 'a described problem is filed');
  // "there is a problem" says something went wrong but not what, in either language.
  assert.equal(complaintRoute('সমস্যা হয়েছে', 'idle').kind, 'ask', 'a vague Bengali complaint is asked about');
});

test('a complaint raised mid-order is held, not parsed as items and not dropped', () => {
  // The old behaviour ignored complaints in these three steps, so at the payment screen
  // "the packet was torn" was read as an order line — the words became an order for a torn packet.
  for (const step of ['confirming', 'naming', 'payment']) {
    assert.equal(complaintRoute('the packet was torn', step).kind, 'later',
      `held at the ${step} step`);
  }
  // And it is genuinely handled rather than falling through to the order parser.
  assert.equal(complaintRoute('the packet was torn', 'cart').kind, 'file', 'still works outside those steps');
});

test('ordinary ordering is never mistaken for a complaint', () => {
  for (const text of ['menu', '1,1,3', '2x1.5', 'yes', 'cash', 'upi', 'hi', '1234', 'rice', 'name Rahim']) {
    assert.equal(complaintRoute(text, 'idle').kind, 'none', `"${text}" is not a complaint`);
  }
});

test('the menu tells the customer complaints exist', () => {
  const menu = buildCatalogText('Corner Store', [{ name: 'Rice 5kg', price: 250, stock: 5, active: true }]);
  assert.match(menu, /complain/i, 'the item list mentions complaining');
  assert.match(menu, /help/i, 'and mentions help');
  assert.match(menu, /Rice 5kg/, 'and still shows the items');
});

test('"help" gives a real help screen, not the did-not-understand message', () => {
  const help = buildHelpText('Corner Store');
  // These were the same string, so typing "help" told the customer the bot had not understood them.
  assert.notEqual(help, buildNotUnderstoodText(), 'help and the fallback are different messages');
  assert.match(help, /complain/i, 'help lists the complaint command');
  assert.match(help, /menu/i, 'and the menu command');
  assert.match(help, /Corner Store/, 'and is personalised with the shop name');
  assert.doesNotMatch(help, /did not understand/i, 'and no longer claims confusion');
});

test('the mid-order complaint wording asks them to finish rather than ignoring them', () => {
  const msg = buildComplainLaterText();
  assert.match(msg, /finish paying first/i, 'says what to do next');
  assert.ok(msg.length > 20, 'and is a real sentence, not a stub');
});

test('a vague complaint is asked about rather than filed empty', () => {
  for (const text of ['complaint', 'i have a problem', 'refund', 'damaged']) {
    assert.equal(complaintRoute(text, 'idle').kind, 'ask', `"${text}" needs a follow-up question`);
  }
  assert.equal(complaintDetail('complaint'), null);
  assert.ok(mentionsComplaint('complaint'), 'but it is still recognised as a complaint');
});
