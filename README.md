# LOCAL POS — Material 3 Web POS

## Run

```bash
npm install
npm start            # http://localhost:3000
```

First launch shows the **Setup wizard**. After saving you land on the POS dashboard; the gear icon in the top bar reopens the same form.

## Structure

```
server.js                     local database (products, bills, customers), photo upload, WebSocket hub for the customer display
public/
  index.html                  POS entry
  display.html                customer screen (Raspberry Pi)
  css/m3.css                  Material 3 tokens (light/dark) + components
  css/print.css               58 / 80 mm thermal print rules
  js/main.js                  boot: setup wizard or dashboard
  js/ui.js                    h(), icons, snackbar, theme, QR helper
  js/store.js                 config cache, paper width, queue of bills the server could not save yet
  js/api.js                   fetch wrappers for the backend
  js/products.js              catalog in memory + add/edit/delete through the server
  js/customers.js             phone-number cleaning + customer lookups
  js/images.js                phone-side photo compress + upload to the server
  js/cart.js                  cart + discount state
  js/barcode.js               USB scanner keydown buffer
  js/payment.js               UPI QR from the shop's UPI ID (receipt vs external display)
  js/camera-scan.js           webcam/phone camera QR scanner (alternative to a USB scanner)
  js/weigh-api.js             API client used by weigh.html (configurable server address)
  js/weigh.js                 boot file for weigh.html
  js/display-link.js          POST to the customer display
  js/display.js               customer display page (WebSocket client)
  js/components/              setup-wizard, dashboard, catalog, cart-panel, receipt-dialog, products-dialog, customers-dialog, weigh-station, whatsapp-orders-dialog, deliveries-dialog, daily-summary-dialog
whatsapp-bot.js                WhatsApp reply text + order-parsing logic (pure — no network code, testable on its own)
whatsapp-bill.js               draws the order bill as a PNG (with the UPI QR) — pure, no network code
whatsapp.js                    the actual WhatsApp connection (Baileys) — only loaded if its package is installed; see below
stats.js                       daily sales aggregation + achievement rules (pure — no server code, testable on its own)
```

## Where the data lives (everything is on the POS computer)

No cloud database is used. Everything is saved in the `data/` folder next to `server.js`
(or in the folder named by the `POS_DATA_DIR` environment variable, e.g. a second drive):

| File | What it holds |
|---|---|
| `config.json` | store name, address, phone, UPI ID, QR mode |
| `products.json` | product catalogue and stock |
| `customers.json` | one entry per phone number: name, visit count, total spent, first/last visit |
| `orders.jsonl` | every paid bill, one per line (append-only) |
| `counters.json` | today's bill counter, so two phones never issue the same number |
| `uploads/` | product photos |
| `wa-orders.json` | orders received over WhatsApp, pending/accepted/dismissed |
| `wa-counters.json` | today's WhatsApp order-code counter (kept separate from the bill counter) |
| `whatsapp-session/` | WhatsApp login — present only once WhatsApp is set up (see below); treat it like a password |

- Files are written to a temporary file first and then renamed, so a power cut cannot leave a half-written file.
- If a data file is damaged the server **refuses to start** instead of silently replacing it with an empty one.
- **Back up the whole `data/` folder** (USB drive or a second computer, at least daily). It is your only copy.
- `customers.json` and `orders.jsonl` contain customers' names and phone numbers. Keep backups private and keep the server on the shop LAN.
- There is no login yet: anyone who can open the POS address can read the products, customers and bills and can change the settings. Do not expose port 3000 to the internet.
- Bill numbers roll over at midnight in India time (`Asia/Kolkata`). Set `POS_TZ` to change that.

## Customers

In the cart, type the customer's **phone** (10-digit mobile, `+91` and spaces are fine) and **name**.

- A phone number seen before fills the name in automatically and shows how many visits so far.
- When the bill is marked paid the server adds one visit and the bill amount to that customer.
- The bill prints **Customer / Phone / Visit no.** under the date.
- Phone and name are optional. A bill with no phone number is a walk-in and is not counted. A wrong phone number stops the sale until it is fixed or cleared.
- The people icon in the top bar lists all customers (search by name or phone) with visits, total spent and last visit.

