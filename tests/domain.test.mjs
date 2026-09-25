// Prompt 2 — behaviour tests for the canonical data/domain layer (Tests A–M).
// Run: node --test tests/

import test from 'node:test';
import fs from 'node:fs';
import assert from 'node:assert/strict';
import { makeApp, tempRepo, readJSON, readText, cleanup, expectedTotals, close } from './helpers.mjs';
import { DomainError } from '../src/domain/index.js';

const DATE = '2026-09-24';
const byId = (list) => Object.fromEntries(list.map((x) => [x.id, x]));

function withApp(fn) {
  return () => {
    const dir = tempRepo();
    try { return fn(makeApp(dir)); } finally { cleanup(dir); } // cleaned up even if setup fails
  };
}

const throwsCode = (fn, code) => assert.throws(fn, (e) => e instanceof DomainError && e.code === code, `expected DomainError ${code}`);

// A small custom Food used by several tests.
function makeBar(app) {
  return app.createCustomFood({ name: 'Test Oat Bar', category: 'cereal', state: 'prepared', nutrition: { protein: 10, carbs: 60, fat: 12 } });
}

test('A — Food search matches canonical names and aliases; similar Foods stay separate', withApp(({ app }) => {
  const alias = app.searchFoods('greek yogurt nonfat');
  assert.equal(alias[0].food.id, 'food_core_fage_0_greek_yogurt');
  assert.equal(alias[0].matchedOn, 'alias');

  const chicken = app.searchFoods('Chicken breast');
  assert.equal(chicken[0].food.id, 'food_core_chicken_breast_raw');
  assert.equal(chicken[0].matchedText, 'chicken breast', 'exact alias outranks a prefix match on the name');

  const name = app.searchFoods('banana');
  assert.equal(name[0].food.id, 'food_core_banana');
  assert.equal(name[0].matchedOn, 'name');
  assert.ok(!name.some((r) => r.food.id === 'food_core_chicken_breast_raw'), 'no unrelated matches');

  const fage = app.searchFoods('fage').map((r) => r.food.id);
  assert.deepEqual(new Set(fage), new Set(['food_core_fage_0_greek_yogurt', 'food_core_fage_2_greek_yogurt', 'food_core_fage_5_greek_yogurt']));

  const oats = app.searchFoods('oats overnight').map((r) => r.food.id);
  for (const id of ['food_core_oats_overnight_packet', 'food_custom_oats_overnight', 'food_custom_oats_overnight_brand']) assert.ok(oats.includes(id), `${id} found separately`);

  const bar = makeBar(app);
  assert.equal(app.searchFoods('test oat bar')[0].food.id, bar.id, 'custom Foods are searchable');
  assert.deepEqual(app.searchFoods(''), []);

  // Recipe labels are display wording only and are never searched.
  app.createSavedMeal({ name: 'Label probe', mealType: 'snack', ingredients: [{ foodId: 'food_core_banana', quantity: 100 }], metadata: { ingredientLabels: { food_core_banana: 'zzqx wording' } } });
  assert.deepEqual(app.searchFoods('zzqx'), []);
}));

test('B — Meal P/C/F comes only from its Food ingredients', withApp(({ app }) => {
  const foods = {};
  const b1 = app.getMeal('meal_library_B1');
  for (const i of b1.ingredients) foods[i.foodId] = app.getFood(i.foodId);
  const calc = app.calculateMealMacros('meal_library_B1');
  const want = expectedTotals(b1, foods);
  assert.ok(calc.valid);
  for (const m of ['protein', 'carbs', 'fat']) assert.ok(close(calc.totals[m], want[m]), `${m}`);
  assert.equal(b1.protein, undefined, 'no stored totals on the Meal');

  // Labels and garnishes do not affect the numbers.
  const l26 = app.getMeal('meal_library_L26');
  assert.ok(l26.metadata.garnishes.length, 'L26 has a garnish');
  const withoutMeta = app.calculateMealMacros({ id: 'x', ingredients: l26.ingredients });
  assert.deepEqual(app.calculateMealMacros(l26).totals, withoutMeta.totals);
  const relabelled = { ...l26, metadata: { ...l26.metadata, ingredientLabels: { food_core_onion: 'something else entirely' } } };
  assert.deepEqual(app.calculateMealMacros(relabelled).totals, withoutMeta.totals);
}));

