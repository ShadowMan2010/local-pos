/* Reading a photo, a slip or a sentence into draft product records.
 *
 * The model's answer is untrusted text, and the parts that go wrong quietly are the numeric ones: a
 * price read as "Rs 55/-", a quantity read as negative, a name with the price glued onto it. Every one of
 * those is checked here, with no network and no key, because a draft the shop has to notice and correct
 * is the failure this flow exists to avoid. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  cleanProductDraft, parseProductDrafts, parseProductFromText, parseSlip,
  buildScanProductsPrompt, buildProductFromTextPrompt, buildSlipPrompt
} from '../catalog-ai.js';

test('a draft needs a name and nothing else', () => {
  assert.equal(cleanProductDraft(null), null);
  assert.equal(cleanProductDraft({ name: '   ' }), null);
  assert.equal(cleanProductDraft({ price: 50 }), null);
  assert.equal(cleanProductDraft({ name: 'Sugar' }).name, 'Sugar');
});

test('a price written like a shop writes it becomes a number, and a minus is not money', () => {
  assert.equal(cleanProductDraft({ name: 'Rice', price: 'Rs 55/-' }).price, 55);
  assert.equal(cleanProductDraft({ name: 'Rice', rate: '1,250.50' }).price, 1250.5);
  assert.equal(cleanProductDraft({ name: 'Rice', price: -20 }).price, 0);
  assert.equal(cleanProductDraft({ name: 'Rice', price: 'free' }).price, undefined);
});

test('an unread price is left out rather than saved as zero', () => {
  const d = cleanProductDraft({ name: 'Milk packet' });
  assert.equal('price' in d, false);
  assert.equal('cost' in d, false);
  assert.equal('stock' in d, false);
});

test('loose goods are marked sold by weight from the unit', () => {
  assert.equal(cleanProductDraft({ name: 'Onion', unit: 'kg' }).soldByWeight, true);
  assert.equal(cleanProductDraft({ name: 'Onion', unit: 'kilograms' }).soldByWeight, true);
  assert.equal(cleanProductDraft({ name: 'Biscuit', unit: 'packet' }).soldByWeight, false);
  assert.equal(cleanProductDraft({ name: 'Biscuit', soldByWeight: true, unit: 'pcs' }).soldByWeight, true);
});

test('a long name, a long SKU and an emoji are clipped, not rejected', () => {
  const d = cleanProductDraft({ name: 'x'.repeat(200), sku: 'y'.repeat(200), emoji: '🍚🍛🥘🍲🥗🍜' });
  assert.equal(Array.from(d.name).length, 80);
  assert.equal(Array.from(d.sku).length, 40);
  assert.equal(Array.from(d.emoji).length, 4);
});

test('a list of products is read from an array or a wrapped object, deduped, and capped', () => {
  assert.deepEqual(parseProductDrafts('[{"name":"A"},{"name":"B"}]').map((d) => d.name), ['A', 'B']);
  assert.deepEqual(parseProductDrafts('{"products":[{"name":"A"}]}').map((d) => d.name), ['A']);
  // The same item twice is one item; a junk row with no name is dropped.
  assert.deepEqual(parseProductDrafts('[{"name":"A"},{"name":"a"},{"price":9}]').map((d) => d.name), ['A']);
  const many = Array.from({ length: 100 }, (_, i) => ({ name: `P${i}` }));
  assert.equal(parseProductDrafts(JSON.stringify(many), { max: 5 }).length, 5);
});

test('a fenced or chatty answer still yields products, and garbage yields an empty list', () => {
  assert.deepEqual(parseProductDrafts('```json\n[{"name":"Tea"}]\n```').map((d) => d.name), ['Tea']);
  assert.deepEqual(parseProductDrafts('Here are the items: [{"name":"Tea"}]').map((d) => d.name), ['Tea']);
  assert.deepEqual(parseProductDrafts('I could not read the photo.'), []);
});

test('one sentence becomes one product', () => {
  const d = parseProductFromText('{"name":"Amul Butter","price":"56","unit":"100g packet"}');
  assert.equal(d.name, 'Amul Butter');
  assert.equal(d.price, 56);
  assert.equal(parseProductFromText('[{"name":"Sugar","unit":"kg"}]').soldByWeight, true);
  assert.equal(parseProductFromText('nothing readable here'), null);
});

test('a slip keeps its rows, its written total and its kind', () => {
  const s = parseSlip(JSON.stringify({
    kind: 'invoice',
    supplier: 'Das Traders',
    date: '15-10-2026',
    total: 540,
    items: [
      { name: 'Sugar', qty: '2', unit: 'kg', price: 90 },
      { name: 'Rice', qty: '0.5', unit: 'kg', price: 450 },
      { qty: 1, price: 5 },
      { name: '', qty: 3 }
    ]
  }));
  assert.equal(s.kind, 'invoice');
  assert.equal(s.supplier, 'Das Traders');
  assert.equal(s.total, 540);
  assert.deepEqual(s.items.map((i) => i.name), ['Sugar', 'Rice']);
  assert.equal(s.items[0].qty, 2);
  assert.equal(s.items[1].price, 450);
});

test('the written total is quoted, never recomputed from the rows', () => {
  // The rows add up to 90 but the slip says 100, which is exactly the mismatch a person needs to see.
  const s = parseSlip('{"total":100,"items":[{"name":"A","price":90}]}');
  assert.equal(s.total, 100);
});

test('an unreadable slip field is dropped, and a bad kind falls back to unknown', () => {
  const s = parseSlip('{"kind":"receipt","items":[]}');
  assert.equal(s.kind, 'unknown');
  assert.equal(s.total, null);
  assert.deepEqual(s.items, []);
  assert.equal(parseSlip('not json at all'), null);
});

test('every prompt tells the model not to invent a price and to answer in plain JSON', () => {
  for (const p of [buildScanProductsPrompt({ storeName: 'Test Bazaar' }), buildProductFromTextPrompt({}), buildSlipPrompt({})]) {
    assert.match(p, /JSON only/);
    assert.match(p, /invent/i);
    assert.match(p, /No markdown/);
  }
});

test('the scan prompt reuses the shop\'s own categories when it is given some', () => {
  const p = buildScanProductsPrompt({ categories: ['Dairy', 'Snacks'] });
  assert.match(p, /Dairy, Snacks/);
  assert.equal(/already used/.test(buildScanProductsPrompt({})), false);
});
