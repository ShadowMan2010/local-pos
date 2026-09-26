// Pure daily-sales and achievement logic — no server/database code here, so it's easy to test on
// its own. server.js filters that day's paid bills and calls computeDailyStats/computeAchievements.

const round2 = (n) => Math.round(n * 100) / 100;

/**
 * @param {object[]} dayOrders paid bills for one day (already filtered by the caller)
 * @returns {{billCount:number, totalSales:number, biggestBill:number,
 *            items:{sku:string,name:string,qty:number,revenue:number,unit:'kg'|'pcs'}[]}}
 */
export function computeDailyStats(dayOrders) {
  const billCount = dayOrders.length;
  let totalSales = 0;
  let biggestBill = 0;
  const itemMap = new Map();

  for (const o of dayOrders) {
    totalSales += o.total;
    biggestBill = Math.max(biggestBill, o.total);
    for (const it of o.items || []) {
      const key = it.sku || it.name;
      const isWeight = it.weightKg != null;
      const qty = isWeight ? it.weightKg : it.qty;
      const revenue = it.price * it.qty; // qty is always 1 for a weighed line, so this is that line's total either way
      const cur = itemMap.get(key) || { sku: it.sku || '', name: it.name, qty: 0, revenue: 0, unit: isWeight ? 'kg' : 'pcs' };
      cur.qty = Math.round((cur.qty + qty) * 1000) / 1000;
      cur.revenue = round2(cur.revenue + revenue);
      itemMap.set(key, cur);
    }
  }

  const items = [...itemMap.values()].sort((a, b) => b.revenue - a.revenue);
  return { billCount, totalSales: round2(totalSales), biggestBill: round2(biggestBill), items };
}

// Highest threshold crossed in each category — one badge per category, not one per rung on the ladder.
const REVENUE_STEPS = [1000, 5000, 10000, 25000, 50000, 100000, 200000];
const BILL_STEPS = [10, 25, 50, 100, 200];
const ITEM_QTY_STEP = 20;
const BIG_BILL_STEP = 2000;

const highestCrossed = (value, steps) => steps.reduce((hit, s) => (value >= s ? s : hit), null);
const inr = (n) => `₹${Math.round(n).toLocaleString('en-IN')}`;

/** @returns {{emoji:string, title:string}[]} */
export function computeAchievements(stats) {
  const badges = [];
  if (stats.billCount >= 1) badges.push({ emoji: '🎉', title: "Aajker prothom bill!" });

  const revStep = highestCrossed(stats.totalSales, REVENUE_STEPS);
  if (revStep) badges.push({ emoji: '💰', title: `${inr(revStep)} periye gelo aaj!` });

  const billStep = highestCrossed(stats.billCount, BILL_STEPS);
  if (billStep) badges.push({ emoji: '🧾', title: `${billStep} bill aaj!` });

  if (stats.biggestBill >= BIG_BILL_STEP) badges.push({ emoji: '🏆', title: `Boro bill: ${inr(stats.biggestBill)}` });

  const bigItem = stats.items.find((i) => i.qty >= ITEM_QTY_STEP);
  if (bigItem) badges.push({ emoji: '🔥', title: `${bigItem.name}: ${Math.round(bigItem.qty)} ${bigItem.unit} bikri holo!` });

  return badges;
}

/**
 * @param {object[]} products
 * @returns {{lowStock:object[], outOfStock:object[]}} low: 1..5 (or kg) left; out: 0 left (weighed items excluded from "out of stock" — 0 kg just means weigh less)
 */
export function computeStockPosition(products, threshold = 5) {
  const lowStock = products.filter((p) => p.stock > 0 && p.stock <= threshold)
    .sort((a, b) => a.stock - b.stock)
    .map((p) => ({ sku: p.sku, name: p.name, stock: p.stock, soldByWeight: !!p.soldByWeight }));
  const outOfStock = products.filter((p) => !p.soldByWeight && p.stock <= 0)
    .map((p) => ({ sku: p.sku, name: p.name }));
  return { lowStock, outOfStock };
}
