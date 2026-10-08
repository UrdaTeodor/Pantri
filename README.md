# Office Pantry

A phone app for running an office pantry. Scan barcodes to track stock, expiry dates and reorders, and let it tell you what to check.

- **Scan** a barcode. The first time, it looks the product up on Open Food Facts. After that, one scan adds stock, counts it or logs waste. Multipacks count correctly: scanning a 6-pack adds 6 bottles.
- **Organise it your way** with nested locations (Kitchen › Fridge › Door, Storage › Shelf B) and categories.
- **Expiry dates per delivery.** Every restock is its own batch, so new milk never hides the old carton. It warns you before items expire, including stock that *won't be used in time* at the current pace.
- **Usage rates and checks.** Set "water: 5 per office day" or "chips: 1 per week". The app estimates what's left, counting only office hours and days and skipping the holidays you enter. When something should be gone or low, the Today screen asks you to check it. Your counts teach it the real pace.
- **Reorder list.** It collects anything that's out, below its minimum, or will run out before your next order, and suggests how much to buy. Share it as text.
- **Waste log.** Thrown-out items are logged, and it flags what you're over-buying.

It's an installable web app (PWA), not a store app. It works offline. All data stays on your phone, and the only thing sent anywhere is a barcode when it's looked up online.

## Install on your phone

1. Open **https://urdateodor.github.io/office-pantry/** on the phone:
   - Android: in Chrome.
   - iPhone: in Safari.
2. Install it:
   - Android: tap the menu (⋮), then **Install app** (or **Add to Home screen**).
   - iPhone: tap Share, then **Add to Home Screen**.
3. Open it from the new icon. Allow the camera the first time you scan.

Long-press the icon on Android for shortcuts: *Scan item*, *Restock* and *Reorder list*.

When a new version is published, the app shows "A new version of the app is ready". Tap **Update**.

## First steps

1. **More → Office hours & settings:** set your office days and hours, and any closures (holidays). Usage estimates pause outside these.
2. **More → Locations:** shape your storage. Tap a location to rename, move, or add places inside it.
3. **Scan** your products. Give the ones that get used regularly a usage rate and a minimum to keep.
4. **More → Backup & restore:** save a backup file now and then. This is the only copy outside the phone.

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
```

| Path | What |
| --- | --- |
| `app/js/model.js` | Pure logic: office-time maths, estimates, checks, reorder, rate learning |
| `app/js/store.js` | State, actions, persistence (IndexedDB) |
| `app/js/ui/` | Screens and components |
| `app/js/barcode.js` | Camera barcode detection (native `BarcodeDetector` or ZXing) |
| `app/sw.js` | Service worker: offline cache, update prompt |

`npm run deploy` publishes `app/` to the `gh-pages` branch, which GitHub Pages serves. It first stamps the service worker with a content hash, so phones notice the new version. If you'd rather deploy automatically on every push, see `tools/ci/pages.yml`.

## Licenses

Bundled libraries are listed in `app/vendor/licenses/`. Product data and images come from [Open Food Facts](https://world.openfoodfacts.org) (ODbL / CC BY-SA).
