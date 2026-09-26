// Finalized V2 foundations — the requirements A–AD of the "Finalize V2 domain and
// persistence foundations" task. Requirements already proven in pre-ui.test.mjs are listed
// here for traceability rather than duplicated; the rest are tested below.
// Run: node --test tests/
//
//   A  explicit day completion ................ pre-ui A, B
//   B  empty night snack doesn't block ........ pre-ui A
//   C  completion not inferred from slots ..... pre-ui B, C
//   D  deterministic Coach order .............. pre-ui D; here D·E·F·I
//   E  favourites before recent ............... here
//   F  recent before other Saved .............. here
//   G  Library starters for new users ......... pre-ui E
//   H  retired Library Meals excluded ......... here
//   I  no macro-fit ranking ................... here (and pre-ui D)
//   J  target changes don't mutate Days ....... pre-ui F
//   K  apply current targets to Today ......... pre-ui G
//   L  past day-type change keeps history ..... pre-ui H
//   M  switching back restores context ........ pre-ui I
//   N  same day type is a no-op ............... pre-ui J
//   O/P/Q  NaN / Infinity / -Infinity ......... here (every boundary) and pre-ui K, L, M
//   R  browser persistence load/save .......... pre-ui N, W2, W3
//   S  persistence failure → stable state ..... here
//   T  retry through the data layer ........... here
//   U  backup export / restore validation ..... pre-ui P, R
//   V  invalid backup can't partially write ... pre-ui Q; here (recovery path)
//   W  explicit fresh-start recovery .......... here
//   X  meal search ............................ here
//   Y  Custom Food listing .................... here
//   Z  Custom Food usage lookup ............... here
//   AA canonical macro previews ............... here and pre-ui S
//   AB labels allowed by the source scan ...... here and pre-ui U
//   AC duplicate arithmetic still detected .... here and pre-ui T
//   AD forbidden-concept scan stays clean ..... here and pre-ui V, architecture O, boundary 14

import test from 'node:test';
import assert from 'node:assert/strict';
import { ROOT, macroArithmeticInSource, FORBIDDEN_NUTRITION, listRepoFiles, isBinary } from './helpers.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { createDataLayer, createMemoryAdapter, DomainError } from '../src/domain/index.js';
import { createFileAdapter } from '../src/node/file-adapter.js';
import { createMemorySnapshotStore } from '../src/browser/memory-snapshot-store.js';
import { createIndexedDbSnapshotStore } from '../src/browser/indexeddb-snapshot-store.js';
import { APP_DATA, openBrowserDataLayer, recoverStoredData } from '../src/browser/app-data.js';

const TODAY = '2026-09-24';
const SEED = createFileAdapter(ROOT).load();
const throwsCode = (fn, code) => assert.throws(fn, (e) => e instanceof DomainError && e.code === code, `expected DomainError ${code}`);
async function rejectsCode(promise, code) {
  let error = null;
  try { await promise; } catch (e) { error = e; }
  assert.ok(error instanceof DomainError, `expected DomainError ${code}, got ${error}`);
  assert.equal(error.code, code);
  return error;
}
function makeLayer(adapter = createMemoryAdapter(SEED)) {
  let t = Date.parse(`${TODAY}T12:00:00Z`);
  let n = 0;
  return createDataLayer({ adapter, today: () => TODAY, clock: () => new Date((t += 60000)), newId: () => `t${String(++n).padStart(4, '0')}` });
}
const saved = (app, name, grams = 100, mealType = 'lunch') => app.createSavedMeal({ name, mealType, ingredients: [{ foodId: 'food_core_banana', quantity: grams }] });
const tierIds = (r, name) => r.tiers.find((t) => t.tier === name).items.map((i) => i.mealId);

/* ---------------- Coach order (D, E, F, H, I) ---------------- */

