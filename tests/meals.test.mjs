/*
 * meals.test.mjs — V2 UI Slice 4: the Meals screen (V2_UI_CONTRACT.md §6, §6.5, §7.5).
 * Pure renderers and domain-backed actions are tested here; the DOM wiring is exercised in a
 * real browser (see the slice report).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, macroArithmeticInSource, FORBIDDEN_NUTRITION, domainImportsBypassingIndex } from './helpers.mjs';
import { createDataLayer, createMemoryAdapter } from '../src/domain/index.js';
import { createFileAdapter } from '../src/node/file-adapter.js';
import { macroLine } from '../app/today.js';
import { resetSession, session } from '../app/session.js';
import { resolveLogContext, afterLogging, returnToMeals, createLogActions } from '../app/log.js';
import { presentationFor } from '../app/view-host.js';
import {
  MEALS_VIEW_TYPES, mealsSegment, sortSavedMeals, copyOfName, mealsList, renderMealsTop, renderMealsList, listCountText, needsFixCount,
  renderMealsDetail, newDraft, draftFromMeal, draftIngredients, draftMeal, ingredientsChanged, draftDirty, draftNeeds,
  renderEditor, renderPicker, renderReplace, renderDeleteMeal, renderSaveCopy, renderRemoveIngredient, renderDiscard,
  mealsErrorMessage, createMealsActions, mealsScreen
} from '../app/meals.js';

const TODAY = '2026-09-27';
const SEED = createFileAdapter(ROOT).load();

function setup() {
  resetSession();
  const inner = createMemoryAdapter(SEED);
  const writes = [];
  const adapter = { load: () => inner.load(), save: (c, d) => inner.save(c, d), saveMany: (ch) => { writes.push(Object.keys(ch)); inner.saveMany(ch); } };
  let t = Date.parse(`${TODAY}T12:00:00Z`);
  let n = 0;
  const app = createDataLayer({ adapter, today: () => TODAY, clock: () => new Date((t += 60000)), newId: () => `m${String(++n).padStart(4, '0')}` });
  return { app, writes, actions: createMealsActions(app) };
}
const text = (html) => html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ');
const detailOf = (app, id) => {
  const meal = app.getMeal(id);
  const calc = app.calculateMealMacros(id);
  const foods = Object.fromEntries(calc.ingredients.map((i) => [i.foodId, app.getFood(i.foodId)]).filter(([, f]) => f));
  return renderMealsDetail({ meal, calc, foods, isFavorite: app.getPreferences().favoriteMeals.includes(id), copyOf: copyOfName(app, meal) });
};
const yogurt = (app, name = 'Yogurt bowl', mealType = 'snack') => app.createSavedMeal({ name, mealType, ingredients: [{ foodId: 'food_core_fage_0_greek_yogurt', quantity: 150 }, { foodId: 'food_core_blueberries_frozen', quantity: 75 }] });
function invalidMeal(app, { twoMissing = false } = {}) {
  const a = app.createCustomFood({ name: 'Test bar', category: 'snack bar', state: 'prepared', nutrition: { protein: 20, carbs: 40, fat: 10 } });
  const b = app.createCustomFood({ name: 'Test granola', category: 'cereal', state: 'dry', nutrition: { protein: 10, carbs: 60, fat: 15 } });
  const meal = app.createSavedMeal({ name: 'Bar snack', mealType: 'snack', ingredients: [{ foodId: a.id, quantity: 50 }, ...(twoMissing ? [{ foodId: b.id, quantity: 40 }] : []), { foodId: 'food_core_banana', quantity: 100 }] });
  app.deleteCustomFood(a.id);
  if (twoMissing) app.deleteCustomFood(b.id);
  return { meal: app.getMeal(meal.id), deletedId: a.id };
}

/* ---------------- route, segment, empty state ---------------- */

test('Meals — the route is built and registered with the shell; Saved | Library, search and filter chips', () => {
  const main = fs.readFileSync(path.join(ROOT, 'app/main.js'), 'utf8');
  assert.match(main, /import \{ mealsScreen \} from '\.\/meals\.js';/);
  assert.match(main, /meals: mealsScreen/);
  assert.equal(typeof mealsScreen.mount, 'function');
  const html = renderMealsTop({ segment: 'saved', query: '', type: 'all', favorites: false });
  assert.match(html, /<h1 id="screen-title"[^>]*>Meals<\/h1>/);
  assert.match(html, /data-action="new-meal">New meal</);
  assert.match(html, /data-segment="saved" aria-pressed="true">Saved/);
  assert.match(html, /data-segment="library" aria-pressed="false">Library/);
  assert.deepEqual([...html.matchAll(/data-type="([a-z]+)" aria-pressed/g)].map((m) => m[1]), ['all', 'breakfast', 'lunch', 'snack', 'dinner', 'other'], 'type chips (§6.1)');
  assert.match(html, /data-action="favorites-filter" aria-pressed="false"/);
  assert.match(html, /<label class="visually-hidden" for="meals-query">Search saved meals<\/label>/);
});

