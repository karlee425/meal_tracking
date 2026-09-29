/*
 * foods.test.mjs — V2 UI: Food management. Food detail (§7.3), favourites (A-31), "Don't
 * suggest" (A-32), Custom Food edit / delete (§7.4, §7.6, A-17), and Settings → My foods ·
 * Favourites · Foods not suggested (§10.1, A-36). Pure renderers and domain behaviour here;
 * the DOM wiring is exercised in a real browser (slice report).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, macroArithmeticInSource, FORBIDDEN_NUTRITION, domainImportsBypassingIndex } from './helpers.mjs';
import { createDataLayer, createMemoryAdapter } from '../src/domain/index.js';
import { createFileAdapter } from '../src/node/file-adapter.js';
import { openBrowserDataLayer } from '../src/browser/app-data.js';
import { createMemorySnapshotStore } from '../src/browser/memory-snapshot-store.js';
import {
  foodDetailModel, renderFoodDetail, renderDeleteFood, deletedFoodMessage, foodUsageMeals, foodDetailRow, renderLinkedMessage,
  createFoodActions, otherNames, sourceLabel, renderDiscardFood
} from '../app/foods.js';
import {
  foodResults, renderResults, renderFoodSheet, renderConfirmation, renderCustomFoodForm, customFoodValues, customFoodPatch,
  customFoodDirty, validateCustomFoodForm, logModel
} from '../app/log.js';
import { renderSettings, settingsFoodsModel, SETTINGS_VIEW_TYPES } from '../app/settings.js';

const TODAY = '2026-09-28';
const PAST = '2026-09-25';
const SEED = createFileAdapter(ROOT).load();
const CORE = 'food_core_fage_0_greek_yogurt';
const OATS = 'food_custom_oats_overnight';
const OATS_BRAND = 'food_custom_oats_overnight_brand';

function setup() {
  const inner = createMemoryAdapter(SEED);
  const writes = [];
  const adapter = { load: () => inner.load(), save: (c, d) => inner.save(c, d), saveMany: (ch) => { writes.push(Object.keys(ch)); inner.saveMany(ch); } };
  let t = Date.parse(`${TODAY}T12:00:00Z`);
  const app = createDataLayer({ adapter, today: () => TODAY, clock: () => new Date((t += 60000)) });
  return { app, writes };
}
const text = (html) => html.replace(/<[^>]*>/g, ' ').replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').replace(/\s+/g, ' ');
const detail = (app, id, extra = {}) => renderFoodDetail({ ...foodDetailModel(app, id), ...extra });
const settingsHtml = (app, foodsNote = null) => renderSettings({ targets: app.getAllCurrentTargets(), status: app.getPersistenceStatus(), lastBackupAt: null, restore: null, foods: settingsFoodsModel(app), foodsNote });

/** A past day with a logged Custom Food, a logged Core Food and a logged Saved Meal that uses the Custom Food. */
function withHistory(app) {
  const meal = app.createSavedMeal({ name: 'Oats bowl', mealType: 'breakfast', ingredients: [{ foodId: OATS, quantity: 80 }, { foodId: CORE, quantity: 150 }] });
  app.createDay(PAST, 'lift');
  app.logFood({ date: PAST, mealSlot: 'breakfast', foodId: OATS, quantity: 90 });
  app.logFood({ date: PAST, mealSlot: 'lunch', foodId: CORE, quantity: 200 });
  app.createMealInstance({ date: PAST, mealSlot: 'dinner', mealId: meal.id });
  return meal;
}
const historyText = (app) => JSON.stringify(app.exportUserData().data.days);

/* ---------------- Food detail (§7.3) ---------------- */

