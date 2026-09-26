// Pre-UI foundations — tests for the approved decisions (review of 25 Sep 2026):
// day completeness (Q1), Coach order (Q2), applying targets to today (Q13), browser
// persistence (N1/N2), backup/restore (N3), day-type correction (N4), finite numbers,
// one calculator with UI previews, and Custom Food validation. Tests A–V.
// Run: node --test tests/

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  ROOT, tempRepo, cleanup, readText, macroArithmeticInSource, domainImportsBypassingIndex,
  FORBIDDEN_NUTRITION, close
} from './helpers.mjs';
import { createDataLayer, createMemoryAdapter, DomainError, macros, BACKUP_FORMAT, BACKUP_FORMAT_VERSION, USER_COLLECTIONS } from '../src/domain/index.js';
import { makeSchemaValidator } from '../src/domain/schema-validator.js';
import { createFileAdapter } from '../src/node/file-adapter.js';
import { createBrowserAdapter, STORE_RECORD_FORMAT } from '../src/browser/browser-adapter.js';
import { createMemorySnapshotStore } from '../src/browser/memory-snapshot-store.js';
import { DEFAULT_DB_NAME } from '../src/browser/indexeddb-snapshot-store.js';
import { APP_DATA, openBrowserDataLayer } from '../src/browser/app-data.js';

const TODAY = '2026-09-24';
const PAST = '2026-09-10';
const SEED = createFileAdapter(ROOT).load(); // read-only: canonical data + first-run user data

const throwsCode = (fn, code) => assert.throws(fn, (e) => e instanceof DomainError && e.code === code, `expected DomainError ${code}`);

/** A deterministic data layer. `adapter` defaults to an in-memory copy of the canonical data. */
function makeLayer({ adapter = createMemoryAdapter(SEED), today = TODAY } = {}) {
  let t = Date.parse(`${TODAY}T12:00:00Z`);
  let n = 0;
  return createDataLayer({ adapter, today: () => today, clock: () => new Date((t += 60000)), newId: () => `t${String(++n).padStart(4, '0')}` });
}

/** Memory adapter that counts writes and can be told to fail. */
function countingAdapter(initial = SEED) {
  const inner = createMemoryAdapter(initial);
  const calls = [];
  let fail = false;
  return {
    calls,
    failWrites(on = true) { fail = on; },
    snapshot: () => inner.snapshot(),
    load: () => inner.load(),
    save(c, d) { this.saveMany({ [c]: d }); },
    saveMany(changes) {
      if (fail) throw new Error('simulated storage failure');
      calls.push(Object.keys(changes).sort());
      inner.saveMany(changes);
    }
  };
}

const appData = () => ({
  schemas: SEED.schemas,
  coreFoods: SEED.coreFoods,
  libraryMeals: SEED.libraryMeals,
  seed: { targets: SEED.targets, customFoods: SEED.customFoods, savedMeals: SEED.savedMeals, days: SEED.days, preferences: SEED.preferences }
});

const userState = (app) => app.exportUserData().data;
const makeBar = (app, name = 'Test Oat Bar') => app.createCustomFood({ name, category: 'cereal', state: 'prepared', nutrition: { protein: 10, carbs: 60, fat: 12 } });
const F = (...parts) => parts.join(''); // assemble forbidden words so this file does not contain them

/* ================================================================== */
/* A–C  Day completeness (Q1)                                          */
/* ================================================================== */

test('A — a Day can be complete without a night snack', () => {
  const app = makeLayer();
  const day = app.createDay(TODAY, 'lift');
  assert.equal(day.loggingComplete, false, 'a new Day is not complete');
  for (const slot of ['breakfast', 'lunch', 'snack_afternoon', 'dinner']) app.logFood({ date: TODAY, mealSlot: slot, foodId: 'food_core_banana', quantity: 100 });
  app.setDayLoggingComplete(TODAY, true);

  const s = app.getDaySummary(TODAY);
  assert.equal(s.status, 'complete');
  assert.equal(s.loggingComplete, true);
  assert.deepEqual(s.unloggedSlots, ['snack_night'], 'slot coverage is still reported, as information');

  const p = app.getProgress({ period: 7, endDate: TODAY });
  assert.equal(p.counts.complete, 1);
  assert.equal(p.averages.completeDays.days, 1, 'enters the complete-day average without a night snack');
  assert.deepEqual(p.averages.completeDays.actual, s.logged);
  assert.equal(p.daily.at(-1).hit.carbs, 'missed', 'a complete Day below target is a miss');

  // One meal is enough to mark a Day done: no slot pattern is required.
  const one = makeLayer();
  one.createMealInstance({ date: TODAY, mealSlot: 'lunch', mealId: 'meal_library_L26', dayType: 'rest' });
  assert.equal(one.setDayLoggingComplete(TODAY, true).loggingComplete, true);
  assert.equal(one.getDaySummary(TODAY).status, 'complete');
});

test('B — an unmarked Day stays partial however many slots have food', () => {
  const app = makeLayer();
  for (const slot of app.constants.MEAL_SLOTS) app.logFood({ date: TODAY, mealSlot: slot, foodId: 'food_core_banana', quantity: 100, dayType: 'lift' });
  const s = app.getDaySummary(TODAY);
  assert.deepEqual(s.unloggedSlots, [], 'all five slots have food');
  assert.equal(s.status, 'partial');
  assert.equal(s.loggingComplete, false);
  const p = app.getProgress({ period: 7, endDate: TODAY });
  assert.deepEqual(p.counts, { complete: 0, partial: 1, noData: 6 });
  assert.equal(p.averages.completeDays, null);
  assert.equal(p.daily.at(-1).hit.carbs, 'undetermined', 'not a miss until the user says the Day is done');

  // Reopening works and never touches the food.
  const before = app.getDay(TODAY).mealInstances;
  app.setDayLoggingComplete(TODAY, true);
  app.setDayLoggingComplete(TODAY, false);
  assert.equal(app.getDaySummary(TODAY).status, 'partial');
  assert.deepEqual(app.getDay(TODAY).mealInstances, before);
  throwsCode(() => app.setDayLoggingComplete(TODAY, 'yes'), 'INVALID_ARGUMENT');
  throwsCode(() => app.setDayLoggingComplete('2026-01-01', true), 'DAY_NOT_FOUND');
});

test('C — missing meal slots are never treated as zero food', () => {
  const app = makeLayer();
  app.createDay(TODAY, 'lift');
  throwsCode(() => app.setDayLoggingComplete(TODAY, true), 'NOTHING_LOGGED');
  assert.equal(app.getDaySummary(TODAY).status, 'no_data');

  const lunch = app.createMealInstance({ date: TODAY, mealSlot: 'lunch', mealId: 'meal_library_L26' });
  const s = app.getDaySummary(TODAY);
  assert.deepEqual(s.logged, lunch.totals, 'logged is exactly what was logged');
  assert.equal(s.loggedSlots.length, 1);

  const p = app.getProgress({ period: 3, endDate: TODAY });
  for (const d of p.daily.slice(0, 2)) { assert.equal(d.status, 'no_data'); assert.equal(d.actual, null); }
  assert.equal(p.trend.actual.protein[0], null);
  assert.equal(p.averages.loggedDays.days, 1, 'no-data days are not averaged in as zero');

  // Marked done, then every meal deleted: the Day reopens rather than meaning "ate nothing".
  app.setDayLoggingComplete(TODAY, true);
  app.deleteMealInstance(TODAY, lunch.id);
  const after = app.getDay(TODAY);
  assert.equal(after.loggingComplete, false);
  assert.equal(app.getDaySummary(TODAY).status, 'no_data');

  // The store refuses the contradiction outright.
  const dir = tempRepo();
  try {
    const bad = { ...after, loggingComplete: true };
    fs.writeFileSync(path.join(dir, 'user-data/daily-logs.json'), JSON.stringify([bad]));
    throwsCode(() => createDataLayer({ adapter: createFileAdapter(dir) }), 'DATA_INVALID');
  } finally { cleanup(dir); }
});

