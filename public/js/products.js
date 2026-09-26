// Product catalog. The products live in data/products.json on the POS server; this module keeps a
// copy in memory for the screen and talks to the server for every change.
import * as api from './api.js';

let products = [];

const normalize = (p) => ({
  id: p.id,
  sku: String(p.sku ?? ''),
  name: String(p.name ?? 'Unnamed'),
  price: Number(p.price) || 0,
  stock: Number(p.stock) || 0,
  category: p.category || '',
  image: p.image || '',
  emoji: p.emoji || '',
  soldByWeight: Boolean(p.soldByWeight) // true: price is per kg, stock is kg — sold via the weighing station
});

/** Replaces the in-memory list (same array object, so screens holding it stay current). */
function setAll(list) {
  products.length = 0;
  products.push(...list.map(normalize));
  return products;
}

export async function loadProducts() {
  const { products: list } = await api.listProducts();
  return setAll(list);
}

export const getProducts = () => products;
export const findBySku = (sku) => products.find((p) => p.sku === String(sku).trim());

/** Load the 10 sample items (only allowed while the catalogue is empty). */
export async function addSampleProducts() {
  const { products: list } = await api.loadDemoProducts();
  return setAll(list);
}

/** One-time copy of the products that were saved in Firebase before. -> { imported, skipped } */
export async function importFromFirebase() {
  const { imported, skipped, products: list } = await api.importFirebaseProducts();
  setAll(list);
  return { imported, skipped };
}

/** Create (no id) or update (with id). The server checks the fields again and rejects a repeated SKU. */
export async function saveProduct(input) {
  const p = normalize(input);
  if (!p.sku || !p.name) throw new Error('SKU and name are required');
  if (p.price < 0 || p.stock < 0) throw new Error('Price and stock cannot be negative');
  const body = { sku: p.sku, name: p.name, price: p.price, stock: p.stock, category: p.category, emoji: p.emoji, image: p.image, soldByWeight: p.soldByWeight };

  if (input.id) {
    const { product } = await api.updateProduct(input.id, body);
    const cur = products.find((x) => x.id === input.id);
    if (cur) Object.assign(cur, normalize(product));
    return cur;
  }
  const { product } = await api.createProduct(body);
  const created = normalize(product);
  products.push(created);
  return created;
}

export async function removeProduct(id) {
  await api.deleteProduct(id);
  const i = products.findIndex((p) => p.id === id);
  if (i >= 0) products.splice(i, 1);
}