test('Food detail — a Core Food: name, state, category, brand, "App food · can’t be edited", P/C/F per 100 g, other names; no Edit or Delete', () => {
  const { app } = setup();
  const html = detail(app, CORE, { context: 'settings' });
  const t = text(html);
  assert.match(html, /<h2 id="sheet-title" class="sheet-title">Fage 0% Greek yogurt<\/h2>/);
  assert.match(html, /<p class="sheet-subtitle">App food · can’t be edited<\/p>/, 'A-17');
  assert.match(t, /State prepared Category/);
  assert.match(t, /Category dairy/);
  assert.match(t, /Brand Fage/);
  assert.match(t, /Source App food/);
  assert.match(t, /Other names greek yogurt nonfat Per 100 g/, 'an alias that only repeats the name is left out');
  assert.match(html, /<caption class="group-title">Per 100 g<\/caption>/);
  assert.match(html, /<td>10\.3 g<\/td><td>3\.6 g<\/td><td>0 g<\/td>/, 'stored values, one decimal, grams');
  assert.match(html, /<thead><tr><th scope="col">Protein<\/th><th scope="col">Carbs<\/th><th scope="col">Fat<\/th><\/tr><\/thead>/);
  assert.ok(!/data-action="fd-edit"|data-action="fd-delete"/.test(html), 'A-17: Core Foods are read-only');
  // Never shown (I-30): migration metadata.
  assert.ok(!/swap|stateInferred|yield|macroRole|legacySwap|portionStep|editable|active/i.test(t), t);
  assert.ok(!FORBIDDEN_NUTRITION.test(html));
});

test('Food detail — a Custom Food: "My food", Edit · Delete; other names skip one that only repeats the name', () => {
  const { app } = setup();
  const html = detail(app, OATS, { context: 'settings' });
  assert.match(html, /<p class="sheet-subtitle">My food<\/p>/);
  assert.match(text(html), /Source My food/);
  assert.match(html, /data-action="fd-edit">Edit</);
  assert.match(html, /class="button danger" data-action="fd-delete">Delete</);
  assert.ok(!/can’t be edited/.test(html));
  assert.deepEqual(otherNames(app.getFood(OATS)), [], '"oats overnight" is only the name again');
  assert.ok(!/Other names/.test(text(html)));
  assert.equal(sourceLabel(app.getFood(CORE)), 'App food');
});

test('Food detail — from Log: Log this food and Add to a meal (Log disabled for a future date); from Settings: neither', () => {
  const { app } = setup();
  const fromLog = detail(app, CORE, { context: 'log' });
  assert.match(fromLog, /class="button primary" data-action="fd-log" data-food="food_core_fage_0_greek_yogurt">Log this food</);
  assert.match(fromLog, /data-action="fd-add" data-food="food_core_fage_0_greek_yogurt">Add to a meal</);
  const future = detail(app, CORE, { context: 'log', future: true });
  assert.match(future, /data-action="fd-log"[^>]*disabled aria-describedby="fd-future">Log this food/);
  assert.match(future, /You can log this day when it arrives\./);
  assert.ok(!/data-action="fd-(log|add)"/.test(detail(app, CORE, { context: 'settings' })), 'Settings opens Food detail without logging actions');
  // Log reaches Food detail from the quantity sheet; the row itself still opens the quantity sheet (§5.5).
  const model = logModel(app, { origin: 'log', date: TODAY, slot: null, launchDate: TODAY });
  const food = app.getFood(CORE);
  const sheet = renderFoodSheet({ model, food, text: '', preview: null, slot: null });
  assert.match(sheet, /data-action="food-detail" data-food="food_core_fage_0_greek_yogurt" aria-label="Details for Fage 0% Greek yogurt">Food details</);
  assert.match(sheet, /class="button primary" data-action="log-food" disabled>Log</, 'Log is the main action by default');
  const trayIntent = renderFoodSheet({ model, food, text: '', preview: null, slot: null, intent: 'tray' });
  assert.match(trayIntent, /class="button primary" data-action="add-to-tray" disabled>Add to a meal/, 'opened with Add to a meal: that is the main action');
  assert.match(renderResults({ segment: 'foods', meals: null, foods: foodResults(app, 'fage'), future: false }), /data-action="food" data-food="food_core_fage_0_greek_yogurt"/, 'a food row still opens the quantity sheet');
});

/* ---------------- favourites (A-31) ---------------- */

