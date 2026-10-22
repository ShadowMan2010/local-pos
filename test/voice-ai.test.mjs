import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_STT_BASE,
  DEFAULT_STT_MODEL,
  resolveStt,
  buildTranscribeRequest,
  parseTranscription,
  buildVoiceOrderPrompt,
  parseVoiceOrder,
  buildVoiceOrderReply
} from '../voice-ai.js';

const shop = () => [
  { id: 'p1', sku: 'ONI', name: 'Onion', price: 40, stock: 10, soldByWeight: true, category: 'Vegetables' },
  { id: 'p2', sku: 'POT', name: 'Potato', price: 30, stock: 0, soldByWeight: true, category: 'Vegetables' },
  { id: 'p3', sku: 'AMU', name: 'Amul Butter 100g', price: 56, stock: 4, category: 'Dairy' },
  { id: 'p4', sku: 'DM1', name: 'Dairy Milk 40g', price: 40, stock: 20, category: 'Chocolate' },
  { id: 'p5', sku: 'KIT', name: 'KitKat 25g', price: 25, stock: 7, category: 'Chocolate' },
  { id: 'p6', sku: 'CHE', name: 'Paneer', price: 400, stock: 5, soldByWeight: true, category: 'Dairy' }
];

/* ---------- step 1: the local Whisper server ---------- */

test('STT is dark until the owner switches it on', () => {
  const s = resolveStt(undefined);
  assert.equal(s.configured, false);
  assert.equal(s.baseUrl, DEFAULT_STT_BASE);
  assert.equal(s.model, DEFAULT_STT_MODEL);
  assert.equal(resolveStt({ enabled: true }).configured, true);
});

test('a stored base URL and model are used, trimmed of a trailing slash', () => {
  const s = resolveStt({ enabled: true, baseUrl: 'http://127.0.0.1:9000/v1/', model: 'small' });
  assert.equal(s.baseUrl, 'http://127.0.0.1:9000/v1');
  assert.equal(s.model, 'small');
});

test('a transcription request is multipart and carries the audio bytes', () => {
  const audio = Buffer.from('OggS-not-really-opus');
  const req = buildTranscribeRequest({ stt: { enabled: true }, audio, mimeType: 'audio/ogg' });
  assert.equal(req.url, `${DEFAULT_STT_BASE}/v1/audio/transcriptions`);
  assert.match(req.headers['content-type'], /^multipart\/form-data; boundary=/);
  assert.ok(req.body.includes(audio), 'the audio bytes are in the body');
  assert.ok(req.body.includes(Buffer.from('name="model"')), 'the model field is present');
  assert.ok(req.body.includes(Buffer.from('voice.ogg')), 'the file is named .ogg');
  assert.ok(req.body.includes(Buffer.from(`--${req.boundary}--`)), 'the body is terminated');
});

test('a base URL that already ends in /v1 is not doubled', () => {
  const req = buildTranscribeRequest({ stt: { enabled: true, baseUrl: 'http://127.0.0.1:9000/v1' }, audio: Buffer.from('x') });
  assert.equal(req.url, 'http://127.0.0.1:9000/v1/audio/transcriptions');
});

test('an api key becomes a bearer header only when present', () => {
  const withKey = buildTranscribeRequest({ stt: { enabled: true, apiKey: 'k' }, audio: Buffer.from('x') });
  const noKey = buildTranscribeRequest({ stt: { enabled: true }, audio: Buffer.from('x') });
  assert.equal(withKey.headers.authorization, 'Bearer k');
  assert.equal(noKey.headers.authorization, undefined);
});

test('a language hint is sent only when one is given', () => {
  const withLang = buildTranscribeRequest({ stt: { enabled: true }, audio: Buffer.from('x'), language: 'bn' });
  const noLang = buildTranscribeRequest({ stt: { enabled: true }, audio: Buffer.from('x') });
  assert.ok(withLang.body.includes(Buffer.from('name="language"')));
  assert.ok(!noLang.body.includes(Buffer.from('name="language"')));
});

