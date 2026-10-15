/*
 * logged-servings.test.mjs — V3 Slice 1 · C8 Stage 2: logged-serving snapshots and the reserved
 * serving-ID rule across logged meals (src/domain/days.js logFood / updateMealInstance,
 * servings.resolveAmount, store.js). Grams stay authoritative; a logged serving is a copy taken
 * when it was logged; every serving ID a logged meal refers to stays live or retired.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { ROOT } from './helpers.mjs';
import { createDataLayer, createMemoryAdapter } from '../src/domain/index.js';
import { createStore } from '../src/domain/store.js';
import { createServingsApi } from '../src/domain/servings.js';
import { createFileAdapter } from '../src/node/file-adapter.js';

const TODAY = '2026-09-27';
const SEED = createFileAdapter(ROOT).load();
const CORE = 'food_core_fage_0_greek_yogurt';
const OATS = 'food_custom_oats_overnight';
const uuid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const SRV = (n) => `srv_${uuid(n)}`;
const AT = '2026-09-01T00:00:00.000Z';
const code = (c) => (e) => e.code === c;
const serving = (n, label, grams, approximate = false) => ({ id: SRV(n), label, grams, approximate, createdAt: AT, updatedAt: AT });

/** A data layer over a copy of the seed (optionally with userFoodData / days), counting writes. */
function setup({ userFoodData, days, uuids = [], failWrites = () => false } = {}) {
  const seed = { ...SEED, ...(userFoodData ? { userFoodData } : {}), ...(days ? { days } : {}) };
  const inner = createMemoryAdapter(seed);
  const writes = [];
  const adapter = {
    load: () => inner.load(),
    save: (c, d) => inner.save(c, d),
    saveMany: (ch) => { if (failWrites(ch)) throw new Error('disk full'); writes.push(Object.keys(ch).sort()); inner.saveMany(ch); }
  };
  let t = Date.parse(`${TODAY}T12:00:00Z`);
  let next = 1000;
  const queue = [...uuids];
  const app = createDataLayer({ adapter, today: () => TODAY, clock: () => new Date((t += 60000)), newUuid: () => (queue.length ? queue.shift() : uuid(++next)) });
  return { app, writes, inner };
}
const data = (app) => app.exportUserData().data;

/** A store over the seed plus the given collections (for rules no domain operation can break). */
function storeWith(collections = {}) {
  const inner = createMemoryAdapter({ ...SEED, ...collections });
  const writes = [];
  const store = createStore({ load: () => inner.load(), save: () => { throw new Error('unused'); }, saveMany: (ch) => { writes.push(Object.keys(ch)); inner.saveMany(ch); } });
  return { store, writes, inner };
}

/** A logged ingredient with a serving snapshot (macros are free numbers to the store). */
const loggedRow = (foodId, quantity, sv, extra = {}) => ({ foodId, foodName: foodId, quantity, unit: 'g', protein: 1, carbs: 1, fat: 1, ...(sv ? { serving: sv } : {}), ...extra });
const snap = (n, label, grams, numerator = 1, denominator = 1, approximate = false) => ({ id: SRV(n), label, grams, approximate, count: { numerator, denominator } });
const day = (date, ingredientsList) => ({
  id: `day_${date}`, date, dayType: 'lift', targetSnapshot: { protein: 150, carbs: 250, fat: 70 }, loggingComplete: false,
  mealInstances: ingredientsList.map((ingredients, i) => ({ id: `mi_${date}_${i}`, sourceMealId: null, mealName: 'M', mealSlot: 'lunch', ingredients, totals: { protein: 1, carbs: 1, fat: 1 }, loggedAt: AT }))
});
const UFD = { foods: [{ foodId: CORE, servings: [serving(1, 'Tub', 170), serving(3, 'Spoon', 15, true)] }, { foodId: OATS, servings: [serving(2, 'Pouch', 60)] }], retiredServingIds: [SRV(9)] };

/* ---------------- 1–4: logging a serving ---------------- */

test('C8 — 1: logFood with a serving stores the snapshot { id, label, grams, approximate, count } on the ingredient', () => {
  const { app, writes } = setup({ uuids: [uuid(1)] });
  const s = app.createServing(CORE, { label: 'Tub', grams: 100, approximate: true });
  app.createDay(TODAY, 'lift');
  const before = writes.length;
  const mi = app.logFood({ date: TODAY, mealSlot: 'breakfast', foodId: CORE, servingId: s.id, count: '1 1/3' });
  assert.equal(writes.length, before + 1, 'one write');
  assert.deepEqual(writes.at(-1), ['days']);
  const ing = mi.ingredients[0];
  assert.deepEqual(ing.serving, { id: s.id, label: 'Tub', grams: 100, approximate: true, count: { numerator: 4, denominator: 3 } });
  assert.deepEqual(Object.keys(ing.serving), ['id', 'label', 'grams', 'approximate', 'count']);
  assert.equal(ing.quantity, 133.33);
  assert.equal(ing.unit, 'g');
  assert.deepEqual(data(app).days[0].mealInstances[0], mi, 'stored exactly as returned');
  assert.equal(mi.mealName, app.getFood(CORE).name);
});

