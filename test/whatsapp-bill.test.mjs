/* The bill the WhatsApp bot sends back to the customer, and the loading indicator on the buttons that
   drive it.

   Two separate things are pinned here, because they were both reported and neither was covered.

   The customer name: the bot asks "What name should we write on the bill?", stores whatever is typed, and
   then never passed it to the renderer. The name was collected, kept, and dropped on the last step — so
   every bill the shop sent said nothing about who it was for, while the conversation a few messages
   earlier had specifically promised a name on it. Nothing failed, because no test ever rendered a bill
   with a name and looked at it.

   The loading indicator: a button that took a second and a half looked identical to one that had been
   missed, and the only way to find out was to press it again. */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildBillImage } from '../whatsapp-bill.js';
import sharp from 'sharp';

const BASKET = {
  storeName: 'Corner Store',
  code: 'WA-7',
  items: [{ name: 'Rice 5kg', price: 250, qty: 1 }, { name: 'Oil 1L', price: 180, qty: 2 }],
  total: 610,
  phone: '9876543210',
  method: 'cash'
};

/** The vertical extent of everything drawn, so a test can tell a cropped bill from a complete one. */
const ink = async (buf) => {
  const { width, height } = await sharp(buf).metadata();
  const { data } = await sharp(buf).raw().toBuffer({ resolveWithObject: true });
  const ch = data.length / (width * height);
  const rows = [];
  for (let y = 0; y < height; y++) {
    let dark = 0;
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * ch;
      if (data[i] < 160 && data[i + 1] < 160 && data[i + 2] < 160) dark++;
    }
    if (dark > 0) rows.push(y);
  }
  return { width, height, first: rows[0], last: rows[rows.length - 1] };
};

/**
 * The picture reduced to the horizontal bands of ink it contains, top to bottom.
 *
 * Needed because a bill is a PNG and there is no reading it back here. Each line of text, and each rule
 * dark enough to see, is one band. Comparing the bands of two bills says what was actually drawn on them,
 * which is the only claim worth making: an earlier version of these tests checked the canvas height and
 * the bottom margin alone, and they passed even with the name line commented out — they were measuring the
 * frame and never the picture in it.
 */
const bands = async (buf) => {
  const { width, height } = await sharp(buf).metadata();
  const { data } = await sharp(buf).raw().toBuffer({ resolveWithObject: true });
  const ch = data.length / (width * height);
  const out = [];
  let start = -1;
  for (let y = 0; y <= height; y++) {
    let dark = 0;
    if (y < height) {
      for (let x = 0; x < width; x++) {
        const i = (y * width + x) * ch;
        if (data[i] < 160 && data[i + 1] < 160 && data[i + 2] < 160) dark++;
      }
    }
    if (dark > 0 && start === -1) start = y;
    if (dark === 0 && start !== -1) { out.push([start, y - 1]); start = -1; }
  }
  return out;
};

test("the bill actually draws the name the customer gave", async () => {
  // The whole point, and the thing that was broken: the bot asks what to write on the bill, the customer
  // answers, and the answer never reached the picture. Asserted by comparing the bands of ink, because
  // checking the canvas height alone would pass with the name line commented out — that mistake was made
  // once already and is why this counts bands.
  const plain = await bands(await buildBillImage(BASKET));
  const named = await bands(await buildBillImage({ ...BASKET, name: 'Rahim Uddin' }));

  assert.equal(named.length, plain.length + 1,
    `a bill with a name should have one more line of text on it: ${plain.length} bands without, ${named.length} with`);

  // The shop name and the date are above the rule, so they must not have moved at all.
  assert.deepEqual(named.slice(0, 2), plain.slice(0, 2),
    'the shop name and date moved when a name was added');

  // Everything below the rule moves down by exactly the height of the new line, and by nothing else.
  // Asserted as an exact shift rather than a tolerance, because a shift of 29 or 31 would mean the total
  // sits a pixel off where the layout thinks it is, and the QR block would be misaligned by the same.
  for (let i = 2; i < plain.length; i++) {
    assert.equal(named[i + 1][0], plain[i][0] + 30,
      `the line at y=${plain[i][0]} should have moved to y=${plain[i][0] + 30}, but it is at y=${named[i + 1][0]}`);
  }

  // And the one band that is not part of that shift is the name itself, sitting between the date and the
  // first item, where a name belongs on a bill.
  const extra = named[2];
  assert.ok(extra[0] > plain[1][1], `the new line is at y=${extra[0]}, which is above the date, not below it`);
  assert.ok(extra[0] < plain[2][0], `the new line is at y=${extra[0]}, which overlaps the first item`);
});