test('Meals — segment: Library when there are no Saved Meals, else Saved; then the session’s choice', () => {
  const { app } = setup();
  assert.equal(mealsSegment({ segment: null }, app), 'library');
  yogurt(app);
  assert.equal(mealsSegment({ segment: null }, app), 'saved');
  assert.equal(mealsSegment({ segment: 'library' }, app), 'library', 'remembered');
  assert.equal(session.meals.type, 'all');
});

test('Meals — a new user has no Saved Meals, and none are manufactured from the Library', () => {
  const { app, writes } = setup();
  const list = mealsList(app, { segment: 'saved' });
  assert.equal(list.items.length, 0);
  const html = renderMealsList(list);
  assert.match(text(html), /No saved meals yet\. Save one from the Library, or create your own\./);
  assert.match(html, /data-action="segment" data-segment="library">Browse Library/);
  assert.match(html, /data-action="new-meal">New meal/);
  assert.equal(app.getSavedMeals().length, 0);
  assert.equal(writes.length, 0);
});

/* ---------------- Library ---------------- */

test('Meals — Library browsing: shipped order, retired hidden, domain P/C/F, read-only detail with Save a copy', () => {
  const { app } = setup();
  const list = mealsList(app, { segment: 'library' });
  assert.deepEqual(list.items.map((x) => x.meal.id), app.getLibraryMeals().map((m) => m.id));
  assert.ok(!list.items.some((x) => x.meal.metadata && x.meal.metadata.retired));
  const html = renderMealsList(list);
  for (const x of list.items.slice(0, 5)) assert.ok(html.includes(macroLine(app.calculateMealMacros(x.meal.id).totals)), 'totals from the domain');
  assert.ok(!FORBIDDEN_NUTRITION.test(html), 'protein, carbs and fat only');
  const detail = detailOf(app, 'meal_library_B1');
  assert.match(detail, /Breakfast · Library meal/);
  assert.match(detail, /data-action="save-copy"/);
  assert.match(detail, /Library meals can’t be changed\. Save a copy to make your own version\./);
  assert.ok(!/data-action="(edit|delete|duplicate|repair-replace|repair-remove)"/.test(detail), 'no editing a Library Meal');
  for (const ing of app.calculateMealMacros('meal_library_B1').ingredients) assert.ok(detail.includes(`${ing.quantity} g`), 'grams per ingredient');
  assert.match(detail, /<span class="state-chip">dry<\/span>/, 'Food state shown');
});

/* ---------------- search and filters ---------------- */

test('Meals — search uses searchMeals in the active segment, in the domain order; filters only filter', () => {
  const { app, writes } = setup();
  yogurt(app, 'Chicken yogurt bowl', 'lunch');
  yogurt(app, 'Chicken wrap', 'dinner');
  const lib = mealsList(app, { segment: 'library', query: 'chicken' });
  assert.deepEqual(lib.items.map((x) => x.meal.id), app.searchMeals('chicken', { source: 'library', limit: 500 }).map((h) => h.meal.id), 'no re-ranking');
  const saved = mealsList(app, { segment: 'saved', query: 'chicken' });
  assert.deepEqual(saved.items.map((x) => x.meal.name), app.searchMeals('chicken', { source: 'saved' }).map((h) => h.meal.name));
  const dinners = mealsList(app, { segment: 'library', query: 'chicken', type: 'dinner' });
  assert.deepEqual(dinners.items.map((x) => x.meal.id), lib.items.filter((x) => x.meal.mealType === 'dinner').map((x) => x.meal.id), 'type chip filters, order kept');
  app.setFavoriteMeal('meal_library_B1', true);
  assert.deepEqual(mealsList(app, { segment: 'library', favorites: true }).items.map((x) => x.meal.id), ['meal_library_B1'], 'Library favourites filter within Library');
  assert.deepEqual(mealsList(app, { segment: 'saved', favorites: true }).items, [], 'a Library favourite is never a Saved favourite (A-15)');
  const none = mealsList(app, { segment: 'library', query: 'zzqx' });
  assert.match(text(renderMealsList(none)), /No meals match “zzqx”\. Clear search/);
  assert.equal(listCountText(none), '0 meals');
  assert.match(text(renderMealsList(mealsList(app, { segment: 'saved', favorites: true }))), /Star a meal to find it here\./);
  const n = writes.length;
  mealsList(app, { segment: 'saved', query: 'bowl' });
  assert.equal(writes.length, n, 'search writes nothing');
});

