import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  defaultSettings, officeTime, addOfficeTime, ratePerOfficeDay, estimate, analyze, todayLists,
  reorderList, observedRate, rateSuggestion, wasteSummary, findByCode, locationTree, locationPath,
  unusedAtExpiry, isOfficeOpen, DAY,
} from '../app/js/model.js';
import { codeKey, parseGs1, interpretScan, lookupVariants } from '../app/js/codes.js';
import * as store from '../app/js/store.js';

// Week of Monday 12 Oct 2026 (local time; no DST change that week).
const at = (day, h = 9, m = 0) => new Date(2026, 9, day, h, m).getTime();
const MON = 12, TUE = 13, WED = 14, THU = 15, FRI = 16, SAT = 17;
const S = defaultSettings();
const near = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} ≉ ${b}`);

test('office time counts only office hours on office days', () => {
  near(officeTime(at(MON, 9), at(MON, 18), S), 1);
  near(officeTime(at(MON, 13, 30), at(TUE, 13, 30), S), 1);
  near(officeTime(at(FRI, 18), at(MON + 7, 9), S), 0); // weekend
  near(officeTime(at(FRI, 9), at(MON + 7, 9), S), 1);
  near(officeTime(at(MON, 0), at(SAT, 0), S), 5);
  near(officeTime(at(MON, 0), at(SAT, 0), { ...S, closed: [{ from: '2026-10-14', to: '2026-10-14' }] }), 4);
  near(officeTime(at(MON, 0), at(TUE, 0), { ...S, dayStart: '00:00', dayEnd: '00:00' }), 1);
  assert.equal(officeTime(at(TUE), at(MON), S), 0);
});

test('addOfficeTime is the inverse of officeTime', () => {
  assert.equal(addOfficeTime(at(MON, 9), 2.5, S), at(WED, 13, 30));
  assert.equal(addOfficeTime(at(FRI, 17), 0.5, S), at(MON + 7, 12, 30));
  for (const d of [0.1, 1, 3.7, 12.25]) near(officeTime(at(TUE, 11), addOfficeTime(at(TUE, 11), d, S), S), d, 1e-6);
  assert.equal(addOfficeTime(at(MON), 1, { ...S, workdays: [] }), Infinity);
});

test('isOfficeOpen', () => {
  assert.equal(isOfficeOpen(at(MON, 10), S), true);
  assert.equal(isOfficeOpen(at(MON, 19), S), false);
  assert.equal(isOfficeOpen(at(SAT, 10), S), false);
});

test('rates convert to units per office day', () => {
  assert.equal(ratePerOfficeDay({ qty: 5, per: 'day' }, S), 5);
  near(ratePerOfficeDay({ qty: 1, per: 'week' }, S), 0.2);
  near(ratePerOfficeDay({ qty: 260 / 12, per: 'month' }, S), 1);
  assert.equal(ratePerOfficeDay(null, S), 0);
  assert.equal(ratePerOfficeDay({ qty: 0, per: 'day' }, S), 0);
});

const product = (over = {}) => ({
  id: 'p1', name: 'Milk', unit: 'carton', barcodes: [], rate: { qty: 2, per: 'day' }, minStock: 0,
  anchorAt: at(MON, 9), countedAt: at(MON, 9), countedQty: 9, addedAt: null, touchedAt: at(MON, 9),
  createdAt: at(MON, 9), ...over,
});
const batch = (id, qty, expiry, addedAt = at(MON, 9)) => ({ id, productId: 'p1', locationId: null, qty, expiry, addedAt });

test('estimate uses the earliest-expiring batch first', () => {
  const p = product();
  const bs = [batch('late', 6, '2026-10-30'), batch('early', 3, '2026-10-20')];
  const e = estimate(p, bs, S, at(WED, 9)); // 2 office days × 2 = 4 used
  near(e.total, 5);
  assert.deepEqual(e.per.map(r => [r.batch.id, r.qty]), [['early', 0], ['late', 5]]);
  assert.equal(e.runOutAt, at(FRI, 13, 30)); // 9 units / 2 per day = 4.5 office days
});

test('unused-at-expiry predicts waste', () => {
  const p = product({ rate: { qty: 1, per: 'day' } });
  const b = batch('b', 5, '2026-10-14'); // printed Wed → expired from Thu 00:00
  const e = estimate(p, [b], S, at(MON, 9));
  near(unusedAtExpiry(p, e, b, S), 2); // Mon, Tue, Wed used 3 of 5
  const info = analyze({ settings: S, products: [p], batches: [b] }, at(MON, 9)).get('p1');
  near(info.batches[0].unused, 2);
  const lists = todayLists(new Map([['p1', info]]), S, at(MON, 9));
  assert.equal(lists.soon.length, 1);
});

test('checks: probably-gone until counted, low only when not verified low', () => {
  const water = product({ id: 'w', name: 'Water', rate: { qty: 5, per: 'day' }, minStock: 6, countedQty: 24 });
  const bs = [{ ...batch('b', 24, null), productId: 'w' }];
  const state = { settings: S, products: [water], batches: bs };
  let l = todayLists(analyze(state, at(TUE, 18)), S, at(TUE, 18)); // 10 used, 14 left
  assert.equal(l.checks.length, 0);
  l = todayLists(analyze(state, at(THU, 13, 30)), S, at(THU, 13, 30)); // 17.5 used, 6.5 left... ≤ min? no (6.5 > 6)
  assert.equal(l.checks.length, 0);
  l = todayLists(analyze(state, at(THU, 18)), S, at(THU, 18)); // 20 used, 4 left ≤ 6
  assert.deepEqual(l.checks.map(c => c.kind), ['low']);
  l = todayLists(analyze(state, at(MON + 7, 12)), S, at(MON + 7, 12)); // 26.67 used → gone
  assert.deepEqual(l.checks.map(c => c.kind), ['gone']);
  assert.equal(l.checks[0].since, at(FRI, 16, 12)); // 24/5 = 4.8 office days after Mon 9:00
  // Snoozed → hidden
  const snoozed = { ...state, products: [{ ...water, snoozeUntil: at(MON + 8, 0) }] };
  assert.equal(todayLists(analyze(snoozed, at(MON + 7, 12)), S, at(MON + 7, 12)).checks.length, 0);
  // Counted 0 → no check; reorder says verified "out"
  const gone = { ...state, products: [{ ...water, anchorAt: at(MON + 7, 12), countedAt: at(MON + 7, 12), countedQty: 0 }], batches: [] };
  const info = analyze(gone, at(MON + 7, 13));
  assert.equal(todayLists(info, S, at(MON + 7, 13)).checks.length, 0);
  const r = reorderList(info, S, at(MON + 7, 13));
  assert.equal(r.need[0].reason, 'out');
  // 5/day × 5 office days in the next 7 days + min 6 = 31 units
  assert.equal(r.need[0].qty.units, 31);
});

test('no "gone?" check once a person has emptied the stock (used up / thrown away)', () => {
  store.resetStore(store.initialState(at(MON, 9)));
  const id = withClock(at(MON, 9), () => store.createProduct({ name: 'Milk', rate: { qty: 1, per: 'day' } }, { qty: 2, expiry: '2026-10-13' }));
  const b = store.getState().batches[0];
  withClock(at(TUE, 9), () => store.useUpBatch(b.id));
  const s = store.getState();
  const info = analyze(s, at(THU, 9));
  assert.equal(todayLists(info, s.settings, at(THU, 9)).checks.length, 0);
  assert.equal(reorderList(info, s.settings, at(THU, 9)).need[0].reason, 'out');
  assert.deepEqual(s.events.map(e => e.type), ['add', 'count', 'used']);
  assert.equal(s.events[2].qty, 1); // 1 of 2 had been used by Tuesday 09:00
  void id;
});

test('reorder: low, runs out soon, ordered, opt-out', () => {
  const mk = (id, over) => product({ id, name: id, countedQty: 10, ...over });
  const products = [
    mk('soon', { rate: { qty: 1, per: 'day' } }), // 10 left at 1/day → runs out in 10 office days (> 7 calendar days)
    mk('fast', { rate: { qty: 3, per: 'day' } }), // runs out in 3.3 office days
    mk('low', { rate: null, minStock: 12 }),
    mk('ordered', { rate: null, minStock: 12, orderedAt: at(MON, 10) }),
    mk('nope', { rate: null, minStock: 12, reorder: false }),
    mk('pack', { rate: null, minStock: 30, barcodes: [{ code: '1', units: 1 }, { code: '2', units: 24 }] }),
  ];
  const batches = products.map(p => ({ ...batch('b' + p.id, 10, null), productId: p.id }));
  const info = analyze({ settings: S, products, batches }, at(MON, 9));
  const r = reorderList(info, S, at(MON, 9));
  assert.deepEqual(r.need.map(x => [x.i.product.id, x.reason]), [['low', 'low'], ['pack', 'low'], ['fast', 'soon']]);
  assert.deepEqual(r.ordered.map(x => x.i.product.id), ['ordered']);
  const pack = r.need.find(x => x.i.product.id === 'pack').qty;
  assert.deepEqual(pack, { units: 21, pack: 24, packs: 1 });
});

test('learning: counts reveal a faster pace', () => {
  const evs = [
    { type: 'add', productId: 'p1', qty: 24, at: at(MON, 9), initial: true },
    { type: 'count', productId: 'p1', qty: 24, at: at(MON, 9), initial: true },
    { type: 'count', productId: 'p1', qty: 4, at: at(WED, 9) }, // 20 used in 2 office days
  ];
  near(observedRate(evs, 'p1', S).perOfficeDay, 10);
  const p = product({ rate: { qty: 5, per: 'day' }, countedAt: at(WED, 9) });
  assert.deepEqual(rateSuggestion(p, evs, S), { qty: 10, per: 'day', days: 2, faster: true });
  // within ±20–25% → no suggestion
  assert.equal(rateSuggestion(product({ rate: { qty: 9, per: 'day' }, countedAt: at(WED, 9) }), evs, S), null);
  // dismissed for this count
  assert.equal(rateSuggestion({ ...p, rateHintAt: at(WED, 9) }, evs, S), null);
  // adds and waste between counts are accounted for
  const evs2 = [
    { type: 'count', productId: 'p1', qty: 10, at: at(MON, 9) },
    { type: 'add', productId: 'p1', qty: 12, at: at(TUE, 9) },
    { type: 'waste', productId: 'p1', qty: 2, at: at(TUE, 10) },
    { type: 'count', productId: 'p1', qty: 5, at: at(THU, 9) }, // used 10+12-2-5 = 15 in 3 days
  ];
  near(observedRate(evs2, 'p1', S).perOfficeDay, 5);
  // ran out → slower pace is not trusted
  const evs3 = [evs[1], { type: 'count', productId: 'p1', qty: 0, at: at(MON + 14, 9) }];
  assert.equal(rateSuggestion(product({ rate: { qty: 5, per: 'day' }, countedAt: at(MON + 14, 9) }), evs3, S), null);
  // no rate yet → proposes one in a sensible unit
  const evs4 = [
    { type: 'count', productId: 'p1', qty: 6, at: at(MON, 9) },
    { type: 'count', productId: 'p1', qty: 4, at: at(MON + 14, 9) }, // 2 in 10 office days → 1/week
  ];
  assert.deepEqual(rateSuggestion(product({ rate: null, countedAt: at(MON + 14, 9) }), evs4, S), { qty: 1, per: 'week', days: 10, faster: null });
});

test('barcode keys, lookup variants and GS1', () => {
  assert.equal(codeKey('049000028911'), codeKey('0049000028911'));
  assert.equal(codeKey('96385074'), '00000096385074');
  assert.equal(codeKey('ABC-123'), 'ABC-123');
  assert.deepEqual(lookupVariants('049000028911'), ['049000028911', '0049000028911']);
  assert.deepEqual(lookupVariants('0049000028911'), ['0049000028911', '049000028911']);
  const g = parseGs1(']d201054490000009961727123110LOT42\u001d21XYZ');
  assert.deepEqual(g, { gtin: '05449000000996', expiry: '2027-12-31', batch: 'LOT42' });
  assert.deepEqual(parseGs1('(01)05449000000996(15)270600'), { gtin: '05449000000996', expiry: '2027-06-30' });
  assert.equal(parseGs1('5449000000996'), null);
  assert.deepEqual(interpretScan('0105449000000996172712'), { code: '5449000000996', expiry: null }); // truncated AI 17
  assert.deepEqual(interpretScan(' 5449000000996 '), { code: '5449000000996', expiry: null });
  const found = findByCode([{ id: 'x', barcodes: [{ code: '0049000028911', units: 6 }] }], '049000028911');
  assert.equal(found.units, 6);
});

test('locations tree and paths', () => {
  const locs = [
    { id: 'k', name: 'Kitchen', parentId: null, order: 0 },
    { id: 'f', name: 'Fridge', parentId: 'k', order: 0 },
    { id: 'd', name: 'Door', parentId: 'f', order: 0 },
    { id: 's', name: 'Storage', parentId: null, order: 1 },
  ];
  assert.deepEqual(locationTree(locs).map(x => [x.path, x.depth]), [
    ['Kitchen', 0], ['Kitchen › Fridge', 1], ['Kitchen › Fridge › Door', 2], ['Storage', 0],
  ]);
  assert.equal(locationPath(locs, 'd'), 'Kitchen › Fridge › Door');
});

test('waste summary flags repeat waste', () => {
  const state = {
    products: [{ id: 'm', name: 'Milk', unit: 'carton' }],
    events: [
      { type: 'add', productId: 'm', qty: 10, at: at(MON) },
      { type: 'waste', productId: 'm', qty: 1, at: at(TUE), name: 'Milk' },
      { type: 'waste', productId: 'm', qty: 2, at: at(WED), name: 'Milk' },
      { type: 'waste', productId: 'gone', qty: 1, at: at(WED), name: 'Old cake', unit: 'pcs' },
    ],
  };
  const w = wasteSummary(state, at(FRI));
  assert.equal(w.units, 4);
  assert.deepEqual(w.rows.map(r => [r.name, r.wasted, r.buyLess]), [['Milk', 3, true], ['Old cake', 1, false]]);
  near(w.rows[0].share, 0.3);
});

// ---------- store actions (Date.now is pinned) ----------

function withClock(t, fn) {
  const real = Date.now;
  Date.now = () => t;
  try {
    return fn();
  } finally {
    Date.now = real;
  }
}

test('store: create, add, count, use, waste, undo', () => {
  store.resetStore(withClock(at(MON, 9), () => store.initialState(at(MON, 9))));
  const fridge = store.getState().locations.find(l => l.name === 'Fridge').id;
  const id = withClock(at(MON, 9), () => store.createProduct(
    { name: 'Water', unit: 'bottle', rate: { qty: 5, per: 'day' }, locationId: fridge, barcodes: [{ code: '5449000000996', units: 6 }] },
    { qty: 24, expiry: '2027-03-01' },
  ));
  let s = store.getState();
  assert.equal(s.batches.length, 1);
  assert.equal(s.batches[0].locationId, fridge);
  assert.deepEqual(s.events.map(e => e.type), ['add', 'count']);

  // Wed 09:00: 10 used → 14 left; add 6 more with a later date → materialized to 14 + new batch of 6
  withClock(at(WED, 9), () => store.addStock(id, { qty: 6, expiry: '2027-05-01' }));
  s = store.getState();
  assert.deepEqual(s.batches.map(b => b.qty).sort((a, b) => a - b), [6, 14]);
  assert.equal(s.products[0].anchorAt, at(WED, 9));

  // Count 8: keeps the 6 latest-expiring + 2 from the older batch
  const sug = withClock(at(THU, 9), () => store.count(id, 8));
  s = store.getState();
  assert.deepEqual(s.batches.map(b => [b.expiry, b.qty]).sort(), [['2027-03-01', 2], ['2027-05-01', 6]]);
  // Mon→Thu: 24 + 6 − 8 = 22 used in 3 office days ≈ 7.3/day vs 5 → suggestion
  assert.equal(sug.qty, 7.3);
  assert.equal(sug.faster, true);

  // Undo the count, then redo it
  assert.equal(store.undo(), true);
  assert.equal(store.getState().batches.reduce((t, b) => t + b.qty, 0), 20);
  withClock(at(THU, 9), () => store.count(id, 8));

  // Count more than recorded → surplus goes to the newest batch
  withClock(at(THU, 9), () => store.count(id, 10));
  s = store.getState();
  assert.equal(s.batches.reduce((t, b) => t + b.qty, 0), 10);
  assert.equal(s.batches.find(b => b.expiry === '2027-05-01').qty, 8);

  // Waste 2 from the older batch (no time passed since count)
  const older = s.batches.find(b => b.expiry === '2027-03-01');
  withClock(at(THU, 9), () => store.wasteBatch(older.id, 2, 'damaged'));
  s = store.getState();
  assert.equal(s.batches.length, 1);
  assert.equal(s.events.at(-1).type, 'waste');
  assert.equal(s.events.at(-1).name, 'Water');

  // Gone → counted 0, no batches, reorder "out"
  withClock(at(THU, 10), () => store.count(id, 0));
  s = store.getState();
  assert.equal(s.batches.length, 0);
  const r = reorderList(analyze(s, at(THU, 11)), s.settings, at(THU, 11));
  assert.equal(r.need[0].reason, 'out');

  // Ordered → moves to "on order"; adding stock clears it
  withClock(at(THU, 11), () => store.setOrdered(id, true));
  assert.equal(reorderList(analyze(store.getState(), at(THU, 11)), S, at(THU, 11)).ordered.length, 1);
  withClock(at(FRI, 9), () => store.addStock(id, { qty: 24 }));
  assert.equal(store.getState().products[0].orderedAt, null);

  // Deleting the product keeps waste history
  store.deleteProduct(id);
  s = store.getState();
  assert.equal(s.products.length, 0);
  assert.deepEqual(s.events.map(e => e.type), ['waste']);
});

test('store: untracked product, manual use, rate change is not retroactive', () => {
  store.resetStore(store.initialState(at(MON, 9)));
  const id = withClock(at(MON, 9), () => store.createProduct({ name: 'Toner', unit: 'cartridge' }, { qty: 3 }));
  withClock(at(TUE, 9), () => store.useStock(id, 1));
  let s = store.getState();
  assert.equal(s.batches[0].qty, 2);
  // Set 1/day on Wed: Mon–Wed must not count retroactively
  withClock(at(WED, 9), () => store.updateProduct(id, { rate: { qty: 1, per: 'day' } }));
  s = store.getState();
  const e = estimate(s.products[0], s.batches, s.settings, at(THU, 9));
  near(e.total, 1);
});

test('store: locations delete moves children and stock up; import validates', () => {
  store.resetStore(store.initialState(at(MON, 9)));
  let s = store.getState();
  const kitchen = s.locations.find(l => l.name === 'Kitchen').id;
  const fridge = s.locations.find(l => l.name === 'Fridge').id;
  const door = store.addLocation('Door', fridge);
  const id = withClock(at(MON, 9), () => store.createProduct({ name: 'Milk', locationId: fridge }, { qty: 2 }));
  store.deleteLocation(fridge);
  s = store.getState();
  assert.equal(s.locations.find(l => l.id === door).parentId, kitchen);
  assert.equal(s.batches[0].locationId, kitchen);
  assert.equal(s.products.find(p => p.id === id).locationId, kitchen);
  // can't move a location under its own descendant
  store.moveLocation(kitchen, door);
  assert.equal(store.getState().locations.find(l => l.id === kitchen).parentId, null);

  const json = store.exportJson();
  store.eraseAll();
  assert.equal(store.getState().products.length, 0);
  store.importJson(json);
  assert.equal(store.getState().products[0].name, 'Milk');
  assert.throws(() => store.importJson('{"hello": 1}'), /not an Office Pantry backup/);
});

test('analyze stays fast with a realistic pantry', () => {
  const products = [];
  const batches = [];
  for (let k = 0; k < 300; k++) {
    products.push(product({ id: 'p' + k, anchorAt: at(MON, 9) - 200 * DAY, rate: k % 3 ? { qty: 0.1, per: 'day' } : null }));
    for (let j = 0; j < 3; j++) batches.push({ ...batch(`b${k}-${j}`, 10, `2027-0${1 + j}-15`), productId: 'p' + k });
  }
  const state = { settings: S, products, batches, events: [] };
  const t0 = performance.now();
  const info = analyze(state, at(WED, 12));
  todayLists(info, S, at(WED, 12));
  reorderList(info, S, at(WED, 12));
  const ms = performance.now() - t0;
  assert.ok(ms < 400, `analyze took ${ms.toFixed(0)} ms`);
});
