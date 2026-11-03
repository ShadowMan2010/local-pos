import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildOrdersCsv } from '../stats.js';

const LATE_NIGHT_BILL = {
  id: 'INV-261103-0001',
  paidAt: '2026-11-02T20:30:00.000Z',
  items: [{ name: 'Rice 5kg', qty: 1, price: 250, cost: 200 }],
  subtotal: 250,
  discount: 0,
  total: 250,
  paymentMethod: 'upi',
  customer: { name: 'Anita Sen', phone: '9800011122' },
  visitNo: 1
};

test('bill CSV writes the shop-local date and time, not UTC', () => {
  const csv = buildOrdersCsv([LATE_NIGHT_BILL], 'Asia/Kolkata');
  const row = csv.split('\r\n')[1];
  assert.ok(row.startsWith('INV-261103-0001,2026-11-03,02:00,'), row);
});

test('bill CSV keeps UTC when the shop timezone is UTC', () => {
  const csv = buildOrdersCsv([LATE_NIGHT_BILL], 'UTC');
  const row = csv.split('\r\n')[1];
  assert.ok(row.startsWith('INV-261103-0001,2026-11-02,20:30,'), row);
});