test('Meals — Saved Meals are listed by most recently updated, then name (I-26)', () => {
  const meals = [
    { name: 'B', metadata: { updatedAt: '2026-09-01T00:00:00Z' } },
    { name: 'A', metadata: { updatedAt: '2026-09-03T00:00:00Z' } },
    { name: 'C', metadata: { updatedAt: '2026-09-01T00:00:00Z' } }
  ];
  assert.deepEqual(sortSavedMeals(meals).map((m) => m.name), ['A', 'B', 'C']);
  assert.deepEqual(meals.map((m) => m.name), ['B', 'A', 'C'], 'input untouched');
});

/* ---------------- creating ---------------- */

test('Meals — New Saved Meal: name, ≥ 1 ingredient, grams > 0; totals come from the domain; then created', () => {
  const { app, actions, writes } = setup();
  const draft = newDraft();
  let calc = app.calculateMealMacros(draftMeal(draft));
  assert.deepEqual(draftNeeds(draft, calc), ['a name', 'at least one ingredient']);
  let html = renderEditor({ draft, calc, foods: {}, touched: new Set() });
  assert.match(html, /<h2 id="sheet-title"[^>]*>New Saved Meal<\/h2>/);
  assert.match(html, /data-action="editor-save" data-sync="ed-save" aria-describedby="ed-needs" disabled>Save/, 'Save really disabled');
  assert.match(html, /Needed before saving: a name, at least one ingredient\./);
  assert.match(html, /name="ed-type" value="other" checked/, 'type defaults to Other');

  draft.name = 'Rice bowl';
  draft.rows.push({ foodId: 'food_core_banana', text: '', unit: 'g' }); // added from the picker: grams empty
  calc = app.calculateMealMacros(draftMeal(draft));
  assert.deepEqual(draftNeeds(draft, calc), ['a weight above 0 g for every ingredient']);
  html = renderEditor({ draft, calc, foods: { food_core_banana: app.getFood('food_core_banana') }, touched: new Set([0]) });
  assert.match(html, /<p id="ed-q-0-error" class="field-error" data-sync="row-0-error">Enter a weight above 0 g<\/p>/);
  assert.match(html, /id="ed-q-0"[^>]*aria-invalid="true" aria-describedby="ed-q-0-error ed-q-0-macros"/, 'error associated with its field');
  assert.match(html, /<span class="state-chip">raw<\/span>/, 'state shown, never converted');

  draft.rows[0].text = '120';
  draft.rows.push({ foodId: 'food_core_fage_0_greek_yogurt', text: '150', unit: 'g' });
  calc = app.calculateMealMacros(draftMeal(draft));
  assert.equal(calc.valid, true);
  assert.deepEqual(draftNeeds(draft, calc), []);
  html = renderEditor({ draft, calc, foods: {}, touched: new Set() });
  assert.ok(html.includes(`<p class="preview-totals">${macroLine(calc.totals)}</p>`), 'live totals: calculateMealMacros on the draft');
  assert.ok(html.includes(macroLine(calc.ingredients[1])), 'per-ingredient P/C/F from the domain');
  assert.equal(writes.length, 0, 'the draft is never saved while editing');

  const r = actions.saveDraft({ ...draft, mealType: 'lunch' });
  assert.equal(r.meal.source, 'saved');
  assert.deepEqual(app.calculateMealMacros(r.meal.id).totals, calc.totals, 'saved totals equal the previewed totals');
  assert.deepEqual(r.meal.ingredients, [{ foodId: 'food_core_banana', quantity: 120, unit: 'g' }, { foodId: 'food_core_fage_0_greek_yogurt', quantity: 150, unit: 'g' }]);
  assert.equal(r.meal.mealType, 'lunch');
  assert.equal(r.message, 'Saved “Rice bowl”.');
  assert.throws(() => actions.saveDraft({ ...newDraft(), name: 'x' }), (e) => e.code === 'INVALID_MEAL', 'the domain refuses an empty meal too');
});

/* ---------------- editing ---------------- */