test('C8 — 1b: the count is kept as the exact reduced fraction, whatever form it was typed in', () => {
  const { app } = setup({ uuids: [uuid(1)] });
  const s = app.createServing(CORE, { label: 'Tub', grams: 30 });
  app.createDay(TODAY, 'lift');
  const cases = [['2', 2, 1], ['1.5', 3, 2], ['1,5', 3, 2], ['1 1/2', 3, 2], ['6/4', 3, 2], ['.25', 1, 4], ['0 1/2', 1, 2]];
  for (const [count, numerator, denominator] of cases) {
    const mi = app.logFood({ date: TODAY, mealSlot: 'lunch', foodId: CORE, servingId: s.id, count });
    assert.deepEqual(mi.ingredients[0].serving.count, { numerator, denominator }, count);
    assert.equal(mi.ingredients[0].quantity, app.resolveAmount(CORE, { servingId: s.id, count }).quantity, count);
  }
  assert.deepEqual(app.resolveAmount(CORE, { servingId: s.id, count: '6/4' }).count, { numerator: 3, denominator: 2 });
});

test('C8 — 2: a serving logs the same canonical quantity, macros and totals as the same grams', () => {
  const { app } = setup({ uuids: [uuid(1)] });
  const s = app.createServing(CORE, { label: 'Tub', grams: 100 });
  app.createDay(TODAY, 'lift');
  const bySrv = app.logFood({ date: TODAY, mealSlot: 'lunch', foodId: CORE, servingId: s.id, count: '1/3' });
  const byGrams = app.logFood({ date: TODAY, mealSlot: 'lunch', foodId: CORE, quantity: 33.33 });
  const strip = ({ serving: _s, ...rest }) => rest;
  assert.deepEqual(strip(bySrv.ingredients[0]), byGrams.ingredients[0]);
  assert.deepEqual(bySrv.totals, byGrams.totals);
  const preview = app.previewLogFood({ date: TODAY, foodId: CORE, quantity: 33.33 });
  assert.deepEqual(bySrv.totals, preview.totals, 'the preview the sheet shows is what was logged');
});

test('C8 — 3: grams-only logging has no serving property at all', () => {
  const { app } = setup({ uuids: [uuid(1)] });
  app.createServing(CORE, { label: 'Tub', grams: 100 });
  app.createDay(TODAY, 'lift');
  const mi = app.logFood({ date: TODAY, mealSlot: 'lunch', foodId: CORE, quantity: 100 });
  assert.ok(!('serving' in mi.ingredients[0]));
  const meal = app.createMealInstance({ date: TODAY, mealSlot: 'dinner', mealName: 'Tray', ingredients: [{ foodId: CORE, quantity: 100 }, { foodId: OATS, quantity: 40 }] });
  for (const ing of meal.ingredients) assert.ok(!('serving' in ing));
  assert.ok(!JSON.stringify(data(app).days).includes('"serving"'));
});

test('C8 — 4: a caller can’t forge a snapshot through createMealInstance or updateMealInstance', () => {
  const { app } = setup({ uuids: [uuid(1)] });
  const s = app.createServing(CORE, { label: 'Tub', grams: 100 });
  app.createDay(TODAY, 'lift');
  const forged = { id: s.id, label: 'Forged', grams: 50, approximate: false, count: { numerator: 2, denominator: 1 } };
  const mi = app.createMealInstance({ date: TODAY, mealSlot: 'lunch', mealName: 'X', ingredients: [{ foodId: CORE, quantity: 100, unit: 'g', serving: forged }] });
  assert.ok(!('serving' in mi.ingredients[0]));
  const mi2 = app.createMealInstance({ date: TODAY, mealSlot: 'lunch', mealName: 'Y', ingredients: [{ foodId: CORE, quantity: 100 }] }, [forged]);
  assert.ok(!('serving' in mi2.ingredients[0]), 'a second argument is not a way in either');
  const logged = app.logFood({ date: TODAY, mealSlot: 'lunch', foodId: CORE, servingId: s.id, count: '1' });
  const updated = app.updateMealInstance(TODAY, logged.id, { ingredients: [{ foodId: CORE, quantity: 100, serving: forged }, { foodId: OATS, quantity: 40, serving: forged }] });
  assert.deepEqual(updated.ingredients[0].serving, logged.ingredients[0].serving, 'a continued row keeps only its own snapshot');
  assert.ok(!('serving' in updated.ingredients[1]), 'a new row is calculated from the Food');
  assert.ok(!('serving' in app.updateMealInstance(TODAY, mi.id, { ingredients: [{ foodId: CORE, quantity: 100, serving: forged }] }).ingredients[0]));
});