test('C — saving a Library Meal creates an independent Saved Meal', withApp(({ app }) => {
  const lib = app.getMeal('meal_library_L26');
  const saved = app.createSavedMeal({ fromMealId: lib.id });
  assert.notEqual(saved.id, lib.id);
  assert.match(saved.id, /^meal_saved_/);
  assert.equal(saved.source, 'saved');
  assert.equal(saved.metadata.copiedFromMealId, lib.id);
  assert.deepEqual(saved.ingredients, lib.ingredients);
  for (const k of ['legacyId', 'retired', 'isNew']) assert.equal(saved.metadata[k], undefined, `${k} not copied`);
  assert.equal(app.getSavedMeals().length, 1);
  assert.deepEqual(app.getMeal(lib.id), lib, 'Library Meal unchanged');
}));

test('D — editing a Saved Meal changes the recipe, not the Library, and drops stale labels', withApp(({ app }) => {
  const lib = app.getMeal('meal_library_L26');
  const saved = app.createSavedMeal({ fromMealId: lib.id });
  assert.equal(saved.metadata.ingredientLabels.food_core_onion, 'red onion');

  const ingredients = saved.ingredients.map((i) => (i.foodId === 'food_core_onion' ? { foodId: 'food_core_scallions', quantity: 20, unit: 'g' } : i));
  const edited = app.updateSavedMeal(saved.id, { name: 'My Southwest Salad', ingredients });
  assert.equal(edited.name, 'My Southwest Salad');
  assert.equal(edited.metadata.ingredientLabels.food_core_onion, undefined, 'label for the replaced Food removed');
  assert.equal(edited.metadata.ingredientLabels.food_core_tomato, 'cherry tomatoes', 'other labels kept');
  assert.ok(edited.ingredients.some((i) => i.foodId === 'food_core_scallions'));
  assert.deepEqual(app.getMeal(lib.id), lib, 'Library Meal unchanged');
  assert.notDeepEqual(app.calculateMealMacros(edited.id).totals, app.calculateMealMacros(lib.id).totals);

  throwsCode(() => app.updateSavedMeal(lib.id, { name: 'x' }), 'LIBRARY_MEAL_READ_ONLY');
  throwsCode(() => app.updateSavedMeal(saved.id, { ingredients: [{ foodId: 'food_core_nope', quantity: 10 }] }), 'FOOD_NOT_FOUND');
  throwsCode(() => app.updateSavedMeal(saved.id, { ingredients: [{ foodId: 'food_core_banana', quantity: 10, unit: 'ml' }] }), 'UNSUPPORTED_UNIT');
}));

test('E — logging a Saved Meal creates a historical snapshot', withApp(({ app }) => {
  const saved = app.createSavedMeal({ fromMealId: 'meal_library_B1' });
  const calc = app.calculateMealMacros(saved.id);
  const mi = app.createMealInstance({ date: DATE, mealSlot: 'breakfast', mealId: saved.id, dayType: 'lift' });

  assert.equal(mi.sourceMealId, saved.id);
  assert.equal(mi.mealName, saved.name);
  assert.equal(mi.mealSlot, 'breakfast');
  assert.deepEqual(mi.totals, calc.totals);
  assert.equal(mi.ingredients.length, saved.ingredients.length);
  for (const [k, ing] of mi.ingredients.entries()) {
    assert.equal(ing.foodId, saved.ingredients[k].foodId);
    assert.equal(ing.foodName, app.getFood(ing.foodId).name);
    assert.equal(ing.quantity, saved.ingredients[k].quantity);
    assert.equal(ing.unit, 'g');
    for (const m of ['protein', 'carbs', 'fat']) assert.equal(typeof ing[m], 'number');
  }
  assert.match(mi.loggedAt, /Z$/);

  const day = app.getDay(DATE);
  assert.deepEqual(day.targetSnapshot, { protein: 150, carbs: 293, fat: 70 });
  assert.deepEqual(day.mealInstances[0], mi);

  // Later changes to the Saved Meal, or deleting it, leave the snapshot alone.
  app.updateSavedMeal(saved.id, { name: 'Renamed', ingredients: [{ foodId: 'food_core_banana', quantity: 50 }] });
  app.deleteSavedMeal(saved.id);
  assert.deepEqual(app.getDay(DATE).mealInstances[0], mi);
  assert.equal(app.getMeal(saved.id), null);
}));