test('D·E·F — favourites, then recently logged Saved Meals, then other Saved Meals, then Library starters', () => {
  const app = makeLayer();
  const fav = saved(app, 'Favourite');
  const logged = saved(app, 'Logged');
  const other = saved(app, 'Other');
  app.setFavoriteMeal(fav.id, true);
  app.createMealInstance({ date: TODAY, mealSlot: 'lunch', mealId: logged.id, dayType: 'lift' });
  app.createMealInstance({ date: TODAY, mealSlot: 'dinner', mealId: fav.id }); // favourite AND logged → stays in favourites
  const r = app.getMacroCoachSuggestions({ date: TODAY, mealSlot: 'dinner' });
  assert.deepEqual(r.tiers.map((t) => t.tier), ['favoriteSaved', 'recent', 'saved', 'library']);
  assert.deepEqual(tierIds(r, 'favoriteSaved'), [fav.id], 'E: favourites first');
  assert.deepEqual(tierIds(r, 'recent'), [logged.id], 'F: recent before other Saved Meals, favourites not repeated');
  assert.deepEqual(tierIds(r, 'saved'), [other.id]);
  assert.ok(tierIds(r, 'library').length > 0, 'Library starters last');
  assert.ok(r.topUpFoods, 'Foods are a separate top-up path, not a tier');
  assert.deepEqual(app.getMacroCoachSuggestions({ date: TODAY, mealSlot: 'dinner' }), r, 'deterministic');
});

test('H — retired Library Meals never appear, even after being logged', () => {
  const app = makeLayer();
  const retired = app.getLibraryMeals({ includeRetired: true }).filter((m) => m.metadata && m.metadata.retired).map((m) => m.id);
  assert.ok(retired.length >= 1);
  for (const id of retired) app.createMealInstance({ date: TODAY, mealSlot: 'lunch', mealId: id, dayType: 'lift' });
  const r = app.getMacroCoachSuggestions({ date: TODAY, mealSlot: 'dinner' });
  const all = r.tiers.flatMap((t) => t.items.map((i) => i.mealId));
  for (const id of retired) assert.ok(!all.includes(id), `${id} excluded`);
  assert.deepEqual(tierIds(r, 'recent'), [], 'recent is Saved Meals only');
});

test('I — no macro-fit ranking: order does not depend on what is left', () => {
  const app = makeLayer();
  const small = saved(app, 'A small meal', 20);
  const big = saved(app, 'B big meal', 500);
  const before = app.getMacroCoachSuggestions({ date: TODAY, mealSlot: 'lunch', dayType: 'rest' });
  app.logFood({ date: TODAY, mealSlot: 'breakfast', foodId: 'food_core_rolled_oats_dry', quantity: 250, dayType: 'rest' }); // remaining changes a lot
  const after = app.getMacroCoachSuggestions({ date: TODAY, mealSlot: 'lunch' });
  assert.notDeepEqual(before.remaining, after.remaining);
  for (const name of ['favoriteSaved', 'recent', 'saved', 'library']) assert.deepEqual(tierIds(after, name), tierIds(before, name), `${name} order unchanged`);
  assert.deepEqual(tierIds(after, 'saved'), [big.id, small.id], 'most recently updated first — not by size or fit');
  const text = JSON.stringify(after);
  assert.ok(!/"(score|rank|fit|fitScore|best|winner|recommended)"/i.test(text), 'no score, rank or winner fields');
});

/* ---------------- O, P, Q — non-finite numbers at every input boundary ---------------- */

