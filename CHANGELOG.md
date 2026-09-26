# Changelog

All notable changes to LOCAL POS are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project uses
[semantic versioning](https://semver.org/spec/v2.0.0.html).

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