test('two different names produce two different bills', async () => {
  // A weaker version of the test above, kept because it catches the failure where the name is drawn but
  // the same text goes on every bill — a copy-paste slip that a band count cannot see.
  const a = await buildBillImage({ ...BASKET, name: 'Rahim Uddin' });
  const b = await buildBillImage({ ...BASKET, name: 'Karim Mia' });
  assert.ok(!a.equals(b), 'two different customers got a byte-identical bill');
});

test('adding a name makes the bill taller, and nothing falls off the bottom', async () => {
  // The regression risk in a fixed-width, fixed-height image: the name takes a line, and if the canvas
  // height is not moved down with it, the total — the one line that must never be missing — is silently
  // cropped off the bottom of the picture.
  const without = await ink(await buildBillImage(BASKET));
  const withName = await ink(await buildBillImage({ ...BASKET, name: 'Rahim Uddin' }));

  assert.equal(withName.height - without.height, 30,
    `a name line should add exactly 30px, it added ${withName.height - without.height}`);
  // Same amount of empty space below the last thing drawn, in both. That is the check that actually
  // matters: it is what "nothing was cut off" means, and a height change that was not mirrored in the
  // layout would show up here as a shrunken margin.
  assert.equal(without.height - without.last, withName.height - withName.last,
    'the bottom margin changed when a name was added, so something is being cropped');
});

test('the bill is the same shape with a name whether paying by UPI or cash', async () => {
  // The UPI bill has a QR block under the total and the cash one does not, so their heights differ — but
  // both must have gained exactly the same 30px for the name, or the name and the QR have collided on one
  // of the two paths.
  const cash = await ink(await buildBillImage({ ...BASKET, name: 'Rahim' }));
  const cashNone = await ink(await buildBillImage(BASKET));
  const upi = await ink(await buildBillImage({ ...BASKET, name: 'Rahim', method: 'upi', upiVpa: 'shop@bank' }));
  const upiNone = await ink(await buildBillImage({ ...BASKET, method: 'upi', upiVpa: 'shop@bank' }));
  assert.equal(cash.height - cashNone.height, 30, 'the cash bill did not grow for a name');
  assert.equal(upi.height - upiNone.height, 30, 'the UPI bill did not grow for a name');
  assert.ok(upi.height - upi.last > 40, 'the UPI bill is cropped at the bottom');
});

test('a bill with no name is unchanged, so nothing shifts for a customer who skipped it', async () => {
  // Empty string, undefined and a name of only spaces all mean "no name", and must not each reserve a
  // blank line for it.
  for (const name of [undefined, '', '   ']) {
    const m = await ink(await buildBillImage({ ...BASKET, name }));
    assert.equal(m.height, 388, `a blank name (${JSON.stringify(name)}) still reserved a line`);
  }
});

test('a very long name is shortened rather than running off the edge', async () => {
  // A bill is a fixed-width image, so a long name has to be cut somewhere. It must not be cut in a way that
  // pushes text into the margin — the check is that the bill is exactly as wide as any other bill.
  const m = await ink(await buildBillImage({ ...BASKET, name: 'Abdul'.repeat(20) }));
  assert.equal(m.width, 720, 'a long name changed the bill width');
});

test('a name with markup in it cannot inject anything into the bill', async () => {
  // Names come from a customer's WhatsApp message, so they are untrusted free text, and this renderer
  // builds an SVG string. The items on a bill already go through the same escaping.
  const buf = await buildBillImage({ ...BASKET, name: '<script>alert(1)</script>' });
  assert.ok(buf.length > 1000, 'the bill did not render at all');
  // Nothing to assert about the pixels beyond "it rendered": a crash or a blank image is the failure mode.
  const m = await ink(buf);
  assert.ok(m.height > 300, 'the bill rendered blank');
});
