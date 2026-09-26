// Pure daily-sales and achievement logic — no server/database code here, so it's easy to test on
// its own. server.js filters that day's paid bills and calls computeDailyStats/computeAchievements.

const round2 = (n) => Math.round(n * 100) / 100;

/**
 * @param {object[]} dayOrders paid bills for one day (already filtered by the caller)
 * @returns {{billCount:number, totalSales:number, biggestBill:number,
 *            totalCost:number|null, totalProfit:number|null, marginPct:number|null,
 *            uncostedLines:number,
 *            items:{sku:string,name:string,qty:number,revenue:number,cost:number|null,
 *                   profit:number|null,unit:'kg'|'pcs'}[]}}
 */
export function computeDailyStats(dayOrders) {
  const billCount = dayOrders.length;
  let totalSales = 0;
  let biggestBill = 0;
  let totalCost = 0;      // only meaningful while every line is costed, tracked by uncostedLines
  let totalProfit = 0;
  let uncostedLines = 0;
  const itemMap = new Map();

  for (const o of dayOrders) {
    totalSales += o.total;
    biggestBill = Math.max(biggestBill, o.total);
    for (const it of o.items || []) {
      const key = it.sku || it.name;
      const isWeight = it.weightKg != null;
      const qty = isWeight ? it.weightKg : it.qty;
      const revenue = it.price * it.qty; // qty is always 1 for a weighed line, so this is that line's total either way
      const cur = itemMap.get(key) || { sku: it.sku || '', name: it.name, qty: 0, revenue: 0, cost: 0, costed: true, unit: isWeight ? 'kg' : 'pcs' };
      cur.qty = Math.round((cur.qty + qty) * 1000) / 1000;
      cur.revenue = round2(cur.revenue + revenue);
      // One uncosted line makes this item's cost unknown, not zero — a partly-known cost would
      // quietly understate profit, which is the number the owner is relying on.
      if (it.cost == null) { cur.costed = false; uncostedLines += 1; }
      else cur.cost = round2(cur.cost + it.cost * qty);
      itemMap.set(key, cur);
    }
  }

  const items = [...itemMap.values()].sort((a, b) => b.revenue - a.revenue);
  for (const i of items) {
    i.cost = i.costed ? round2(i.cost) : null;
    i.profit = i.costed ? round2(i.revenue - i.cost) : null;
  }

  // Profit is only reported when every line in the day is costed; a partial figure would be a lie.
  const fullyCosted = uncostedLines === 0;
  if (fullyCosted) {
    for (const i of items) totalCost += i.cost;
    totalProfit = round2(totalSales - totalCost);
  }
  return {
    billCount,
    totalSales: round2(totalSales),
    biggestBill: round2(biggestBill),
    totalCost: fullyCosted ? round2(totalCost) : null,
    totalProfit: fullyCosted ? totalProfit : null,
    marginPct: fullyCosted && totalSales > 0 ? round2((totalProfit / totalSales) * 100) : null,
    uncostedLines,
    items
  };
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

/* ---------- CSV export ---------- */

// A cell whose first character makes a spreadsheet treat it as a formula. A product called
// "=SUM(A1)" or "+91 discount" would otherwise be executed on open, which is a real risk once an
// exported file is emailed to an accountant and opened in Excel.
const FORMULA_LEAD = /^[=+\-@\t\r]/;

function csvCell(value) {
  if (value == null) return '';
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : ''; // never guard numbers: -12.50 is data, not a formula
  if (typeof value === 'boolean') return value ? 'yes' : 'no';
  let s = String(value);
  if (FORMULA_LEAD.test(s)) s = `'${s}`; // leading apostrophe tells Excel/LibreOffice to treat it as text
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/**
 * Joins rows into RFC 4180 CSV. Rows are arrays of cells; the caller decides the columns.
 * A UTF-8 BOM is prepended so Excel opens rupee signs and Bengali text correctly instead of
 * showing mojibake — the difference between a usable export and an unreadable one.
 * @param {(string|number|boolean|null)[][]} rows
 */
export function toCsv(rows) {
  return '﻿' + rows.map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n';
}

/** One row per bill, newest first. */
export function buildOrdersCsv(orders) {
  const rows = [[
    'Bill', 'Date', 'Time', 'Customer', 'Phone', 'Items', 'Subtotal', 'Discount', 'Total',
    'Payment', 'Delivery status', 'Delivered by', 'Visit no.'
  ]];
  const sorted = [...orders].sort((a, b) => String(b.id).localeCompare(String(a.id)));
  for (const o of sorted) {
    const when = new Date(o.paidAt || o.createdAt);
    if (Number.isNaN(when.getTime())) continue;
    const itemText = (o.items || [])
      .map((it) => `${it.name} x${it.weightKg != null ? it.weightKg + 'kg' : it.qty}`)
      .join('; ');
    rows.push([
      o.id,
      when.toISOString().slice(0, 10),
      when.toISOString().slice(11, 16),
      o.customer?.name || '',
      o.customer?.phone || '',
      itemText,
      o.subtotal,
      o.discount,
      o.total,
      o.paymentMethod || '',
      o.delivery?.status || 'not a delivery',
      o.delivery?.boy?.name || '',
      o.visitNo ?? ''
    ]);
  }
  return toCsv(rows);
}

/** One row per product for the period: what sold, what it brought in, and what it earned. */
export function buildProductsCsv(items) {
  const rows = [['SKU', 'Product', 'Quantity', 'Unit', 'Revenue', 'Cost', 'Profit', 'Margin %']];
  for (const it of items) {
    rows.push([
      it.sku || '',
      it.name,
      it.qty,
      it.unit,
      it.revenue,
      it.cost == null ? 'cost not set' : it.cost,
      it.profit == null ? 'unknown' : it.profit,
      it.profit == null || it.revenue <= 0 ? '' : round2((it.profit / it.revenue) * 100)
    ]);
  }
  return toCsv(rows);
}

/** One row per day, for charting a trend across the period. */
export function buildDaysCsv(days) {
  const rows = [['Date', 'Bills', 'Sales', 'Cost', 'Profit', 'Margin %', 'Biggest bill']];
  for (const d of days) {
    rows.push([
      d.date,
      d.billCount,
      d.totalSales,
      d.totalCost == null ? 'cost not set' : d.totalCost,
      d.totalProfit == null ? 'unknown' : d.totalProfit,
      d.marginPct == null ? '' : d.marginPct,
      d.biggestBill
    ]);
  }
  return toCsv(rows);
}