const BOUNDARIES = [
  ['createCustomFood', (app, v) => app.createCustomFood({ name: 'N', category: 'x', state: 'raw', nutrition: { protein: v, carbs: 1, fat: 1 } })],
  ['updateCustomFood', (app, v, f) => app.updateCustomFood(f.bar.id, { nutrition: { carbs: v } })],
  ['updateCurrentTargets', (app, v) => app.updateCurrentTargets('lift', { fat: v })],
  ['logFood quantity', (app, v) => app.logFood({ date: TODAY, mealSlot: 'lunch', foodId: 'food_core_banana', quantity: v })],
  ['createMealInstance ingredients', (app, v) => app.createMealInstance({ date: TODAY, mealSlot: 'lunch', mealName: 'x', ingredients: [{ foodId: 'food_core_banana', quantity: v }] })],
  ['updateMealInstance quantity', (app, v, f) => app.updateMealInstance(TODAY, f.mi.id, { ingredients: [{ foodId: 'food_core_banana', quantity: v }] })],
  ['updateMealInstance new ingredient', (app, v, f) => app.updateMealInstance(TODAY, f.mi.id, { ingredients: [{ foodId: 'food_core_banana', quantity: 10 }, { foodId: 'food_core_sourdough', quantity: v }] })],
  ['createSavedMeal quantity', (app, v) => app.createSavedMeal({ name: 'x', ingredients: [{ foodId: 'food_core_banana', quantity: v }] })],
  ['updateSavedMeal quantity', (app, v, f) => app.updateSavedMeal(f.meal.id, { ingredients: [{ foodId: 'food_core_banana', quantity: v }] })],
  ['replaceSavedMealIngredient quantity', (app, v, f) => app.replaceSavedMealIngredient(f.meal.id, 'food_core_banana', 'food_core_sourdough', { quantity: v })],
  ['Saved Meal metadata', (app, v, f) => app.updateSavedMeal(f.meal.id, { metadata: { prepMinutes: v } })],
  ['preferences', (app, v) => app.updatePreferences({ appPreferences: { x: v } })],
  ['previewLogFood quantity', (app, v) => app.previewLogFood({ date: TODAY, foodId: 'food_core_banana', quantity: v })],
  ['restoreUserData', (app, v) => { const b = app.exportUserData(); b.data.targets.rest.carbs = v; return app.restoreUserData(b); }]
];

for (const [label, bad] of [['O — NaN', NaN], ['P — Infinity', Infinity], ['Q — -Infinity', -Infinity]]) {
  test(`${label} is rejected at every numeric input boundary and never stored`, () => {
    const adapter = createMemoryAdapter(SEED);
    const app = makeLayer(adapter);
    const bar = app.createCustomFood({ name: 'Bar', category: 'bar', state: 'prepared', nutrition: { protein: 10, carbs: 50, fat: 10 } });
    const mi = app.logFood({ date: TODAY, mealSlot: 'lunch', foodId: 'food_core_banana', quantity: 100, dayType: 'lift' });
    const meal = saved(app, 'Meal');
    const fixtures = { bar, mi, meal };
    const stored = JSON.stringify(adapter.snapshot());
    for (const [where, fn] of BOUNDARIES) {
      assert.throws(() => fn(app, bad, fixtures), (e) => e instanceof DomainError, `${where}: rejected with a DomainError`);
      assert.equal(JSON.stringify(adapter.snapshot()), stored, `${where}: nothing written`);
    }
    assert.equal(app.validateCustomFood({ name: 'x', category: 'x', state: 'raw', nutrition: { protein: 1, carbs: bad, fat: 1 } }).errors[0].code, 'NUTRITION_NOT_A_NUMBER');
    assert.equal(app.validateBackup({ ...app.exportUserData(), data: { ...app.exportUserData().data, targets: { ...SEED.targets, rest: { protein: 1, carbs: bad, fat: 1 } } } }).valid, false);
    assert.ok(!/null/.test(JSON.stringify(adapter.snapshot().targets)), 'no null written in place of a number');
    makeLayer(createMemoryAdapter(adapter.snapshot())); // the stored data still opens
  });
}

/* ---------------- S, T — persistence errors and retry through the data layer ---------------- */

test('S — storage failures surface as stable codes and states, never as message text', async () => {
  // Start-up: storage missing entirely.
  throwsCode(() => createIndexedDbSnapshotStore({ indexedDB: null }), 'STORAGE_UNAVAILABLE');
  // Start-up: storage present but refusing (e.g. private mode).
  const refusing = { open() { throw new Error('denied'); } };
  await rejectsCode(createIndexedDbSnapshotStore({ indexedDB: refusing }).read(), 'STORAGE_UNAVAILABLE');
  await rejectsCode(openBrowserDataLayer({ snapshotStore: { read: async () => { throw new Error('boom'); }, write: async () => {} } }), 'STORAGE_UNAVAILABLE');
  // Start-up: a record this app does not recognise — kept and readable.
  const foreign = createMemorySnapshotStore({ format: 'something-else', revision: 3, data: {} });
  const e = await rejectsCode(openBrowserDataLayer({ snapshotStore: foreign }), 'STORED_DATA_UNRECOGNIZED');
  assert.equal((await e.readStoredRecord()).format, 'something-else');
  // Start-up: a recognised record that fails validation → DATA_INVALID (see W).
  // Running: a failed background write is a stable status on the data layer.
  const store = createMemorySnapshotStore();
  const { app } = await openBrowserDataLayer({ snapshotStore: store, today: () => TODAY });
  store.failNextWrites(1);
  app.createDay(TODAY, 'rest');
  const status = await app.flushPersistence();
  assert.equal(status.state, 'error');
  assert.equal(app.getPersistenceStatus().state, 'error');
  assert.equal(app.getDay(TODAY).dayType, 'rest', 'the change is kept in the app');
});

