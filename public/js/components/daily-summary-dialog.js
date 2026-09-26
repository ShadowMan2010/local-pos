// Today's sales at a glance: a few fun milestones, the total and bill count, which items sold,
// and a quick look at what's running low — so closing up for the day takes one glance, not a
// trip through the order history.
import { h, icon, iconBtn, money, snack } from '../ui.js';
import * as api from '../api.js';

export function openDailySummaryDialog() {
  const dlg = h('dialog', { class: 'm3-dialog daily-dialog' });
  const body = h('div', { class: 'daily-body' }, h('p', { class: 'body-l' }, 'Loading…'));

  dlg.append(
    h('div', { class: 'dlg-head' },
      h('h2', { class: 'title-l' }, "Today's sales"), h('span', { class: 'spacer' }),
      iconBtn('close', () => dlg.close(), 'Close')),
    body);
  dlg.addEventListener('close', () => dlg.remove());
  document.body.append(dlg);
  dlg.showModal();
  load();

  async function load() {
    try {
      const s = await api.getDailyStats();
      render(s);
    } catch (err) {
      body.replaceChildren(h('p', { class: 'body-m' }, err.message));
    }
  }

  function render(s) {
    const parts = [];

    if (s.achievements.length) {
      parts.push(h('div', { class: 'badge-row' },
        ...s.achievements.map((a) => h('span', { class: 'badge-chip' }, h('span', { class: 'badge-emoji' }, a.emoji), a.title))));
    }

    parts.push(h('div', { class: 'daily-hero' },
      h('div', {}, h('div', { class: 'daily-figure' }, money(s.totalSales)), h('div', { class: 'body-m muted' }, 'Total sales today')),
      h('div', {}, h('div', { class: 'daily-figure' }, String(s.billCount)), h('div', { class: 'body-m muted' }, s.billCount === 1 ? 'bill' : 'bills'))));

    parts.push(h('h3', { class: 'title-m daily-section' }, 'What sold'));
    parts.push(s.items.length
      ? h('ul', { class: 'daily-list' }, ...s.items.map((it) =>
          h('li', {},
            h('span', { class: 'daily-item-name' }, it.name),
            h('span', { class: 'body-s muted' }, `${it.unit === 'kg' ? it.qty.toFixed(3) : it.qty} ${it.unit === 'kg' ? 'kg' : 'pcs'}`),
            h('span', { class: 'daily-item-rev' }, money(it.revenue)))))
      : h('p', { class: 'body-m muted' }, 'No bills yet today.'));

    if (s.lowStock.length || s.outOfStock.length) {
      parts.push(h('h3', { class: 'title-m daily-section' }, 'Stock position'));
      if (s.outOfStock.length) {
        parts.push(h('p', { class: 'body-s stock-out' }, icon('error'), `Out of stock: ${s.outOfStock.map((p) => p.name).join(', ')}`));
      }
      if (s.lowStock.length) {
        parts.push(h('ul', { class: 'daily-list' }, ...s.lowStock.map((p) =>
          h('li', {},
            h('span', { class: 'daily-item-name' }, p.name),
            h('span', { class: 'body-s stock-low' }, `${p.soldByWeight ? p.stock.toFixed(3) + ' kg' : p.stock} left`)))));
      }
    }

    body.replaceChildren(...parts);
  }
}