/* ================================================================== */
/* D–E  Macro Coach order (Q2)                                         */
/* ================================================================== */

function coachFixture() {
  const app = makeLayer();
  const bar = makeBar(app);
  const s1 = app.createSavedMeal({ name: 'Zeta bowl', mealType: 'dinner', ingredients: [{ foodId: 'food_core_banana', quantity: 100 }] });
  const s2 = app.createSavedMeal({ name: 'Alpha bowl', mealType: 'lunch', ingredients: [{ foodId: 'food_core_banana', quantity: 150 }] });
  const s3 = app.createSavedMeal({ name: 'Logged saved meal', mealType: 'snack', ingredients: [{ foodId: 'food_core_banana', quantity: 80 }] });
  const s4 = app.createSavedMeal({ name: 'Never logged', mealType: 'breakfast', ingredients: [{ foodId: 'food_core_banana', quantity: 60 }] });
  const broken = app.createSavedMeal({ name: 'Broken', mealType: 'snack', ingredients: [{ foodId: bar.id, quantity: 50 }] });
  app.deleteCustomFood(bar.id);
  app.setFavoriteMeal(s1.id, true);
  app.setFavoriteMeal(s2.id, true);
  app.createMealInstance({ date: TODAY, mealSlot: 'breakfast', mealId: 'meal_library_B1', dayType: 'lift' });
  app.createMealInstance({ date: TODAY, mealSlot: 'lunch', mealId: s3.id });
  app.createMealInstance({ date: TODAY, mealSlot: 'snack_afternoon', mealId: s1.id });
  return { app, s1, s2, s3, s4, broken };
}

test('D — Coach suggestions follow the approved order, deterministically', () => {
  const { app, s1, s2, s3, s4, broken } = coachFixture();
  const r = app.getMacroCoachSuggestions({ date: TODAY, mealSlot: 'dinner' });
  const ids = (tier) => r.tiers.find((t) => t.tier === tier).items.map((i) => i.mealId);

  assert.deepEqual(r.tiers.map((t) => t.tier), ['favoriteSaved', 'recent', 'saved', 'library']);
  assert.deepEqual(r.tiers.map((t) => t.personalized), [true, true, true, false]);
  assert.deepEqual(ids('favoriteSaved'), [s1.id, s2.id], 'favourite Saved Meals, most recently logged first');
  assert.deepEqual(ids('recent'), [s3.id], 'recently logged Saved Meals, newest first, favourites not repeated');
  assert.deepEqual(ids('saved'), [s4.id], 'other Saved Meals');
  assert.ok(ids('library').includes('meal_library_B1'), 'a logged Library Meal stays a Library starter (recent = Saved Meals only)');
  assert.ok(ids('library').length > 50, 'Library starters follow');
  assert.deepEqual(r.excluded.needsReplacement, [broken.id], 'meals that cannot be calculated are excluded and listed');
  const all = r.tiers.flatMap((t) => t.items.map((i) => i.mealId));
  assert.equal(new Set(all).size, all.length, 'no duplicates across tiers');
  assert.equal(r.insufficientHistory, false);
  assert.equal(r.personalMealCount, 4);

  // "After this" comes from the calculator and matches what logging would do.
  const first = r.tiers[0].items[0];
  const preview = app.previewMealInstance({ date: TODAY, mealId: first.mealId });
  assert.deepEqual(first.after.remaining, preview.day.after.remaining);
  assert.deepEqual(first.totals, app.calculateMealMacros(first.mealId).totals);

  // Same inputs, same answer; limitPerTier only trims.
  assert.deepEqual(app.getMacroCoachSuggestions({ date: TODAY, mealSlot: 'dinner' }), r);
  const trimmed = app.getMacroCoachSuggestions({ date: TODAY, mealSlot: 'dinner', limitPerTier: 1 });
  assert.equal(trimmed.tiers[3].items.length, 1);
  assert.equal(trimmed.tiers[3].total, r.tiers[3].total);
  assert.deepEqual(trimmed.tiers[3].items[0], r.tiers[3].items[0]);

  // No scoring or fit ranking of any kind in the output.
  assert.ok(!/"(score|rank|fit|fitScore|distance)"/i.test(JSON.stringify(r)));

  // Library starters that use a disliked Food are left out; personal meals are not filtered.
  app.setDislikedFood('food_core_banana', true);
  const d = app.getMacroCoachSuggestions({ date: TODAY, mealSlot: 'dinner' });
  assert.deepEqual(d.tiers[0].items.map((i) => i.mealId), [s1.id, s2.id]);
  for (const item of d.tiers[3].items) assert.ok(!app.getMeal(item.mealId).ingredients.some((i) => i.foodId === 'food_core_banana'));
  throwsCode(() => app.getMacroCoachSuggestions({ date: TODAY, mealSlot: 'dinner', limitPerTier: 0 }), 'INVALID_ARGUMENT');
});

test('D2 — personal tiers are Saved Meals only; a favourited or logged Library Meal stays in the Library tier', () => {
  const app = makeLayer();
  const libFav = 'meal_library_D1';                          // favourited, never logged
  const libOrder = app.getLibraryMeals().map((m) => m.id);
  assert.ok(libOrder.indexOf(libFav) > 0, 'fixture: not already first in the Library');
  const savedFav = app.createSavedMeal({ name: 'My favourite', mealType: 'dinner', ingredients: [{ foodId: 'food_core_banana', quantity: 100 }] });
  const savedOther = app.createSavedMeal({ name: 'My other', mealType: 'lunch', ingredients: [{ foodId: 'food_core_banana', quantity: 50 }] });
  const copy = app.createSavedMeal({ fromMealId: 'meal_library_B1' }); // a saved copy of a Library Meal
  app.setFavoriteMeal(libFav, true);                          // Library favouriting is still allowed…
  app.setFavoriteMeal('meal_library_B1', true);
  app.setFavoriteMeal(savedFav.id, true);
  assert.deepEqual(app.getPreferences().favoriteMeals, [libFav, 'meal_library_B1', savedFav.id]);

  const r = app.getMacroCoachSuggestions({ date: TODAY, mealSlot: 'dinner', dayType: 'lift' });
  const tier = (name) => r.tiers.find((t) => t.tier === name);
  const ids = (name) => tier(name).items.map((i) => i.mealId);

  // …but it never makes a Library Meal part of the favourites group.
  assert.deepEqual(ids('favoriteSaved'), [savedFav.id], 'tier 1 = favourited Saved Meals only');
  for (const item of tier('favoriteSaved').items) assert.equal(item.source, 'saved');
  assert.deepEqual(ids('recent'), [], 'nothing logged yet');
  assert.deepEqual(new Set(ids('saved')), new Set([savedOther.id, copy.id]), 'the copy is an ordinary Saved Meal: favouriting its Library source does not carry over');
  assert.deepEqual(ids('library'), libOrder, 'favourited Library Meals keep their Library position (no boost)');
  const libItem = tier('library').items.find((i) => i.mealId === libFav);
  assert.equal(libItem.isFavorite, true, 'the favourite state is still visible on the item');
  assert.equal(tier('library').personalized, false);

  // Logging a Library Meal does not make it personal: "recent" is Saved Meals only.
  app.createMealInstance({ date: TODAY, mealSlot: 'dinner', mealId: libFav, dayType: 'lift' });
  const r2 = app.getMacroCoachSuggestions({ date: TODAY, mealSlot: 'snack_night' });
  const ids2 = (name) => r2.tiers.find((t) => t.tier === name).items.map((i) => i.mealId);
  assert.deepEqual(ids2('favoriteSaved'), [savedFav.id]);
  assert.deepEqual(ids2('recent'), []);
  assert.deepEqual(ids2('library'), libOrder, 'still a Library starter, in Library order');
  assert.deepEqual(r2.tiers.map((t) => t.tier), ['favoriteSaved', 'recent', 'saved', 'library'], 'order is fixed');
  assert.ok(Array.isArray(r2.topUpFoods.personalized), 'top-up Foods are separate from the meal tiers');
});