test('T — retry works through the data layer, for every adapter', async () => {
  const store = createMemorySnapshotStore();
  const { app } = await openBrowserDataLayer({ snapshotStore: store, today: () => TODAY });
  store.failNextWrites(2);
  app.createDay(TODAY, 'lift');
  assert.equal((await app.flushPersistence()).state, 'error');
  assert.equal((await app.retryPersistence()).state, 'error', 'second failure is reported too');
  assert.equal((await app.retryPersistence()).state, 'saved');
  assert.equal(store.peek().data.days[0].date, TODAY);
  // Synchronous adapters: retry is a harmless no-op that reports 'saved'.
  assert.equal((await makeLayer().retryPersistence()).state, 'saved');
});

/* ---------------- V, W — explicit recovery of unreadable stored data ---------------- */

async function brokenStore() {
  const store = createMemorySnapshotStore();
  const { app } = await openBrowserDataLayer({ snapshotStore: store, today: () => TODAY });
  app.createDay(TODAY, 'lift');
  await app.flushPersistence();
  const bad = store.peek();
  bad.data.days[0].dayType = 'long';
  return createMemorySnapshotStore(bad);
}

test('W — start fresh is explicit, and only then replaces unreadable stored data', async () => {
  const store = await brokenStore();
  const before = store.peek();
  await rejectsCode(openBrowserDataLayer({ snapshotStore: store }), 'DATA_INVALID');
  assert.deepEqual(store.peek(), before, 'opening never discards stored data');
  await rejectsCode(recoverStoredData({ snapshotStore: store }), 'INVALID_ARGUMENT'); // must choose
  await rejectsCode(recoverStoredData({ snapshotStore: store, startFresh: true, backup: {} }), 'INVALID_ARGUMENT');
  const { app } = await recoverStoredData({ snapshotStore: store, startFresh: true, today: () => TODAY });
  assert.deepEqual(app.exportUserData().data, APP_DATA.seed, 'shipped first-run seed');
  assert.equal(store.peek().revision, before.revision + 1);
  const reopened = await openBrowserDataLayer({ snapshotStore: store });
  assert.deepEqual(reopened.app.exportUserData().data, APP_DATA.seed);
});

test('V — recovery from a backup validates it fully first; an invalid one writes nothing', async () => {
  const source = await openBrowserDataLayer({ snapshotStore: createMemorySnapshotStore(), today: () => TODAY });
  source.app.createMealInstance({ date: TODAY, mealSlot: 'lunch', mealId: 'meal_library_L26', dayType: 'lift' });
  source.app.setDayLoggingComplete(TODAY, true);
  const backup = source.app.exportUserData();

  const store = await brokenStore();
  const before = store.peek();
  const bad = JSON.parse(JSON.stringify(backup));
  bad.data.days[0].mealInstances = []; // done with nothing logged: invalid
  await rejectsCode(recoverStoredData({ snapshotStore: store, backup: bad }), 'BACKUP_INVALID');
  await rejectsCode(recoverStoredData({ snapshotStore: store, backup: '{not json' }), 'BACKUP_UNREADABLE');
  await rejectsCode(recoverStoredData({ snapshotStore: store, backup: { ...backup, formatVersion: 99 } }), 'BACKUP_INCOMPATIBLE');
  assert.deepEqual(store.peek(), before, 'storage untouched by every rejected backup');

  const { app } = await recoverStoredData({ snapshotStore: store, backup: JSON.stringify(backup), today: () => TODAY });
  assert.deepEqual(app.exportUserData().data, backup.data, 'historical Days and snapshots restored exactly');
  assert.equal(app.getDaySummary(TODAY).status, 'complete');
});