test('Meals — Edit: rename, change grams, add and remove ingredients, review totals, save', () => {
  const { app, actions } = setup();
  const meal = yogurt(app);
  const draft = draftFromMeal(meal);
  assert.equal(draftDirty(draft), false);
  draft.name = 'Bigger bowl';
  draft.rows[0].text = '200';
  draft.rows.splice(1, 1);
  draft.rows.push({ foodId: 'food_core_banana', text: '100', unit: 'g' });
  assert.equal(draftDirty(draft), true);
  assert.equal(ingredientsChanged(draft), true);
  const calc = app.calculateMealMacros(draftMeal(draft));
  const html = renderEditor({ draft, calc, foods: {}, touched: new Set() });
  assert.match(html, /Edit Saved Meal/);
  assert.match(text(html), /Changes apply the next time you log this meal\. Meals you’ve already logged won’t change\./);
  const r = actions.saveDraft(draft);
  assert.equal(r.meal.id, meal.id, 'same Saved Meal');
  assert.equal(r.meal.name, 'Bigger bowl');
  assert.deepEqual(app.getMeal(meal.id).ingredients.map((i) => [i.foodId, i.quantity]), [['food_core_fage_0_greek_yogurt', 200], ['food_core_banana', 100]]);
  assert.deepEqual(app.calculateMealMacros(meal.id).totals, calc.totals);

  const renameOnly = draftFromMeal(app.getMeal(meal.id));
  renameOnly.name = 'Renamed';
  assert.equal(ingredientsChanged(renameOnly), false, 'an unchanged ingredient list is not sent');
  actions.saveDraft(renameOnly);
  assert.equal(app.getMeal(meal.id).name, 'Renamed');
});

test('Meals — editing or deleting a Saved Meal never changes meals already logged from it', () => {
  const { app, actions } = setup();
  const meal = yogurt(app);
  const logged = createLogActions(app).logMeal({ date: TODAY, mealSlot: 'snack_night', mealId: meal.id, dayType: 'rest' }).instance;
  const before = JSON.stringify(app.getDay(TODAY));
  const draft = draftFromMeal(meal);
  draft.rows[0].text = '10';
  draft.name = 'Tiny bowl';
  actions.saveDraft(draft);
  assert.equal(JSON.stringify(app.getDay(TODAY)), before, 'history is a snapshot');
  actions.deleteMeal(meal.id);
  assert.equal(JSON.stringify(app.getDay(TODAY)), before, 'deleting leaves history alone');
  assert.equal(app.getDay(TODAY).mealInstances[0].mealName, logged.mealName);
});

/* ---------------- duplicate, delete, save a copy ---------------- */

test('Meals — Duplicate makes a new Saved Meal with its own ID; the original is unchanged', () => {
  const { app, actions } = setup();
  const meal = yogurt(app);
  const original = JSON.stringify(app.getMeal(meal.id));
  const r = actions.duplicate(meal.id);
  assert.notEqual(r.meal.id, meal.id);
  assert.equal(r.meal.name, 'Yogurt bowl (copy)');
  assert.equal(r.message, 'Duplicated as “Yogurt bowl (copy)”.');
  assert.equal(JSON.stringify(app.getMeal(meal.id)), original);
  const draft = draftFromMeal(r.meal);
  draft.rows[0].text = '300';
  actions.saveDraft(draft);
  assert.equal(JSON.stringify(app.getMeal(meal.id)), original, 'editing the copy leaves the original alone');
  assert.match(detailOf(app, r.meal.id), /Copy of Yogurt bowl/);
});

test('Meals — Delete asks first, names the meal, and removes only that Saved Meal', () => {
  const { app, actions } = setup();
  const meal = yogurt(app);
  app.setFavoriteMeal(meal.id, true);
  const other = yogurt(app, 'Other bowl');
  const html = renderDeleteMeal({ meal });
  assert.match(text(html), /Delete Saved Meal “Yogurt bowl”\? Meals you’ve already logged from it stay in your history\./);
  assert.ok(html.indexOf('data-autofocus') < html.indexOf('delete-confirm'), 'Cancel is focused');
  assert.match(html, /class="button danger" data-action="delete-confirm">Delete Saved Meal</, 'the destructive action says what it does');
  assert.match(detailOf(app, meal.id), /class="button danger" data-action="delete"/);
  const r = actions.deleteMeal(meal.id);
  assert.match(r.message, /^Deleted “Yogurt bowl”\./);
  assert.equal(app.getMeal(meal.id), null);
  assert.ok(app.getMeal(other.id));
  assert.ok(!app.getPreferences().favoriteMeals.includes(meal.id));
});