test('F — editing a Meal Instance changes only that instance', withApp(({ app }) => {
  const saved = app.createSavedMeal({ fromMealId: 'meal_library_B1' });
  const a = app.createMealInstance({ date: DATE, mealSlot: 'breakfast', mealId: saved.id, dayType: 'lift' });
  const b = app.createMealInstance({ date: DATE, mealSlot: 'snack_afternoon', mealId: saved.id });
  const first = a.ingredients[0];

  const ingredients = a.ingredients.map((i, k) => ({ foodId: i.foodId, quantity: k === 0 ? i.quantity * 2 : i.quantity, unit: i.unit }));
  const edited = app.updateMealInstance(DATE, a.id, { ingredients, mealSlot: 'lunch' });

  assert.equal(edited.ingredients[0].quantity, first.quantity * 2);
  for (const m of ['protein', 'carbs', 'fat']) assert.ok(close(edited.ingredients[0][m], first[m] * 2), `${m} doubled`);
  assert.equal(edited.mealSlot, 'lunch');
  assert.ok(edited.totals.carbs > a.totals.carbs);
  assert.deepEqual(app.getDay(DATE).mealInstances.find((x) => x.id === b.id), b, 'other instance unchanged');
  assert.deepEqual(app.getMeal(saved.id).ingredients, saved.ingredients, 'Saved Meal unchanged');

  app.deleteMealInstance(DATE, b.id);
  assert.equal(app.getDay(DATE).mealInstances.length, 1);
}));

test('G — changing a Food changes Saved Meal and future calculations, not history', withApp(({ app, dir, reopen }) => {
  const bar = makeBar(app);
  const saved = app.createSavedMeal({ name: 'Bar snack', mealType: 'snack', ingredients: [{ foodId: bar.id, quantity: 50 }] });
  const before = app.createMealInstance({ date: DATE, mealSlot: 'snack_afternoon', mealId: saved.id, dayType: 'lift' });
  assert.equal(before.totals.carbs, 30);

  app.updateCustomFood(bar.id, { nutrition: { carbs: 80 } });
  assert.equal(app.calculateMealMacros(saved.id).totals.carbs, 40, 'Saved Meal recalculates');
  const after = app.createMealInstance({ date: DATE, mealSlot: 'snack_night', mealId: saved.id });
  assert.equal(after.totals.carbs, 40, 'future logs use the new value');
  assert.deepEqual(app.getDay(DATE).mealInstances.find((x) => x.id === before.id), before, 'history unchanged');
  assert.equal(app.getFood(bar.id).id, bar.id, 'ID unchanged');

  // A Core Food update ships as new app data: same rule applies.
  const lib = app.createMealInstance({ date: DATE, mealSlot: 'breakfast', mealId: 'meal_library_B1' });
  const core = readJSON(dir, 'data/foods/core-foods.json');
  core.find((f) => f.id === 'food_core_rolled_oats_dry').nutrition.carbs = 70;
  fs.writeFileSync(`${dir}/data/foods/core-foods.json`, JSON.stringify(core, null, 2) + '\n');
  const app2 = reopen();
  assert.notDeepEqual(app2.calculateMealMacros('meal_library_B1').totals, lib.totals, 'Meal recalculates with new Core data');
  assert.deepEqual(app2.getDay(DATE).mealInstances.find((x) => x.id === lib.id), lib, 'logged instance unchanged');

  throwsCode(() => app.updateCustomFood('food_core_banana', { name: 'x' }), 'CORE_FOOD_READ_ONLY');
  throwsCode(() => app.updateCustomFood(bar.id, { id: 'food_custom_other' }), 'IMMUTABLE_ID');
}));

