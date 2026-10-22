// Product manager: add, edit, delete products, each with an optional photo stored on the POS server.
import { h, icon, iconBtn, money, snack, runBusy } from '../ui.js';
import { getProducts, saveProduct, removeProduct, addSampleProducts, importFromFirebase } from '../products.js';
import { compressImage, uploadImage, deleteImage } from '../images.js';
import { scanProducts } from '../api.js';
import { suggestSku } from '../catalogue-draft.js';

const thumb = (p) => h('div', { class: 'thumb' }, p.image ? h('img', { src: p.image, alt: '' }) : (p.emoji || '🛒'));

export function openProductsDialog({ config = {}, onChange }) {
  const dlg = h('dialog', { class: 'm3-dialog products-dialog' });
  const body = h('div', { class: 'pm-body' });
  dlg.append(body);
  dlg.addEventListener('close', () => { dlg.remove(); onChange(); });

  /* ---------- one-time helpers for an empty store ---------- */
  /* Uses runBusy rather than disabling the button directly. Disabling it gives no feedback at all, so
     importing from Firebase — a network round trip to a stranger's database — looked like a tap that had
     done nothing, on a screen that usually opens precisely because the shop has no products yet. */
  async function runOnce(btn, work, done) {
    await runBusy(btn, async () => {
      try { done(await work()); showList(); }
      catch (err) { snack(err.message, 7000, 'error'); }
    });
  }
  const sampleBtn = () => {
    const b = h('button', { type: 'button', class: 'btn btn-text', onclick: () => runOnce(b, addSampleProducts, () => snack('10 sample products added')) }, 'Load 10 sample products');
    return b;
  };
  const importBtn = () => {
    const b = h('button', { type: 'button', class: 'btn btn-tonal', onclick: () => runOnce(b, importFromFirebase, ({ imported, skipped }) =>
      snack(`Imported ${imported} ${imported === 1 ? 'product' : 'products'}${skipped ? ` (${skipped} skipped: repeated SKU or missing details)` : ''}`, 6000)) },
      // Spins while the import runs, for the same reason: the button's own spinner is enough, and this
      // icon only means "this is happening" when the button is busy.
      icon('cloud_download', { spin: true }), 'Import from Firebase');
    return b;
  };

  const scanBtn = h('button', { type: 'button', class: 'btn btn-tonal', onclick: () => fileInput.click() }, icon('photo_camera'), 'Scan a photo');
  const fileInput = h('input', { type: 'file', accept: 'image/*', hidden: true, onchange: onScanFile });
  async function onScanFile(e) {
    const file = e.target.files[0]; e.target.value = '';
    if (!file) return;
    await runBusy(scanBtn, async () => {
      try {
        const blob = await compressImage(file, 1600, 0.85);
        const products = await scanProducts(blob);
        if (!products.length) {
          snack('No products found in that photo. Try a closer, clearer picture.', 6000, 'error');
          return;
        }
        showScan(products);
      } catch (err) {
        snack(err.message, 7000, 'error');
      }
    });
  }
  /* ---------- list view ---------- */
  function showList() {
    const list = getProducts();
    const uncosted = list.filter((p) => p.cost == null).length;
    const aiOn = Boolean(config.aiEnabled);
    const row = (p) =>
      h('li', { class: 'pm-row' },
        thumb(p),
        h('div', { class: 'pm-main' },
          h('div', { class: 'title-s' }, p.name),
          h('div', { class: 'body-s muted' },
            p.soldByWeight ? `${money(p.price)}/kg · ${p.stock} kg in stock · SKU ${p.sku}` : `${money(p.price)} · ${p.stock} in stock · SKU ${p.sku}`),
          h('div', { class: 'body-s muted' },
            p.cost == null ? 'Cost not set — profit hidden' : `Cost ${money(p.cost)} · margin ${money(p.price - p.cost)} (${p.price > 0 ? (((p.price - p.cost) / p.price) * 100).toFixed(0) : 0}%)`)),
        iconBtn('edit', () => showForm(p), `Edit ${p.name}`));

    body.replaceChildren(
      h('div', { class: 'dlg-head' },
        h('h2', { class: 'title-l' }, 'Products'),
        h('span', { class: 'body-m muted' }, `${list.length} ${list.length === 1 ? 'item' : 'items'}`),
        h('span', { class: 'spacer' }),
        iconBtn('close', () => dlg.close(), 'Close')),
      uncosted
        ? h('div', { class: 'pm-note' }, icon('info', {}), `Set a cost price on ${uncosted} ${uncosted === 1 ? 'item' : 'items'} to see profit and margin.`)
        : null,
      h('div', { class: 'pm-actions' },
        h('button', { type: 'button', class: 'btn btn-filled', onclick: () => showForm(null) }, icon('add'), 'Add product'),
        aiOn && scanBtn,
        config.canImportFirebase && importBtn()),
      h('ul', { class: 'pm-list' }, ...(list.length
        ? list.map(row)
        : [h('li', { class: 'cart-empty' }, icon('inventory_2'), h('p', { class: 'body-l' }, 'No products yet.'), h('p', { class: 'body-m' }, 'Tap "Add product" to create the first one.'), sampleBtn())])));
  }

  /* ---------- add / edit form ---------- */
  function showForm(p) {
    const isEdit = Boolean(p);
    const oldImage = p?.image || '';
    let blob = null;        // newly chosen (already compressed) photo
    let removed = false;    // user tapped "Remove photo"

    const preview = h('div', { class: 'img-preview' });
    const drawPreview = (src) => preview.replaceChildren(src ? h('img', { src, alt: 'Product photo' }) : icon('add_a_photo'));
    drawPreview(oldImage);

    const fileInput = h('input', {
      type: 'file', accept: 'image/*', hidden: true,
      onchange: async (e) => {
        const file = e.target.files[0];
        e.target.value = '';
        if (!file) return;
        try {
          blob = await compressImage(file);
          removed = false;
          drawPreview(URL.createObjectURL(blob));
        } catch (err) { snack(err.message); }
      }
    });

    const field = (name, label, attrs = {}) =>
      h('label', { class: 'm3-field', style: '--field-bg: var(--md-surface-container-high)' },
        h('input', { name, placeholder: ' ', autocomplete: 'off', ...attrs }),
        h('span', {}, label));

    const cats = [...new Set(getProducts().map((x) => x.category).filter(Boolean))];
    const saveBtn = h('button', { type: 'submit', class: 'btn btn-filled' }, icon('check'), 'Save');

    const weightCheck = h('input', { type: 'checkbox', name: 'soldByWeight', checked: p?.soldByWeight || false, onchange: syncWeightLabels });
    const priceLabel = () => (weightCheck.checked ? 'Price per kg (₹) *' : 'Price (₹) *');
    const stockLabel = () => (weightCheck.checked ? 'Stock (kg) *' : 'Stock *');
    const priceField = field('price', priceLabel(), { type: 'number', min: '0', step: 'any', inputmode: 'decimal', value: p?.price ?? '', required: true });
    const stockField = field('stock', stockLabel(), { type: 'number', min: '0', step: p?.soldByWeight ? 'any' : '1', inputmode: 'decimal', value: p?.stock ?? '', required: true });
    // Cost is optional on purpose: leaving it blank keeps profit reporting honest ("unknown")
    // instead of pretending the item was free. A real 0 is allowed and means genuinely free.
    const costField = field('cost', 'Cost price (₹)', { type: 'number', min: '0', step: 'any', inputmode: 'decimal', value: p?.cost ?? '' });

    // Shows what this product actually earns, so the owner can judge a price before saving it.
    const marginNote = h('small', { class: 'field-hint' });
    function syncMarginNote() {
      const price = Number(priceField.querySelector('input').value);
      const costRaw = costField.querySelector('input').value.trim();
      if (costRaw === '') { marginNote.textContent = 'Leave blank if you do not know the cost. Profit stays hidden until you fill it in.'; return; }
      const cost = Number(costRaw);
      if (!Number.isFinite(cost) || cost < 0) { marginNote.textContent = ''; return; }
      if (!Number.isFinite(price) || price <= 0) { marginNote.textContent = `Cost ${money(cost)} recorded.`; return; }
      const per = price - cost;
      marginNote.textContent = `Margin ${money(per)} per ${weightCheck.checked ? 'kg' : 'unit'} (${((per / price) * 100).toFixed(1)}%)`;
    }
    for (const f of [priceField, costField]) f.querySelector('input').addEventListener('input', syncMarginNote);
    weightCheck.addEventListener('change', syncMarginNote);
    syncMarginNote();

    function syncWeightLabels() {
      priceField.querySelector('span').textContent = priceLabel();
      stockField.querySelector('span').textContent = stockLabel();
      stockField.querySelector('input').step = weightCheck.checked ? 'any' : '1';
    }

    const form = h('form', { class: 'pm-form', onsubmit: submit },
      h('div', { class: 'dlg-head' },
        iconBtn('arrow_back', showList, 'Back to products'),
        h('h2', { class: 'title-l' }, isEdit ? 'Edit product' : 'New product')),
      h('div', { class: 'pm-fields' },
        h('div', { class: 'pm-photo' }, preview,
          h('div', { class: 'pm-photo-btns' },
            h('button', { type: 'button', class: 'btn btn-tonal', onclick: () => fileInput.click() }, icon('photo_camera'), 'Choose photo'),
            h('button', { type: 'button', class: 'btn btn-text', onclick: () => { blob = null; removed = true; drawPreview(''); } }, 'Remove photo')),
          fileInput),
        h('div', {},
          field('sku', 'SKU / barcode *', {
            value: p?.sku || '', required: true,
            onkeydown: (e) => { if (e.key === 'Enter') e.preventDefault(); } // a scanner ends with Enter — don't submit
          }),
          h('small', { class: 'field-hint' }, 'Tap this box, then scan the product barcode with the USB scanner.')),
        field('name', 'Product name *', { value: p?.name || '', required: true }),
        h('label', { class: 'choice' }, weightCheck,
          h('div', {},
            h('div', { class: 'title-s' }, 'Sold by weight'),
            h('div', { class: 'body-s muted' }, 'Price is per kg. Sold from the weighing station, not "Add to cart".'))),
        h('div', { class: 'pm-two' }, priceField, stockField),
        h('div', {},
          costField,
          marginNote),
        h('div', { class: 'pm-two' },
          field('category', 'Category', { value: p?.category || '', list: 'pm-cats' }),
          field('emoji', 'Emoji (if no photo)', { value: p?.emoji || '' })),
        h('datalist', { id: 'pm-cats' }, ...cats.map((c) => h('option', { value: c })))),
      h('div', { class: 'pm-foot' },
        isEdit && h('button', { type: 'button', class: 'btn btn-text', style: 'color:var(--md-error)', onclick: del }, icon('delete'), 'Delete'),
        h('span', { class: 'spacer' }),
        h('button', { type: 'button', class: 'btn btn-text', onclick: showList }, 'Cancel'),
        saveBtn));

    body.replaceChildren(form);

    async function submit(e) {
      e.preventDefault();
      const v = Object.fromEntries(new FormData(form).entries());
      saveBtn.disabled = true;
      let newUrl = null;
      try {
        let image = removed ? '' : oldImage;
        if (blob) { newUrl = await uploadImage(blob); image = newUrl; }
        await saveProduct({
          id: p?.id, sku: v.sku.trim(), name: v.name.trim(), price: v.price, stock: v.stock,
          category: v.category.trim(), emoji: v.emoji.trim(), image, soldByWeight: v.soldByWeight === 'on',
          // '' means "not recorded yet"; the server stores that as null so it is never read as zero.
          cost: v.cost.trim() === '' ? '' : v.cost
        });
        if (oldImage && oldImage !== image) deleteImage(oldImage); // old photo is no longer used
        snack(isEdit ? 'Product updated' : 'Product added', 3200, 'success');
        showList();
      } catch (err) {
        if (newUrl) deleteImage(newUrl); // don't leave an unused photo behind
        snack(err.message, 5000, 'error');
        saveBtn.disabled = false;
      }
    }

    async function del() {
      if (!confirm(`Delete "${p.name}"? This cannot be undone.`)) return;
      try {
        await removeProduct(p.id);
        deleteImage(p.image);
        snack('Product deleted', 3200, 'success');
        showList();
      } catch (err) { snack(err.message, 5000, 'error'); }
    }
  }

  /* ---------- AI photo scan: review drafts ---------- */
  function showScan(drafts) {
    const all = getProducts();
    const taken = new Set(all.map((p) => p.sku));
    const items = drafts.map((d, i) => {
      let base = d.sku && String(d.sku).trim() ? String(d.sku).trim() : suggestSku(d.name, taken, `AI-${String(i + 1).padStart(2, '0')}`);
      if (taken.has(base)) base = suggestSku(d.name, taken, `AI-${String(i + 1).padStart(2, '0')}`);
      taken.add(base);
      return {
        include: true,
        sku: base,
        name: (d.name || '').trim(),
        price: d.price == null || d.price === '' ? '' : String(d.price),
        stock: d.stock == null || d.stock === '' ? '0' : String(d.stock),
        category: (d.category || '').trim(),
        emoji: (d.emoji || '').trim(),
        soldByWeight: Boolean(d.soldByWeight),
        cost: d.cost == null || d.cost === '' ? '' : String(d.cost)
      };
    });
    let itemEls = [];

    const listEl = h('div', { class: 'pm-scan-list' });
    const saveScanBtn = h('button', { type: 'button', class: 'btn btn-filled' }, icon('check'), 'Add products');
    const actions = h('div', { class: 'pm-foot' },
      iconBtn('arrow_back', showList, 'Back to products'),
      h('span', { class: 'spacer' }),
      h('button', { type: 'button', class: 'btn btn-text', onclick: showList }, 'Cancel'),
      saveScanBtn);

    const note = h('div', { class: 'pm-note' }, icon('info', {}), 'Check the AI reading. Prices missing from the photo are left blank — fill them before adding.');

    function render() {
      listEl.replaceChildren(...itemEls.map((ie, idx) => {
        const it = items[idx];
        const row = h('div', { class: 'pm-scan-row' },
          h('input', { type: 'checkbox', checked: it.include, onchange: (e) => { it.include = e.target.checked; } }),
          h('div', { class: 'pm-scan-main' },
            field(it, 'name', 'Product name *', { value: it.name, required: true }),
            h('div', { class: 'pm-two' },
              field(it, 'price', 'Price (₹) *', { type: 'number', min: '0', step: 'any', inputmode: 'decimal', value: it.price, required: true }),
              field(it, 'stock', 'Stock', { type: 'number', min: '0', step: it.soldByWeight ? 'any' : '1', inputmode: 'decimal', value: it.stock })),
            h('div', { class: 'pm-two' },
              field(it, 'category', 'Category', { value: it.category }),
              field(it, 'emoji', 'Emoji', { value: it.emoji })),
            h('label', { class: 'choice' },
              h('input', { type: 'checkbox', checked: it.soldByWeight, onchange: (e) => { it.soldByWeight = e.target.checked; syncRowLabels(idx); } }),
              h('div', {}, h('div', { class: 'title-s' }, 'Sold by weight'), h('div', { class: 'body-s muted' }, 'Price is per kg'))),
            h('small', { class: 'body-s muted' }, `SKU ${it.sku}` + (it.cost ? ` · cost ₹${it.cost}` : ''))));
        return row;
      }));
    }

    function field(it, key, label, attrs = {}) {
      const inp = h('input', { ...attrs, oninput: (e) => { it[key] = e.target.value; } });
      return h('label', { class: 'm3-field', style: '--field-bg: var(--md-surface-container-high)' }, inp, h('span', {}, label));
    }
    function syncRowLabels(idx) {
      // render() rebuilds labels via step; easier to rebuild whole list lightly
      render();
    }

    itemEls = items;
    body.replaceChildren(
      h('div', { class: 'dlg-head' },
        iconBtn('arrow_back', showList, 'Back to products'),
        h('h2', { class: 'title-l' }, `${items.length} ${items.length === 1 ? 'product' : 'products'} from photo`)),
      note,
      listEl,
      actions);

    render();

    saveScanBtn.onclick = async () => {
      const chosen = items.filter((x) => x.include);
      if (!chosen.length) { snack('Select at least one product to add.', 4000, 'error'); return; }
      let failed = 0;
      let ok = 0;
      let firstErr = '';
      for (const it of chosen) {
        const name = it.name.trim();
        if (!name) { snack('Every included product needs a name.', 4000, 'error'); return; }
        const price = Number(it.price);
        if (!Number.isFinite(price) || price < 0) { snack('Every included product needs a valid price.', 4000, 'error'); return; }
        const stock = Number(it.stock) || 0;
        const cost = it.cost.trim() === '' ? '' : Number(it.cost);
        try {
          await saveProduct({
            sku: it.sku,
            name,
            price,
            stock,
            category: it.category.trim(),
            emoji: it.emoji.trim(),
            image: '',
            soldByWeight: it.soldByWeight,
            cost: cost === '' ? '' : cost
          });
          ok += 1;
        } catch (err) {
          failed += 1;
          if (!firstErr) firstErr = err.message;
        }
      }
      if (ok) snack(`Added ${ok} ${ok === 1 ? 'product' : 'products'}.`, 3200, 'success');
      if (failed) snack(`Failed to add ${failed}: ${firstErr}`, 7000, 'error');
      showList();
    };
  }
  showList();
  document.body.append(dlg);
  dlg.showModal();
}