test('Favourites — favourite and unfavourite a Core and a Custom Food through the domain; one entry each, no Food record touched', () => {
  const { app, writes } = setup();
  const actions = createFoodActions(app);
  const foodsBefore = JSON.stringify([app.getFood(CORE), app.getCustomFoods()]);
  assert.equal(actions.setFavorite(app.getFood(CORE), true), 'Fage 0% Greek yogurt added to favourites.');
  actions.setFavorite(app.getFood(OATS), true);
  actions.setFavorite(app.getFood(OATS), true); // again: still one entry
  assert.deepEqual(app.getPreferences().favoriteFoods, [CORE, OATS]);
  assert.equal(foodDetailModel(app, CORE).isFavorite, true);
  assert.match(detail(app, CORE), /data-action="fd-favorite" data-sync="fd-favorite" aria-pressed="true" aria-label="Favourite Fage 0% Greek yogurt"><span aria-hidden="true">★<\/span> Favourite/);
  assert.equal(actions.setFavorite(app.getFood(CORE), false), 'Fage 0% Greek yogurt removed from favourites.');
  assert.deepEqual(app.getPreferences().favoriteFoods, [OATS]);
  assert.match(detail(app, CORE), /aria-pressed="false"[^>]*><span aria-hidden="true">☆<\/span> Favourite/);
  assert.equal(JSON.stringify([app.getFood(CORE), app.getCustomFoods()]), foodsBefore, 'nutrition and Food records unchanged; nothing duplicated');
  assert.ok(writes.every((w) => w.length === 1 && w[0] === 'preferences'), 'only preferences are written');
  assert.deepEqual(app.getPreferences().favoriteMeals, [], 'Food favourites are separate from Saved Meal favourites');
});

test('Favourites — persist through the browser data layer (one store) and show up in Log’s Favourite foods right away', async () => {
  const store = createMemorySnapshotStore();
  const { app } = await openBrowserDataLayer({ snapshotStore: store });
  const before = renderResults({ segment: 'foods', meals: null, foods: foodResults(app, ''), future: false });
  assert.ok(!/Favourite foods/.test(before));
  createFoodActions(app).setFavorite(app.getFood(CORE), true);
  const after = renderResults({ segment: 'foods', meals: null, foods: foodResults(app, ''), future: false });
  assert.match(after, /<h3 id="foods-fav" class="group-title">Favourite foods<\/h3>[\s\S]*Fage 0% Greek yogurt[\s\S]*aria-label="Favourite">★/, 'no stale list after starring');
  await app.flushPersistence();
  const { app: reopened } = await openBrowserDataLayer({ snapshotStore: store });
  assert.deepEqual(reopened.getPreferences().favoriteFoods, [CORE], 'kept after a reload');
  createFoodActions(reopened).setFavorite(reopened.getFood(CORE), false);
  await reopened.flushPersistence();
  const { app: third } = await openBrowserDataLayer({ snapshotStore: store });
  assert.deepEqual(third.getPreferences().favoriteFoods, []);
});

/* ---------------- "Don't suggest" (A-32) ---------------- */

test('Don’t suggest — reversible, persisted as a preference; the Food, its search result and Log’s lists are unchanged', () => {
  const { app, writes } = setup();
  app.createDay(TODAY, 'lift');
  app.logFood({ date: TODAY, mealSlot: 'breakfast', foodId: CORE, quantity: 100 });
  app.setFavoriteFood(CORE, true);
  const actions = createFoodActions(app);
  const food = app.getFood(CORE);
  const logLists = () => [renderResults({ segment: 'foods', meals: null, foods: foodResults(app, ''), future: false }), renderResults({ segment: 'foods', meals: null, foods: foodResults(app, 'greek yogurt'), future: false })];
  const listsBefore = logLists();
  writes.length = 0;
  assert.equal(actions.setNotSuggested(food, true), 'Fage 0% Greek yogurt won’t be suggested in Build My Next Meal.');
  assert.deepEqual(app.getPreferences().dislikedFoods, [CORE]);
  assert.deepEqual(writes, [['preferences']], 'a preference, not a deletion');
  assert.deepEqual(app.getFood(CORE), food, 'the Food and its values are unchanged');
  assert.ok(app.searchFoods('greek yogurt').some((h) => h.food.id === CORE), 'explicit search still finds it');
  assert.ok(app.getRecentFoods().some((f) => f.id === CORE));
  assert.deepEqual(logLists(), listsBefore, 'Log’s favourites, recents and search results are exactly as before (A-32)');
  const on = detail(app, CORE);
  assert.match(on, /data-action="fd-suggest" data-sync="fd-suggest" data-on="true">Suggest this food again</);
  assert.match(text(on), /Not suggested in Build My Next Meal\. It still shows in search and your lists\./);
  assert.equal(actions.setNotSuggested(food, false), 'Fage 0% Greek yogurt can be suggested again.');
  assert.deepEqual(app.getPreferences().dislikedFoods, []);
  assert.match(detail(app, CORE), /data-on="false">Don’t suggest this food</);
});

