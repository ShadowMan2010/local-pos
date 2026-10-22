// Turning an AI product draft into something the product endpoints will accept.
//
// The draft comes from catalog-ai.js and may be missing the one field every product must have: a SKU.
// A shelf photo rarely shows a barcode, so one is derived from the name. This is pure and kept out of
// the dialog so the part that can go wrong quietly — two products ending up with the same SKU, which
// the server rejects — is tested without a browser.

/**
 * A short, readable SKU from a product name, made unique against `taken`.
 *
 * Only A–Z and 0–9 survive, so "Amul Butter 100g" becomes "AMULBUTTER". A name that yields nothing
 * (an emoji-only or non-Latin name left untransliterated) falls back to `fallback`, which still gets
 * the same uniqueness suffix. `taken` is read, never mutated — the caller decides what to record, so
 * numbering two drafts in a row still works.
 *
 * @param {string} name the product name
 * @param {Set<string>} taken SKUs already in use (existing products and earlier drafts)
 * @param {string} fallback used when the name has no usable characters
 */
export function suggestSku(name, taken = new Set(), fallback = 'ITEM') {
  const base = (String(name || '').toUpperCase().match(/[A-Z0-9]+/g) || []).join('').slice(0, 10) || fallback;
  if (!taken.has(base)) return base;
  let n = 2;
  while (taken.has(`${base}-${n}`)) n += 1;
  return `${base}-${n}`;
}