test('Meals — Save a copy: a new, independent Saved Meal; the Library Meal is unchanged', () => {
  const { app, actions } = setup();
  app.setFavoriteMeal('meal_library_B1', true);
  const libBefore = JSON.stringify(app.getMeal('meal_library_B1'));
  const prompt = renderSaveCopy({ meal: app.getMeal('meal_library_B1'), name: 'Big Oat Jar with chia' });
  assert.match(prompt, /id="copy-name"[^>]*value="Big Oat Jar with chia"/, 'name prefilled');
  const r = actions.saveCopy('meal_library_B1', 'My oat jar');
  assert.equal(r.meal.source, 'saved');
  assert.notEqual(r.meal.id, 'meal_library_B1');
  assert.equal(r.meal.metadata.copiedFromMealId, 'meal_library_B1');
  assert.deepEqual(r.meal.ingredients, app.getMeal('meal_library_B1').ingredients);
  assert.ok(!app.getPreferences().favoriteMeals.includes(r.meal.id), 'the favourite doesn’t carry over');
  const draft = draftFromMeal(r.meal, { copyNote: true });
  draft.rows[0].text = '100';
  const html = renderEditor({ draft, calc: app.calculateMealMacros(draftMeal(draft)), foods: {}, touched: new Set() });
  assert.match(text(html), /This is your copy\. Changes here don’t affect the Library meal\./);
  actions.saveDraft(draft);
  assert.equal(JSON.stringify(app.getMeal('meal_library_B1')), libBefore, 'Library Meal unchanged');
  assert.equal(app.getMeal(r.meal.id).ingredients[0].quantity, 100, 'the copy is independently editable');
  assert.match(detailOf(app, r.meal.id), /Copy of Big Oat Jar with chia/);
  assert.throws(() => app.updateSavedMeal('meal_library_B1', { name: 'x' }), (e) => e.code === 'LIBRARY_MEAL_READ_ONLY');
  assert.equal(mealsErrorMessage({ code: 'LIBRARY_MEAL_READ_ONLY' }), 'Library meals can’t be changed. Save a copy to make your own version.');
});

test('Meals — logging a Library Meal leaves it a Library Meal', () => {
  const { app } = setup();
  const before = app.getSavedMeals().length;
  const r = createLogActions(app).logMeal({ date: TODAY, mealSlot: 'lunch', mealId: 'meal_library_L26', dayType: 'lift' });
  assert.equal(app.getMeal(r.instance.sourceMealId).source, 'library');
  assert.equal(app.getSavedMeals().length, before);
  assert.equal(mealsList(app, { segment: 'saved' }).items.length, before);
});

/* ---------------- invalid Saved Meals and repair (§6.5) ---------------- */

test('Meals — an invalid Saved Meal: Needs a fix, banner, Log and Duplicate disabled with the reason', () => {
  const { app } = setup();
  const { meal } = invalidMeal(app);
  const list = renderMealsList(mealsList(app, { segment: 'saved' }));
  assert.match(list, /<span class="marker marker-fix">Needs a fix<\/span>/);
  assert.match(list, /aria-label="Fix Bar snack">Fix</);
  const html = detailOf(app, meal.id);
  assert.match(text(html), /Bar snack can’t be logged right now\. Test bar was deleted, so this meal needs a replacement\. Meals you’ve already logged aren’t affected\./);
  assert.match(html, /data-action="log-meal" data-meal="[^"]+" disabled aria-describedby="detail-why">Log this meal/);
  assert.match(html, /data-action="duplicate" data-meal="[^"]+" disabled aria-describedby="detail-why">Duplicate/);
  assert.match(html, /data-action="edit"[^>]*>Edit</, 'Edit still works');
  assert.match(html, /aria-label="Replace Test bar">Replace</);
  assert.match(html, /aria-label="Remove Test bar">Remove</);
  assert.match(text(html), /Totals will show once every ingredient is fixed\./);
});

test('Meals — Replace a deleted food (picker prefilled, grams kept, live preview) and Remove one', () => {
  const { app, actions } = setup();
  const { meal, deletedId } = invalidMeal(app);
  const picker = renderPicker({ title: 'Replace Test bar', query: 'Test bar', results: '' });
  assert.match(picker, /id="pick-query"[^>]*value="Test bar"/, 'search prefilled with the last known name');
  const food = app.getFood('food_core_rice_cakes');
  const ingredientPreview = app.previewMealInstance({ ingredients: [{ foodId: food.id, quantity: 50, unit: 'g' }], mealName: food.name });
  const mealCalc = app.calculateMealMacros({ ...meal, ingredients: meal.ingredients.map((i, k) => (k === 0 ? { foodId: food.id, quantity: 50, unit: 'g' } : i)) });
  const confirm = renderReplace({ oldName: 'Test bar', food, text: '50', ingredientPreview, mealCalc });
  assert.match(text(confirm), /Replace Test bar with Rice cakes \(prepared\)\?/);
  assert.match(confirm, /id="rep-grams"[^>]*value="50"/);
  assert.ok(confirm.includes(macroLine(ingredientPreview.totals)) && confirm.includes(macroLine(mealCalc.totals)));
  const r = actions.replaceIngredient(meal.id, deletedId, food.id, 30);
  assert.equal(app.calculateMealMacros(meal.id).valid, true);
  assert.equal(app.getMeal(meal.id).ingredients[0].quantity, 30);
  assert.equal(r.message, 'Replaced. “Bar snack” can be logged again.');

  const { meal: m2 } = invalidMeal(app);
  const remove = renderRemoveIngredient({ meal: m2, name: 'Test bar' });
  assert.match(text(remove), /Remove Test bar from “Bar snack”\? Meals you’ve already logged aren’t affected\./);
  actions.removeIngredient(m2.id, 0);
  assert.equal(app.calculateMealMacros(m2.id).valid, true);
  assert.deepEqual(app.getMeal(m2.id).ingredients.map((i) => i.foodId), ['food_core_banana']);
});