/* ---------------- X, Y, Z — meal search, Custom Food list, Food usage ---------------- */

test('X — meal search ranks like Food search, covers Saved and Library, excludes retired', () => {
  const app = makeLayer();
  const mine = saved(app, 'Hot honey chicken bowl');
  const hits = app.searchMeals('hot honey');
  assert.ok(hits.length > 0);
  assert.deepEqual(hits.map((h) => h.score), hits.map((h) => h.score).slice().sort((a, b) => b - a), 'best first');
  assert.ok(hits.some((h) => h.meal.id === mine.id));
  assert.equal(app.searchMeals('hot honey chicken bowl')[0].meal.id, mine.id, 'exact match first');
  assert.deepEqual(app.searchMeals('hot honey', { source: 'saved' }).map((h) => h.meal.id), [mine.id]);
  assert.ok(app.searchMeals('bowl', { source: 'library' }).every((h) => h.meal.source === 'library'));
  const retired = app.getLibraryMeals({ includeRetired: true }).filter((m) => m.metadata && m.metadata.retired);
  for (const m of retired) assert.ok(!app.searchMeals(m.name, { limit: 500 }).some((h) => h.meal.id === m.id), `${m.id} never found`);
  assert.deepEqual(app.searchMeals(''), []);
  assert.deepEqual(app.searchMeals('HOT   Honey'), hits, 'same normalisation as Food search');
  assert.deepEqual(app.searchMeals('hot honey'), hits, 'deterministic');
  throwsCode(() => app.searchMeals('x', { source: 'both' }), 'INVALID_ARGUMENT');
});

test('Y — Custom Foods are listed, sorted by name then ID', () => {
  const app = makeLayer();
  app.createCustomFood({ name: 'Zucchini chips', category: 'snack', state: 'baked', nutrition: { protein: 5, carbs: 50, fat: 20 } });
  app.createCustomFood({ name: 'apple rings', category: 'fruit', state: 'dry', nutrition: { protein: 1, carbs: 80, fat: 1 } });
  const list = app.getCustomFoods();
  assert.deepEqual(list.map((f) => f.name), list.map((f) => f.name).slice().sort((a, b) => a.localeCompare(b)));
  assert.equal(list.length, SEED.customFoods.length + 2);
  assert.ok(list.every((f) => f.source === 'custom'));
  list[0].name = 'mutated';
  assert.notEqual(app.getCustomFoods()[0].name, 'mutated', 'returns copies');
});

test('Z — Food usage lists Saved Meals only; history is not a dependency', () => {
  const app = makeLayer();
  const bar = app.createCustomFood({ name: 'Bar', category: 'bar', state: 'prepared', nutrition: { protein: 10, carbs: 50, fat: 10 } });
  const b = app.createSavedMeal({ name: 'B uses bar', ingredients: [{ foodId: bar.id, quantity: 30 }] });
  const a = app.createSavedMeal({ name: 'A uses bar', ingredients: [{ foodId: bar.id, quantity: 20 }, { foodId: 'food_core_banana', quantity: 50 }] });
  saved(app, 'No bar');
  app.logFood({ date: TODAY, mealSlot: 'lunch', foodId: bar.id, quantity: 40, dayType: 'lift' });
  assert.deepEqual(app.getFoodUsage(bar.id), { foodId: bar.id, savedMealIds: [a.id, b.id] });
  const { affectedSavedMealIds } = app.deleteCustomFood(bar.id);
  assert.deepEqual(affectedSavedMealIds.slice().sort(), [a.id, b.id].sort(), 'usage predicted exactly what deletion affects');
  assert.equal(app.getDay(TODAY).mealInstances[0].ingredients[0].foodName, 'Bar', 'history intact');
  assert.deepEqual(app.getFoodUsage('food_core_nope'), { foodId: 'food_core_nope', savedMealIds: [] });
});

