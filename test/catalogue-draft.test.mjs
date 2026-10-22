import assert from 'node:assert/strict';
import { test } from 'node:test';

import { suggestSku } from '../public/js/catalogue-draft.js';

test('a SKU is derived from the name, letters and digits only', () => {
  assert.equal(suggestSku('Amul Butter 100g'), 'AMULBUTTER');
  assert.equal(suggestSku('Surf Excel 1kg'), 'SURFEXCEL1');
  assert.equal(suggestSku('  rice  '), 'RICE');
});

test('a name that yields nothing falls back rather than producing an empty SKU', () => {
  assert.equal(suggestSku('🍚'), 'ITEM');
  assert.equal(suggestSku(''), 'ITEM');
  assert.equal(suggestSku(null), 'ITEM');
  assert.equal(suggestSku('🍚', new Set(), 'PROD'), 'PROD');
});

test('a SKU already in use is numbered until it is free', () => {
  assert.equal(suggestSku('Rice', new Set(['RICE'])), 'RICE-2');
  assert.equal(suggestSku('Rice', new Set(['RICE', 'RICE-2'])), 'RICE-3');
  assert.equal(suggestSku('Rice', new Set(['RICE', 'RICE-2', 'RICE-3'])), 'RICE-4');
});

test('the taken set is not mutated, so numbering two drafts in a row is the caller\'s job', () => {
  const taken = new Set();
  const first = suggestSku('Rice', taken);
  taken.add(first);
  const second = suggestSku('Rice', taken);
  assert.equal(first, 'RICE');
  assert.equal(second, 'RICE-2');
});