test('C8 — 4b: logFood takes exactly one amount form; every refusal writes nothing', () => {
  const { app, writes } = setup({ uuids: [uuid(1), uuid(2)] });
  const s = app.createServing(CORE, { label: 'Tub', grams: 100 });
  const other = app.createServing(OATS, { label: 'Pouch', grams: 60 });
  app.createDay(TODAY, 'lift');
  const n = writes.length;
  const log = (extra) => () => app.logFood({ date: TODAY, mealSlot: 'lunch', foodId: CORE, ...extra });
  assert.throws(log({ quantity: 100, servingId: s.id, count: '1' }), code('AMOUNT_AMBIGUOUS'));
  assert.throws(log({ servingId: s.id, count: '1', unit: 'ml' }), code('UNSUPPORTED_UNIT'));
  assert.throws(log({ servingId: s.id }), code('INVALID_SERVING_COUNT'));
  assert.throws(log({ count: '1' }), code('SERVING_NOT_FOUND'));
  assert.throws(log({ servingId: other.id, count: '1' }), code('SERVING_NOT_FOUND'), 'another Food’s serving');
  assert.throws(log({ servingId: s.id, count: '0' }), code('INVALID_SERVING_COUNT'));
  assert.throws(log({ servingId: s.id, count: '1/100000' }), code('AMOUNT_TOO_SMALL'));
  assert.throws(() => app.logFood({ date: '2026-09-28', mealSlot: 'lunch', foodId: CORE, servingId: s.id, count: '1' }), code('DAY_TYPE_REQUIRED'));
  assert.equal(writes.length, n);
  assert.equal(data(app).days[0].mealInstances.length, 0);
  const mi = app.logFood({ date: '2026-09-28', mealSlot: 'lunch', foodId: CORE, servingId: s.id, count: '1', dayType: 'rest' });
  assert.equal(writes.length, n + 1, 'a new Day and its logged meal in one write');
  assert.equal(app.getDay('2026-09-28').mealInstances[0].id, mi.id);
});

/* ---------------- 5–7: snapshot validation ---------------- */

test('C8 — 5: the store checks a snapshot’s ID, label, unit, count and quantity', () => {
  storeWith({ userFoodData: UFD }).store.commit({ days: [day(TODAY, [[loggedRow(CORE, 170, snap(1, 'Tub', 170))]])] }); // valid
  const bad = [
    ['an ID that is not srv_<uuid>', loggedRow(CORE, 170, { ...snap(1, 'Tub', 170), id: 'srv_1' })],
    ['an upper-case ID', loggedRow(CORE, 170, { ...snap(1, 'Tub', 170), id: 'srv_0000000A-0000-4000-8000-000000000001' })],
    ['a blank label', loggedRow(CORE, 170, snap(1, '   ', 170))],
    ['an empty label', loggedRow(CORE, 170, snap(1, '', 170))],
    ['a unit other than g', loggedRow(CORE, 170, snap(1, 'Tub', 170), { unit: 'ml' })],
    ['a quantity the serving does not come to', loggedRow(CORE, 171, snap(1, 'Tub', 170))],
    ['a quantity off by rounding', loggedRow(CORE, 33.34, snap(1, 'Tub', 100, 1, 3))],
    ['zero grams', loggedRow(CORE, 170, snap(1, 'Tub', 0))],
    ['a missing count', loggedRow(CORE, 170, (({ count: _c, ...r }) => r)(snap(1, 'Tub', 170)))],
    ['an extra field', loggedRow(CORE, 170, { ...snap(1, 'Tub', 170), text: '1' })],
    ['a null snapshot', loggedRow(CORE, 170, null, { serving: null })]
  ];
  for (const [why, row] of bad) {
    const { store, writes } = storeWith({ userFoodData: UFD });
    assert.throws(() => store.commit({ days: [day(TODAY, [[row]])] }), code('VALIDATION_FAILED'), why);
    assert.equal(writes.length, 0, why);
    assert.deepEqual(store.get('days'), [], why);
  }
  // historical labels are records: a reserved word, or a label that now duplicates another, is fine
  const { store } = storeWith({ userFoodData: UFD });
  store.commit({ days: [day(TODAY, [[loggedRow(CORE, 170, snap(1, 'g', 170))], [loggedRow(CORE, 15, snap(3, 'TUB', 15))]])] });
  assert.equal(store.get('days')[0].mealInstances.length, 2);
  // the canonical rule decides: 1/3 × 100 g is 33.33; half-up, 1/4 × 0.02 g is 0.01
  store.commit({ days: [day(TODAY, [[loggedRow(CORE, 33.33, snap(1, 'Tub', 100, 1, 3))], [loggedRow(CORE, 0.01, snap(3, 'Spoon', 0.02, 1, 4))]])] });
});