test('Meals — two deleted foods: one-at-a-time repair is refused by the domain and explained; the editor fixes both', () => {
  const { app, actions } = setup();
  const { meal, deletedId } = invalidMeal(app, { twoMissing: true });
  let error = null;
  try { actions.replaceIngredient(meal.id, deletedId, 'food_core_banana', 50); } catch (e) { error = e; }
  assert.equal(error.code, 'FOOD_NOT_FOUND', 'domain gap: each repair re-checks every ingredient');
  assert.equal(mealsErrorMessage(error, 'repair'), 'Another ingredient was also deleted. Use Edit to replace or remove them together.');
  const draft = draftFromMeal(meal);
  let calc = app.calculateMealMacros(draftMeal(draft));
  let html = renderEditor({ draft, calc, foods: {}, touched: new Set() });
  assert.equal((html.match(/class="adjust-row is-missing"/g) || []).length, 2);
  assert.deepEqual(draftNeeds(draft, calc), [], 'renaming alone is allowed');
  draft.rows.splice(0, 1);
  calc = app.calculateMealMacros(draftMeal(draft));
  assert.deepEqual(draftNeeds(draft, calc), ['the deleted food replaced or removed'], 'ingredient changes wait for the other deleted food');
  draft.rows[0] = { foodId: 'food_core_rolled_oats_dry', text: draft.rows[0].text, unit: 'g' };
  calc = app.calculateMealMacros(draftMeal(draft));
  assert.deepEqual(draftNeeds(draft, calc), []);
  actions.saveDraft(draft);
  assert.equal(app.calculateMealMacros(meal.id).valid, true);
});

test('Meals — the only ingredient can be replaced but not removed', () => {
  const { app } = setup();
  const f = app.createCustomFood({ name: 'Solo bar', category: 'bar', state: 'prepared', nutrition: { protein: 20, carbs: 40, fat: 10 } });
  const meal = app.createSavedMeal({ name: 'Solo', mealType: 'snack', ingredients: [{ foodId: f.id, quantity: 50 }] });
  app.deleteCustomFood(f.id);
  const html = detailOf(app, meal.id);
  assert.match(html, /data-action="repair-replace"/);
  assert.ok(!/data-action="repair-remove"/.test(html));
  assert.match(text(html), /It’s the only ingredient: replace it, or delete this meal\./);
});

/* ---------------- presentation, focus, navigation ---------------- */