test('Don’t suggest — only the Coach leaves the Food out (top-up Foods and Library starters that use it); personal meals stay', () => {
  const { app } = setup();
  const starter = app.getLibraryMeals().find((m) => m.ingredients.some((i) => i.foodId === CORE));
  assert.ok(starter, 'fixture: a Library meal with the yogurt');
  app.setFavoriteFood(CORE, true);
  const mine = app.createSavedMeal({ name: 'Yogurt cup', mealType: 'snack', ingredients: [{ foodId: CORE, quantity: 170 }] });
  app.setFavoriteMeal(mine.id, true);
  app.createDay(TODAY, 'lift');
  const coach = () => app.getMacroCoachSuggestions({ date: TODAY, mealSlot: 'snack_afternoon' });
  const foodsIn = (s) => [...s.topUpFoods.personalized, ...s.topUpFoods.starter].map((x) => x.food.id);
  const libraryIn = (s) => s.tiers.find((t) => t.tier === 'library').items.map((i) => i.mealId);
  const favIn = (s) => s.tiers.find((t) => t.tier === 'favoriteSaved').items.map((i) => i.mealId);
  assert.ok(foodsIn(coach()).includes(CORE));
  assert.ok(libraryIn(coach()).includes(starter.id));
  createFoodActions(app).setNotSuggested(app.getFood(CORE), true);
  assert.ok(!foodsIn(coach()).includes(CORE), 'not offered as a top-up');
  assert.ok(!libraryIn(coach()).includes(starter.id), 'Library starters using it are left out');
  assert.deepEqual(favIn(coach()), [mine.id], 'the user’s own meals are never filtered by dislikes');
  createFoodActions(app).setNotSuggested(app.getFood(CORE), false);
  assert.ok(foodsIn(coach()).includes(CORE) && libraryIn(coach()).includes(starter.id), 'fully reversible');
});

/* ---------------- editing and deleting a Custom Food (§7.4, §7.6) ---------------- */

test('Custom Food edit — the form in edit mode: banner, Save changes, domain validation of the merged Food, aliases can be cleared', () => {
  const { app } = setup();
  const food = app.getFood(OATS);
  const values = customFoodValues(food);
  assert.deepEqual(values, { name: 'Oats overnight', category: food.category, state: 'prepared', brand: 'Oats Overnight', protein: '10.7', carbs: '66.3', fat: '6.9', aliases: 'oats overnight' });
  const form = { type: 'custom-food', mode: 'edit', foodId: OATS, initial: { ...values }, values: { ...values }, touched: new Set() };
  form.validation = validateCustomFoodForm(app, form);
  assert.equal(form.validation.valid, true);
  assert.deepEqual(form.validation.warnings, [], 'its own name is not a duplicate');
  const html = renderCustomFoodForm(form);
  assert.match(html, /<h2 id="sheet-title" class="sheet-title">Edit food<\/h2>\s*<p class="sheet-subtitle">Oats overnight<\/p>/);
  assert.match(text(html), /Changing these values updates your Saved Meals that use this food\. Meals you’ve already logged won’t change\./, '§7.4 edit banner');
  assert.match(html, /data-action="cf-save" data-sync="cf-save" aria-describedby="cf-save-hint">Save changes</);
  assert.equal(customFoodDirty(form), false);
  form.values.protein = '26.3';
  assert.equal(customFoodDirty(form), true);
  form.values.protein = '-1';
  assert.deepEqual(validateCustomFoodForm(app, form).errors.map((e) => e.code), ['NUTRITION_NEGATIVE'], 'the domain decides');
  form.values.name = 'Oats Overnight Brand';
  form.values.protein = '10.7';
  assert.equal(validateCustomFoodForm(app, form).warnings[0].code, 'DUPLICATE_NAME', 'another Food with that name is a warning');
  assert.deepEqual(customFoodPatch({ ...values, aliases: '' }).aliases, [], 'clearing other names clears them');
  // The create forms keep their own labels: Log (and Meals) → quantity sheet; Settings → detail.
  const blank = { name: '', category: '', state: '', brand: '', protein: '', carbs: '', fat: '', aliases: '' };
  assert.match(renderCustomFoodForm({ values: blank, validation: app.validateCustomFood({}), touched: new Set() }), />Save and enter grams</);
  assert.match(renderCustomFoodForm({ values: blank, validation: app.validateCustomFood({}), touched: new Set(), mode: 'create-settings' }), /disabled>Save</);
  assert.match(text(renderDiscardFood()), /Discard changes\? Your changes to this food haven’t been saved\. Keep editing Discard/);
});