test('the transcript is read from an object, a JSON string, or a raw string', () => {
  assert.equal(parseTranscription({ text: '  two kilos of onion ' }), 'two kilos of onion');
  assert.equal(parseTranscription('{"text":"hello"}'), 'hello');
  assert.equal(parseTranscription('plain text'), 'plain text');
  assert.equal(parseTranscription({ nope: 1 }), '');
  assert.equal(parseTranscription(null), '');
});

/* ---------- step 2: transcript -> named items ---------- */

test('the prompt carries the store, the transcript and only in-stock products', () => {
  const prompt = buildVoiceOrderPrompt({ storeName: 'Sharma Store', products: shop(), transcript: 'two kilo pyaz and a butter' });
  assert.match(prompt, /Sharma Store/);
  assert.match(prompt, /two kilo pyaz and a butter/);
  assert.match(prompt, /Onion/);
  assert.match(prompt, /Amul Butter 100g/);
  assert.ok(!prompt.includes('Potato'), 'an out-of-stock item is not offered to the model');
});

test('an exact name match becomes an order line at the shop price', () => {
  const v = parseVoiceOrder(
    '{"lang":"en","items":[{"spoken":"butter","match":"Amul Butter 100g","qty":2}]}',
    { products: shop() }
  );
  assert.equal(v.ok, true);
  assert.equal(v.items.length, 1);
  assert.equal(v.items[0].name, 'Amul Butter 100g');
  assert.equal(v.items[0].qty, 2);
  assert.equal(v.items[0].price, 56, 'the price is the shop\'s, not the model\'s');
  assert.equal(v.total, 112);
});

test('a match is found even with different spacing or case', () => {
  const v = parseVoiceOrder(
    '{"items":[{"match":"amulbutter100g","qty":1}]}',
    { products: shop() }
  );
  assert.equal(v.items.length, 1);
  assert.equal(v.items[0].sku, 'AMU');
});

test('an item sold by weight keeps a fractional kilogram quantity', () => {
  const v = parseVoiceOrder(
    '{"items":[{"spoken":"pyaz","match":"Onion","qty":1.5}]}',
    { products: shop() }
  );
  assert.equal(v.items[0].isWeight, true);
  assert.equal(v.items[0].weightKg, 1.5);
  assert.equal(v.items[0].pricePerKg, 40);
  assert.equal(v.total, 60);
});

test('a name that matches nothing on the shelf becomes unavailable, not a line', () => {
  const v = parseVoiceOrder(
    '{"items":[{"spoken":"ice cream","match":"Ice Cream"}],"unavailable":[{"spoken":"ice cream","alternatives":["Dairy Milk 40g","KitKat 25g"]}]}',
    { products: shop() }
  );
  assert.equal(v.items.length, 0);
  assert.equal(v.unavailable.length, 1);
  assert.equal(v.unavailable[0].spoken, 'ice cream');
  assert.deepEqual(v.unavailable[0].alternatives.map((a) => a.name), ['Dairy Milk 40g', 'KitKat 25g']);
  assert.equal(v.total, 0);
});

test('an out-of-stock product cannot be ordered and is offered as unavailable', () => {
  const v = parseVoiceOrder(
    '{"items":[{"spoken":"aloo","match":"Potato","qty":2}],"unavailable":[{"spoken":"aloo","alternatives":[]}]}',
    { products: shop() }
  );
  assert.equal(v.items.length, 0, 'Potato has no stock');
  assert.equal(v.unavailable.length, 1);
});

test('an alternative that is out of stock or invented is dropped', () => {
  const v = parseVoiceOrder(
    '{"unavailable":[{"spoken":"chocolate","alternatives":["Potato","Unicorn Bar","Dairy Milk 40g"]}]}',
    { products: shop() }
  );
  assert.deepEqual(v.unavailable[0].alternatives.map((a) => a.name), ['Dairy Milk 40g']);
});