test('H — deleting a Custom Food invalidates Saved Meals visibly; history stays valid', withApp(({ app, reopen }) => {
  const bar = makeBar(app);
  const saved = app.createSavedMeal({
    name: 'Bar and banana', mealType: 'snack',
    ingredients: [{ foodId: 'food_core_banana', quantity: 100 }, { foodId: bar.id, quantity: 40 }],
    metadata: { ingredientLabels: { [bar.id]: 'my oat bar' } }
  });
  const mi = app.createMealInstance({ date: DATE, mealSlot: 'snack_afternoon', mealId: saved.id, dayType: 'lift' });
  app.setFavoriteFood(bar.id, true);

  const res = app.deleteCustomFood(bar.id);
  assert.deepEqual(res.affectedSavedMealIds, [saved.id]);
  assert.equal(app.getFood(bar.id), null);

  const meal = app.getMeal(saved.id);
  assert.deepEqual(meal.ingredients, saved.ingredients, 'ingredient kept, nothing substituted or removed');
  const calc = app.calculateMealMacros(saved.id);
  assert.equal(calc.valid, false);
  assert.equal(calc.needsReplacement, true);
  assert.equal(calc.totals, null, 'no misleading partial total');
  assert.equal(calc.problems.length, 1);
  assert.equal(calc.problems[0].foodId, bar.id);
  assert.equal(calc.problems[0].index, 1);
  assert.equal(calc.problems[0].lastKnownName, 'Test Oat Bar');
  assert.ok(!app.getPreferences().favoriteFoods.includes(bar.id));

  // No crash anywhere that reads it.
  const ctx = app.getMacroCoachContext({ date: DATE, mealSlot: 'dinner' });
  assert.equal(ctx.savedMeals[0].needsReplacement, true);
  assert.deepEqual(app.getDay(DATE).mealInstances[0], mi, 'historical instance untouched');
  assert.equal(app.getDaySummary(DATE).logged.carbs, mi.totals.carbs);
  assert.equal(reopen().calculateMealMacros(saved.id).needsReplacement, true, 'state survives a reload');

  // Logging the invalid meal is refused cleanly.
  throwsCode(() => app.createMealInstance({ date: DATE, mealSlot: 'dinner', mealId: saved.id }), 'MEAL_NEEDS_REPLACEMENT');

  // A new Food with the same name never takes over the old ID.
  const again = makeBar(app);
  assert.notEqual(again.id, bar.id);
  assert.equal(app.calculateMealMacros(saved.id).needsReplacement, true);

  // Replacing it fixes the meal and clears the note and stale label.
  const fixed = app.replaceSavedMealIngredient(saved.id, bar.id, again.id);
  assert.equal(app.calculateMealMacros(fixed.id).valid, true);
  assert.equal(fixed.metadata.unresolvedFoods, undefined);
  assert.equal(fixed.metadata.ingredientLabels, undefined);
  assert.deepEqual(app.getDay(DATE).mealInstances[0], mi);
}));

test('I — changing Day Type changes target context only', withApp(({ app }) => {
  app.createMealInstance({ date: DATE, mealSlot: 'lunch', mealId: 'meal_library_L26', dayType: 'lift' });
  app.logFood({ date: DATE, mealSlot: 'snack_afternoon', foodId: 'food_core_banana', quantity: 120 });
  const before = app.getDay(DATE);
  const sumBefore = app.getDaySummary(DATE);

  const after = app.updateDayType(DATE, 'rest');
  assert.equal(after.dayType, 'rest');
  assert.deepEqual(after.targetSnapshot, { protein: 150, carbs: 218, fat: 70 });
  assert.deepEqual(after.mealInstances, before.mealInstances, 'logged food identical');
  const sumAfter = app.getDaySummary(DATE);
  assert.deepEqual(sumAfter.logged, sumBefore.logged);
  assert.ok(close(sumBefore.remaining.carbs - sumAfter.remaining.carbs, 293 - 218), 'remaining recalculated');

  throwsCode(() => app.updateDayType(DATE, 'long'), 'INVALID_DAY_TYPE');
  assert.equal(app.updateDayType(DATE, 'long_run').targetSnapshot.carbs, 343);
}));

test('J — changing current targets affects new Days only', withApp(({ app, dir }) => {
  const old = app.createDay('2026-09-20', 'lift');
  assert.deepEqual(old.targetSnapshot, { protein: 150, carbs: 293, fat: 70 });
  assert.deepEqual(app.getCurrentTargets('lift'), { protein: 150, carbs: 293, fat: 70 });

  app.updateCurrentTargets('lift', { carbs: 310 });
  assert.deepEqual(app.getCurrentTargets('lift'), { protein: 150, carbs: 310, fat: 70 });
  assert.equal(readJSON(dir, 'data/targets.json').lift.carbs, 310, 'current targets persisted');
  assert.deepEqual(app.getDay('2026-09-20').targetSnapshot, { protein: 150, carbs: 293, fat: 70 }, 'existing Day unchanged');
  assert.equal(app.createDay('2026-09-21', 'lift').targetSnapshot.carbs, 310, 'new Day uses new target');
  assert.deepEqual(app.createTargetSnapshot('rest'), { protein: 150, carbs: 218, fat: 70 });

  app.logFood({ date: '2026-09-20', mealSlot: 'breakfast', foodId: 'food_core_banana', quantity: 100 });
  const p = app.getProgress({ startDate: '2026-09-20', endDate: '2026-09-21' });
  assert.equal(p.daily[0].target.carbs, 293, 'Progress uses the historical snapshot');
  throwsCode(() => app.updateCurrentTargets('lift', { calcium: 1 }), 'INVALID_TARGETS');
  throwsCode(() => app.getCurrentTargets('long'), 'INVALID_DAY_TYPE');
}));

