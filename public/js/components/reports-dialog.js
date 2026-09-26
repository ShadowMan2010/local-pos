// Reports over a date range: what is selling, what it actually earned, and a day-by-day trend.
//
// This is deliberately separate from Today's sales. That dialog is a close-of-day glance with
// achievements and a stock check; this one is a book-keeping screen that gets exported, and mixing
// the two would bury the numbers the owner came to read.
import { h, icon, iconBtn, money, snack } from '../ui.js';
import * as api from '../api.js';

const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

// The report API works in YYMMDD because that is what a bill number starts with. It is derived from
// the browser's own date, which is the till's own clock — the same clock the till stamps bills with.
const yymmdd = (d) => iso(d).slice(2).replace(/-/g, '');

function defaultRange() {
  const to = new Date();
  const from = new Date();
  from.setDate(from.getDate() - 6); // a week: long enough to show a trend, short enough to read
  return { from: yymmdd(from), to: yymmdd(to) };
}

// "260926" -> "2026-09-26" for the date input, which needs ISO.
function toInputValue(yy) {
  if (!/^\d{6}$/.test(yy || '')) return '';
  return `20${yy.slice(0, 2)}-${yy.slice(2, 4)}-${yy.slice(4, 6)}`;
}
const qtyText = (it) => (it.unit === 'kg' ? `${(+it.qty).toFixed(3)} kg` : `${it.qty} pcs`);

export function openReportsDialog() {
  const dlg = h('dialog', { class: 'm3-dialog daily-dialog reports-dialog' });
  const body = h('div', { class: 'daily-body' }, h('p', { class: 'body-l' }, 'Loading…'));
  const { from, to } = defaultRange();
  let range = { from, to };

  const fromInput = h('input', { type: 'date', placeholder: ' ', autocomplete: 'off', 'aria-label': 'From date' });
  const toInput = h('input', { type: 'date', placeholder: ' ', autocomplete: 'off', 'aria-label': 'To date' });
  // The floating-label field is the app's own pattern (see products-dialog); a bare date input
  // would look pasted in from somewhere else.
  const dateField = (label, input) =>
    h('label', { class: 'm3-field compact reports-date', style: '--field-bg: var(--md-surface)' }, input, h('span', {}, label));

  const apply = async () => {
    const f = yymmdd(new Date(`${fromInput.value}T00:00:00`));
    const t = yymmdd(new Date(`${toInput.value}T00:00:00`));
    if (!/^\d{6}$/.test(f) || !/^\d{6}$/.test(t)) return snack('Pick a start and end date', 3000);
    if (f > t) return snack('The start date is after the end date', 3000);
    range = { from: f, to: t };
    load();
  };
  for (const el of [fromInput, toInput]) el.addEventListener('change', apply);

  const exportBar = h('div', { class: 'reports-exports' },
    h('span', { class: 'body-s muted' }, 'Download:'),
    ...[['orders', 'Bills'], ['products', 'Products'], ['days', 'Day by day']].map(([kind, label]) =>
      h('a', { class: 'btn btn-tonal', href: api.exportUrl(kind, range.from, range.to), download: '' }, icon('download'), label)));

  dlg.append(
    h('div', { class: 'dlg-head' },
      h('h2', { class: 'title-l' }, 'Reports'), h('span', { class: 'spacer' }),
      iconBtn('close', () => dlg.close(), 'Close')),
    h('div', { class: 'reports-range' },
      dateField('From', fromInput),
      dateField('To', toInput),
      h('div', { class: 'spacer' }),
      h('button', { type: 'button', class: 'btn btn-outlined', onclick: () => { const r = defaultRange(); fromInput.value = toInputValue(r.from); toInput.value = toInputValue(r.to); apply(); } }, 'This week')),
    exportBar,
    body);
  dlg.addEventListener('close', () => dlg.remove());
  document.body.append(dlg);
  fromInput.value = toInputValue(range.from);
  toInput.value = toInputValue(range.to);
  dlg.showModal();
  load();

  async function load() {
    body.replaceChildren(h('p', { class: 'body-l' }, 'Loading…'));
    try {
      render(await api.getRangeStats(range.from, range.to));
    } catch (err) {
      body.replaceChildren(h('p', { class: 'body-m' }, err.message));
    }
  }

  function render(r) {
    // The export links carry the range in their href, so they have to be rewritten after a
    // range change or the download would silently be for the previous dates.
    for (const a of exportBar.querySelectorAll('a')) {
      const kind = a.getAttribute('href').match(/\/api\/export\/(\w+)\.csv/)?.[1];
      if (kind) a.setAttribute('href', api.exportUrl(kind, r.from, r.to));
    }

    const parts = [];
    const dayWord = r.overall.billCount === 1 ? 'bill' : 'bills';
    parts.push(h('div', { class: 'daily-hero' },
      h('div', {}, h('div', { class: 'daily-figure' }, money(r.overall.totalSales)), h('div', { class: 'body-m muted' }, r.days === 1 ? 'Sales that day' : 'Sales in this period')),
      h('div', {}, h('div', { class: 'daily-figure' }, String(r.overall.billCount)), h('div', { class: 'body-m muted' }, `${dayWord} over ${r.days} ${r.days === 1 ? 'day' : 'days'}`))));

    // Same rule as the daily view: no cost prices means no profit claim.
    parts.push(r.overall.totalProfit == null
      ? h('p', { class: 'body-s muted daily-profit-note' }, icon('info'),
          r.overall.uncostedLines
            ? `Profit hidden: ${r.overall.uncostedLines} ${r.overall.uncostedLines === 1 ? 'line has' : 'lines have'} no cost price set. Add cost prices under Products.`
            : 'Add cost prices under Products to see profit.')
      : h('div', { class: 'daily-profit' },
          h('div', {}, h('div', { class: 'daily-figure' }, money(r.overall.totalProfit)), h('div', { class: 'body-m muted' }, 'Profit')),
          h('div', {}, h('div', { class: 'daily-figure' }, `${r.overall.marginPct}%`), h('div', { class: 'body-m muted' }, `Margin · cost ${money(r.overall.totalCost)}`))));

    parts.push(h('h3', { class: 'title-m daily-section' }, 'What sold'));
    parts.push(r.overall.items.length
      ? h('ul', { class: 'daily-list' }, ...r.overall.items.map((it) =>
          h('li', {},
            h('span', { class: 'daily-item-name' }, it.name),
            h('span', { class: 'body-s muted' }, qtyText(it)),
            h('span', { class: 'daily-item-rev' }, money(it.revenue)),
            h('span', { class: 'body-s muted daily-item-profit' },
              it.profit == null ? 'cost n/a' : `${money(it.profit)} profit`))))
      : h('p', { class: 'body-m muted' }, 'Nothing sold in this period.'));

    if (r.byDay.length > 1) {
      parts.push(h('h3', { class: 'title-m daily-section' }, 'Day by day'));
      parts.push(h('ul', { class: 'daily-list' }, ...[...r.byDay].reverse().map((d) =>
        h('li', {},
          h('span', { class: 'daily-item-name' }, `${d.date.slice(0, 2)}/${d.date.slice(2, 4)}/${d.date.slice(4, 6)}`),
          h('span', { class: 'body-s muted' }, `${d.billCount} ${d.billCount === 1 ? 'bill' : 'bills'}`),
          h('span', { class: 'daily-item-rev' }, money(d.totalSales)),
          h('span', { class: 'body-s muted daily-item-profit' },
            d.totalProfit == null ? 'cost n/a' : `${money(d.totalProfit)} profit`)))));
    }

    body.replaceChildren(...parts);
  }
}