test('C8 — 6: a non-reduced fraction, zero, a non-integer or an unsafe integer count is refused', () => {
  const counts = [[2, 2, 170, 'not reduced (2/2)'], [2, 4, 85, 'not reduced (2/4)'], [0, 1, 170, 'zero'], [1, 0, 170, 'zero denominator'],
    [1.5, 1, 255, 'not whole'], [2 ** 53, 1, 170, 'numerator above the safe range'], [1, 2 ** 53, 170, 'denominator above the safe range'], [-1, 1, 170, 'negative']];
  for (const [numerator, denominator, quantity, why] of counts) {
    const { store, writes } = storeWith({ userFoodData: UFD });
    assert.throws(() => store.commit({ days: [day(TODAY, [[loggedRow(CORE, quantity, snap(1, 'Tub', 170, numerator, denominator))]])] }), code('VALIDATION_FAILED'), why);
    assert.equal(writes.length, 0, why);
  }
});

test('C8 — 7: a count whose exact fraction exceeds safe integers is refused, even when the grams would round fine', () => {
  const { app, writes } = setup({ uuids: [uuid(1)] });
  const s = app.createServing(CORE, { label: 'Tub', grams: 30 });
  app.createDay(TODAY, 'lift');
  const n = writes.length;
  assert.equal(app.resolveAmount(CORE, { servingId: s.id, count: '1.000000000001' }).quantity, 30, 'an ordinary amount');
  // each is at most the 24 characters a count may have, so only the size of the fraction refuses it
  for (const count of ['1.0000000000000000000001', '1 1/90071992547409930', '1/9007199254740993']) {
    assert.throws(() => app.resolveAmount(CORE, { servingId: s.id, count }), code('INVALID_SERVING_COUNT'), count);
    assert.throws(() => app.logFood({ date: TODAY, mealSlot: 'lunch', foodId: CORE, servingId: s.id, count }), code('INVALID_SERVING_COUNT'), count);
  }
  assert.equal(writes.length, n);
  assert.deepEqual(app.resolveAmount(CORE, { servingId: s.id, count: '1.00000000000000000000' }).count, { numerator: 1, denominator: 1 }, 'a long decimal that reduces into range is fine');
});

/* ---------------- 8–12: the reserved-ID rule across collections ---------------- */

test('C8 — 8: a commit can’t leave a logged serving ID neither live nor retired (H ⊆ L ∪ R)', () => {
  {
    const { store, writes } = storeWith({ userFoodData: UFD });
    assert.throws(() => store.commit({ days: [day(TODAY, [[loggedRow(CORE, 170, snap(7, 'Tub', 170))]])] }), (e) => e.code === 'VALIDATION_FAILED' && e.details.some((d) => /neither a live nor a retired/.test(d)));
    assert.equal(writes.length, 0);
  }
  const { store, writes } = storeWith({ userFoodData: UFD, days: [day(TODAY, [[loggedRow(CORE, 170, snap(1, 'Tub', 170))]])] });
  const without = (ids, retired) => ({ foods: UFD.foods.map((r) => ({ ...r, servings: r.servings.filter((s) => !ids.includes(s.id)) })).filter((r) => r.servings.length), retiredServingIds: retired });
  assert.throws(() => store.commit({ userFoodData: without([SRV(1)], [SRV(9)]) }), code('VALIDATION_FAILED'), 'a live ID removed without retiring it');
  assert.throws(() => store.commit({ userFoodData: { foods: [], retiredServingIds: [] } }), code('VALIDATION_FAILED'));
  assert.equal(writes.length, 0);
  store.commit({ userFoodData: without([SRV(1)], [SRV(9), SRV(1)]) }); // retired: still reserved
  assert.throws(() => store.commit({ userFoodData: without([SRV(1)], [SRV(9)]) }), code('VALIDATION_FAILED'), 'a retired ID can’t be dropped while logged');
  store.commit({ days: [], userFoodData: without([SRV(1)], [SRV(9)]) }); // both together: checked against the state they produce
  assert.equal(writes.length, 2);
});

test('C8 — 9: one historical serving ID always refers to one Food', () => {
  const { store, writes } = storeWith({ userFoodData: { foods: [], retiredServingIds: [SRV(1)] } });
  const two = [day(TODAY, [[loggedRow(CORE, 170, snap(1, 'Tub', 170))], [loggedRow(OATS, 170, snap(1, 'Tub', 170))]])];
  assert.throws(() => store.commit({ days: two }), (e) => e.code === 'VALIDATION_FAILED' && e.details.some((d) => /more than one Food/.test(d)));
  const acrossDays = [day('2026-09-26', [[loggedRow(CORE, 170, snap(1, 'Tub', 170))]]), day(TODAY, [[loggedRow(OATS, 170, snap(1, 'Tub', 170))]])];
  assert.throws(() => store.commit({ days: acrossDays }), code('VALIDATION_FAILED'), 'across Days');
  assert.equal(writes.length, 0);
  store.commit({ days: [day(TODAY, [[loggedRow(CORE, 170, snap(1, 'Tub', 170))], [loggedRow(CORE, 340, snap(1, 'Old tub', 170, 2))]])] }); // same Food, different labels
});