## Scanning: USB scanner or camera

Anywhere the POS expects a scan (a product barcode, or a weighing-station ticket), there are two
ways to do it, and both work at the same time:

- **USB barcode scanner** — plug it in, it needs no setup. It works everywhere on the page (not just one box).
- **Phone/webcam camera** — tap the camera icon (next to search, and in the top bar) to open a live scanner. Useful when there is no USB scanner yet, or the device only has a camera (a phone, a laptop).

## Loose items sold by weight (dal, rice, etc.) and the weighing station

For items sold by weight rather than by the piece, mark the product **"Sold by weight"** in the
product manager. Its price becomes **per kg**, and its stock is tracked in **kg** instead of units.
A "sold by weight" product does not get an "Add to cart" button in the main catalog, so it enters
a bill one of two ways: through a **weighing-station ticket** (the exact weight off the scale), or
through a **WhatsApp order where the customer declared a weight**. Either way the till shows the kg
and the line total, and the cashier can correct the weight before charging — see
[WhatsApp orders](#whatsapp-orders-the-till-side).

**`weigh.html`** is a separate kiosk page for the scale area:

1. Open `http://<computer-ip>:3000/weigh.html` on the computer next to the scale (it can be the
   same computer as the till, or a separate mini PC / Raspberry Pi — see below).
2. The customer/staff taps the item (or scans its barcode with the camera icon).
3. **There is no real scale wired in yet.** Weight is typed in on the on-screen keypad, at the
   spot in the code where a real scale's reading would be read instead — see `js/components/weigh-station.js`,
   function `pickItem`. Connecting a real scale needs a scale with a USB or serial (RS-232) output;
   many inexpensive shop scales don't have one, and the alternative (a load-cell kit) is a separate,
   fairly involved electronics project. Ask if you'd like help with a specific scale model.
4. "Generate ticket" shows a full-screen QR code (with the item, weight and price also printed as
   plain text, in case the QR can't be scanned) and a short **text code** as a backup.
5. At the till, scanning that QR (USB scanner or the camera icon) adds the item to the cart with
   its exact weight and price. **Each ticket works once** — scanning it again is rejected. A ticket
   not used within **20 minutes** expires and the item must be weighed again.
6. Stock for that item goes down by the weight actually sold, at the moment the bill is paid (same
   as everything else) — not when the ticket is created, so a ticket that is never used doesn't
   affect stock.

**Weighing station on a separate computer:** open `weigh.html`'s **gear icon** and enter the till's
address (e.g. `http://192.168.1.10:3000`) so it talks to the same server. Both devices must be on
the same Wi-Fi/network. Tickets are kept in the server's memory only — if the server restarts, any
ticket not yet scanned is lost and must be weighed again.

## Products and photos

Top bar **box icon** opens the product manager: add, edit, delete, choose a photo (camera or gallery) and scan the barcode into the SKU box. On an empty store it can also load 10 sample products.

**Products that were in Firebase before:** if the server still has the old Firebase settings, the product manager shows an **Import from Firebase** button. It copies the `products` collection into `products.json` once (SKUs that already exist are skipped). It only works while the Firebase database rules still allow reading. Old Firebase orders are not imported.

Photos are shrunk on the device (max 640 px, JPEG) and saved in `data/uploads/`. Every device that opens this server sees the same photos.

## Payment

The QR is a UPI link built from the **UPI ID** in Settings, with the bill amount filled in. A plain UPI QR does not tell the POS when the money arrives, so the cashier taps **UPI received** (or **Cash received**) after checking the payment app.

## WhatsApp orders (beta, unofficial)

Customers can message your shop's **own WhatsApp number** — the phone that already has WhatsApp
on it — to see the catalogue and place an order, which then shows up as a notification (a bell
badge) on the till.

**Language:** everything the bot sends is in English. All of that text lives in
`whatsapp-bot.js`, one function per message, so changing a wording means editing one function
rather than hunting through the message handling. Keywords the customer types stay lowercase
English (`menu`, `yes`, `cancel`, `upi`, `cash`, `gpay`, `phonepe`, `paytm`); a couple of
Bengali spellings of "yes" are still accepted as input, but the replies are English.

**This is not the official WhatsApp Business API.** It works by connecting as a second "linked
device" on your existing WhatsApp number (via the [Baileys](https://github.com/WhiskeySockets/Baileys)
library), the same mechanism as WhatsApp Web. That means:

- **No Meta approval, business verification, or per-message cost** — unlike the official API.
- **It is against WhatsApp's terms of service**, and carries a small risk of the number being
  temporarily restricted, especially if it sends a lot of messages quickly. Keep it to genuine
  replies to your own customers — this is not built or intended for bulk marketing.
- It needs `@whiskeysockets/baileys` and `pino`, added to `package.json`. Run `npm install` after
  pulling this update, then restart the server, to turn it on. Until then, everything else in the
  POS works exactly as before — WhatsApp just stays off.

**Setup:** open **Settings** → **WhatsApp orders (beta)**. It shows a QR code — on the shop's
phone, open WhatsApp → **Linked devices** → **Link a device**, and scan it. Once linked, the
section shows the connected number. The login is stored in `data/whatsapp-session/` — back it up
like the rest of `data/`, and treat it like a password (anyone with that folder can send WhatsApp
messages as your shop's number).

**What a customer sees:** messaging the number (or texting "menu") gets a numbered list of in-stock
items, including items sold by weight at their per-kg price. They reply with item numbers, e.g.
`1,1,3` (two of item 1, one of item 3) or `1x2, 3x1`, get a total, and reply "yes" to confirm.
"cancel" abandons the order at any point.

**The customer's name:** straight after they confirm, the bot asks what name to write on the bill.
They type it, or send "skip" (or "na", "no name", "-") to leave it blank. It is optional and never
blocks the order: a payment word typed at this point ("cash", "upi", "no") is read as the payment
rather than as a name. The name is stored on the pending order, so **"Load into cart"** fills the
name into the customer box at the till along with the phone number — ready to correct or delete
before checkout. Because the name travels with the bill, charging the sale also writes it to that
customer's record, and a later bill that gives a better name overwrites the old one.

**Items sold by weight:** a customer can order them by writing how many kg they think they need —
`9x2.5` means "2.5 kg of item 9", and decimals are allowed (up to 3 places). A weight item on its
own, like `9`, means 1 kg. Normal per-piece items still only accept whole numbers, so `1x2.5` is
rejected. The summary the customer gets says that the shop will weigh the item again at
the counter, because the customer's number is only an estimate — see below.

**The bill, sent as a picture:** after confirming, the customer is asked how they want to pay —
"upi" or "cash". Either way the bill arrives in the chat as a picture, drawn by `whatsapp-bill.js`
with the itemised order and the total:

- **upi** — the bill also carries a scannable UPI QR code with the amount already filled in. If no
  UPI ID is set in Settings, the customer is told online payment isn't available and to pay cash.
- **cash** — the bill carries a note to pay at the counter instead.

The UPI payload is built exactly as `public/js/payment.js` builds it, so a customer scanning either
QR lands in the same UPI app with the same amount. Payment is still confirmed by the cashier: a
plain UPI QR has no way to report back to the till, so sending the QR does not mark the order paid.

**What you see:** the **chat bubble icon** in the top bar badges with the number of orders
waiting. Opening it shows each order's name and phone number, items and total; **"Load into cart"**
puts the items into the current sale (at today's live prices and stock — an item that's sold out or
been removed since is skipped with a note) and fills in the customer's phone number and name, so you
can add anything else, apply a discount, and check out exactly as normal. **"Dismiss"** clears an
order without billing it (e.g. it's a duplicate, or the customer never followed up).

**Correcting a declared weight:** a weight that came off the scale is trustworthy and is shown as
fixed ("Weighed"). A weight the customer typed on WhatsApp is only their claim, so it lands in the
cart with a **"Check"** chip and a kg box. Weigh the item, type the real reading into that box, and
the line total and bill total update immediately. Only kg that is actually in stock is accepted.
**Always weigh before charging** — the customer's number is an estimate, and a UPI QR was already
sent for the estimated total, so if the real weight is higher you'll need to collect the difference
(or refund it if the item was lighter).

## Home delivery from a WhatsApp order

A bill that came from a WhatsApp order is treated as a delivery, and it works in two stages, the way a
parcel courier does: the shop packs it, the delivery boy collects it, then he hands it over. Each
stage is confirmed by a scan, and each scan proves a different thing.

| Stage | Who scans | What it proves | Code the customer has |
|---|---|---|---|
| Packed → out | delivery boy, at the shop, the **package sticker** | he is walking out with the goods | none yet |
| Out → delivered | delivery boy, at the door, the **customer's QR** | the goods reached the customer | QR + 4-digit code |

The customer is told the boy's **name** in both messages, so they know who is coming and can ask for
him by name instead of describing an unnamed rider to whoever opens the door. If no boy was assigned
to the bill, the line is simply left out rather than showing a blank.

The two QR codes are **different secrets**. The sticker only says "this boy is leaving the shop with
this parcel"; the customer's says "these goods reached me". Keeping them apart means neither can be
used to fake the other, and it means the customer is never told an order is on its way until a boy is
actually carrying it.

1. **Register the delivery boys** in **Settings → Delivery boys** — just their name and their own
   WhatsApp number. A message from one of those numbers is read as a delivery update, never as a new
   customer order (otherwise a 4-digit code could be misread as an item order). A number on this list
   therefore *cannot* order from the shop; if a real customer is also a delivery boy, one of those
   two is wrong.
2. **Charge the order as usual.** On a WhatsApp order the bill screen first asks **who is
   delivering**; the payment buttons stay disabled until a boy is picked. With one boy on the list
   he is chosen for you.
3. **Two messages go out automatically.** The customer is told the order is **being packed** — and is
   deliberately *not* given a code yet, because the parcel is still in the shop and a boy who never
   collects it should not have already told the customer it is on its way. The delivery boy gets the
   bill number, the customer's number, the items, the amount, and instructions to send a photo of the
   package sticker.
4. **Print the package sticker.** In the deliveries list, **Sticker** opens a printable label with a
   QR code for that parcel. Stick it on the package. The same sticker keeps working after a hand-back
   or a reassign, so it only ever has to be printed once.
5. **He collects the parcel** by sending that sticker as a photo to the shop's WhatsApp number. The
   bill becomes **out for delivery**, and only now does the customer get their QR code and 4-digit
   code. He is never told either secret, so he cannot get ahead of the customer.
6. **At the door**, the customer shows him the QR. The boy sends that picture straight back to the
   shop's WhatsApp number — no typing, nothing to mistype, and he need not read any text. The bot
   reads the code out of the photo, marks the bill **delivered**, replies to the boy, and tells the
   customer it arrived. If the photo will not read, he can type the 4-digit code instead and that
   works exactly the same. Only a registered delivery boy can confirm, by photo or by code.
7. The **scooter icon** in the top bar badges with how many orders are still moving, and opens a list
   of everything **packed** or **out**, each labelled with which stage it is at. An out-for-delivery
   row has a box to type the customer's 4-digit code in yourself — useful when he can't send it and
   the shop is closing the order by hand. Neither any code nor either QR secret is ever shown in that
   list or sent to the browser, because showing the shop a secret that proves the customer handed it
   over would defeat the point. If a message failed to send, that order says so.
8. Two extra buttons on each out-for-delivery row: **Resend** puts the same message out again, and
   **New code** issues a fresh code *and* a fresh QR secret to the customer alone, invalidating both
   old ones. Use **New code** when the current pair can no longer be trusted as proof — for instance
   if it turns out the delivery boy already had it. The boy is never texted either secret, so
   replacements stay secret from him and the check keeps its meaning.

**If a boy can't take the job**, he replies **"can't"** from his own WhatsApp and it comes off the
list, ready to be given to somebody else. The customer is only ever told an order is being packed, so
nothing has been promised to them that this breaks. From the till, a packed row offers **Give to
another boy** (which messages the new boy the job), **Hand back**, and **Picked up** — a shop-side
fallback for a torn sticker or a phone camera that can't read it, which tells the customer exactly
what a real scan would. Once a boy has scanned the sticker he is holding the goods, so **reassigning
and handing back are refused from that point on**: putting a different name on the record would be a
lie about who has the parcel.

**The customer is never lied to.** Telling them an order is out for delivery happens on the scan, not
on the billing. And a customer who somehow offers their 4-digit code before the parcel has been
collected is refused, with a message telling the boy to scan the sticker first — otherwise a job could
be closed for goods nobody ever picked up.

Why a secret at all: it is the only part of the handover neither side can fake alone. Only the
customer can supply it, so the shop can't claim a delivery that didn't happen, and the delivery boy
can't mark an order done while the customer isn't there. It has to stay a secret from the delivery boy
for that to be true. The package sticker works the same way in reverse: the shop printed it and stuck
it on the goods, so a boy can only produce it while standing in the shop holding the parcel — which
is what makes "he collected it" a fact rather than a claim.

**Guessing is not a threat.** A 4-digit code is only 10,000 possibilities, so a delivery boy could
in principle sweep every open order just by sending numbers until one landed. Two things stop that.
The QR carries a 96-bit random secret instead, which cannot be swept; and the code path is rate
limited per boy anyway — five wrong codes in ten minutes locks him out for ten. A couple of honest
typos is fine, and one correct code clears the slate.

What a secret does *not* do is stop a customer being given the wrong goods — for that, still confirm
the items at handover. A determined customer can also read the code out over the phone, or photograph
the QR before the boy arrives, which defeats the check; that is a limit of any secret the customer
holds. And if a photo is too blurry or too compressed to read, that is what the 4-digit code is
there for.

**Welcome message:** the first time a phone number is saved as a customer (i.e. the first bill
with that number), a short welcome message is sent automatically, if WhatsApp is connected at that
moment. If it's not connected, the message is simply skipped — it does not queue or retry.

**Known limits:** replies are a fixed numbered-menu flow, not free-form text — a message like
"2kg rice please" won't be understood, only the exact formats above. A declared weight is never
cross-checked against the scale automatically, so the cashier must do it. There's no order history
beyond the pending list (accepted/dismissed orders aren't shown anywhere in the UI, though they
stay in `data/wa-orders.json`). Only one shop phone number can be linked at a time. A delivery boy
must message from the exact number registered in Settings, since that number is what marks his
message as a delivery update rather than an order.

## Today's sales and achievements

The **trophy icon** in the top bar opens a quick end-of-day-style view of **today only**:

- A few fun milestone badges — first bill of the day, sales crossing ₹1,000 / 5,000 / 10,000 and
  so on, a bill count milestone, an unusually large single bill, or one item selling in bulk. Only
  the highest milestone in each category shows (crossing ₹10,000 doesn't also show the ₹1,000 and
  ₹5,000 badges).
- Today's total sales and number of bills.
- Every item sold today, most valuable first, with quantity (kg for weighed items) and revenue.
- **Stock position**: what's out of stock, and what's running low (5 or fewer left).

This reads today's paid bills already held in memory — nothing new is stored on disk for it. It
resets naturally at midnight (`POS_TZ`) since a new day has no bills yet.

## Customer display on a Raspberry Pi Zero 2W

Default (hub mode): the Pi only runs a browser.

```bash
chromium-browser --kiosk --noerrdialogs --disable-infobars http://<POS-IP>:3000/display.html
```

Direct mode: run `server.js` on the Pi too, and put `http://<PI-IP>:3000` in **Customer display address** in Settings. The POS then POSTs to the Pi's `/api/display/push`.

The QR image is drawn in the browser by `qrcodejs` from a CDN. For an offline Pi, download that file into `public/js/` and change the `<script src>` in `display.html`.

## Printing

Receipt preview → **Print bill**. Pick 58 or 80 mm in the dialog. In the browser print dialog choose the thermal printer, margins "None", scale 100%. For silent printing start Chrome with `--kiosk-printing`.

## Known limits / next steps

- The weighing station has no real scale connected — weight is typed in by hand (see the section above).
- WhatsApp orders use an unofficial connection method and a fixed numbered-menu flow (see the section above).
- Payment confirmation is manual. Automatic confirmation needs a payment gateway with webhooks (and a public HTTPS address for the callback).
- No login / roles yet (see the note above), no returns or refunds, no public e-commerce storefront.
- `orders.jsonl` is loaded into memory at start-up. That is fine for a shop for years; for very large volumes move to SQLite.