test('E — a new user gets honest, non-personal starters', () => {
  const app = makeLayer();
  throwsCode(() => app.getMacroCoachSuggestions({ date: TODAY, mealSlot: 'lunch' }), 'DAY_TYPE_REQUIRED');
  const r = app.getMacroCoachSuggestions({ date: TODAY, mealSlot: 'lunch', dayType: 'lift' });
  assert.equal(r.insufficientHistory, true, 'says there is not enough personal history');
  assert.equal(r.personalMealCount, 0);
  for (const t of r.tiers.slice(0, 3)) assert.equal(t.total, 0);
  const lib = r.tiers[3];
  assert.equal(lib.personalized, false, 'starters are not presented as personal');
  assert.equal(lib.total, app.getLibraryMeals().length, 'every non-retired, calculable Library Meal');
  const retired = app.getLibraryMeals({ includeRetired: true }).filter((m) => m.metadata && m.metadata.retired).map((m) => m.id);
  assert.ok(retired.length > 0 && !lib.items.some((i) => retired.includes(i.mealId)), 'retired Library Meals are never starters');
  assert.deepEqual(lib.items.map((i) => i.mealId), app.getLibraryMeals().map((m) => m.id), 'Library order');

  assert.deepEqual(r.topUpFoods.personalized, []);
  assert.ok(r.topUpFoods.starter.length > 0 && r.topUpFoods.starter.length <= 10, 'useful individual Foods are offered');
  for (const f of r.topUpFoods.starter) assert.deepEqual(f.reasons, ['library_ingredient']);
  const counts = r.topUpFoods.starter.map((f) => f.usedInLibraryMeals);
  assert.deepEqual(counts, counts.slice().sort((a, b) => b - a), 'most-used first');
  assert.equal(app.getDay(TODAY), null, 'asking for suggestions does not create a Day');
  assert.deepEqual(r.remaining, app.getCurrentTargets('lift'));
});

/* ================================================================== */
/* F–J  Targets and day types (Q13, N4)                                */
/* ================================================================== */

test('F — changing current targets never mutates an existing Day', () => {
  const app = makeLayer();
  app.createDay(PAST, 'lift');
  app.createDay(TODAY, 'rest');
  app.updateDayType(PAST, 'long_run'); // gives the past Day a prior snapshot too
  const before = [app.getDay(PAST), app.getDay(TODAY)];
  for (const type of ['lift', 'long_run', 'rest']) app.updateCurrentTargets(type, { protein: 160, carbs: 400, fat: 80 });
  assert.deepEqual([app.getDay(PAST), app.getDay(TODAY)], before, 'snapshots and prior snapshots unchanged');
  assert.deepEqual(app.createDay('2026-09-25', 'rest').targetSnapshot, { protein: 160, carbs: 400, fat: 80 }, 'new Days use current targets');
});

test('G — applying current targets to today is explicit and touches only today', () => {
  const adapter = countingAdapter();
  const app = makeLayer({ adapter });
  app.createDay(PAST, 'lift');
  app.logFood({ date: TODAY, mealSlot: 'lunch', foodId: 'food_core_banana', quantity: 120, dayType: 'lift' });
  app.setDayLoggingComplete(TODAY, true);
  app.updateCurrentTargets('lift', { carbs: 310 });
  assert.equal(app.getDay(TODAY).targetSnapshot.carbs, 293, 'not applied automatically');

  const before = app.getDay(TODAY);
  const after = app.applyCurrentTargetsToToday();
  assert.equal(app.getToday(), TODAY);
  assert.deepEqual(after.targetSnapshot, { protein: 150, carbs: 310, fat: 70 });
  assert.equal(after.dayType, 'lift', 'day type unchanged');
  assert.deepEqual(after.mealInstances, before.mealInstances, 'logged food unchanged');
  assert.equal(after.loggingComplete, true);
  assert.deepEqual(app.getCurrentTargets('lift'), { protein: 150, carbs: 310, fat: 70 }, 'current targets unchanged');
  assert.equal(app.getDay(PAST).targetSnapshot.carbs, 293, 'no other Day changes');

  const writes = adapter.calls.length;
  app.applyCurrentTargetsToToday();
  assert.equal(adapter.calls.length, writes, 'already current: nothing written');

  const noToday = makeLayer({ today: '2026-09-30' });
  throwsCode(() => noToday.applyCurrentTargetsToToday(), 'DAY_NOT_FOUND');
});

test('H — correcting a past Day type keeps the earlier target context', () => {
  const app = makeLayer();
  app.logFood({ date: PAST, mealSlot: 'dinner', foodId: 'food_core_banana', quantity: 100, dayType: 'lift' });
  const food = app.getDay(PAST).mealInstances;
  app.updateCurrentTargets('lift', { carbs: 310 });
  app.updateCurrentTargets('rest', { carbs: 225 });

  const preview = app.previewDayTypeChange(PAST, 'rest');
  assert.equal(preview.noOp, false);
  assert.deepEqual(preview.from, { dayType: 'lift', target: { protein: 150, carbs: 293, fat: 70 } });
  assert.deepEqual(preview.to, { dayType: 'rest', target: { protein: 150, carbs: 225, fat: 70 }, targetSource: 'current' });
  assert.deepEqual(preview.before.logged, preview.after.logged, 'logged food identical in both');
  assert.deepEqual(app.getDay(PAST).dayType, 'lift', 'a preview changes nothing');

  const changed = app.updateDayType(PAST, 'rest');
  assert.equal(changed.dayType, 'rest');
  assert.deepEqual(changed.targetSnapshot, { protein: 150, carbs: 225, fat: 70 });
  assert.deepEqual(changed.priorTargetSnapshots, { lift: { protein: 150, carbs: 293, fat: 70 } }, 'the replaced context is kept');
  assert.deepEqual(changed.mealInstances, food, 'logged food never changes');
  assert.equal(app.getDaySummary(PAST).target.carbs, 225, 'remaining follows the new context');
});