test('History — favourite, don’t suggest, editing and deleting a Custom Food never change a logged meal; Saved Meal repair still works', () => {
  const { app } = setup();
  const meal = withHistory(app);
  const history = historyText(app);
  const pastSummary = JSON.stringify(app.getDaySummary(PAST));
  const actions = createFoodActions(app);
  actions.setFavorite(app.getFood(OATS), true);
  actions.setNotSuggested(app.getFood(OATS), true);
  actions.setFavorite(app.getFood(CORE), true);
  assert.equal(historyText(app), history, 'preferences never touch a Day');
  // Edit: Saved Meals follow the Food (derived), logged meals keep their snapshot (A-13).
  const savedBefore = app.calculateMealMacros(meal.id).totals;
  const values = { ...customFoodValues(app.getFood(OATS)), name: 'Oats overnight (label)', protein: '26.3' };
  actions.updateCustomFood(OATS, customFoodPatch(values));
  assert.equal(app.getFood(OATS).nutrition.protein, 26.3);
  assert.equal(app.getFood(OATS).id, OATS, 'the ID never changes');
  assert.notDeepEqual(app.calculateMealMacros(meal.id).totals, savedBefore, 'the Saved Meal recalculates');
  assert.equal(historyText(app), history, 'logged meals keep their snapshot name and values');
  assert.equal(JSON.stringify(app.getDaySummary(PAST)), pastSummary, 'the past day’s totals are unchanged');
  // Delete: impact list first, then the domain's delete.
  const usage = foodUsageMeals(app, OATS);
  assert.deepEqual(usage, [{ id: meal.id, name: 'Oats bowl' }]);
  const dialog = renderDeleteFood({ food: app.getFood(OATS), meals: usage });
  assert.match(text(dialog), /^ Delete food\? Delete Oats overnight \(label\) \? 1 Saved Meal uses it and will need a replacement before you can log it: Oats bowl \. Meals you’ve already logged aren’t affected\. Cancel Delete food $/);
  assert.match(dialog, /data-action="close" data-autofocus>Cancel</);
  assert.match(dialog, /class="button danger" data-action="fd-delete-confirm">Delete food</);
  const note = actions.deleteCustomFood(app.getFood(OATS));
  assert.deepEqual(note, { message: 'Deleted Oats overnight (label). 1 Saved Meal needs a fix:', links: [{ href: `#/meals?meal=${meal.id}`, label: 'Oats bowl' }] });
  assert.match(renderLinkedMessage(note), /<a href="#\/meals\?meal=meal_saved_[^"]+">Oats bowl<\/a>/);
  assert.match(renderConfirmation(note), /^<p class="log-confirmation">Deleted Oats overnight \(label\)\. 1 Saved Meal needs a fix: <a href=/);
  assert.equal(app.getFood(OATS), null);
  assert.deepEqual(app.getPreferences().favoriteFoods, [CORE], 'the domain retires the deleted ID from favourites');
  assert.deepEqual(app.getPreferences().dislikedFoods, [], '… and from dislikes');
  assert.equal(historyText(app), history, 'history untouched by the delete');
  assert.equal(JSON.stringify(app.getDaySummary(PAST)), pastSummary);
  // The Saved Meal needs a fix (A-18) and the repair path still works.
  assert.equal(app.calculateMealMacros(meal.id).valid, false);
  app.replaceSavedMealIngredient(meal.id, OATS, OATS_BRAND, { quantity: 80 });
  assert.equal(app.calculateMealMacros(meal.id).valid, true, 'Replace fixes it');
  assert.equal(historyText(app), history);
  assert.throws(() => app.updateCustomFood(CORE, { name: 'x' }), (e) => e.code === 'CORE_FOOD_READ_ONLY');
  assert.throws(() => app.deleteCustomFood(CORE), (e) => e.code === 'CORE_FOOD_READ_ONLY');
});