test('Meals — presented like Log: views pushed on phones, a side panel at medium, a right-hand pane on wide', () => {
  assert.deepEqual([...MEALS_VIEW_TYPES], ['meal-detail', 'editor', 'picker', 'custom-food', 'replace']);
  for (const type of MEALS_VIEW_TYPES) {
    assert.equal(presentationFor(type, 'compact', MEALS_VIEW_TYPES), 'pushed');
    assert.equal(presentationFor(type, 'medium', MEALS_VIEW_TYPES), 'panel');
    assert.equal(presentationFor(type, 'wide', MEALS_VIEW_TYPES), 'pane');
  }
  for (const type of ['delete', 'save-copy', 'remove-ingredient', 'discard']) assert.equal(presentationFor(type, 'compact', MEALS_VIEW_TYPES), 'sheet');
  const src = fs.readFileSync(path.join(ROOT, 'app/meals.js'), 'utf8');
  assert.match(src, /createViewHost\(\{[\s\S]*?viewTypes: MEALS_VIEW_TYPES,[\s\S]*?beforeLeave/, 'the same view host as Log');
  assert.match(src, /const openDetail = \(mealId\) => show\(\{ type: 'meal-detail', mealId \}, \{ startAtTitle: true \}\);/, 'detail opens at its title');
  assert.ok(!/showModal|pushState|popstate/.test(src), 'no second dialog or history system');
  const { app } = setup();
  const meal = yogurt(app);
  for (const html of [detailOf(app, meal.id), renderEditor({ draft: draftFromMeal(meal), calc: app.calculateMealMacros(meal.id), foods: {}, touched: new Set() }), renderPicker({ title: 'Add an ingredient', query: '', results: '' })]) {
    assert.match(html, /class="link-button view-back" data-action="close"/, 'a Back control when pushed');
  }
  const css = fs.readFileSync(path.join(ROOT, 'app/app.css'), 'utf8');
  assert.match(css, /\.view-page\.has-view \{/, 'two panes shared with Log');
  assert.match(css, /\.app-frame:has\(\.log-screen\[data-origin="meals"\]\) \.primary-nav \{ display: none; \}/, 'Log opened from Meals is a pushed destination on phones');
});

test('Meals — accessibility state: pressed chips and star, focus on Cancel / Keep editing, named Log and Fix buttons', () => {
  const { app } = setup();
  const meal = yogurt(app);
  assert.match(renderMealsTop({ segment: 'saved', query: '', type: 'dinner', favorites: true }), /data-type="dinner" aria-pressed="true"[\s\S]*data-action="favorites-filter" aria-pressed="true"/);
  assert.match(detailOf(app, meal.id), /data-action="favorite" data-meal="[^"]+" aria-pressed="false"><span aria-hidden="true">☆ <\/span>Favourite/);
  app.setFavoriteMeal(meal.id, true);
  assert.match(detailOf(app, meal.id), /aria-pressed="true"><span aria-hidden="true">★ <\/span>Favourite/);
  assert.match(renderDiscard(), /data-action="keep-editing" data-autofocus>Keep editing/);
  assert.match(renderMealsList(mealsList(app, { segment: 'saved' })), /aria-label="Log Yogurt bowl">Log</);
  const editor = renderEditor({ draft: { ...draftFromMeal(meal), name: '' }, calc: app.calculateMealMacros(meal.id), foods: {}, touched: new Set(['name']) });
  assert.match(editor, /id="ed-name"[^>]*aria-describedby="ed-name-error" aria-invalid="true"/);
  assert.match(editor, /<p id="ed-name-error" class="field-error" data-sync="ed-name-error">Give it a name<\/p>/);
});

test('Meals — "Log this meal" uses Log’s one logging flow and returns to Meals with View on Today', () => {
  const { app } = setup();
  const meal = yogurt(app);
  session.todayDate = '2026-09-25';
  const ctx = resolveLogContext(app, `#/log?from=meals&meal=${meal.id}`);
  assert.deepEqual(ctx, { origin: 'meals', date: '2026-09-25', slot: null, launchDate: '2026-09-25', openMealId: meal.id });
  const result = createLogActions(app).logMeal({ date: ctx.date, mealSlot: 'lunch', mealId: meal.id, dayType: 'rest' });
  const out = afterLogging(app, ctx, result);
  assert.equal(out.to, 'meals');
  assert.deepEqual(out.confirmation, { message: 'Logged Yogurt bowl to Lunch.', instanceId: result.instance.id, date: '2026-09-25' });
  assert.deepEqual(returnToMeals({ launchedFromMeals: true }), { method: 'back' });
  assert.deepEqual(returnToMeals({ launchedFromMeals: false }), { method: 'replace', href: '#/meals' });
  const src = fs.readFileSync(path.join(ROOT, 'app/meals.js'), 'utf8');
  assert.match(src, /host\.leave\(\{ method: 'push', href: `#\/log\?from=meals&meal=\$\{encodeURIComponent\(mealId\)\}` \}\)/);
  const host = fs.readFileSync(path.join(ROOT, 'app/view-host.js'), 'utf8');
  assert.match(host, /else if \(nav\.method === 'push'\) \{ if \(hadViewEntry\) win\.location\.replace\(nav\.href\); else win\.location\.hash = nav\.href; \}/, 'a pushed view’s entry is replaced, not stacked under Log');
  assert.match(host, /if \(beforeLeave && !beforeLeave\(\)\) \{ win\.history\.pushState/, 'browser Back on an unsaved editor asks first and keeps the entry');
});

test('Meals — Today’s logged-meal detail links to the Saved Meal editor (§4.3.3)', () => {
  const src = fs.readFileSync(path.join(ROOT, 'app/today.js'), 'utf8');
  assert.match(src, /href="#\/meals\?meal=\$\{encodeURIComponent\(instance\.sourceMealId\)\}&edit=1">Edit Saved Meal “\$\{escapeHtml\(sourceName\)\}”<\/a>/);
  assert.match(src, /source === 'saved' && instance\.sourceMealId/, 'only for a Saved Meal that still exists');
});

/* ---------------- architecture ---------------- */

test('Meals — no macro arithmetic, no forbidden terms, no second store, domain via its entry point', () => {
  for (const f of ['app/meals.js', 'app/view-host.js', 'app/session.js', 'app/app.css']) {
    const src = fs.readFileSync(path.join(ROOT, f), 'utf8');
    assert.deepEqual(macroArithmeticInSource(src, f), [], f);
    assert.ok(!FORBIDDEN_NUTRITION.test(src), f);
    assert.deepEqual(domainImportsBypassingIndex(src), [], f);
  }
  const src = fs.readFileSync(path.join(ROOT, 'app/meals.js'), 'utf8');
  assert.deepEqual([...src.matchAll(/from '([^']+)'/g)].map((m) => m[1]).sort(), ['../src/domain/index.js', './log.js', './session.js', './shell.js', './today.js', './view-host.js']);
  assert.ok(!/localStorage|sessionStorage|indexedDB|\bfetch\(|import\(/.test(src), 'no second persistence mechanism');
  assert.ok(!/savedMeals\s*[.=[]|libraryMeals\s*[.=[]|store\./.test(src), 'no direct data access: domain calls only');
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, ''); // executable code, not comments
  assert.ok(!/\byield|convert/i.test(code), 'no yield or unit conversion');
  assert.ok(!/score|best match|rank/i.test(code), 'no ranking or scoring');
});

test('Meals — "Needs a fix" is a filter over the Saved Meals the domain can’t calculate (the Coach footer lands here, §8.3)', () => {
  const { app } = setup();
  const good = app.createSavedMeal({ name: 'Good bowl', mealType: 'lunch', ingredients: [{ foodId: 'food_core_banana', quantity: 100 }] });
  const bar = app.createCustomFood({ name: 'Test bar', category: 'snack bar', state: 'prepared', nutrition: { protein: 20, carbs: 40, fat: 10 } });
  const broken = app.createSavedMeal({ name: 'Bar snack', mealType: 'snack', ingredients: [{ foodId: bar.id, quantity: 50 }, { foodId: 'food_core_banana', quantity: 80 }] });
  assert.equal(needsFixCount(app), 0);
  assert.match(renderMealsTop({ segment: 'saved', query: '', type: 'all', favorites: false }, { fixCount: 0 }), /data-action="needs-fix-filter" aria-pressed="false" hidden>Needs a fix</, 'no chip while nothing needs a fix');
  app.deleteCustomFood(bar.id);
  assert.equal(needsFixCount(app), 1);
  const top = renderMealsTop({ segment: 'saved', query: '', type: 'all', favorites: false, needsFix: true }, { fixCount: 1 });
  assert.match(top, /data-action="needs-fix-filter" aria-pressed="true">Needs a fix</);
  assert.ok(!/needs-fix-filter/.test(renderMealsTop({ segment: 'library', query: '', type: 'all', favorites: false }, { fixCount: 1 })), 'Saved only');
  const list = mealsList(app, { segment: 'saved', needsFix: true });
  assert.deepEqual(list.items.map((x) => x.meal.id), [broken.id], 'only the meal that needs a fix; the good one is not included');
  assert.equal(list.items[0].calc.valid, false, 'decided by calculateMealMacros, the same state the Coach counts');
  const html = renderMealsList(list);
  assert.match(html, /<h2 id="meals-list-title" class="group-title">Saved meals that need a fix<\/h2>/);
  assert.match(html, /<span class="marker marker-fix">Needs a fix<\/span>/);
  assert.match(html, /data-action="meal-detail" data-meal="[^"]+" aria-label="Fix Bar snack">Fix</, 'the existing repair flow (§6.5)');
  assert.deepEqual(mealsList(app, { segment: 'library', needsFix: true }).items.length, app.getLibraryMeals().length, 'no effect on Library');
  // Repair through the existing flow: the meal leaves the filter; nothing was changed by filtering.
  assert.equal(app.getMeal(broken.id).ingredients.length, 2);
  app.replaceSavedMealIngredient(broken.id, bar.id, 'food_core_fage_0_greek_yogurt', { quantity: 50 });
  assert.equal(needsFixCount(app), 0);
  assert.match(text(renderMealsList(mealsList(app, { segment: 'saved', needsFix: true }))), /No saved meals need a fix\. Show all meals/);
  assert.ok(app.getMeal(good.id));
  const src = fs.readFileSync(path.join(ROOT, 'app/meals.js'), 'utf8');
  assert.match(src, /if \(params\.get\('filter'\) === 'needs-fix'\) \{\n\s+Object\.assign\(state, \{ segment: 'saved', query: '', type: 'all', favorites: false, needsFix: true \}\);/, '#/meals?filter=needs-fix turns the filter on');
});