test('I — switching back restores the earlier context, not today\'s current targets', () => {
  const app = makeLayer();
  app.createDay(PAST, 'lift');
  app.updateCurrentTargets('lift', { carbs: 310 });
  app.updateDayType(PAST, 'rest');
  assert.equal(app.previewDayTypeChange(PAST, 'lift').to.targetSource, 'restored');
  const back = app.updateDayType(PAST, 'lift');
  assert.deepEqual(back.targetSnapshot, { protein: 150, carbs: 293, fat: 70 }, 'original Lift targets, not the new 310');
  assert.deepEqual(back.priorTargetSnapshots, { rest: { protein: 150, carbs: 218, fat: 70 } });

  // A type the Day never had comes from current targets, and says so.
  assert.equal(app.previewDayTypeChange(PAST, 'long_run').to.targetSource, 'current');
  const lr = app.updateDayType(PAST, 'long_run');
  assert.equal(lr.targetSnapshot.carbs, 343);
  assert.deepEqual(Object.keys(lr.priorTargetSnapshots).sort(), ['lift', 'rest']);
  assert.equal(app.updateDayType(PAST, 'rest').targetSnapshot.carbs, 218, 'each type restores its own snapshot');

  // Survives a reload through the file adapter.
  const dir = tempRepo();
  try {
    const a = createDataLayer({ adapter: createFileAdapter(dir) });
    a.createDay(PAST, 'lift');
    a.updateDayType(PAST, 'rest');
    const reopened = createDataLayer({ adapter: createFileAdapter(dir) });
    assert.deepEqual(reopened.getDay(PAST), a.getDay(PAST));
    assert.equal(reopened.updateDayType(PAST, 'lift').targetSnapshot.carbs, 293);
  } finally { cleanup(dir); }
});

test('J — choosing the same day type again is a no-op', () => {
  const adapter = countingAdapter();
  const app = makeLayer({ adapter });
  app.createDay(PAST, 'lift');
  app.updateCurrentTargets('lift', { carbs: 310 });
  const before = app.getDay(PAST);
  const writes = adapter.calls.length;
  assert.deepEqual(app.updateDayType(PAST, 'lift'), before);
  assert.equal(adapter.calls.length, writes, 'nothing written');
  assert.equal(app.getDay(PAST).targetSnapshot.carbs, 293, 'no silent refresh to current targets');
  assert.equal(app.previewDayTypeChange(PAST, 'lift').noOp, true);
});

/* ================================================================== */
/* K–M  Finite numbers                                                 */
/* ================================================================== */

function nonFiniteCases(bad) {
  return [
    ['Custom Food nutrition', (app) => app.createCustomFood({ name: 'Bad', category: 'x', state: 'prepared', nutrition: { protein: bad, carbs: 1, fat: 1 } }), 'INVALID_FOOD'],
    ['Custom Food update', (app) => app.updateCustomFood(makeBar(app, `Bar ${String(bad)}`).id, { nutrition: { fat: bad } }), 'INVALID_FOOD'],
    ['current targets', (app) => app.updateCurrentTargets('rest', { carbs: bad }), 'INVALID_TARGETS'],
    ['logged quantity', (app) => app.logFood({ date: TODAY, mealSlot: 'lunch', foodId: 'food_core_banana', quantity: bad, dayType: 'lift' }), 'INVALID_QUANTITY'],
    ['Saved Meal quantity', (app) => app.createSavedMeal({ name: 'Bad', ingredients: [{ foodId: 'food_core_banana', quantity: bad }] }), 'INVALID_QUANTITY'],
    ['Saved Meal metadata (untyped)', (app) => app.createSavedMeal({ name: 'Bad', ingredients: [{ foodId: 'food_core_banana', quantity: 10 }], metadata: { prepMinutes: bad } }), 'VALIDATION_FAILED'],
    ['preferences (untyped)', (app) => app.updatePreferences({ mealPreferences: { size: bad } }), 'VALIDATION_FAILED']
  ];
}

test('K — NaN is rejected everywhere a number can be stored', () => {
  const app = makeLayer();
  for (const [what, fn, code] of nonFiniteCases(NaN)) {
    assert.throws(() => fn(app), (e) => e instanceof DomainError && e.code === code, `${what}: expected ${code}`);
  }
  const v = app.validateCustomFood({ name: 'Bad', category: 'x', state: 'prepared', nutrition: { protein: NaN, carbs: 1, fat: 1 } });
  assert.equal(v.valid, false);
  assert.deepEqual(v.errors.map((e) => [e.field, e.code]), [['nutrition.protein', 'NUTRITION_NOT_A_NUMBER']]);
  const validate = makeSchemaValidator(SEED.schemas);
  assert.ok(validate({ lift: { protein: NaN, carbs: 1, fat: 1 }, long_run: { protein: 1, carbs: 1, fat: 1 }, rest: { protein: 1, carbs: 1, fat: 1 } }, 'targets.schema.json', 't').length > 0, 'the schema validator itself rejects NaN');
});

test('L — Infinity and -Infinity are rejected everywhere a number can be stored', () => {
  for (const bad of [Infinity, -Infinity]) {
    const app = makeLayer();
    for (const [what, fn, code] of nonFiniteCases(bad)) {
      assert.throws(() => fn(app), (e) => e instanceof DomainError && e.code === code, `${what} (${bad}): expected ${code}`);
    }
  }
  const validate = makeSchemaValidator(SEED.schemas);
  const food = { ...SEED.coreFoods[0], nutrition: { ...SEED.coreFoods[0].nutrition, carbs: Infinity } };
  assert.ok(validate(food, 'food.schema.json', 'f').some((e) => /non-finite/.test(e)));
  assert.equal(makeLayer().validateCustomFood({ name: 'x', category: 'x', state: 'raw', nutrition: { protein: 1, carbs: '5', fat: 1 } }).errors[0].code, 'NUTRITION_NOT_A_NUMBER', 'numeric strings are not numbers');
});

test('M — invalid values never persist and never corrupt existing data', () => {
  const dir = tempRepo();
  try {
    const app = createDataLayer({ adapter: createFileAdapter(dir) });
    const bar = makeBar(app);
    app.logFood({ date: TODAY, mealSlot: 'lunch', foodId: bar.id, quantity: 50, dayType: 'lift' });
    const files = ['data/targets.json', 'user-data/custom-foods.json', 'user-data/saved-meals.json', 'user-data/daily-logs.json', 'user-data/preferences.json'];
    const snapshot = () => files.map((f) => readText(dir, f));
    const before = snapshot();
    for (const bad of [NaN, Infinity, -Infinity]) {
      for (const [, fn] of nonFiniteCases(bad)) {
        const probe = createDataLayer({ adapter: createFileAdapter(dir) });
        const kept = snapshot();
        try { fn(probe); } catch { /* expected */ }
        // makeBar inside a case may have succeeded; everything else must be unchanged
        const now = snapshot();
        for (let i = 0; i < files.length; i++) if (files[i] !== 'user-data/custom-foods.json') assert.equal(now[i], kept[i], `${files[i]} unchanged`);
        for (const f of JSON.parse(now[1])) for (const m of ['protein', 'carbs', 'fat']) assert.ok(Number.isFinite(f.nutrition[m]), `${f.id}.${m} is a finite number on disk`);
        for (const t of Object.values(JSON.parse(now[0]))) for (const m of ['protein', 'carbs', 'fat']) assert.ok(Number.isFinite(t[m]), 'targets finite on disk');
      }
    }
    const reopened = createDataLayer({ adapter: createFileAdapter(dir) }); // would throw DATA_INVALID if corrupted
    assert.deepEqual(reopened.getFood(bar.id).nutrition, bar.nutrition);
    assert.deepEqual(reopened.getDay(TODAY), app.getDay(TODAY));
    assert.equal(snapshot()[3], before[3], 'daily logs untouched by every rejected write');
  } finally { cleanup(dir); }
});