test('asking for more than the shelf holds trims the line and flags it', () => {
  const v = parseVoiceOrder(
    '{"items":[{"spoken":"butter","match":"Amul Butter 100g","qty":10}]}',
    { products: shop() }
  );
  assert.equal(v.items[0].qty, 4, 'only the 4 in stock');
  assert.equal(v.items[0].trimmedFrom, 10);
  assert.equal(v.total, 224);
});

test('a quantity of zero or a fraction of a piece falls back to one', () => {
  const v = parseVoiceOrder(
    '{"items":[{"match":"Amul Butter 100g","qty":0},{"match":"Dairy Milk 40g","qty":"two"}]}',
    { products: shop() }
  );
  assert.deepEqual(v.items.map((i) => i.qty), [1, 1]);
});

test('the same product asked twice is one line', () => {
  const v = parseVoiceOrder(
    '{"items":[{"match":"Onion","qty":1},{"match":"Onion","qty":2}]}',
    { products: shop() }
  );
  assert.equal(v.items.length, 1);
});

test('an unknown language falls back to English', () => {
  assert.equal(parseVoiceOrder('{"items":[]}', { products: shop() }).lang, 'en');
  assert.equal(parseVoiceOrder('{"lang":"hi","items":[]}', { products: shop() }).lang, 'hi');
});

test('unreadable model output is an error, not an empty order', () => {
  assert.equal(parseVoiceOrder('I could not understand', { products: shop() }).ok, false);
  assert.equal(parseVoiceOrder('', { products: shop() }).ok, false);
});

/* ---------- step 3: the reply ---------- */

test('the reply lists the confirmed items, the total, and asks to confirm', () => {
  const v = parseVoiceOrder('{"items":[{"match":"Dairy Milk 40g","qty":2}]}', { products: shop() });
  const reply = buildVoiceOrderReply({ storeName: 'Sharma Store', verdict: v });
  assert.match(reply, /Sharma Store/);
  assert.match(reply, /2 x Dairy Milk 40g/);
  assert.match(reply, /₹80\.00/);
  assert.match(reply, /write "yes"/i);
});

test('the reply names what is missing and the substitutes', () => {
  const v = parseVoiceOrder(
    '{"unavailable":[{"spoken":"ice cream","alternatives":["Dairy Milk 40g"]}]}',
    { products: shop() }
  );
  const reply = buildVoiceOrderReply({ verdict: v });
  assert.match(reply, /ice cream/);
  assert.match(reply, /Dairy Milk 40g/);
  assert.match(reply, /don't have/);
});

test('a Bengali voice note is recognised but answered in English', () => {
  const v = parseVoiceOrder('{"lang":"bn","items":[{"match":"Onion","qty":1}]}', { products: shop() });
  assert.equal(v.lang, 'bn', 'the language is still detected');
  const reply = buildVoiceOrderReply({ verdict: v });
  assert.match(reply, /Total/);
  assert.match(reply, /yes/);
  assert.doesNotMatch(reply, /[\u0980-\u09FF]/, 'the reply carries no Bengali');
});

test('a trimmed line is explained to the customer', () => {
  const v = parseVoiceOrder('{"items":[{"match":"Amul Butter 100g","qty":10}]}', { products: shop() });
  const reply = buildVoiceOrderReply({ verdict: v });
  assert.match(reply, /only 4 are left/);
});

test('nothing understood is said plainly rather than as an empty order', () => {
  const v = parseVoiceOrder('{"items":[],"unavailable":[]}', { products: shop() });
  assert.equal(v.ok, true);
  assert.equal(buildVoiceOrderReply({ verdict: v }), "Sorry, I couldn't make out any items. Please send the voice note again, or write your item numbers.");
});

test('a note that matched nothing but named missing items is not offered for "yes"', () => {
  const v = parseVoiceOrder('{"unavailable":[{"spoken":"ice cream"}]}', { products: shop() });
  const reply = buildVoiceOrderReply({ verdict: v });
  assert.match(reply, /ice cream/);
  assert.doesNotMatch(reply, /write "yes"/i);
  assert.match(reply, /another voice note/i);
});
