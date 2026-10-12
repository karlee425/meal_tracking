/*
 * servings.test.mjs — V3 Slice 1 · C6: named servings in the domain (src/domain/servings.js,
 * macros.servingQuantity, foods.js deleteCustomFood / referencedFoodIds). Grams stay canonical;
 * a serving is stored in userFoodData by foodId and resolved to grams by the domain.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { ROOT } from './helpers.mjs';
import { createDataLayer, createMemoryAdapter, carryForwardServingIds, parseServingCount, isUnfinishedServingCount, parseServingGrams, SERVING_COUNT_QUICK_PICKS, macros } from '../src/domain/index.js';
import { createFileAdapter } from '../src/node/file-adapter.js';

const TODAY = '2026-09-27';
const SEED = createFileAdapter(ROOT).load();
const CORE = 'food_core_fage_0_greek_yogurt';
const OATS = 'food_custom_oats_overnight';
const uuid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const SRV = (n) => `srv_${uuid(n)}`;
const SERVING_ID = /^srv_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** A data layer over a copy of the seed. uuids: the UUIDs newUuid hands out, in order (then 1001, 1002 …). */
function setup({ userFoodData, uuids = [], failWrites = () => false } = {}) {
  const seed = userFoodData ? { ...SEED, userFoodData } : SEED;
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
  const calls = { uuid: 0 };
  const app = createDataLayer({
    adapter, today: () => TODAY, clock: () => new Date((t += 60000)),
    newUuid: () => { calls.uuid += 1; return queue.length ? queue.shift() : uuid(++next); }
  });
  return { app, writes, calls };
}
const ufd = (app) => app.exportUserData().data.userFoodData;
const foods = (app) => JSON.stringify({ core: app.getFood(CORE), custom: app.getCustomFoods() });
const code = (c) => (e) => e.code === c;
const detail = (c) => (e) => e.code === 'INVALID_SERVING' && e.details.some((d) => d.code === c);
const restored = (servings, retired = []) => ({ foods: [{ foodId: CORE, servings: servings.map(([n, label, grams, approximate = false]) => ({ id: SRV(n), label, grams, approximate, createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-01T00:00:00.000Z' })) }], retiredServingIds: retired });

/* ---------------- storage ---------------- */

test('getServings — none yet, or an unknown Food: an empty list', () => {
  const { app } = setup();
  assert.deepEqual(app.getServings(CORE), []);
  assert.deepEqual(app.getServings(OATS), []);
  assert.deepEqual(app.getServings('food_nope'), []);
});

test('createServing — a Core Food: stored in userFoodData by foodId, the Food records untouched, one write', () => {
  const { app, writes } = setup({ uuids: [uuid(1)] });
  const before = foods(app);
  const s = app.createServing(CORE, { label: '  Tub  ', grams: 170, approximate: false });
  assert.deepEqual(Object.keys(s), ['id', 'label', 'grams', 'approximate', 'createdAt', 'updatedAt']);
  assert.equal(s.id, SRV(1));
  assert.equal(s.label, 'Tub', 'trimmed');
  assert.equal(s.createdAt, s.updatedAt);
  assert.deepEqual(writes, [['userFoodData']], 'only userFoodData is written');
  assert.equal(foods(app), before, 'no Core or Custom Food record changes');
  assert.deepEqual(ufd(app), { foods: [{ foodId: CORE, servings: [s] }], retiredServingIds: [] });
  assert.deepEqual(app.getServings(CORE), [s]);
  assert.equal(app.getCustomFoods().filter((f) => f.id === CORE).length, 0, 'no duplicate Food is created');
});

test('createServing — a Custom Food: appended after its existing servings, so the first stays the default', () => {
  const { app } = setup({ uuids: [uuid(1), uuid(2)] });
  const before = foods(app);
  const a = app.createServing(OATS, { label: 'Pouch', grams: 60 });
  const b = app.createServing(OATS, { label: 'Half pouch', grams: 30, approximate: true });
  assert.equal(a.approximate, false, 'approximate defaults to false');
  assert.deepEqual(app.getServings(OATS).map((s) => s.id), [SRV(1), SRV(2)]);
  assert.equal(app.getServings(OATS)[0].label, 'Pouch');
  assert.equal(b.approximate, true);
  assert.equal(ufd(app).foods.length, 1, 'one record per Food');
  assert.equal(foods(app), before);
});

test('createServing — label, grams and approximate rules; a rejected serving writes nothing', () => {
  const { app, writes } = setup({ uuids: [uuid(1)] });
  app.createServing(CORE, { label: 'Tub', grams: 170 });
  const stored = JSON.stringify(ufd(app));
  const cases = [
    [{ label: '', grams: 30 }, 'SERVING_LABEL_REQUIRED'],
    [{ label: '   ', grams: 30 }, 'SERVING_LABEL_REQUIRED'],
    [{ grams: 30 }, 'SERVING_LABEL_REQUIRED'],
    [{ label: 'g', grams: 30 }, 'SERVING_LABEL_RESERVED'],
    [{ label: ' Gram ', grams: 30 }, 'SERVING_LABEL_RESERVED'],
    [{ label: 'GRAMS', grams: 30 }, 'SERVING_LABEL_RESERVED'],
    [{ label: ' tub ', grams: 30 }, 'SERVING_LABEL_DUPLICATE'],
    [{ label: 'Spoon', grams: 0 }, 'INVALID_SERVING_GRAMS'],
    [{ label: 'Spoon', grams: -5 }, 'INVALID_SERVING_GRAMS'],
    [{ label: 'Spoon', grams: NaN }, 'INVALID_SERVING_GRAMS'],
    [{ label: 'Spoon', grams: Infinity }, 'INVALID_SERVING_GRAMS'],
    [{ label: 'Spoon', grams: '30' }, 'INVALID_SERVING_GRAMS'],
    [{ label: 'Spoon', grams: null }, 'INVALID_SERVING_GRAMS'],
    [{ label: 'Spoon', grams: 12.345 }, 'INVALID_SERVING_GRAMS'],
    [{ label: 'Spoon', grams: 0.1 + 0.2 }, 'INVALID_SERVING_GRAMS'],
    [{ label: 'Spoon', grams: 15, approximate: 'yes' }, 'INVALID_ARGUMENT']
  ];
  for (const [input, c] of cases) assert.throws(() => app.createServing(CORE, input), detail(c), JSON.stringify(input));
  assert.throws(() => app.createServing(CORE, { label: '', grams: 0 }), (e) => e.details.length === 2, 'every problem is reported, by field');
  assert.equal(JSON.stringify(ufd(app)), stored, 'nothing changed');
  assert.equal(writes.length, 1, 'only the first, valid serving was written');
  assert.equal(app.createServing(CORE, { label: 'Spoon', grams: 12.35 }).grams, 12.35, 'two decimal places are fine');
  assert.equal(app.createServing(CORE, { label: 'Other tub', grams: 1e3 }).grams, 1000);
});

test('createServing — a Food that does not exist: FOOD_NOT_FOUND, nothing written', () => {
  const { app, writes } = setup();
  assert.throws(() => app.createServing('food_nope', { label: 'Tub', grams: 10 }), code('FOOD_NOT_FOUND'));
  assert.deepEqual(writes, []);
  assert.deepEqual(ufd(app), SEED.userFoodData);
});

test('createServing — a failed write changes nothing in memory either', () => {
  const { app } = setup({ failWrites: (ch) => 'userFoodData' in ch });
  assert.throws(() => app.createServing(CORE, { label: 'Tub', grams: 170 }), code('PERSIST_FAILED'));
  assert.deepEqual(app.getServings(CORE), []);
  assert.deepEqual(ufd(app), SEED.userFoodData);
});

test('serving IDs — srv_ + a UUID never used before, live or retired; bounded retries, then SERVING_ID_UNAVAILABLE', () => {
  // SRV(1) live on OATS, SRV(2) retired (its Custom Food deleted).
  const { app } = setup({ uuids: [uuid(1), uuid(2)] });
  const food = app.createCustomFood({ name: 'Zzq bar', category: 'snack bar', state: 'prepared', nutrition: { protein: 20, carbs: 40, fat: 10 } });
  app.createServing(OATS, { label: 'Pouch', grams: 60 });
  app.createServing(food.id, { label: 'Bar', grams: 45 });
  app.deleteCustomFood(food.id);
  assert.deepEqual(ufd(app).retiredServingIds, [SRV(2)]);

  // Draws: the live ID, the retired ID, a malformed one, then a fresh one.
  const two = setup({ userFoodData: ufd(app), uuids: [uuid(1), uuid(2), 'NOT-A-UUID', uuid(9)] });
  const s = two.app.createServing(CORE, { label: 'Tub', grams: 170 });
  assert.equal(s.id, SRV(9));
  assert.equal(two.calls.uuid, 4);

  const stuck = setup({ userFoodData: ufd(app), uuids: Array(10).fill(uuid(1)) });
  const before = JSON.stringify(ufd(stuck.app));
  assert.throws(() => stuck.app.createServing(CORE, { label: 'Tub', grams: 170 }), code('SERVING_ID_UNAVAILABLE'));
  assert.equal(stuck.calls.uuid, 5, 'exactly five attempts');
  assert.equal(JSON.stringify(ufd(stuck.app)), before, 'nothing written');
  assert.deepEqual(stuck.writes, []);
});

test('serving IDs — production draws from crypto.randomUUID', () => {
  const app = createDataLayer({ adapter: createMemoryAdapter(SEED), today: () => TODAY });
  assert.match(app.createServing(CORE, { label: 'Tub', grams: 170 }).id, SERVING_ID);
});

/* ---------------- deleting a Custom Food retires its serving IDs ---------------- */

test('deleteCustomFood — its servings go and their IDs are retired, in the same commit as the Food', () => {
  const { app, writes } = setup({ uuids: [uuid(1), uuid(2), uuid(3)] });
  const food = app.createCustomFood({ name: 'Zzq bar', category: 'snack bar', state: 'prepared', nutrition: { protein: 20, carbs: 40, fat: 10 } });
  app.createServing(food.id, { label: 'Bar', grams: 45 });
  app.createServing(food.id, { label: 'Half bar', grams: 22.5 });
  app.createServing(OATS, { label: 'Pouch', grams: 60 });
  writes.length = 0;
  const result = app.deleteCustomFood(food.id);
  assert.deepEqual(Object.keys(result), ['deletedFoodId', 'affectedSavedMealIds'], 'the result is unchanged');
  assert.deepEqual(writes, [['customFoods', 'preferences', 'savedMeals', 'userFoodData']], 'one commit');
  assert.equal(app.getFood(food.id), null);
  assert.deepEqual(ufd(app).foods.map((r) => r.foodId), [OATS], 'its record is gone; others stay');
  assert.deepEqual(ufd(app).retiredServingIds, [SRV(1), SRV(2)]);

  // A restore of a backup without them keeps them reserved (C5).
  const carried = carryForwardServingIds({ foods: [], retiredServingIds: [] }, ufd(app));
  assert.ok([SRV(1), SRV(2), SRV(3)].every((id) => carried.userFoodData.retiredServingIds.includes(id)));
});

test('deleteCustomFood — a Food with no servings writes exactly what it did before', () => {
  const { app, writes } = setup();
  const food = app.createCustomFood({ name: 'Zzq bar', category: 'snack bar', state: 'prepared', nutrition: { protein: 20, carbs: 40, fat: 10 } });
  writes.length = 0;
  app.deleteCustomFood(food.id);
  assert.deepEqual(writes, [['customFoods', 'preferences', 'savedMeals']]);
  assert.deepEqual(ufd(app), SEED.userFoodData);
});

test('deleteCustomFood — a write that fails deletes nothing and retires nothing', () => {
  let fail = false;
  const { app } = setup({ uuids: [uuid(1)], failWrites: () => fail });
  const food = app.createCustomFood({ name: 'Zzq bar', category: 'snack bar', state: 'prepared', nutrition: { protein: 20, carbs: 40, fat: 10 } });
  app.createServing(food.id, { label: 'Bar', grams: 45 });
  fail = true;
  assert.throws(() => app.deleteCustomFood(food.id), code('PERSIST_FAILED'));
  assert.ok(app.getFood(food.id));
  assert.equal(app.getServings(food.id).length, 1);
  assert.deepEqual(ufd(app).retiredServingIds, []);
});

test('Custom Food IDs — a new Food never takes over servings: deleted ones are retired, orphaned records reserve their ID', () => {
  const { app } = setup({ uuids: [uuid(1)] });
  const food = app.createCustomFood({ name: 'Zzq bar', category: 'snack bar', state: 'prepared', nutrition: { protein: 20, carbs: 40, fat: 10 } });
  app.createServing(food.id, { label: 'Bar', grams: 45 });
  app.deleteCustomFood(food.id);
  const again = app.createCustomFood({ name: 'Zzq bar', category: 'snack bar', state: 'prepared', nutrition: { protein: 21, carbs: 40, fat: 10 } });
  assert.deepEqual(app.getServings(again.id), [], 'the recreated Food starts with no servings');

  // A record whose Food doesn't exist (allowed by the store, e.g. from restored data).
  const orphan = { foods: [{ foodId: 'food_custom_ghost', servings: [{ id: SRV(5), label: 'Scoop', grams: 30, approximate: false, createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-01T00:00:00.000Z' }] }], retiredServingIds: [] };
  const two = setup({ userFoodData: orphan });
  assert.deepEqual(two.app.getServings('food_custom_ghost'), [], 'ignored while its Food is missing');
  const ghost = two.app.createCustomFood({ name: 'Ghost', category: 'misc', state: 'prepared', nutrition: { protein: 1, carbs: 1, fat: 1 } });
  assert.equal(ghost.id, 'food_custom_ghost_2', 'the orphaned record keeps its Food ID reserved');
  assert.deepEqual(two.app.getServings(ghost.id), []);
});

/* ---------------- count parsing ---------------- */

test('parseServingCount — every accepted format, as an exact fraction in lowest terms', () => {
  const ok = {
    2: [2n, 1n], ' 2 ': [2n, 1n], '1.5': [3n, 2n], '.5': [1n, 2n], '1,5': [3n, 2n], ',5': [1n, 2n], '0 1/2': [1n, 2n],
    '0.25': [1n, 4n], '1.50': [3n, 2n], '1/2': [1n, 2n], '2/4': [1n, 2n], '3/4': [3n, 4n], '5/2': [5n, 2n],
    '1 1/2': [3n, 2n], '2  3/4': [11n, 4n], '1/3': [1n, 3n], '007': [7n, 1n]
  };
  for (const [text, [n, d]] of Object.entries(ok)) assert.deepEqual(parseServingCount(text), { n, d }, text);
  assert.deepEqual(parseServingCount(2), { n: 2n, d: 1n });
  assert.deepEqual(SERVING_COUNT_QUICK_PICKS, ['1/4', '1/2', '3/4', '1', '2']);
  for (const p of SERVING_COUNT_QUICK_PICKS) assert.ok(parseServingCount(p), `quick pick ${p} parses`);
});

test('parseServingCount — rejects blank, zero, negative, malformed or stacked fractions, zero denominators, exponents, Infinity and text', () => {
  const bad = ['', '   ', null, undefined, '0', '0.0', '.', ',', '1.', '1,', '0.', '12,', '1 1/', '-1', '+1', '-1/2', '0/3', '1/0', '1/2/3', '1 1/2/3', '1 0/2', '1 3/2', '1 1/0', '1/', '/2',
    '1.2.3', '1,2,3', '1e2', '1E2', '1e-1', 'Infinity', '-Infinity', 'NaN', '0x10', 'one', '½', '1 ½', '2 servings', '1..5', '1 . 5', '1 1', '12345678901234567890123456'];
  for (const text of bad) assert.equal(parseServingCount(text), null, JSON.stringify(text));
});

/* ---------------- resolution and rounding ---------------- */

test('resolveAmount — serving × count to canonical grams, half-up to 0.01 g, with the text the UI shows', () => {
  const { app } = setup({ userFoodData: restored([[1, 'a', 30], [2, 'b', 100], [3, 'c', 200], [4, 'd', 45], [5, 'e', 12.5], [6, 'f', 0.1], [7, 'g1', 1.005], [8, 'h', 0.01], [9, 'i', 0.02]]) });
  const r = (n, count) => app.resolveAmount(CORE, { servingId: SRV(n), count });
  const cases = [
    [1, '1/3', 10, '10', false],
    [2, '1/3', 33.33, '33.33', true],
    [3, '2/3', 133.33, '133.33', true],
    [4, '1.5', 67.5, '67.5', false],
    [5, '3/4', 9.38, '9.38', true],
    [6, '3', 0.3, '0.3', false],
    [7, '1', 1.01, '1.01', true], // a restored 3-decimal weight, half-up
    [1, '1', 30, '30', false],
    [4, '1,5', 67.5, '67.5', false],
    [4, '1 1/2', 67.5, '67.5', false],
    [9, '1/4', 0.01, '0.01', true] // 0.005 rounds up
  ];
  for (const [n, count, quantity, text, rounded] of cases) {
    const a = r(n, count);
    assert.equal(a.quantity, quantity, `${n} × ${count}`);
    assert.equal(a.text, text, `${n} × ${count}`);
    assert.equal(a.rounded, rounded, `${n} × ${count}`);
    assert.equal(a.unit, 'g');
    assert.equal(Number(a.text), a.quantity, 'the text is the quantity');
  }
  assert.deepEqual(r(2, '1').serving, { id: SRV(2), label: 'b', grams: 100, approximate: false });
  assert.throws(() => r(8, '1/4'), code('AMOUNT_TOO_SMALL'), '0.0025 g rounds to 0');
  assert.throws(() => r(8, '0.4'), code('AMOUNT_TOO_SMALL'));
  assert.equal(r(8, '0.5').quantity, 0.01);
  assert.throws(() => r(3, '99999999999999999999'), code('INVALID_SERVING_COUNT'), 'too large to be a safe quantity');
});

test('macros.servingQuantity — integer arithmetic, no binary drift', () => {
  const q = (grams, n, d) => macros.servingQuantity(grams, { n: BigInt(n), d: BigInt(d) });
  assert.equal(0.1 * 3, 0.30000000000000004, 'the float problem being avoided');
  assert.equal(q(0.1, 3, 1).text, '0.3');
  assert.equal(1.005 * 100, 100.49999999999999, 'the float problem being avoided');
  assert.equal(q(1.005, 1, 1).text, '1.01');
  assert.equal(q(2.675, 1, 1).text, '2.68');
  assert.equal(q(0.05, 1, 1).text, '0.05');
  assert.equal(q(10.1, 1, 1).text, '10.1');
  assert.equal(q(1e-7, 1, 1).centigrams, 0n);
  assert.equal(macros.decimalPlaces(30), 0);
  assert.equal(macros.decimalPlaces(22.5), 1);
  assert.equal(macros.decimalPlaces(0.125), 3);
  assert.equal(macros.decimalPlaces(0), null);
  assert.throws(() => q(-1, 1, 1));
  assert.throws(() => macros.servingQuantity(30, { n: 1, d: 1 }), 'the count must come from the parser');
});

test('resolveAmount — grams pass through unchanged; ambiguous, unknown or invalid amounts are refused', () => {
  const { app } = setup({ uuids: [uuid(1), uuid(2)] });
  const s = app.createServing(CORE, { label: 'Tub', grams: 170 });
  const other = app.createServing(OATS, { label: 'Pouch', grams: 60 });
  assert.deepEqual(app.resolveAmount(CORE, { quantity: 45.123 }), { quantity: 45.123, unit: 'g', text: '45.123', rounded: false, serving: null });
  assert.throws(() => app.resolveAmount(CORE, {}), code('AMOUNT_AMBIGUOUS'));
  assert.throws(() => app.resolveAmount(CORE), code('AMOUNT_AMBIGUOUS'));
  assert.throws(() => app.resolveAmount(CORE, { quantity: 10, servingId: s.id, count: '1' }), code('AMOUNT_AMBIGUOUS'));
  for (const quantity of [0, -1, NaN, '10', null]) assert.throws(() => app.resolveAmount(CORE, { quantity }), code('INVALID_QUANTITY'));
  assert.throws(() => app.resolveAmount('food_nope', { quantity: 10 }), code('FOOD_NOT_FOUND'));
  assert.throws(() => app.resolveAmount(CORE, { servingId: 'srv_gone', count: '1' }), code('SERVING_NOT_FOUND'));
  assert.throws(() => app.resolveAmount(CORE, { servingId: other.id, count: '1' }), code('SERVING_NOT_FOUND'), 'another Food’s serving');
  assert.throws(() => app.resolveAmount(CORE, { servingId: s.id, count: '' }), code('INVALID_SERVING_COUNT'));
  assert.throws(() => app.resolveAmount(CORE, { servingId: s.id, count: '0' }), code('INVALID_SERVING_COUNT'));
  assert.throws(() => app.resolveAmount(CORE, { servingId: s.id }), code('INVALID_SERVING_COUNT'));
});

test('one canonical quantity — preview and logging get exactly what resolveAmount gave; what is logged is grams', () => {
  const { app } = setup({ uuids: [uuid(1)] });
  const s = app.createServing(CORE, { label: 'Tub', grams: 100, approximate: true });
  app.createDay(TODAY, 'lift');
  const amount = app.resolveAmount(CORE, { servingId: s.id, count: '1/3' });
  assert.equal(amount.quantity, 33.33);
  const preview = app.previewLogFood({ date: TODAY, foodId: CORE, quantity: amount.quantity });
  assert.equal(preview.ingredients[0].quantity, amount.quantity);
  const instance = app.logFood({ date: TODAY, mealSlot: 'snack_afternoon', foodId: CORE, quantity: amount.quantity });
  assert.equal(instance.ingredients[0].quantity, amount.quantity);
  assert.equal(instance.ingredients[0].unit, 'g');
  assert.ok(!JSON.stringify(instance).includes('srv_'), 'no serving metadata in the logged meal yet (C8)');
  assert.deepEqual(instance.ingredients[0].protein, preview.ingredients[0].protein);
});

/* ---------------- audit: unfinished counts and typed serving weights ---------------- */

test('parseServingCount — deterministic for 0 1/2, 1/2, 1 1/2, 1.5 and 1,5; the same text always gives the same fraction', () => {
  const same = [['0 1/2', '1/2', '.5', ',5', '0.5'], ['1 1/2', '3/2', '1.5', '1,5', '1.50', '6/4']];
  for (const group of same) {
    const want = parseServingCount(group[0]);
    for (const t of group) for (let i = 0; i < 3; i++) assert.deepEqual(parseServingCount(t), want, t);
  }
  assert.deepEqual(parseServingCount('0 1/2'), { n: 1n, d: 2n });
  assert.deepEqual(parseServingCount('1 1/2'), { n: 3n, d: 2n });
});

test('isUnfinishedServingCount — part-typed counts are recognised; none of them parses, so none can be logged', () => {
  for (const t of ['1.', '1,', '.', ',', '0.', '12,', '1/', '12/', '1 1', '1 1/', ' 2  3/ ', '0', '0 ', ' 0 ', '0 1', '0 1/']) {
    assert.equal(isUnfinishedServingCount(t), true, JSON.stringify(t));
    assert.equal(parseServingCount(t), null, `${JSON.stringify(t)} is not a count`);
  }
  for (const t of ['', '1', '1.5', '1/2', '1 1/2', '00', '0.0', '0/3', '-0', '-1', '1/0', '1/2/3', '1e2', 'abc', '1..', '1/2/', null]) {
    assert.equal(isUnfinishedServingCount(t), false, JSON.stringify(t));
  }
});

test('parseServingGrams — plain digits with one decimal point or comma; unfinished or malformed text is null', () => {
  for (const [t, n] of [['45', 45], [' 30 ', 30], ['45.5', 45.5], ['1,5', 1.5], ['.5', 0.5], ['0', 0], ['12.345', 12.345]]) assert.equal(parseServingGrams(t), n, t);
  for (const t of ['', '  ', null, '45.', '45,', '.', '1e2', '0x10', 'Infinity', '-5', '+5', '1.2.3', '45 g', 'abc', '1 1/2']) assert.equal(parseServingGrams(t), null, JSON.stringify(t));
  const { app } = setup({ uuids: [uuid(1)] });
  for (const t of ['45.', '1e2', '0x10', '0', '12.345']) assert.throws(() => app.createServing(CORE, { label: 'Tub', grams: parseServingGrams(t) }), detail('INVALID_SERVING_GRAMS'), t);
  assert.deepEqual(app.getServings(CORE), [], 'none saved');
});
