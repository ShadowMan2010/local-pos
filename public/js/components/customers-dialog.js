// Customers: everyone who has been billed with a phone number, how many visits, and how much they spent.
// The list comes from the server (data/customers.json). Names are typed by cashiers, so they are only ever set as text.
import { h, icon, iconBtn, money } from '../ui.js';
import { listCustomers } from '../customers.js';

const fmtDate = (iso) => new Date(iso).toLocaleDateString('en-IN', { dateStyle: 'medium' });

export function openCustomersDialog() {
  const dlg = h('dialog', { class: 'm3-dialog products-dialog' });
  const list = h('ul', { class: 'pm-list' });
  const countEl = h('span', { class: 'body-m muted' });
  let timer;
  let seq = 0; // ignore answers that arrive after a newer search was started

  const row = (c) =>
    h('li', { class: 'pm-row' },
      h('div', { class: 'thumb' }, (Array.from(c.name || '')[0] || '#').toUpperCase()),
      h('div', { class: 'pm-main' },
        h('div', { class: 'title-s' }, c.name || 'No name'),
        h('div', { class: 'body-s muted' }, c.phone),
        h('div', { class: 'body-s muted' }, `${money(c.totalSpent)} spent · last visit ${fmtDate(c.lastVisit)}`)),
      h('span', { class: 'chip-static' }, `${c.visits} ${c.visits === 1 ? 'visit' : 'visits'}`));

  const message = (iconName, text) =>
    h('li', { class: 'cart-empty' }, icon(iconName), h('p', { class: 'body-m' }, text));

  async function load(q = '') {
    const mine = ++seq;
    try {
      const { total, customers } = await listCustomers(q);
      if (mine !== seq) return;
      countEl.textContent = `${total} ${total === 1 ? 'customer' : 'customers'}`;
      list.replaceChildren(...(customers.length
        ? customers.map(row)
        : [message('groups', q ? 'No customer matches your search.' : 'No customers yet. Type a phone number in the cart when you bill someone.')]));
    } catch (err) {
      if (mine === seq) list.replaceChildren(message('error', err.message));
    }
  }

  const search = h('label', { class: 'search-bar' }, icon('search'),
    h('input', {
      type: 'search', placeholder: 'Search name or phone', 'aria-label': 'Search customers',
      oninput: (e) => { clearTimeout(timer); timer = setTimeout(() => load(e.target.value), 200); }
    }));

  dlg.append(h('div', { class: 'pm-body' },
    h('div', { class: 'dlg-head' },
      h('h2', { class: 'title-l' }, 'Customers'), countEl, h('span', { class: 'spacer' }),
      iconBtn('close', () => dlg.close(), 'Close')),
    h('div', { class: 'pm-actions' }, search),
    list));
  dlg.addEventListener('close', () => { clearTimeout(timer); dlg.remove(); });

  document.body.append(dlg);
  dlg.showModal();
  load();
}