/* ================================================================== */
/* N–O  Browser persistence and atomic commits                         */
/* ================================================================== */

test('N — browser persistence survives reload (three save/reload cycles)', async () => {
  const snapshotStore = createMemorySnapshotStore();
  const open = async () => {
    const adapter = await createBrowserAdapter({ appData: appData(), snapshotStore, now: () => '2026-09-24T12:00:00.000Z' });
    return { adapter, app: makeLayer({ adapter }) };
  };

  let { adapter, app } = await open();
  assert.equal(adapter.status().state, 'saved');
  const bar = makeBar(app);
  const saved = app.createSavedMeal({ name: 'Bar bowl', mealType: 'lunch', ingredients: [{ foodId: bar.id, quantity: 40 }, { foodId: 'food_core_banana', quantity: 100 }] });
  app.createMealInstance({ date: TODAY, mealSlot: 'lunch', mealId: saved.id, dayType: 'long_run' });
  app.setDayLoggingComplete(TODAY, true);
  app.setFavoriteMeal(saved.id, true);
  app.updateCurrentTargets('rest', { carbs: 230 });
  const status = await app.flushPersistence();
  assert.equal(status.state, 'saved');
  const expected = userState(app);

  for (let cycle = 1; cycle <= 3; cycle++) {
    ({ adapter, app } = await open()); // a page reload: new adapter, new data layer, same storage
    assert.deepEqual(userState(app), expected, `cycle ${cycle}: everything came back`);
    // …and the reopened app can save again (the second-visit failure mode of 16 Sep).
    app.logFood({ date: TODAY, mealSlot: 'snack_night', foodId: 'food_core_banana', quantity: 10 * cycle });
    assert.equal((await app.flushPersistence()).state, 'saved');
    expected.days = userState(app).days;
  }
  ({ app } = await open());
  assert.equal(app.getDay(TODAY).mealInstances.length, 4);

  // Only the five user collections are stored, in V2's own record format.
  const record = snapshotStore.peek();
  assert.equal(record.format, STORE_RECORD_FORMAT);
  assert.deepEqual(Object.keys(record.data).sort(), [...USER_COLLECTIONS].sort());
  assert.equal(DEFAULT_DB_NAME, 'meal-tracking-v2', 'a database of its own, isolated from the retired pages');

  // A failing write is visible, keeps the change in memory, and can be retried.
  const store2 = createMemorySnapshotStore();
  const a2 = await createBrowserAdapter({ appData: appData(), snapshotStore: store2 });
  const app2 = makeLayer({ adapter: a2 });
  const seen = [];
  app2.onPersistenceChange((s) => seen.push(s.state));
  store2.failNextWrites(1);
  app2.createDay(TODAY, 'rest');
  assert.equal((await app2.flushPersistence()).state, 'error');
  assert.equal(app2.getPersistenceStatus().state, 'error');
  assert.equal(store2.peek(), null, 'nothing half-written');
  assert.equal((await a2.retry()).state, 'saved');
  assert.equal(store2.peek().data.days.length, 1);
  assert.deepEqual(seen, ['saving', 'error', 'saving', 'saved']);

  // Two tabs: the stale one is refused, nothing is overwritten.
  const shared = createMemorySnapshotStore();
  const tabA = makeLayer({ adapter: await createBrowserAdapter({ appData: appData(), snapshotStore: shared }) });
  const tabB = makeLayer({ adapter: await createBrowserAdapter({ appData: appData(), snapshotStore: shared }) });
  tabA.createDay(TODAY, 'lift');
  await tabA.flushPersistence();
  tabB.createDay(PAST, 'rest');
  assert.equal((await tabB.flushPersistence()).state, 'conflict');
  assert.deepEqual(shared.peek().data.days.map((d) => d.date), [TODAY], 'tab A\'s data kept');

  // File and memory adapters report the same status shape.
  assert.equal(makeLayer().getPersistenceStatus().state, 'saved');
});

test('O — a failed multi-collection mutation leaves no partial data', () => {
  // Store level: deleteCustomFood writes three collections in one commit.
  const adapter = countingAdapter();
  const app = makeLayer({ adapter });
  const bar = makeBar(app);
  const meal = app.createSavedMeal({ name: 'Uses bar', ingredients: [{ foodId: bar.id, quantity: 30 }] });
  app.setFavoriteFood(bar.id, true);
  const before = userState(app);
  const stored = adapter.snapshot();
  adapter.failWrites(true);
  throwsCode(() => app.deleteCustomFood(bar.id), 'PERSIST_FAILED');
  assert.deepEqual(userState(app), before, 'in-memory state unchanged');
  assert.deepEqual(adapter.snapshot(), stored, 'storage unchanged');
  assert.equal(app.calculateMealMacros(meal.id).valid, true);
  adapter.failWrites(false);
  app.deleteCustomFood(bar.id);
  assert.deepEqual(adapter.calls.at(-1), ['customFoods', 'preferences', 'savedMeals'], 'one write carrying all three collections');

  // File adapter: a failure writing the second file leaves every canonical file as it was.
  const dir = tempRepo();
  try {
    const fa = createDataLayer({ adapter: createFileAdapter(dir) });
    const b2 = makeBar(fa);
    fa.createSavedMeal({ name: 'Uses bar', ingredients: [{ foodId: b2.id, quantity: 30 }] });
    const files = ['user-data/custom-foods.json', 'user-data/saved-meals.json', 'user-data/preferences.json'];
    const snap = files.map((f) => readText(dir, f));
    const blocker = path.join(dir, `user-data/saved-meals.json.tmp-${process.pid}`);
    fs.mkdirSync(blocker); // the temp write for the second collection will fail
    throwsCode(() => fa.deleteCustomFood(b2.id), 'PERSIST_FAILED');
    assert.deepEqual(files.map((f) => readText(dir, f)), snap, 'no file changed');
    assert.ok(!fs.existsSync(path.join(dir, `user-data/custom-foods.json.tmp-${process.pid}`)), 'temp files cleaned up');
    fs.rmdirSync(blocker);
    assert.equal(fa.getFood(b2.id).id, b2.id, 'the Food still exists in memory too');
    fa.deleteCustomFood(b2.id);
    assert.equal(createDataLayer({ adapter: createFileAdapter(dir) }).getFood(b2.id), null);
  } finally { cleanup(dir); }
});

/* ================================================================== */
/* P–R  Backup / restore (N3)                                          */
/* ================================================================== */