test('K — a partial Day is not zero intake', withApp(({ app }) => {
  const lunch = app.createMealInstance({ date: DATE, mealSlot: 'lunch', mealId: 'meal_library_L26', dayType: 'lift' });
  const s = app.getDaySummary(DATE);
  assert.equal(s.status, 'partial');
  assert.deepEqual(s.loggedSlots, ['lunch']);
  assert.deepEqual(s.unloggedSlots, ['breakfast', 'snack_afternoon', 'dinner', 'snack_night']);
  assert.deepEqual(s.logged, lunch.totals);

  const p = app.getProgress({ period: 7, endDate: DATE });
  assert.equal(p.period.days, 7);
  assert.deepEqual(p.counts, { complete: 0, partial: 1, noData: 6 });
  assert.equal(p.averages.completeDays, null, 'no average built from a partial day');
  assert.equal(p.averages.loggedDays.days, 1);
  const today = p.daily.at(-1);
  assert.equal(today.status, 'partial');
  assert.deepEqual(today.actual, lunch.totals);
  assert.equal(today.hit.carbs, 'undetermined', 'short partial day is not a miss');
  for (const d of p.daily.slice(0, 6)) { assert.equal(d.status, 'no_data'); assert.equal(d.actual, null); }
  assert.equal(p.trend.actual.carbs[0], null, 'no-data days are null in trends, not 0');
  assert.equal(app.getDaySummary('2026-09-01').status, 'no_data');
  assert.equal(app.getDay('2026-09-01'), null, 'no Day invented');

  // Fill every slot → complete; a short complete Day is a miss.
  for (const slot of ['breakfast', 'snack_afternoon', 'dinner', 'snack_night']) app.logFood({ date: DATE, mealSlot: slot, foodId: 'food_core_banana', quantity: 50 });
  const p2 = app.getProgress({ period: 7, endDate: DATE });
  assert.equal(p2.daily.at(-1).status, 'complete');
  assert.equal(p2.daily.at(-1).hit.carbs, 'missed');
  assert.equal(p2.averages.completeDays.days, 1);
  assert.equal(p2.daysHit.carbs.missed, 1);
  for (const period of [14, 30]) assert.equal(app.getProgress({ period, endDate: DATE }).daily.length, period);
}));

test('L — a Food can be logged directly, without a Saved Meal', withApp(({ app }) => {
  const mi = app.logFood({ date: DATE, mealSlot: 'snack_afternoon', foodId: 'food_core_banana', quantity: 120, dayType: 'rest' });
  assert.equal(mi.sourceMealId, null);
  assert.equal(mi.mealName, 'Banana');
  assert.equal(mi.ingredients.length, 1);
  assert.equal(mi.ingredients[0].foodName, 'Banana');
  assert.equal(mi.ingredients[0].quantity, 120);
  assert.equal(app.getSavedMeals().length, 0, 'no Saved Meal created');
  assert.equal(app.getDay(DATE).dayType, 'rest');
  throwsCode(() => app.logFood({ date: '2026-09-25', mealSlot: 'lunch', foodId: 'food_core_banana', quantity: 100 }), 'DAY_TYPE_REQUIRED');
  throwsCode(() => app.logFood({ date: DATE, mealSlot: 'lunch', foodId: 'food_core_banana', quantity: 0 }), 'MEAL_INVALID');
  throwsCode(() => app.logFood({ date: DATE, mealSlot: 'snack', foodId: 'food_core_banana', quantity: 10 }), 'INVALID_MEAL_SLOT');

  // mealType never restricts the slot: a snack Meal goes in either snack slot (or any slot).
  const snack = app.getLibraryMeals().find((m) => m.mealType === 'snack');
  for (const slot of ['snack_afternoon', 'snack_night', 'breakfast']) assert.equal(app.createMealInstance({ date: DATE, mealSlot: slot, mealId: snack.id }).mealSlot, slot);
}));

