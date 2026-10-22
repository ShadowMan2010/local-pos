# Licensing

Local POS uses a dual-licensing model:

## Open Source License (AGPL-3.0)
The core POS functionality is licensed under the [GNU Affero General Public License v3.0](LICENSE). This means if you modify and host this software as a service, you must share your source code.

## Commercial License
For businesses that want to use Local POS without AGPL-3.0 obligations (e.g., proprietary SaaS offerings), commercial licenses are available. See [COMMERCIAL-LICENSE.md](COMMERCIAL-LICENSE.md).

## Premium Features
Some advanced features require a valid Pro licence key:
- AI-powered catalog scanning (Gemini/OpenAI) — `ai_scan`
- Voice ordering via WhatsApp — `voice_ordering`
- WhatsApp announcements to saved customers — `whatsapp_announce`
- WhatsApp payment-screenshot handling — `whatsapp_payment`

These features are gated by the licence system. Core POS functionality (billing, products,
inventory, receipts, delivery, reports) remains fully open under AGPL-3.0, and needs no key.

## Pro licence keys

A key is a signed string you paste into **Settings → Local POS Pro**. It carries the customer, the
type, the features and an expiry date, and is verified on the shop's own machine with a signature —
there is no call home, so a till on a broken connection still works, and no customer list ever leaves
the shop.

### Issuing a key (vendor only)

The signing key lives in `~/.config/local-pos/license-private.pem` and must never be committed. To
mint a key:

```bash
npm run license:key -- --id <customer-ref> --type pro --months 12
npm run license:key -- --id <customer-ref> --type enterprise --months 0   # never expires
npm run license:key -- --id <customer-ref> --type pro --days 14           # a trial
```

Give the shop the printed key. It is checked when entered, so a mistyped or tampered key is refused
at the door rather than saved and discovered later. The matching public key lives in `license.js`.