test('C8 — 10: a live serving ID can’t belong to a different Food from its logged references', () => {
  const { store, writes } = storeWith({ userFoodData: UFD, days: [day(TODAY, [[loggedRow(CORE, 170, snap(1, 'Tub', 170))]])] });
  const moved = { foods: [{ foodId: CORE, servings: [serving(3, 'Spoon', 15, true)] }, { foodId: OATS, servings: [serving(2, 'Pouch', 60), serving(1, 'Tub', 170)] }], retiredServingIds: [SRV(9)] };
  assert.throws(() => store.commit({ userFoodData: moved }), (e) => e.code === 'VALIDATION_FAILED' && e.details.some((d) => /is a live serving of/.test(d)));
  assert.throws(() => store.commit({ days: [day(TODAY, [[loggedRow(OATS, 170, snap(1, 'Tub', 170))]])] }), code('VALIDATION_FAILED'), 'logged for the wrong Food');
  assert.equal(writes.length, 0);
  assert.throws(() => store.commit({ userFoodData: { ...UFD, retiredServingIds: [SRV(9), SRV(1)] } }), (e) => e.details.some((d) => /both live and retired/.test(d)), 'live and retired still can’t overlap');
});

test('C8 — 11: invalid stored history refuses to load with DATA_INVALID', () => {
  const cases = [
    ['an orphan ID', [day(TODAY, [[loggedRow(CORE, 170, snap(7, 'Tub', 170))]])]],
    ['the wrong Food', [day(TODAY, [[loggedRow(OATS, 170, snap(1, 'Tub', 170))]])]],
    ['an inconsistent quantity', [day(TODAY, [[loggedRow(CORE, 100, snap(1, 'Tub', 170))]])]],
    ['a non-reduced count', [day(TODAY, [[loggedRow(CORE, 170, snap(1, 'Tub', 170, 2, 2))]])]],
    ['a serving on a non-gram row', [day(TODAY, [[loggedRow(CORE, 170, snap(1, 'Tub', 170), { unit: 'ml' })]])]]
  ];
  for (const [why, days] of cases) assert.throws(() => setup({ userFoodData: UFD, days }), (e) => e.code === 'DATA_INVALID' && e.details.length > 0, why);
  const { app } = setup({ userFoodData: UFD, days: [day(TODAY, [[loggedRow(CORE, 170, snap(1, 'Tub', 170))], [loggedRow(CORE, 55)]])] });
  assert.equal(app.getDay(TODAY).mealInstances.length, 2, 'valid history, and grams-only history, load');
});

test('C8 — 12: a failed validation or a failed write leaves memory and storage unchanged', () => {
  const { store, writes, inner } = storeWith({ userFoodData: UFD });
  const before = inner.snapshot();
  assert.throws(() => store.commit({ days: [day(TODAY, [[loggedRow(CORE, 170, snap(7, 'Tub', 170))]])], targets: SEED.targets }), code('VALIDATION_FAILED'));
  assert.equal(writes.length, 0);
  assert.deepEqual(inner.snapshot(), before);
  assert.deepEqual(store.get('days'), []);
  let fail = false;
  const { app } = setup({ uuids: [uuid(1)], failWrites: () => fail });
  const s = app.createServing(CORE, { label: 'Tub', grams: 100 });
  app.createDay(TODAY, 'lift');
  const stored = JSON.stringify(data(app));
  fail = true;
  assert.throws(() => app.logFood({ date: TODAY, mealSlot: 'lunch', foodId: CORE, servingId: s.id, count: '1' }), code('PERSIST_FAILED'));
  assert.equal(JSON.stringify(data(app)), stored, 'nothing logged in memory either');
});

/* ---------------- 13–16: editing logged ingredients ---------------- */

test('C8 — 13: name-only and slot-only edits keep the snapshot exactly', () => {
  const { app } = setup({ uuids: [uuid(1)] });
  const s = app.createServing(CORE, { label: 'Tub', grams: 100, approximate: true });
  app.createDay(TODAY, 'lift');
  const mi = app.logFood({ date: TODAY, mealSlot: 'lunch', foodId: CORE, servingId: s.id, count: '1/2' });
  assert.deepEqual(app.updateMealInstance(TODAY, mi.id, { mealName: 'Yogurt' }).ingredients, mi.ingredients);
  assert.deepEqual(app.updateMealInstance(TODAY, mi.id, { mealSlot: 'dinner' }).ingredients, mi.ingredients);
  assert.deepEqual(app.previewMealInstanceUpdate(TODAY, mi.id, { mealSlot: 'breakfast' }).instance.ingredients, mi.ingredients);
});