test('M — a saved copy of a Library Meal is edited independently; Library data never written', withApp(({ app, dir }) => {
  const libBefore = readText(dir, 'data/meals/library-meals.json');
  const coreBefore = readText(dir, 'data/foods/core-foods.json');
  const lib = app.getMeal('meal_library_D1');
  const copy = app.createSavedMeal({ fromMealId: lib.id, name: 'Weeknight D1' });
  const dup = app.duplicateSavedMeal(copy.id);
  assert.notEqual(dup.id, copy.id);

  app.updateSavedMeal(copy.id, { ingredients: copy.ingredients.map((i) => ({ ...i, quantity: i.quantity + 10 })) });
  assert.deepEqual(app.getMeal(lib.id), lib, 'Library Meal unchanged');
  assert.deepEqual(app.getMeal(dup.id).ingredients, lib.ingredients, 'duplicate unaffected');
  assert.equal(readText(dir, 'data/meals/library-meals.json'), libBefore, 'library file never written');
  assert.equal(readText(dir, 'data/foods/core-foods.json'), coreBefore, 'core Foods file never written');

  const retired = app.getLibraryMeals({ includeRetired: true }).filter((m) => m.metadata.retired).map((m) => m.metadata.legacyId);
  assert.deepEqual(retired.sort(), ['L13', 'L16']);
  assert.ok(!app.getLibraryMeals().some((m) => m.metadata.retired), 'retired hidden by default');
}));

test('Persistence, preferences, recents and Macro Coach context', withApp(({ app, reopen }) => {
  const saved = app.createSavedMeal({ fromMealId: 'meal_library_L26' });
  app.createMealInstance({ date: DATE, mealSlot: 'lunch', mealId: saved.id, dayType: 'lift' });
  app.logFood({ date: DATE, mealSlot: 'snack_afternoon', foodId: 'food_core_banana', quantity: 120 });
  app.setFavoriteFood('food_core_sourdough', true);
  app.setDislikedFood('food_core_banana', true);
  app.setFavoriteMeal(saved.id, true);
  app.updatePreferences({ appPreferences: { units: 'g' } });
  throwsCode(() => app.updatePreferences({ nonsense: 1 }), 'INVALID_PREFERENCES');
  throwsCode(() => app.setFavoriteFood('food_core_nope', true), 'NOT_FOUND');

  const again = reopen();
  assert.deepEqual(again.getDay(DATE), app.getDay(DATE), 'Days persist');
  assert.deepEqual(again.getPreferences(), app.getPreferences(), 'preferences persist');
  assert.equal(again.getPreferences().appPreferences.units, 'g');

  assert.equal(app.getRecentFoods()[0].id, 'food_core_banana', 'most recent first');
  assert.equal(app.getRecentMeals()[0].id, saved.id);

  const ctx = app.getMacroCoachContext({ date: DATE, mealSlot: 'snack_night' });
  assert.equal(ctx.dayType, 'lift');
  assert.equal(ctx.targetSource, 'day_snapshot');
  const summary = app.getDaySummary(DATE);
  assert.deepEqual(ctx.remaining, summary.remaining, 'same numbers as Today');
  assert.ok(ctx.relevantFoods.some((f) => f.id === 'food_core_sourdough' && f.reasons.includes('favorite')));
  assert.ok(!ctx.relevantFoods.some((f) => f.id === 'food_core_banana'), 'disliked Foods excluded');
  assert.equal(ctx.savedMeals[0].valid, true);
  assert.deepEqual(ctx.favoriteMealIds, [saved.id]);
  const fresh = app.getMacroCoachContext({ date: '2026-09-30', mealSlot: 'breakfast', dayType: 'long_run' });
  assert.equal(fresh.targetSource, 'current');
  assert.equal(fresh.remaining.carbs, 343);
  assert.equal(app.getDay('2026-09-30'), null, 'building a context does not create a Day');

  app.deleteDay(DATE);
  assert.equal(app.getDay(DATE), null);
  assert.equal(app.getDaySummary(DATE).status, 'no_data');
}));
