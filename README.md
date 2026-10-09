# Pantri

A phone app for keeping a pantry stocked: an office kitchen, a shared flat, a café storeroom, or several places at once. Scan barcodes to track stock, expiry dates and reorders, and let it tell you what to check.

- **Scan** a barcode. The first time, it looks the product up on Open Food Facts. After that, one scan adds stock, counts it or logs waste. Multipacks count correctly: scanning a 6-pack adds 6 bottles.
- **Organise it your way** with nested locations (Kitchen › Fridge › Door, Storage › Shelf B) and categories.
- **Expiry dates per delivery.** Every restock is its own batch, so new stock never hides older stock. It warns you before items expire, including stock that *won't be used in time* at the current pace.
- **Usage rates and checks.** Set "water: 5 per day" or "chips: 1 per week". The app estimates what's left, and when something should be gone or low, the Today screen asks you to check it. Your counts teach it the real pace.
- **Several sites.** Top-level locations are sites. Each site keeps its own stock and reminders, and the Today screen groups reminders per site.
- **Reorder list.** It collects anything that's out, only expired, below its minimum, or will run out soon, and suggests how much to buy. Share it as text.
- **Waste log.** Thrown-out items are logged, and it flags what is being over-bought.
- **Optional account.** Sign in to keep your pantry backed up online and in sync on your phones, with earlier versions kept. Then you can also get a **daily reminder notification** about what to check, what has expired and what to use soon, on Android and on iPhone.

Everything has sensible defaults and the rest is optional. By default, usage counts every day, around the clock. Opening days and hours, closures (holidays) and per-site hours are only needed for places that aren't always in use.

It's an installable web app (PWA), not a store app, and it works offline. Without an account, all data stays on your phone, and the only thing sent anywhere is a barcode when it's looked up online. With an account, your pantry is also stored online; each account only ever sees its own data.

## Install on your phone

1. Open **https://urdateodor.github.io/Pantri/** on the phone:
   - Android: in Chrome.
   - iPhone: in Safari.
2. Install it:
   - Android: tap the menu (⋮), then **Install app** (or **Add to Home screen**).
   - iPhone: tap Share, then **Add to Home Screen**.
3. Open it from the new icon. Allow the camera the first time you scan.

On iPhone and iPad, notifications only work in the app added to the Home Screen (iOS/iPadOS 16.4 or newer). No App Store or developer account is involved.

Long-press the icon on Android for shortcuts: *Scan item*, *Restock* and *Reorder list*.

When a new version is published, the app shows "A new version of the app is ready". Tap **Update**.

## First steps

1. **Scan** your products. Give the ones that get used regularly a usage rate and a minimum to keep.
2. **More → Locations & sites:** shape your storage. Keeping stock in more than one place? Add each place as a site.
3. **Optional, More → Settings:** opening hours, closures and reminder windows, if the defaults don't fit.
4. **More → Notifications:** turn on the daily reminder (no account needed).
5. **More → Account & online backup** (optional): sign in to keep a copy online.
6. Without an account, **More → Backup & restore** saves a backup file. Do that now and then, because it's the only copy outside the phone.

## Development

Plain ES modules with no build step. Preact + htm, and ZXing (WebAssembly) for barcodes on phones without a built-in barcode reader. The libraries are copied into `app/vendor/`.

```sh
npm install           # dev tools only (tests, vendoring, icons)
npm run serve         # http://127.0.0.1:8080 — the camera works on localhost
npm test              # unit tests (logic, store)
npm run e2e           # browser tests in Edge headless (screenshots → test-output/)
npm run check:barcode # barcode decoding works offline via the vendored ZXing
npm run vendor        # re-copy libraries into app/vendor after updating them
npm run deploy        # publish the committed app/ to GitHub Pages (gh-pages branch)
npm run e2e:cloud     # accounts, sync and reminders against a local Supabase (needs Docker; see docs/cloud-setup.md)
npm run vapid         # create the key pair for reminder notifications
```

Accounts, online sync and reminders run on a free Supabase project (`supabase/`: database, security rules, the `send-reminders` function and its schedule). They only switch on when `app/js/config.js` has the project's public URL and key. `docs/cloud-setup.md` lists the setup steps.

| Path | What |
| --- | --- |
| `app/js/model.js` | Pure logic: usage time, estimates, checks, reorder, rate learning, sites |
| `app/js/store.js` | State, actions, persistence (IndexedDB) |
| `app/js/ui/` | Screens and components |
| `app/js/barcode.js` | Camera barcode detection (native `BarcodeDetector` or ZXing) |
| `app/sw.js` | Service worker: offline cache, update prompt |

`npm run deploy` publishes `app/` to the `gh-pages` branch, which GitHub Pages serves. It first stamps the service worker with a content hash, so phones notice the new version. If you'd rather deploy automatically on every push, see `tools/ci/pages.yml`.

## Licenses

Bundled libraries are listed in `app/vendor/licenses/`. Product data and images come from [Open Food Facts](https://world.openfoodfacts.org) (ODbL / CC BY-SA).