/* ---------------- AA — canonical previews ---------------- */

test('AA — previews come from the canonical calculator, including progress for bars', () => {
  const app = makeLayer();
  const food = app.previewLogFood({ foodId: 'food_core_banana', quantity: 150 });
  assert.deepEqual(food.totals, app.calculateMealMacros({ id: 'x', ingredients: [{ foodId: 'food_core_banana', quantity: 150, unit: 'g' }] }).totals, 'Food contribution for a quantity');
  const meal = app.previewMealInstance({ mealId: 'meal_library_L26' });
  assert.deepEqual(meal.totals, app.calculateMealMacros('meal_library_L26').totals, 'Meal total');
  const withDay = app.previewMealInstance({ date: TODAY, mealId: 'meal_library_L26', dayType: 'lift' });
  const logged = app.createMealInstance({ date: TODAY, mealSlot: 'lunch', mealId: 'meal_library_L26', dayType: 'lift' });
  const s = app.getDaySummary(TODAY);
  assert.deepEqual(withDay.day.after.remaining, s.remaining, 'remaining after adding a Meal Instance');
  assert.deepEqual(s.logged, logged.totals);
  for (const m of ['protein', 'carbs', 'fat']) {
    assert.ok(s.progress[m] >= 0 && s.progress[m] <= 1, 'progress is a 0–1 fraction');
    assert.equal(s.progress[m], Math.min(s.logged[m] / s.target[m], 1));
  }
  app.logFood({ date: TODAY, mealSlot: 'dinner', foodId: 'food_core_fage_0_greek_yogurt', quantity: 3000 });
  assert.equal(app.getDaySummary(TODAY).progress.protein, 1, 'capped at 1 once reached');
  assert.equal(app.getDaySummary('2026-01-01').progress, null, 'no Day, no progress');
});

/* ---------------- AB, AC, AD — source scans ---------------- */

test('AB — product labels are allowed by the architecture scan, in every UI file type', () => {
  const ok = [
    ["const labels = ['Protein', 'Carbs', 'Fat', 'Add protein', 'Remaining carbs'];", 'a.js'],
    ["export const copy = { addProtein: 'Add protein', remainingCarbs: 'Remaining carbs' };", 'a.mjs'],
    ['const H = () => <button aria-label="Add protein">Add protein</button>;', 'a.jsx'],
    ["const title: string = 'Remaining carbs';", 'a.ts'],
    ['export const Row = () => <th>Protein / Carbs / Fat</th>;', 'a.tsx'],
    ['.macro--protein, .remaining-carbs { color: var(--macro-carbs); } .bar { width: calc(var(--fill) * 100%); }', 'a.css']
  ];
  for (const [src, file] of ok) assert.deepEqual(macroArithmeticInSource(src, file), [], `${file}: ${src}`);
});

test('AC — duplicated arithmetic is still detected in every UI file type', () => {
  const bad = [
    ['const c = (g / 100) * food.nutrition.carbs;', 'a.mjs'],
    ['const left: number = target.protein - logged.protein;', 'a.ts'],
    ['const Cell = () => <td>{(logged.fat / target.fat) * 100}%</td>;', 'a.tsx'],
    ['const total = items.reduce((s, i) => s + i.protein, 0);', 'a.jsx'],
    ['.bar { width: calc(var(--carbs) / var(--carbs-target) * 100%); }', 'a.css']
  ];
  for (const [src, file] of bad) assert.ok(macroArithmeticInSource(src, file).length > 0, `${file}: ${src}`);
});

test('AD — the forbidden-concept scan is clean across runtime, domain and data', () => {
  const scanned = listRepoFiles().filter((f) => /^(src|data|user-data)\//.test(f) && !isBinary(f) && !f.endsWith('.md'));
  assert.ok(scanned.some((f) => f.startsWith('src/browser/')), 'browser modules included');
  const hits = scanned.filter((f) => FORBIDDEN_NUTRITION.test(fs.readFileSync(path.join(ROOT, f), 'utf8')));
  assert.deepEqual(hits, []);
});