function populated() {
  const app = makeLayer();
  const bar = makeBar(app);
  const saved = app.createSavedMeal({ name: 'Bar bowl', mealType: 'lunch', ingredients: [{ foodId: bar.id, quantity: 40 }] });
  app.createMealInstance({ date: TODAY, mealSlot: 'lunch', mealId: saved.id, dayType: 'lift' });
  app.updateDayType(TODAY, 'rest');
  app.setDayLoggingComplete(TODAY, true);
  app.setFavoriteMeal(saved.id, true);
  app.setDislikedFood('food_core_banana', true);
  app.updateCurrentTargets('long_run', { carbs: 350 });
  return app;
}

test('P — an exported backup validates and restores to identical data', () => {
  const app = populated();
  const backup = app.exportUserData();
  assert.equal(backup.format, BACKUP_FORMAT);
  assert.equal(backup.formatVersion, BACKUP_FORMAT_VERSION);
  assert.deepEqual(Object.keys(backup.data), [...USER_COLLECTIONS]);
  const text = JSON.stringify(backup);
  assert.ok(!FORBIDDEN_NUTRITION.test(text));
  assert.ok(!/"source":"core"/.test(text), 'Core Foods are app data, not in the backup');
  assert.ok(!/"source":"library"/.test(text), 'Library Meals are not in the backup');

  const v = app.validateBackup(text);
  assert.equal(v.valid, true, v.errors.join('; '));
  assert.deepEqual(v.summary, { customFoods: 3, savedMeals: 1, days: 1, mealInstances: 1 });

  const fresh = makeLayer();
  fresh.restoreUserData(text);
  assert.deepEqual(userState(fresh), backup.data);
  assert.deepEqual(fresh.getDaySummary(TODAY), app.getDaySummary(TODAY));
  assert.deepEqual(fresh.getProgress({ period: 7, endDate: TODAY }), app.getProgress({ period: 7, endDate: TODAY }));
});

test('Q — an invalid restore is rejected and changes nothing', () => {
  const good = populated().exportUserData();
  const app = makeLayer();
  app.logFood({ date: PAST, mealSlot: 'dinner', foodId: 'food_core_banana', quantity: 100, dayType: 'lift' });
  const before = userState(app);
  const variant = (fn) => { const d = JSON.parse(JSON.stringify(good)); fn(d); return d; };

  const cases = [
    ['not JSON', '{"format": ', 'BACKUP_UNREADABLE'],
    ['not an object', '[1,2]', 'BACKUP_UNREADABLE'],
    ['another format', variant((d) => { d.format = 'close-the-carbs'; }), 'BACKUP_INCOMPATIBLE'],
    ['newer version', variant((d) => { d.formatVersion = BACKUP_FORMAT_VERSION + 1; }), 'BACKUP_INCOMPATIBLE'],
    ['missing collection', variant((d) => { delete d.data.days; }), 'BACKUP_INVALID'],
    ['extra collection', variant((d) => { d.data.coreFoods = []; }), 'BACKUP_INVALID'],
    ['legacy day type', variant((d) => { d.data.days[0].dayType = 'long'; }), 'BACKUP_INVALID'],
    ['non-finite number', variant((d) => { d.data.targets.lift.carbs = NaN; }), 'BACKUP_INVALID'],
    ['wrong shape', variant((d) => { d.data.customFoods = { a: 1 }; }), 'BACKUP_INVALID'],
    ['broken ingredient reference', variant((d) => { d.data.savedMeals[0].ingredients[0].foodId = 'food_custom_missing'; }), 'BACKUP_INVALID'],
    ['favourite of nothing', variant((d) => { d.data.preferences.favoriteMeals.push('meal_saved_missing'); }), 'BACKUP_INVALID'],
    ['done with nothing logged', variant((d) => { d.data.days[0].mealInstances = []; }), 'BACKUP_INVALID'],
    ['duplicate Meal Instance id', variant((d) => { d.data.days.push({ ...d.data.days[0], id: 'day_2026-09-01', date: '2026-09-01' }); }), 'BACKUP_INVALID'],
    ['forbidden nutrition field', variant((d) => { d.data.customFoods[0].nutrition[F('kc', 'al')] = 100; }), 'BACKUP_INVALID']
  ];
  for (const [what, input, code] of cases) {
    const v = app.validateBackup(input);
    assert.equal(v.valid, false, what);
    assert.equal(v.code, code, what);
    throwsCode(() => app.restoreUserData(input), code);
    assert.deepEqual(userState(app), before, `${what}: current data untouched`);
  }
});

test('R — a valid restore replaces all user data in one atomic write', async () => {
  const backup = populated().exportUserData();

  const adapter = countingAdapter();
  const app = makeLayer({ adapter });
  app.logFood({ date: PAST, mealSlot: 'dinner', foodId: 'food_core_banana', quantity: 100, dayType: 'lift' });
  makeBar(app, 'Something else');
  const writes = adapter.calls.length;
  const result = app.restoreUserData(backup);
  assert.deepEqual(result.restored, { customFoods: 3, savedMeals: 1, days: 1, mealInstances: 1 });
  assert.equal(adapter.calls.length, writes + 1, 'exactly one write');
  assert.deepEqual(adapter.calls.at(-1), [...USER_COLLECTIONS].sort(), 'carrying every user collection');
  assert.deepEqual(userState(app), backup.data, 'previous data fully replaced');
  assert.equal(app.getDay(PAST), null);

  // Through the browser adapter it is one snapshot record, and it survives a reload.
  const snapshotStore = createMemorySnapshotStore();
  const b = makeLayer({ adapter: await createBrowserAdapter({ appData: appData(), snapshotStore }) });
  b.createDay(PAST, 'lift');
  await b.flushPersistence();
  const count = snapshotStore.writeCount();
  b.restoreUserData(JSON.stringify(backup));
  await b.flushPersistence();
  assert.equal(snapshotStore.writeCount(), count + 1);
  const reloaded = makeLayer({ adapter: await createBrowserAdapter({ appData: appData(), snapshotStore }) });
  assert.deepEqual(userState(reloaded), backup.data);
});

/* ================================================================== */
/* S–V  One calculator, UI previews, labels, forbidden concepts         */
/* ================================================================== */