test('C8 — 14–15: the same grams keep the snapshot; changed grams drop only that ingredient’s', () => {
  const ufd = { foods: [{ foodId: CORE, servings: [serving(1, 'Tub', 170)] }, { foodId: OATS, servings: [serving(2, 'Pouch', 60)] }], retiredServingIds: [] };
  const rows = [loggedRow(CORE, 170, snap(1, 'Tub', 170), { protein: 17.51, carbs: 6.12, fat: 0 }), loggedRow(OATS, 30, snap(2, 'Pouch', 60, 1, 2), { protein: 3.21, carbs: 19.89, fat: 2.07 })];
  const { app } = setup({ userFoodData: ufd, days: [day(TODAY, [rows])] });
  const id = `mi_${TODAY}_0`;
  const same = app.updateMealInstance(TODAY, id, { ingredients: [{ foodId: CORE, quantity: 170 }, { foodId: OATS, quantity: 30 }] });
  assert.deepEqual(same.ingredients, rows, 'unchanged grams: unchanged rows, snapshots kept');
  const changed = app.updateMealInstance(TODAY, id, { ingredients: [{ foodId: CORE, quantity: 200 }, { foodId: OATS, quantity: 30 }] });
  assert.ok(!('serving' in changed.ingredients[0]), 'the changed row drops its snapshot');
  assert.equal(changed.ingredients[0].quantity, 200);
  assert.equal(changed.ingredients[0].protein, (200 / 170) * 17.51, 'rescaled from the logged row, as before');
  assert.deepEqual(changed.ingredients[1], rows[1], 'the other row and its snapshot are unchanged');
  const back = app.updateMealInstance(TODAY, id, { ingredients: [{ foodId: CORE, quantity: 170 }, { foodId: OATS, quantity: 30 }] });
  assert.ok(!('serving' in back.ingredients[0]), 'changing it back brings nothing back: nothing is fabricated');
  const preview = app.previewMealInstanceUpdate(TODAY, id, { ingredients: [{ foodId: CORE, quantity: 170 }, { foodId: OATS, quantity: 31 }] });
  assert.ok(!('serving' in preview.instance.ingredients[1]), 'the preview agrees with the edit');
  assert.ok('serving' in app.getDay(TODAY).mealInstances[0].ingredients[1], 'a preview writes nothing');
});

test('C8 — 16: two rows of one Food — a snapshot never moves onto the other row', () => {
  const ufd = { foods: [{ foodId: CORE, servings: [serving(1, 'Tub', 170)] }], retiredServingIds: [] };
  const rows = [loggedRow(CORE, 170, snap(1, 'Tub', 170)), loggedRow(CORE, 170)]; // one Tub as a serving; 170 g typed as grams
  const fresh = () => setup({ userFoodData: ufd, days: [day(TODAY, [rows])] }).app;
  const id = `mi_${TODAY}_0`;
  const edit = (ingredients) => fresh().updateMealInstance(TODAY, id, { ingredients }).ingredients;
  assert.ok(!('serving' in edit([{ foodId: CORE, quantity: 170 }])[0]), 'the serving row removed, no index: the rest can’t be told apart, so no snapshot');
  assert.ok(!('serving' in edit([{ foodId: CORE, quantity: 170, snapshotIndex: 1 }])[0]), 'the grams row stays grams');
  assert.deepEqual(edit([{ foodId: CORE, quantity: 170, snapshotIndex: 0 }]), [rows[0]]);
  assert.deepEqual(edit([{ foodId: CORE, quantity: 170, snapshotIndex: 1 }, { foodId: CORE, quantity: 170, snapshotIndex: 0 }]), [rows[1], rows[0]], 'the snapshot follows its row');
  assert.deepEqual(edit([{ foodId: CORE, quantity: 170, snapshotIndex: 0 }, { foodId: CORE, quantity: 170, snapshotIndex: 1 }]), rows);
  assert.ok(edit([{ foodId: CORE, quantity: 170 }, { foodId: CORE, quantity: 170 }]).every((ing) => !('serving' in ing)), 'no indexes and a duplicate Food: ambiguous, so no snapshot is kept');
  const app = fresh();
  for (const [ings, why] of [
    [[{ foodId: CORE, quantity: 170, snapshotIndex: 2 }], 'out of range'],
    [[{ foodId: CORE, quantity: 170, snapshotIndex: -1 }], 'negative'],
    [[{ foodId: CORE, quantity: 170, snapshotIndex: '0' }], 'not a number'],
    [[{ foodId: CORE, quantity: 170, snapshotIndex: 0 }, { foodId: CORE, quantity: 170, snapshotIndex: 0 }], 'used twice'],
    [[{ foodId: OATS, quantity: 170, snapshotIndex: 0 }], 'a different Food'],
    [[{ foodId: CORE, quantity: 170, unit: 'ml', snapshotIndex: 0 }], 'a different unit']
  ]) assert.throws(() => app.updateMealInstance(TODAY, id, { ingredients: ings }), code('INVALID_MEAL_INSTANCE'), why);
  assert.deepEqual(app.getDay(TODAY).mealInstances[0].ingredients, rows, 'nothing written');
});

