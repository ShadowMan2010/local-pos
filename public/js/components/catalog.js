// Module 2 — product catalog: search, category chips and M3 elevated cards.
import { h, icon, money } from '../ui.js';
import { openCameraScanner } from '../camera-scan.js';

export function renderCatalog({ onAdd, onScan }) {
  let products = [];
  let query = '';
  let category = 'All';

  const grid = h('div', { class: 'catalog-grid' });
  const chips = h('div', { class: 'chip-row', role: 'tablist' });
  const search = h('label', { class: 'search-bar' },
    icon('search'),
    h('input', {
      type: 'search', placeholder: 'Search product name or SKU', 'aria-label': 'Search products',
      oninput: (e) => { query = e.target.value.trim().toLowerCase(); draw(); }
    }),
    h('span', { class: 'scan-pill', title: 'USB barcode scanner is listening' }, icon('barcode_scanner'), h('span', {}, 'Scanner ready')),
    h('button', {
      type: 'button', class: 'icon-btn tonal', 'aria-label': 'Scan with camera', title: 'Scan with camera',
      onclick: () => openCameraScanner({ title: 'Scan barcode or weighing ticket', onResult: onScan })
    }, icon('qr_code_scanner'))
  );

  function card(p) {
    const out = !p.soldByWeight && p.stock <= 0;
    const low = !p.soldByWeight && !out && p.stock <= 5;
    return h('article', { class: 'card-elevated product', dataset: { sku: p.sku } },
      h('div', { class: 'product-media' },
        p.image ? h('img', { src: p.image, alt: '', loading: 'lazy' }) : h('span', { class: 'emoji' }, p.emoji || '🛒'),
        h('span', { class: 'price-tag' }, p.soldByWeight ? `${money(p.price)}/kg` : money(p.price))
      ),
      h('div', { class: 'product-body' },
        h('h3', { class: 'title-m' }, p.name),
        h('p', { class: 'body-s muted' }, `SKU ${p.sku}`),
        h('div', { class: 'row' },
          h('span', { class: `chip-static ${out ? 'err' : low ? 'warn' : ''}`.trim() },
            p.soldByWeight ? `${p.stock} kg in stock` : out ? 'Out of stock' : `${p.stock} in stock`)),
        p.soldByWeight
          ? h('p', { class: 'body-s muted weigh-note' }, icon('scale'), 'Weigh at the station, then scan the ticket')
          : h('button', { type: 'button', class: 'btn btn-tonal btn-block', disabled: out, onclick: () => onAdd(p) },
              icon('add_shopping_cart'), 'Add to cart')
      )
    );
  }

  /* How many cards have ever been drawn. Search and category changes must not re-stagger the grid: the
     cashier is typing and the cards are moving out from under the cursor, which is worse than no motion at
     all. So the stagger runs once, when the catalog first has products, and category changes after that are
     instant. */
  let drawn = 0;

  function draw() {
    const cats = ['All', ...new Set(products.map((p) => p.category).filter(Boolean))];
    chips.replaceChildren(...cats.map((c) =>
      h('button', { type: 'button', class: `chip${c === category ? ' selected' : ''}`, onclick: () => { category = c; draw(); } }, c)));

    const list = products.filter((p) =>
      (category === 'All' || p.category === category) &&
      (!query || p.name.toLowerCase().includes(query) || p.sku.includes(query)));

    const cards = list.map((p, i) => {
      const el = card(p);
      // Capped at eight: the delay is 35ms per card, so the ninth card would start after the first has
      // finished, and a four-hundred-product shop would still be animating minutes later. Cards past the cap
      // simply appear, which is what a shop that big needs anyway.
      if (!drawn && i < 8) {
        el.classList.add('enter');
        el.style.setProperty('--i', String(i));
      }
      return el;
    });
    if (cards.length) drawn++;
    grid.replaceChildren(...(cards.length
      ? cards
      : [h('p', { class: 'empty body-l' }, products.length ? 'No product matches your search.' : 'No products yet. Tap the box icon in the top bar to add your first product.')]));
  }

  draw();
  return {
    el: h('section', { class: 'catalog' }, search, chips, grid),
    setProducts(list) { products = list; draw(); },
    refresh: draw,
    /** brief highlight when a barcode scan adds an item */
    flash(sku) {
      const el = grid.querySelector(`[data-sku="${CSS.escape(sku)}"]`);
      if (!el) return;
      el.classList.remove('flash'); void el.offsetWidth; el.classList.add('flash');
    }
  };
}