test('Delete — with no Saved Meal using it, the dialog and outcome say only that', () => {
  const { app } = setup();
  const food = app.getFood(OATS_BRAND);
  assert.match(text(renderDeleteFood({ food, meals: foodUsageMeals(app, OATS_BRAND) })), /^ Delete food\? Delete Oats Overnight Brand \? Meals you’ve already logged aren’t affected\. Cancel Delete food $/);
  assert.deepEqual(createFoodActions(app).deleteCustomFood(food), { message: 'Deleted Oats Overnight Brand.', links: [] });
});

/* ---------------- Settings: My foods · Favourites · Foods not suggested (§10.1) ---------------- */

test('Settings — My foods lists Custom Foods (domain order) with New food; an empty list says so', () => {
  const { app } = setup();
  assert.deepEqual([...SETTINGS_VIEW_TYPES], ['target-edit', 'food-detail', 'custom-food']);
  const html = settingsHtml(app);
  const mine = html.slice(html.indexOf('id="my-foods-title"'), html.indexOf('id="favourites-title"'));
  assert.deepEqual([...mine.matchAll(/data-action="food-detail" data-food="([^"]+)"/g)].map((m) => m[1]), app.getCustomFoods().map((f) => f.id), 'getCustomFoods order (A-36)');
  assert.match(mine, /<span class="meal-name">Oats overnight<\/span><span class="state-chip">prepared<\/span><span class="hint">Oats Overnight<\/span><span class="marker">My food<\/span>/, '§7.1 row: name · state · brand · My food');
  assert.match(mine, /P 11 · C 66 · F 7 g per 100 g/);
  assert.match(mine, /data-action="new-food">New food</);
  for (const f of app.getCustomFoods()) app.deleteCustomFood(f.id);
  const empty = settingsHtml(app);
  assert.match(text(empty), /No foods of your own yet\. Create one when something isn’t in search\. New food/, '§13.2 empty state, with its action');
  assert.match(renderSettings({ targets: app.getAllCurrentTargets(), status: null, lastBackupAt: null, restore: null, foods: settingsFoodsModel(app), foodsNote: { message: 'Deleted Oats overnight. 1 Saved Meal needs a fix:', links: [{ href: '#/meals?meal=m1', label: 'Oats bowl' }] } }), /data-foods-message role="status"><p>Deleted Oats overnight\. 1 Saved Meal needs a fix: <a href="#\/meals\?meal=m1">Oats bowl<\/a><\/p>/);
});

test('Settings — Favourites: Saved meals · Library bookmarks · Foods, each removable; Foods not suggested, removable', () => {
  const { app } = setup();
  assert.match(text(settingsHtml(app)), /Favourites Nothing starred yet\./);
  assert.match(text(settingsHtml(app)), /Foods not suggested Left out of Build My Next Meal\. They still show in search and your lists\. None\./);
  const saved = app.createSavedMeal({ name: 'Yogurt cup', mealType: 'snack', ingredients: [{ foodId: CORE, quantity: 170 }] });
  const library = app.getLibraryMeals()[0];
  app.setFavoriteMeal(saved.id, true);
  app.setFavoriteMeal(library.id, true);
  app.setFavoriteFood(CORE, true);
  app.setDislikedFood(OATS_BRAND, true);
  const model = settingsFoodsModel(app);
  assert.deepEqual(model.favorites.saved.map((m) => m.id), [saved.id]);
  assert.deepEqual(model.favorites.library.map((m) => m.id), [library.id], 'A-15: a Library bookmark is its own group');
  assert.deepEqual(model.favorites.foods.map((f) => f.id), [CORE]);
  assert.deepEqual(model.notSuggested.map((f) => f.id), [OATS_BRAND]);
  const html = settingsHtml(app);
  assert.deepEqual([...html.matchAll(/<h3 id="(fav-[a-z]+)" class="group-title">([^<]+)<\/h3>/g)].map((m) => m[2]), ['Saved meals', 'Library bookmarks', 'Foods']);
  assert.match(html, /data-action="unfavorite-meal" data-meal="[^"]+" aria-label="Remove Yogurt cup from favourites">Remove</);
  assert.match(html, new RegExp(`data-action="unfavorite-meal" data-meal="${library.id}"`));
  assert.match(html, /data-action="unfavorite-food" data-food="food_core_fage_0_greek_yogurt" aria-label="Remove Fage 0% Greek yogurt from favourites">Remove</);
  assert.match(html, /data-action="suggest-again" data-food="food_custom_oats_overnight_brand" aria-label="Suggest Oats Overnight Brand again">Suggest again</);
  assert.match(html, /data-list="not-suggested">[\s\S]*data-action="food-detail" data-food="food_custom_oats_overnight_brand"/, 'rows open Food detail');
  // Removing (setFavoriteMeal / setFavoriteFood / setDislikedFood with false) empties the lists.
  app.setFavoriteMeal(saved.id, false);
  app.setFavoriteMeal(library.id, false);
  app.setFavoriteFood(CORE, false);
  app.setDislikedFood(OATS_BRAND, false);
  const after = settingsHtml(app);
  assert.match(text(after), /Favourites Nothing starred yet\./);
  assert.ok(!/data-list="not-suggested"/.test(after));
  assert.ok(app.getMeal(saved.id) && app.getFood(CORE) && app.getFood(OATS_BRAND), 'removing from a list deletes nothing');
});

test('Settings — the existing sections keep their place and content around the food sections', () => {
  const { app } = setup();
  const html = settingsHtml(app);
  const order = ['targets-title', 'my-foods-title', 'favourites-title', 'not-suggested-title', 'data-title', 'about-title'].map((id) => html.indexOf(`id="${id}"`));
  assert.ok(order.every((i, k) => i > 0 && (k === 0 || i > order[k - 1])), 'Targets · My foods · Favourites · Foods not suggested · Data on this device · About');
  assert.match(html, /data-action="backup">Download backup</);
  assert.match(html, /data-action="restore">Restore from backup</);
  assert.match(html, /data-action="edit-targets" data-type="lift"/);
  assert.match(html, /<dt>Protected from automatic clean-up<\/dt><dd><span data-storage-protection>Not granted<\/span><\/dd>/, 'G13: shown, never claiming protection it doesn’t have');
});

/* ---------------- boundaries ---------------- */

test('Foods — no macro arithmetic, no forbidden terms, no second store, domain via its entry point, no re-ranking', () => {
  const src = fs.readFileSync(path.join(ROOT, 'app/foods.js'), 'utf8');
  assert.deepEqual(macroArithmeticInSource(src, 'app/foods.js'), []);
  assert.ok(!FORBIDDEN_NUTRITION.test(src));
  assert.deepEqual(domainImportsBypassingIndex(src), []);
  assert.deepEqual([...src.matchAll(/from '([^']+)'/g)].map((m) => m[1]).sort(), ['../src/domain/index.js', './shell.js', './today.js', './view-host.js']);
  assert.ok(!/localStorage|sessionStorage|indexedDB|\bfetch\(|import\(/.test(src), 'no second persistence mechanism');
  assert.ok(!/\.sort\(|score\s*[<>]|getMacroCoachSuggestions/.test(src), 'no ranking of its own');
  assert.ok(!/\byield|\bunit\s*:/.test(src), 'no conversion');
  const settings = fs.readFileSync(path.join(ROOT, 'app/settings.js'), 'utf8');
  for (const call of ['setFavoriteMeal(', 'setFavoriteFood(', 'setDislikedFood(', 'getCustomFoods(']) assert.ok(settings.includes(call) || src.includes(call), call);
  assert.ok(!/\.sort\(/.test(settings), 'Settings lists keep the domain order');
});