/* ---------------- 17–19: reserved IDs over time ---------------- */

test('C8 — 17: editing or deleting the serving, the Custom Food, a logged meal or a Day never changes history or frees an ID', () => {
  const { app } = setup({ uuids: [uuid(1), uuid(2), uuid(1), uuid(2), uuid(1), uuid(2)] });
  const s = app.createServing(CORE, { label: 'Tub', grams: 100 });
  const p = app.createServing(OATS, { label: 'Pouch', grams: 60 });
  app.createDay(TODAY, 'lift');
  const mi = app.logFood({ date: TODAY, mealSlot: 'lunch', foodId: CORE, servingId: s.id, count: '1' });
  const oats = app.logFood({ date: TODAY, mealSlot: 'snack_afternoon', foodId: OATS, servingId: p.id, count: '1' });
  app.updateServing(CORE, s.id, { label: 'Big tub', grams: 150, approximate: true });
  assert.deepEqual(app.getDay(TODAY).mealInstances[0], mi, 'editing the serving changes no logged meal');
  app.setDefaultServing(CORE, s.id);
  app.deleteServing(CORE, s.id);
  app.deleteCustomFood(OATS);
  assert.deepEqual(app.getDay(TODAY).mealInstances, [mi, oats], 'deleting the serving or the Food changes no logged meal');
  assert.deepEqual(data(app).userFoodData.retiredServingIds, [s.id, p.id]);
  app.deleteMealInstance(TODAY, mi.id);
  app.deleteDay(TODAY);
  assert.deepEqual(data(app).userFoodData.retiredServingIds, [s.id, p.id], 'removing the history leaves both reserved');
  const next = app.createServing(CORE, { label: 'Cup', grams: 200 });
  assert.equal(next.id, SRV(1001), 'the next serving skips both, however often they come up');
});

test('C8 — 18: new serving IDs avoid IDs found in logged meals (the guard beside the store rule)', () => {
  // History referring to an ID in neither list — which the real store refuses — shows that
  // newServingId reads history itself, not only L ∪ R.
  const days = [{ date: TODAY, mealInstances: [{ ingredients: [{ foodId: CORE, serving: { id: SRV(5) } }, { foodId: CORE }] }] }];
  const commits = [];
  const fakeStore = { get: (c) => (c === 'days' ? days : c === 'userFoodData' ? { foods: [], retiredServingIds: [] } : []), commit: (ch) => commits.push(ch) };
  const queue = [uuid(5), uuid(6)];
  const api = createServingsApi({ store: fakeStore, lookupFood: (id) => (id === CORE ? { id } : null), now: () => AT, newUuid: () => queue.shift() });
  assert.equal(api.createServing(CORE, { label: 'Tub', grams: 100 }).id, SRV(6));
  assert.equal(commits.length, 1);
  // in the real data layer, a logged (then retired) ID is never drawn again
  const { app } = setup({ uuids: [uuid(1), uuid(1), uuid(1), uuid(1), uuid(1), uuid(1)] });
  const s = app.createServing(CORE, { label: 'Tub', grams: 100 });
  app.createDay(TODAY, 'lift');
  app.logFood({ date: TODAY, mealSlot: 'lunch', foodId: CORE, servingId: s.id, count: '1' });
  app.deleteServing(CORE, s.id);
  assert.throws(() => app.createServing(CORE, { label: 'Cup', grams: 200 }), code('SERVING_ID_UNAVAILABLE'));
});

test('C8 — 19: grams-only logs and edits behave exactly as before', () => {
  const { app } = setup();
  app.createDay(TODAY, 'lift');
  const mi = app.logFood({ date: TODAY, mealSlot: 'lunch', foodId: CORE, quantity: 120 });
  const keys = ['foodId', 'foodName', 'quantity', 'unit', 'protein', 'carbs', 'fat'];
  assert.deepEqual(Object.keys(mi.ingredients[0]), keys);
  const edited = app.updateMealInstance(TODAY, mi.id, { ingredients: [{ foodId: CORE, quantity: 60 }, { foodId: CORE, quantity: 60 }] });
  for (const ing of edited.ingredients) assert.deepEqual(Object.keys(ing), keys);
  assert.equal(edited.ingredients[0].protein, (60 / 120) * mi.ingredients[0].protein, 'the existing row rescales from its snapshot, as before');
  assert.ok(!JSON.stringify(data(app)).includes('"serving"'));
  const old = [day(TODAY, [[loggedRow(CORE, 55)], [loggedRow(OATS, 40), loggedRow(CORE, 10)]])];
  assert.deepEqual(data(setup({ days: old }).app).days, old, 'Days stored before C8 load and validate unchanged');
});

