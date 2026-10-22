# Android app — build prompt

Hand this prompt to an agent when you start the Android work. It is a spec/prompt, not the
module's own README (the Android project writes its own `android/README.md`).

```text
You are a senior Android engineer. Build a native Android app for the existing project at
/home/dhruba/m3-pos ("Local POS"), a small Indian neighbourhood-shop point-of-sale system. Before
writing code, read the repository to learn the real API surface, data model, and conventions —
do not invent endpoints or fields. This is a NEW module inside the existing repo, under `android/`.
Do not modify the existing Node server, PWA, or WhatsApp bot behaviour except to add narrowly
scoped endpoints if something is genuinely missing (call it out first).

## What the existing project is
- A Node.js server (`server.js`, default http://127.0.0.1:3000) that serves an offline-first
  Material 3 PWA and the JSON API the till uses. Also runs a WhatsApp bot (Baileys) for customer
  ordering/voice/complaints, a weighing station, display casting (/api/display/push, behind a PIN),
  delivery-boy flows, and per-shop Gemini AI (photo→catalogue, bill reading, complaint triage).
- The till is PIN-gated and also supports TOTP 2FA. Config lives in `config.json`; data in `data/`.
- The PWA is offline-first (service worker) and is used on the same LAN as the server.

## Goal
A native Android app for the shop OWNER'S TILL DEVICE ONLY (a counter tablet/phone). It replaces the
browser as the daily billing surface, talks to the existing POS server, and adds the hardware
features a browser cannot do. It must be fully usable to ring up and take payment with NO network,
reconciling with the server when connectivity returns.

## Tech stack
- Kotlin, Jetpack Compose (Material 3, matching the PWA's Material 3 look), single-activity.
- Gradle Kotlin DSL + version catalog. Min SDK 26, target/compile latest stable.
- Architecture: MVVM + unidirectional state (ViewModel + StateFlow/Compose state). Repository layer
  over Retrofit/OkHttp for the API and Room for local persistence. Kotlin coroutines/Flow.
- DI with Hilt. Navigation-Compose. DataStore/EncryptedSharedPreferences for secrets.
- No Firebase Analytics/Crashlytics; FCM only.

## Integration and offline model (most important part)
- Treat the POS server HTTP API as the source of truth when reachable. Retrofit client with a
  configurable base URL (LAN IP or Tailscale hostname), edit in Settings.
- Auth: reuse the existing PIN gate and, if enabled, TOTP 2FA. Keep the PIN/session token in
  EncryptedSharedPreferences (Android Keystore). Never hardcode secrets.
- Offline-first: Room is the read cache for catalogue, prices, stock, tax/settings, and the local
  order outbox. The whole billing flow (scan/select items, weigh loose items, totals, cash/UPI,
  print bill) must work offline. Queue writes (orders, stock changes, payments) in an outbox table
  and sync idempotently on reconnect, using a client-generated idempotency key per order so a retry
  never double-books. Show a clear "Offline — N waiting to sync / Last synced …" banner.
- Discover the real endpoints from the repo (look at the PWA's API client `public/js/api.js` and the
  server routes). Mirror the shapes exactly. If a WebSocket/SSE feed already exists for live order/
  complaint/display updates, use it; otherwise poll.
- FCM: register for order/complaint alerts when backgrounded, but the app must be fully functional
  without it. Degrade silently when there is no internet or no FCM project configured.

## Screens / functional parity (port these from the PWA)
- Unlock: PIN (and TOTP if enabled), then BiometricPrompt (fingerprint/face) as a convenience gate.
- Billing/checkout: search + barcode scan, category browse, cart with line editing, loose items with
  weight entry, per-item and cart totals, tax if configured, cash/UPI payment, change due, "Charge".
- Take payment, produce a bill, and print it (see printer below). Support the same bill content and
  fields the PWA bill has (store name, code, items, weights, total, payment method, UPI VPA/QR).
- Products: list/search/edit/add, including the Gemini photo→catalogue capture (below).
- Orders history / open orders / delivery states (mirror the PWA's delivery + handover flow).
- Complaints: list, view transcript, severity, reply (replies are ENGLISH only — this was just made
  English-only across the project; do not add other-language reply UI).
- Settings: store details, logo, UPI VPA, printers, server address, PIN/2FA, AI/voice toggles
  (mirror what the PWA Settings exposes; keep secrets on-device).
- Weighing-station pairing if relevant to this device.
- Reports: today's sales summary, and a share button (see share sheet).

## Native capabilities to implement
1. Bluetooth thermal printer (ESC/POS, 58 mm and 80 mm): discover/pair/select printer in Settings,
   render a receipt bitmap or text, print the customer bill, reprint. Handle paper-out/offline
   gracefully and never lose a sale because printing failed (offer reprint/share instead).
2. Camera barcode/QR scanner: use CameraX + ML Kit Barcode Scanning. Scan product barcodes to add to
   cart; scan delivery/handover QR stickers for the delivery flow. Works offline.
3. ML Kit camera → catalogue: on-device capture; send the image to the existing Gemini
   photo→catalogue endpoint when online; if offline, queue the image and process on reconnect. Show
   the recognised product for the owner to confirm before saving.
4. Biometric unlock via BiometricPrompt, fallback to PIN.
5. FCM push notifications (order/complaint) — optional, graceful offline.
6. Kiosk / lock-task mode: opt-in setting using screen pinning / device-owner (DevicePolicyManager)
   so a guest cannot leave the till. Must be escapable by the shop with the PIN.
7. Home-screen widget (Glance): today's sales total + quick actions (e.g. open billing, scan).
8. Android share sheet: share a bill or a report as text and/or a generated image/PDF to other apps.

## Out of scope
- No customer-facing app; no delivery-boy app; no iOS.
- No cash-drawer kick; no Bluetooth weighing scale (explicitly not needed).
- Do not add non-English reply UI anywhere.

## Quality, conventions, and constraints
- Match the existing repo's care: small, well-named units; tests for pure logic; no comments that
  just restate code; never log secrets or card/bank data.
- Offline correctness is the headline requirement: write tests for the outbox/idempotency and for the
  offline→online reconciliation. Unit-test mapping of API DTOs and the bill renderer.
- Provide an instrumented smoke test for the billing-to-print happy path.
- Distribution is DIRECT APK SIDELOAD: configure a release build, a signing config whose keystore is
  NOT committed, minify with R8 + keep rules, and produce a signed `app-release.apk`. Document the
  install/upgrade steps in `android/README.md`.
- Keep the whole thing buildable with `./gradlew assembleDebug` on a clean machine.

## Deliverables
- `android/` Gradle project implementing the above, building to a debug APK and a signed release APK.
- `android/README.md`: prerequisites, how to point at the server, how to pair a printer, how to sign
  and sideload, and known limitations.
- A short list of any server-side endpoints you had to add, with rationale.

## Acceptance criteria
- With the server unreachable, the owner can unlock, scan/select items, enter weights, take cash/UPI
  payment, print a bill, and see it queued for sync.
- On reconnect, queued orders sync exactly once (no duplicate orders), and the banner clears.
- A real Bluetooth ESC/POS printer prints a correct bill; failure to print does not lose the sale.
- Barcode and delivery QR scans work offline; photo→catalogue works online and queues offline.
- Biometric unlock works; kiosk mode can be enabled and escaped with the PIN; the widget shows
  today's sales; the share sheet shares a bill.
- No secret is committed; release APK is signed and installs on a clean device.

Start by reading the repository and reporting: the exact API endpoints and DTO shapes you will use,
the auth flow, and any gaps you need the server to fill — THEN implement.
```
