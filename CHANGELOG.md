# Changelog

All notable changes to LOCAL POS are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project uses
[semantic versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Handover photos

- The **4-digit code is unchanged and still completes a delivery on its own.** A photo is
  evidence, not a condition: a delivery that really happened is never refused because a
  camera would not cooperate, and a bill closed by code is recorded honestly as having
  no picture.
- When the delivery boy sends a photo of the customer's QR, that same picture is stored
  against the bill. The image is downloaded once and used for both the scan and the
  evidence, so a slow phone connection is not paid for twice.
- Stored copies are shrunk to 1280px and re-encoded as JPEG (an 18 MB photo becomes
  around 250 KB) and the EXIF block is dropped — a photo taken at a customer's door
  otherwise records the GPS position of their home.
- The till's delivery dialog has an optional **Photo** button that opens the camera. The
  photo is uploaded first and the code confirmed after, so a wrong code cannot leave a
  half-finished handover.
- Photos live in their own `delivery-photos/` folder, never `uploads/`, so the
  product-photo cleanup can never delete evidence. The file type comes from the bytes and
  the filename is built by the server; an off-server or path-traversing URL is refused.
- **Recently delivered** appears under the live list, with a thumbnail for a photographed
  handover and a dashed "no photo" marker for a code-only one.
- **Fixed:** an over-sized photo produced a 500 with a stack trace, because the body
  parser throws before the route handler runs. It is now a clear 413.

### Customers are told who is bringing the order

- The "out for delivery" message already named the boy; the **delivered** and
  **replacement-code** messages now name him too, so a customer can say who handed the
  order over if something is wrong. A bill with no boy recorded is left unchanged rather
  than printing "undefined".

### Cost prices and profit

- Per-product cost prices, editable from the product dialog. An unknown cost is `null`,
  not `0`, so it is never silently counted as free stock.
- Cost is snapshotted on the bill at the moment of sale, so a later price change cannot
  rewrite past profit.
- Daily summary and reports show cost, profit and margin. **Profit stays hidden unless
  every sold line is costed** — a margin computed from part-known costs is worse than none.

### Reports and CSV export

- `Reports` in the top bar: any date range (default last 7 days), what sold, day-by-day
  trend, and CSV download of orders, products and days.
- Days are bucketed in shop-local time (`POS_TZ`), not UTC, so a late-night bill lands on
  the right day.
- CSVs are RFC 4180 quoted, written with a UTF-8 BOM so Excel opens Bengali and ₹ correctly,
  and any cell starting `=`, `+`, `-` or `@` is prefixed so a product name cannot become a
  formula.

### Testing

- `npm test` runs the API and image-pipeline suites; `npm run test:ui` drives the
  deliveries dialog in a real browser.
- **Added `POS_NO_WHATSAPP=1`.** The suites run against a throwaway copy of `data/`, and
  that copy used to include `whatsapp-session/` — so a test could bring the shop's real
  WhatsApp account online and text real customers from a synthetic bill. The switch exists
  so that cannot happen, and the tests now set it and never copy the session.

## [0.2.0] — first packaged release

The first release with a downloadable package. Covers everything built while
shifting the app from a single-counter till to a WhatsApp-ordering shop with
verified home delivery.

### WhatsApp ordering

- Customers message the shop's own WhatsApp number and get a numbered catalogue
  of in-stock items, including items sold by weight at their per-kg price.
- Orders are placed with item numbers (`1,1,3` or `1x2, 3x1`), confirmed with
  `yes`, and abandoned with `cancel`. Weight items accept decimals (`9x2.5`).
- The bot asks **what name to write on the bill** after the order is confirmed.
  It is optional — `skip`, `na`, `no name` or `-` skip it — and a payment word
  typed at that point is read as the payment rather than as a name, so somebody
  called Cash is not billed to "Cash".
- The name is stored on the pending order, so **Load into cart** fills the
  customer box at the till with both phone and name. Charging the bill writes it
  to that customer's record, and a later, better name overwrites an earlier one.
- The pending-orders list shows each order's name and phone, not just the number.
- **Fixed:** outbound JIDs were built from 10-digit numbers and silently dropped
  by WhatsApp. Numbers are now normalised to `91XXXXXXXXXX`.
- **Fixed:** a registered delivery boy's number was compared raw against the
  12-digit incoming JID, so no delivery boy could ever be recognised.

### Home delivery, in two verified stages

Modelled on parcel delivery: the shop packs the order, the delivery boy collects
it, then he hands it over. Each stage is confirmed by a scan, and each scan
proves a different thing.

| Stage | Who scans | What it proves |
|---|---|---|
| packed → out | delivery boy, at the shop, the **package sticker** | he is walking out with the goods |
| out → delivered | delivery boy, at the door, the **customer's QR** | the goods reached the customer |

- **Two separate secrets.** The package sticker and the customer's handover QR
  are different random tokens, so neither can be used to fake the other.
- The customer is told the order is **being packed** and is given no code at all
  until the boy actually collects it — so they are never told an order is on its
  way when nobody is carrying it.
- A parcel sticker is printed from the till (`Sticker`), and survives a hand-back
  or reassign, so it only ever has to be printed once.
- The customer is told the **delivery boy's name** in both messages.
- The handover QR carries a 96-bit secret with the 4-digit code as a fallback
  for a phone that cannot read it. The boy is never told either.
- Wrong codes are rate limited per boy: five misses in ten minutes locks him out
  for ten. Honest typos are fine; sweeping all 10,000 is not.
- A customer who offers their code before the parcel has been collected is
  refused, and the boy is told to scan the sticker first.
- A delivery boy replies **"can't"** to hand a job back, and the till can give it
  to somebody else. Reassigning and handing back are refused once he has scanned
  the sticker, because he is holding the goods.
- **Fixed:** the delivery boy's job message used to contain the handover code,
  which let him close a delivery at pickup without the customer ever handing
  anything over. The code now only ever reaches the customer.
- **Fixed:** the plain-text fallback told the customer to "show the QR code
  above" in the one case where no QR had been sent.

### Project

- Renamed to **LOCAL POS** in the package name, README, startup log, browser
  title and the Baileys linked-device name. Internal class names are unchanged.
- All WhatsApp messages are in English. Commands stay English, with a couple of
  Bengali spellings of "yes" still accepted as input.
- `data/` is gitignored — it holds the WhatsApp login session, customer phone
  numbers and order history.
- `server.js` gained a shebang and a `bin` entry, so the app can be run as a
  command and packed as a self-contained archive with no `data/` inside it.