test('S — a UI can call the canonical preview functions instead of computing', () => {
  const adapter = countingAdapter();
  const app = makeLayer({ adapter });

  // No Day yet: totals still come back; day context needs a type and creates nothing.
  const p0 = app.previewLogFood({ date: TODAY, foodId: 'food_core_banana', quantity: 120 });
  assert.equal(p0.dayTypeRequired, true);
  assert.equal(p0.day, null);
  const p1 = app.previewLogFood({ date: TODAY, foodId: 'food_core_banana', quantity: 120, dayType: 'lift' });
  assert.equal(p1.day.targetSource, 'current');
  assert.equal(app.getDay(TODAY), null);
  assert.equal(adapter.calls.length, 0, 'previews never write');

  const logged = app.logFood({ date: TODAY, mealSlot: 'lunch', foodId: 'food_core_banana', quantity: 120, dayType: 'lift' });
  assert.deepEqual(p1.totals, logged.totals, 'preview = what logging does');
  assert.deepEqual(p1.day.after.remaining, app.getDaySummary(TODAY).remaining);

  const mealPreview = app.previewMealInstance({ date: TODAY, mealId: 'meal_library_L26' });
  const writes = adapter.calls.length;
  const mealLogged = app.createMealInstance({ date: TODAY, mealSlot: 'dinner', mealId: 'meal_library_L26' });
  assert.equal(adapter.calls.length, writes + 1);
  assert.deepEqual(mealPreview.totals, mealLogged.totals);
  assert.deepEqual(mealPreview.day.after.remaining, app.getDaySummary(TODAY).remaining);

  // Draft meal (e.g. a builder tray) — no Meal, no date.
  const draft = app.previewMealInstance({ mealName: 'Tray', ingredients: [{ foodId: 'food_core_banana', quantity: 50 }, { foodId: 'food_core_fage_0_greek_yogurt', quantity: 150 }] });
  assert.equal(draft.valid, true);
  assert.equal(draft.day, null);
  const bad = app.previewMealInstance({ ingredients: [{ foodId: 'food_core_nope', quantity: 50 }] });
  assert.equal(bad.valid, false);
  assert.equal(bad.totals, null, 'no partial totals presented as a total');

  // Edit preview = the edit.
  const edit = { ingredients: [{ foodId: 'food_core_banana', quantity: 200 }, { foodId: 'food_core_sourdough', quantity: 60 }] };
  const ep = app.previewMealInstanceUpdate(TODAY, logged.id, edit);
  const w2 = adapter.calls.length;
  const done = app.updateMealInstance(TODAY, logged.id, edit);
  assert.equal(adapter.calls.length, w2 + 1);
  assert.deepEqual(ep.instance, done);
  assert.deepEqual(ep.after.remaining, app.getDaySummary(TODAY).remaining);

  // reached / overBy so a screen never negates remaining itself.
  app.logFood({ date: TODAY, mealSlot: 'snack_afternoon', foodId: 'food_core_fage_0_greek_yogurt', quantity: 2000 });
  const s = app.getDaySummary(TODAY);
  assert.equal(s.reached.protein, true);
  assert.ok(s.remaining.protein < 0);
  assert.ok(close(s.overBy.protein, s.logged.protein - s.target.protein, 1e-9));
  assert.equal(s.overBy.carbs, 0);
  assert.equal(s.reached.carbs, false);

  // Custom Food validation is a dry run.
  const w3 = adapter.calls.length;
  const v = app.validateCustomFood({ name: ' Banana ', category: 'fruit', state: 'raw', nutrition: { protein: 60, carbs: 50, fat: 5 } });
  assert.equal(v.valid, false);
  assert.deepEqual(v.errors.map((e) => e.code), ['NUTRITION_IMPOSSIBLE']);
  assert.deepEqual(v.warnings.map((w) => w.code), ['DUPLICATE_NAME']);
  assert.equal(adapter.calls.length, w3);
  assert.equal(app.validateCustomFood({ name: 'Olive oil', category: 'oil', state: 'other', nutrition: { protein: 0, carbs: 0, fat: 100 } }).valid, true, '100 g per 100 g is fine');
  assert.equal(app.validateCustomFood({ name: 'Water', category: 'drink', state: 'other', nutrition: { protein: 0, carbs: 0, fat: 0 } }).valid, true, 'all zeros is allowed');
  const food = app.createCustomFood({ name: '  Label Bar  ', category: ' bar ', state: 'prepared', nutrition: { protein: 20, carbs: 45, fat: 15 } });
  assert.equal(food.name, 'Label Bar');
  assert.equal(food.category, 'bar');
  assert.throws(() => app.createCustomFood({ name: 'Typo', category: 'x', state: 'prepared', nutrition: { protein: 60, carbs: 50, fat: 5 } }),
    (e) => e.code === 'INVALID_FOOD' && e.details[0].field === 'nutrition' && e.details[0].code === 'NUTRITION_IMPOSSIBLE');
  assert.equal(app.validateCustomFood({ nutrition: { carbs: 90 } }, { id: food.id }).errors[0].code, 'NUTRITION_IMPOSSIBLE', 'edits are checked as merged');

  // The calculator is reachable from the public entry point.
  for (const fn of ['calculateMealMacros', 'targetStatus', 'checkNutritionValues', 'subtractMacros', 'sumMacros', 'roundMacros']) assert.equal(typeof macros[fn], 'function', fn);
});

const DUPLICATE_ARITHMETIC = [
  ['per-100 g formula', 'const c = (grams / 100) * food.nutrition.carbs;', 'a.js'],
  ['formula via 1e2', 'out[k] = q * n[k] / 1e2;', 'a.js'],
  ['formula via 0.01', 'const p = qty * 0.01 * food.nutrition.protein;', 'a.ts'],
  ['nutrition[key] scaling', 'totals[key] += amount * food.nutrition[key];', 'a.js'],
  ['summing a meal', 'const carbs = items.reduce((sum, i) => sum + i.carbs, 0);', 'a.js'],
  ['remaining by hand', 'const left = target.protein - logged.protein;', 'a.jsx'],
  ['arithmetic inside a template', 'label.textContent = `${target.fat - logged.fat} g left`;', 'a.js'],
  ['arithmetic in a JSX expression', 'const Row = () => <td>{day.target.carbs - day.logged.carbs}</td>;', 'a.jsx'],
  ['arithmetic in a Svelte binding', '<p>{target.carbs - logged.carbs} g left</p>', 'a.svelte'],
  ['arithmetic in an HTML script', '<script>const over = logged.fat - target.fat;</script>', 'a.html'],
  ['negating remaining', 'const over = -remaining.protein;', 'a.js']
];

test('T — duplicated macro arithmetic in UI-style source is still detected', () => {
  for (const [what, src, file] of DUPLICATE_ARITHMETIC) assert.ok(macroArithmeticInSource(src, file).length > 0, `${what} must be detected`);
  assert.deepEqual(domainImportsBypassingIndex("import { calculateMealMacros } from '../domain/macros.js';"), ['../domain/macros.js'], 'reaching around the public entry point is detected');
  assert.deepEqual(domainImportsBypassingIndex("import { macros } from '../domain/index.js';"), []);
});

test('U — ordinary Protein / Carbs / Fat labels, class names and imports are allowed', () => {
  const allowed = [
    ["const labels = ['Protein', 'Carbs', 'Fat'];", 'a.js'],
    ["const heading = 'protein / carbs / fat';", 'a.js'],
    ['<th>protein / carbs / fat</th><th>Protein / Carbs / Fat</th>', 'a.html'],
    ['const H = () => <th className="macro macro--fat" aria-label="fat, grams left">protein / carbs / fat</th>;', 'a.jsx'],
    ["el.className = `macro macro--${key} is-high-protein`;", 'a.js'],
    ["const tag = 'fat-free'; const hint = 'a high-protein snack';", 'a.ts'],
    ["import { ProteinRow } from './rows/protein-row.js';", 'a.js'],
    ["import { createDataLayer, macros } from '../domain/index.js';", 'a.js'],
    ['el.textContent = `${fmt(summary.remaining.protein)} g protein left`;', 'a.js'],
    ['const after = macros.subtractMacros(summary.remaining, preview.totals);', 'a.js'],
    ['const s = macros.targetStatus(day.target, day.logged); if (s.reached.carbs) show();', 'a.js'],
    ['if (summary.remaining.carbs <= 0) markReached();', 'a.js'],
    ['<p class="fat">{fmt(summary.overBy.fat)} g over</p>', 'a.svelte'],
    ['/* protein - carbs */ // fat / 100', 'a.js']
  ];
  for (const [src, file] of allowed) assert.deepEqual(macroArithmeticInSource(src, file), [], `${file}: ${src}`);
  for (const label of ['Protein', 'Carbs', 'Fat', 'protein', 'carbs', 'fat', 'macro--fat', 'Grams left']) assert.ok(!FORBIDDEN_NUTRITION.test(label), label);
});