/* ---------------- 20: a re-added ingredient uses the current Food (final correctness fix) ---------------- */

test('C8 — 20: with snapshotIndex, a removed-and-re-added Food is a new ingredient: current Food values, no inherited snapshot', () => {
  // One logged meal: Oats by its Pouch serving, and Fage by its Tub serving — built with the domain,
  // then combined into one meal (the store accepts it; macros are as each was logged).
  const first = setup({ uuids: [uuid(1), uuid(2)] });
  const tub = first.app.createServing(CORE, { label: 'Tub', grams: 170 });
  const pouch = first.app.createServing(OATS, { label: 'Pouch', grams: 60 });
  first.app.createDay(TODAY, 'lift');
  const oats = first.app.logFood({ date: TODAY, mealSlot: 'lunch', foodId: OATS, servingId: pouch.id, count: '1' });
  const fage = first.app.logFood({ date: TODAY, mealSlot: 'lunch', foodId: CORE, servingId: tub.id, count: '1' });
  const exported = data(first.app);
  const rows = [oats.ingredients[0], fage.ingredients[0]];
  const both = { ...oats, ingredients: rows, totals: { protein: oats.totals.protein + fage.totals.protein, carbs: oats.totals.carbs + fage.totals.carbs, fat: oats.totals.fat + fage.totals.fat } };
  const days = [{ ...exported.days[0], mealInstances: [both] }];
  const fresh = () => {
    const { app } = setup({ userFoodData: exported.userFoodData, days });
    app.updateCustomFood(OATS, { nutrition: { protein: 20 } }); // the Food changes after logging
    return app;
  };
  const current = (app, quantity) => app.previewLogFood({ foodId: OATS, quantity }).ingredients[0]; // the domain's own calculation
  {
    const app = fresh();
    const now = current(app, 60);
    assert.notEqual(now.protein, rows[0].protein, 'the Food really changed');
    // Remove the Oats row and add Oats again, same grams; Fage keeps its place by snapshotIndex.
    const patch = { ingredients: [{ foodId: CORE, quantity: 170, snapshotIndex: 1 }, { foodId: OATS, quantity: 60 }] };
    const preview = app.previewMealInstanceUpdate(TODAY, both.id, patch).instance;
    const out = app.updateMealInstance(TODAY, both.id, patch);
    assert.deepEqual(out.ingredients[1], { foodId: OATS, foodName: now.foodName, quantity: 60, unit: 'g', protein: now.protein, carbs: now.carbs, fat: now.fat }, 'the current Food’s values; no serving');
    assert.ok(!('serving' in out.ingredients[1]), 'the removed row’s Pouch snapshot is not inherited');
    assert.deepEqual(out.ingredients[0], rows[1], 'Fage, by snapshotIndex: its own row and Tub snapshot');
    assert.deepEqual(preview, out, 'the preview is what was saved');
  }
  {
    // Changed grams on an indexed row: that row continues its own logged values and drops only its snapshot.
    const app = fresh();
    const out = app.updateMealInstance(TODAY, both.id, { ingredients: [{ foodId: OATS, quantity: 90, snapshotIndex: 0 }, { foodId: CORE, quantity: 170, snapshotIndex: 1 }] });
    assert.ok(!('serving' in out.ingredients[0]));
    assert.equal(out.ingredients[0].protein, (90 / 60) * rows[0].protein, 'an existing row re-scales from its own logged values, not the changed Food');
    assert.deepEqual(out.ingredients[1], rows[1]);
    // name-only and slot-only keep everything
    assert.deepEqual(app.updateMealInstance(TODAY, both.id, { mealName: 'Lunch bowl' }).ingredients, out.ingredients);
    assert.deepEqual(app.updateMealInstance(TODAY, both.id, { mealSlot: 'dinner' }).ingredients, out.ingredients);
  }
  {
    // Name-only / slot-only on the original meal keep both snapshots.
    const app = fresh();
    assert.deepEqual(app.updateMealInstance(TODAY, both.id, { mealName: 'Renamed' }).ingredients, rows);
    assert.deepEqual(app.updateMealInstance(TODAY, both.id, { mealSlot: 'snack_night' }).ingredients, rows);
  }
  {
    // Callers that never send snapshotIndex keep the earlier behaviour: Oats is matched to the logged
    // Oats row (its own logged values), and — one row of that Food before and after — keeps its snapshot.
    const app = fresh();
    const out = app.updateMealInstance(TODAY, both.id, { ingredients: [{ foodId: CORE, quantity: 170 }, { foodId: OATS, quantity: 60 }] });
    assert.deepEqual(out.ingredients, [rows[1], rows[0]], 'legacy pairing by Food, unchanged');
  }
});
