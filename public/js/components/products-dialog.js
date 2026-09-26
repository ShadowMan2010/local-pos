// Product manager: add, edit, delete products, each with an optional photo stored on the POS server.
import { h, icon, iconBtn, money, snack } from '../ui.js';
import { getProducts, saveProduct, removeProduct, addSampleProducts, importFromFirebase } from '../products.js';
import { compressImage, uploadImage, deleteImage } from '../images.js';

const thumb = (p) => h('div', { class: 'thumb' }, p.image ? h('img', { src: p.image, alt: '' }) : (p.emoji || '🛒'));

export function openProductsDialog({ config = {}, onChange }) {
  const dlg = h('dialog', { class: 'm3-dialog products-dialog' });
  const body = h('div', { class: 'pm-body' });
  dlg.append(body);
  dlg.addEventListener('close', () => { dlg.remove(); onChange(); });

  /* ---------- one-time helpers for an empty store ---------- */
  async function runOnce(btn, work, done) {
    btn.disabled = true;
    try { done(await work()); showList(); }
    catch (err) { snack(err.message, 7000); btn.disabled = false; }
  }
  const sampleBtn = () => {
    const b = h('button', { type: 'button', class: 'btn btn-text', onclick: () => runOnce(b, addSampleProducts, () => snack('10 sample products added')) }, 'Load 10 sample products');
    return b;
  };
  const importBtn = () => {
    const b = h('button', { type: 'button', class: 'btn btn-tonal', onclick: () => runOnce(b, importFromFirebase, ({ imported, skipped }) =>
      snack(`Imported ${imported} ${imported === 1 ? 'product' : 'products'}${skipped ? ` (${skipped} skipped: repeated SKU or missing details)` : ''}`, 6000)) },
      icon('cloud_download'), 'Import from Firebase');
    return b;
  };

  /* ---------- list view ---------- */
  function showList() {
    const list = getProducts();
    const row = (p) =>
      h('li', { class: 'pm-row' },
        thumb(p),
        h('div', { class: 'pm-main' },
          h('div', { class: 'title-s' }, p.name),
          h('div', { class: 'body-s muted' },
            p.soldByWeight ? `${money(p.price)}/kg · ${p.stock} kg in stock · SKU ${p.sku}` : `${money(p.price)} · ${p.stock} in stock · SKU ${p.sku}`)),
        iconBtn('edit', () => showForm(p), `Edit ${p.name}`));

    body.replaceChildren(
      h('div', { class: 'dlg-head' },
        h('h2', { class: 'title-l' }, 'Products'),
        h('span', { class: 'body-m muted' }, `${list.length} ${list.length === 1 ? 'item' : 'items'}`),
        h('span', { class: 'spacer' }),
        iconBtn('close', () => dlg.close(), 'Close')),
      h('div', { class: 'pm-actions' },
        h('button', { type: 'button', class: 'btn btn-filled', onclick: () => showForm(null) }, icon('add'), 'Add product'),
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
          category: v.category.trim(), emoji: v.emoji.trim(), image, soldByWeight: v.soldByWeight === 'on'
        });
        if (oldImage && oldImage !== image) deleteImage(oldImage); // old photo is no longer used
        snack(isEdit ? 'Product updated' : 'Product added');
        showList();
      } catch (err) {
        if (newUrl) deleteImage(newUrl); // don't leave an unused photo behind
        snack(err.message, 5000);
        saveBtn.disabled = false;
      }
    }

    async function del() {
      if (!confirm(`Delete "${p.name}"? This cannot be undone.`)) return;
      try {
        await removeProduct(p.id);
        deleteImage(p.image);
        snack('Product deleted');
        showList();
      } catch (err) { snack(err.message, 5000); }
    }
  }

  showList();
  document.body.append(dlg);
  dlg.showModal();
}