test('V — forbidden nutrition concepts stay blocked', () => {
  for (const w of [F('Calor', 'ies'), F('kc', 'al'), F('KC', 'AL'), F('Ener', 'gy'), F('k', 'J'), F('jou', 'les'), F('kilo', 'calorie')]) assert.ok(FORBIDDEN_NUTRITION.test(`value: ${w}`), w);
  const app = makeLayer();
  throwsCode(() => app.createCustomFood({ name: 'x', category: 'x', state: 'prepared', nutrition: { protein: 1, carbs: 1, fat: 1, [F('ener', 'gy')]: 5 } }), 'INVALID_FOOD');
  assert.equal(app.validateCustomFood({ name: 'x', category: 'x', state: 'prepared', nutrition: { protein: 1, carbs: 1, fat: 1, [F('kc', 'al')]: 5 } }).errors[0].code, 'NUTRITION_UNKNOWN_FIELD');
  throwsCode(() => app.updateCurrentTargets('lift', { [F('kc', 'al')]: 2000 }), 'INVALID_TARGETS');

  // Nothing any new API returns mentions the concept.
  app.createMealInstance({ date: TODAY, mealSlot: 'lunch', mealId: 'meal_library_L26', dayType: 'lift' });
  const outputs = [
    app.getMacroCoachSuggestions({ date: TODAY, mealSlot: 'dinner' }),
    app.previewLogFood({ date: TODAY, foodId: 'food_core_banana', quantity: 100 }),
    app.previewDayTypeChange(TODAY, 'rest'),
    app.getDaySummary(TODAY),
    app.exportUserData(),
    app.validateCustomFood({ name: 'x', category: 'x', state: 'raw', nutrition: { protein: 90, carbs: 90, fat: 0 } }),
    app.getPersistenceStatus()
  ];
  assert.ok(!FORBIDDEN_NUTRITION.test(JSON.stringify(outputs)));
});

/* ================================================================== */
/* W  Browser app-data loading contract                                */
/* ================================================================== */

test('W1 — APP_DATA is the canonical files, loaded by static JSON import', () => {
  // Same data the Node file adapter reads: nothing missing, nothing extra.
  assert.deepEqual(Object.keys(APP_DATA.schemas).sort(), fs.readdirSync(path.join(ROOT, 'data/schemas')).filter((f) => f.endsWith('.schema.json')).sort(), 'every schema file is imported');
  assert.deepEqual(APP_DATA.schemas, SEED.schemas);
  assert.deepEqual(APP_DATA.coreFoods, SEED.coreFoods);
  assert.deepEqual(APP_DATA.libraryMeals, SEED.libraryMeals);
  assert.deepEqual(Object.keys(APP_DATA.seed).sort(), [...USER_COLLECTIONS].sort(), 'seed = exactly the user collections');
  for (const c of USER_COLLECTIONS) assert.deepEqual(APP_DATA.seed[c], SEED[c], `seed.${c}`);
  const src = fs.readFileSync(path.join(ROOT, 'src/browser/app-data.js'), 'utf8');
  assert.ok(!/\bfetch\s*\(|\bimport\s*\(/.test(src), 'no fetch, no dynamic import');
  assert.equal((src.match(/^import \w+ from '[^']+\.json' with \{ type: 'json' \};$/gm) || []).length, 13, 'six schemas, Core Foods, Library Meals, five seed files');
});

test('W2 — first run starts from the seed and stores only user data', async () => {
  const snapshotStore = createMemorySnapshotStore();
  const { app, adapter } = await openBrowserDataLayer({ snapshotStore, today: () => TODAY });
  assert.equal(snapshotStore.peek(), null, 'nothing is written just by opening');
  assert.deepEqual(userState(app), APP_DATA.seed, 'user data = seed');
  assert.equal(app.getFood(APP_DATA.coreFoods[0].id).id, APP_DATA.coreFoods[0].id);
  assert.equal(app.getLibraryMeals({ includeRetired: true }).length, APP_DATA.libraryMeals.length);
  assert.equal(adapter.status().state, 'saved');

  app.createDay(TODAY, 'lift');
  await app.flushPersistence();
  const record = snapshotStore.peek();
  assert.deepEqual(Object.keys(record.data).sort(), [...USER_COLLECTIONS].sort(), 'Core Foods, Library Meals and schemas are never stored');
  assert.deepEqual(record.data.customFoods, APP_DATA.seed.customFoods, 'first save carries the seed forward');
});

test('W3 — once data is stored it wins over the seed; app data still comes from the app', async () => {
  const snapshotStore = createMemorySnapshotStore();
  const first = await openBrowserDataLayer({ snapshotStore, today: () => TODAY });
  const logged = first.app.createMealInstance({ date: TODAY, mealSlot: 'breakfast', mealId: 'meal_library_B1', dayType: 'lift' });
  first.app.updateCurrentTargets('rest', { carbs: 230 });
  await first.app.flushPersistence();

  // A later app version: a different seed, and changed Core Food values.
  const next = JSON.parse(JSON.stringify(APP_DATA));
  next.seed.targets.rest.carbs = 999;
  next.seed.customFoods = [];
  next.coreFoods.find((f) => f.id === 'food_core_rolled_oats_dry').nutrition.carbs = 70;
  const { app } = await openBrowserDataLayer({ snapshotStore, appData: next, today: () => TODAY });
  assert.equal(app.getCurrentTargets('rest').carbs, 230, 'stored targets, not the seed');
  assert.deepEqual(userState(app).customFoods, APP_DATA.seed.customFoods, 'stored Custom Foods, not the new seed');
  assert.deepEqual(app.getDay(TODAY).mealInstances[0], logged, 'history is the stored snapshot');
  assert.notDeepEqual(app.calculateMealMacros('meal_library_B1').totals, logged.totals, 'Meals recalculate from the new app data');
});

test('W4 — stored data that fails validation is refused, kept, and readable', async () => {
  const snapshotStore = createMemorySnapshotStore();
  const ok = await openBrowserDataLayer({ snapshotStore, today: () => TODAY });
  ok.app.createDay(TODAY, 'lift');
  await ok.app.flushPersistence();
  const bad = snapshotStore.peek();
  bad.data.days[0].dayType = 'long';
  const broken = createMemorySnapshotStore(bad);
  let error = null;
  try { await openBrowserDataLayer({ snapshotStore: broken }); } catch (e) { error = e; }
  assert.equal(error && error.code, 'DATA_INVALID');
  assert.deepEqual(await error.readStoredRecord(), bad, 'the raw record is available for download');
  assert.deepEqual(broken.peek(), bad, 'nothing overwritten');
  const foreign = createMemorySnapshotStore({ format: 'something-else', version: 1, revision: 1, data: {} });
  await assert.rejects(openBrowserDataLayer({ snapshotStore: foreign }), /refusing to start/);
  assert.equal(foreign.peek().format, 'something-else');
});
