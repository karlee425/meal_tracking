/*
 * log.test.mjs — V2 UI Slice 3: the Log screen (V2_UI_CONTRACT.md §5, §6.4–6.5, §7.4).
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
import { createShell, escapeHtml } from '../app/shell.js';
import { renderDayTypeDialog, macroLine, formatDate } from '../app/today.js';
import { session, resetSession, routeParams, isIsoDate } from '../app/session.js';
import {
  resolveLogContext, logModel, mealResults, foodResults, renderResults, renderLogTop, renderConfirmation,
  renderMealDetail, renderLogMealSheet, renderFoodSheet, renderTraySheet, renderTrayBar, renderDateSheet,
  renderCustomFoodForm, customFoodInput, parseAmount, trayMealName, trayIngredients, createLogActions,
  afterLogging, returnToToday, logSegment, logScreen, presentationFor, widthClass, LOG_VIEW_TYPES, LOG_WIDE_QUERY, LOG_COMPACT_QUERY
} from '../app/log.js';

const TODAY = '2026-09-27';
const PAST = '2026-09-20';
const FUTURE = '2026-09-30';
const SEED = createFileAdapter(ROOT).load();

function setup() {
  resetSession();
  const inner = createMemoryAdapter(SEED);
  const writes = [];
  const adapter = { load: () => inner.load(), save: (c, d) => inner.save(c, d), saveMany: (ch) => { writes.push(Object.keys(ch)); inner.saveMany(ch); } };
  let t = Date.parse(`${TODAY}T12:00:00Z`);
  let n = 0;
  const app = createDataLayer({ adapter, today: () => TODAY, clock: () => new Date((t += 60000)), newId: () => `l${String(++n).padStart(4, '0')}` });
  return { app, writes, actions: createLogActions(app) };
}
const text = (html) => html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ');
const ids = (html, action, attr) => [...html.matchAll(new RegExp(`data-action="${action}" data-${attr}="([^"]+)"`, 'g'))].map((m) => m[1]);
const savedYogurt = (app, name = 'Yogurt bowl') => app.createSavedMeal({ name, mealType: 'snack', ingredients: [{ foodId: 'food_core_fage_0_greek_yogurt', quantity: 150 }, { foodId: 'food_core_blueberries_frozen', quantity: 75 }] });
const fromToday = (date, slot) => `#/log?from=today&date=${date}${slot ? `&slot=${slot}` : ''}`;

/* 1 ---------------- shell ---------------- */

test('Log — renders through the existing shell and navigation', () => {
  const mounted = [];
  const main = { id: 'main' };
  const root = { innerHTML: '', querySelector: (sel) => (sel === '#main' ? main : sel === '#screen-title' ? { focus: () => mounted.push('heading-focus') } : null) };
  const listeners = {};
  const win = { location: { hash: '#/log' }, history: { replaceState() {} }, addEventListener: (t, f) => { (listeners[t] ||= []).push(f); }, setTimeout: () => 0, clearTimeout() {} };
  const doc = { title: '', addEventListener() {} };
  const screen = { mount: (el) => { mounted.push(el.id); return false; }, unmount: () => mounted.push('unmount') };
  const shell = createShell({ root, win, doc, screens: { log: screen } });
  shell.start();
  shell.setDataLayer({ getPersistenceStatus: () => ({ state: 'saved', lastSavedAt: null }), onPersistenceChange: () => () => {}, flushPersistence() {} });
  assert.deepEqual(mounted, ['main'], 'Log mounts into <main>');
  assert.match(root.innerHTML, /data-destination="log" aria-current="page"/, 'Log is the current tab');
  assert.equal(doc.title, 'Log · Macro Tracker');

  // A screen that places focus itself (Today highlighting a logged row) keeps it.
  const focusing = { mount: () => true, unmount() {} };
  const shell2 = createShell({ root, win: { ...win, location: { hash: '#/today' } }, doc, screens: { today: focusing } });
  mounted.length = 0;
  shell2.start();
  shell2.setDataLayer({ getPersistenceStatus: () => ({ state: 'saved' }), onPersistenceChange: () => () => {}, flushPersistence() {} });
  assert.ok(!mounted.includes('heading-focus'));

  const mainSrc = fs.readFileSync(path.join(ROOT, 'app/main.js'), 'utf8');
  assert.match(mainSrc, /screens: \{ today: todayScreen, log: logScreen, meals: mealsScreen \}/);
  assert.equal(typeof logScreen.mount, 'function');
});

/* 2–3 ---------------- context ---------------- */

test('Log — launched from Today keeps that date and slot; the Log tab uses the date last viewed on Today', () => {
  const { app } = setup();
  assert.deepEqual(resolveLogContext(app, fromToday(PAST, 'snack_night')), { origin: 'today', date: PAST, slot: 'snack_night', launchDate: PAST });
  assert.deepEqual(resolveLogContext(app, fromToday(TODAY)), { origin: 'today', date: TODAY, slot: null, launchDate: TODAY }, 'Add (no slot) leaves the slot to choose');
  assert.equal(resolveLogContext(app, fromToday(TODAY, 'second_breakfast')).slot, null, 'only the five approved slots');
  assert.equal(resolveLogContext(app, '#/log?from=today&date=2026-02-30').date, TODAY, 'invalid dates fall back to today');

  assert.deepEqual(resolveLogContext(app, '#/log', { todayDate: null }), { origin: 'log', date: TODAY, slot: null, launchDate: TODAY });
  assert.equal(resolveLogContext(app, '#/log', { todayDate: PAST }).date, PAST, 'the date last viewed on Today');
  assert.equal(resolveLogContext(app, '#/log', { todayDate: PAST }).slot, null);

  // Segment: Meals by default, then whatever was last used this session (§5.3).
  assert.equal(logSegment({ segment: null }), 'meals');
  assert.equal(logSegment({ segment: 'foods' }), 'foods');
  session.log.segment = 'foods';
  assert.equal(logSegment(session.log), 'foods', 'remembered in the session');
  const html = renderLogTop(logModel(app, resolveLogContext(app, '#/log')), { segment: 'foods', query: '' });
  assert.match(html, /data-segment="foods" aria-pressed="true"/);
  assert.match(html, /placeholder="Search foods"/);

  assert.equal(routeParams('#/log?from=today&slot=lunch').get('slot'), 'lunch');
  assert.ok(isIsoDate('2026-09-27') && !isIsoDate('2026-13-01') && !isIsoDate(null));
});

test('Log — the context bar shows date · day type · slot, each tappable', () => {
  const { app } = setup();
  app.createDay(TODAY, 'lift');
  let html = renderLogTop(logModel(app, resolveLogContext(app, fromToday(TODAY, 'lunch'))), { segment: 'meals', query: '' });
  assert.match(html, new RegExp(`data-action="ctx-date"[^>]*>Today · ${formatDate(TODAY)}</button>`));
  assert.match(html, /data-action="ctx-day-type"[^>]*>Lift<\/button>/);
  assert.match(html, /data-action="ctx-slot"[^>]*>Lunch<\/button>/);
  assert.match(html, /data-action="back"/, 'a back control when launched from Today');
  html = renderLogTop(logModel(app, resolveLogContext(app, '#/log', { todayDate: PAST })), { segment: 'meals', query: '' });
  assert.match(html, /data-action="ctx-day-type"[^>]*>Choose day type<\/button>/, 'no Day yet');
  assert.match(html, /data-action="ctx-slot"[^>]*>Choose slot<\/button>/);
  assert.ok(!/data-action="back"/.test(html), 'the tab has no back control');
});

/* 4 ---------------- today, past, future ---------------- */

test('Log — today and past dates can be logged; a future date cannot', () => {
  const { app, actions, writes } = setup();
  const past = logModel(app, { origin: 'log', date: PAST, slot: null, launchDate: PAST });
  assert.equal(past.future, false);
  assert.match(renderDateSheet({ model: past, value: PAST }), new RegExp(`type="date" data-date max="${TODAY}"`), 'the date picker stops at today');

  const future = logModel(app, { origin: 'log', date: FUTURE, slot: 'lunch', launchDate: FUTURE });
  assert.equal(future.future, true);
  const top = renderLogTop(future, { segment: 'meals', query: '' });
  assert.match(top, /You can log this day when it arrives\./);
  assert.match(top, /data-action="ctx-day-type"[^>]*disabled/);
  const list = renderResults({ segment: 'meals', meals: mealResults(app, ''), foods: null, future: true });
  assert.ok(ids(list, 'log-meal-start', 'meal').length > 0);
  assert.ok(!/data-action="log-meal-start"(?![^>]*disabled)/.test(list), 'every Log button is disabled');
  const preview = app.previewMealInstance({ date: FUTURE, mealId: 'meal_library_B1' });
  assert.match(renderLogMealSheet({ model: future, preview, slot: 'lunch', adjusting: false, quantities: [], foods: {} }), /data-action="log-meal" disabled/);
  const food = app.getFood('food_core_banana');
  assert.match(renderFoodSheet({ model: future, food, text: '100', preview: app.previewLogFood({ date: FUTURE, foodId: food.id, quantity: 100 }), slot: 'lunch' }), /data-action="log-food" disabled/);
  assert.equal(writes.length, 0, 'nothing written');

  const r = actions.logFood({ date: PAST, mealSlot: 'dinner', foodId: 'food_core_banana', quantity: 100, dayType: 'rest' });
  assert.equal(app.getDay(PAST).mealInstances[0].id, r.instance.id, 'a past date logs normally');
});

/* 5 ---------------- no Day yet ---------------- */

test('Log — a date with no Day needs its day type before the first log; the Day and the log are created together', () => {
  const { app, actions, writes } = setup();
  const model = logModel(app, { origin: 'log', date: PAST, slot: 'lunch', launchDate: PAST });
  assert.equal(model.summary.exists, false);
  const preview = app.previewMealInstance({ date: PAST, mealId: 'meal_library_L26' });
  assert.equal(preview.dayTypeRequired, true);
  const sheet = renderLogMealSheet({ model, preview, slot: 'lunch', adjusting: false, quantities: [], foods: {} });
  assert.match(text(sheet), /What’s left after this shows once you choose the day type\./);
  assert.ok(!/After this:/.test(sheet));

  assert.throws(() => actions.logMeal({ date: PAST, mealSlot: 'lunch', mealId: 'meal_library_L26' }), (e) => e.code === 'DAY_TYPE_REQUIRED');
  assert.equal(writes.length, 0);
  const chooser = renderDayTypeDialog({ model, selected: null, continueTo: { kind: 'meal' } });
  assert.match(chooser, /What kind of day is Sunday\?/);
  assert.match(chooser, /Choose a day type first, then add your meal\./);
  assert.ok(!/checked/.test(chooser), 'no day type preselected');

  const r = actions.logMeal({ date: PAST, mealSlot: 'lunch', mealId: 'meal_library_L26', dayType: 'long_run' });
  assert.equal(writes.length, 1, 'one write: the Day and its first logged meal together');
  assert.equal(app.getDay(PAST).dayType, 'long_run');
  assert.deepEqual(app.getDay(PAST).targetSnapshot, app.getCurrentTargets('long_run'));
  assert.equal(r.instance.mealSlot, 'lunch');
});

/* 6 ---------------- day type ---------------- */

test('Log — changing the day type uses the same domain flow as Today', () => {
  const { app, actions, writes } = setup();
  assert.equal(actions.chooseDayType(PAST, 'lift').message, `${formatDate(PAST)} is a Lift day.`);
  actions.logFood({ date: PAST, mealSlot: 'lunch', foodId: 'food_core_banana', quantity: 100 });
  const lift = app.getDay(PAST).targetSnapshot;
  const n = writes.length;
  assert.deepEqual(actions.changeDayType(PAST, 'lift'), { noOp: true, message: '' });
  assert.equal(writes.length, n, 'same type: no write');
  const model = logModel(app, { origin: 'log', date: PAST, slot: null, launchDate: PAST });
  const dialog = renderDayTypeDialog({ model: { ...model, isToday: false }, selected: 'rest', preview: app.previewDayTypeChange(PAST, 'rest') });
  assert.match(dialog, /Logged food stays exactly the same\./);
  actions.changeDayType(PAST, 'rest');
  actions.changeDayType(PAST, 'lift');
  assert.deepEqual(app.getDay(PAST).targetSnapshot, lift, 'switching back restores');
  assert.equal(app.getDay(PAST).mealInstances.length, 1, 'food intact');
});

/* 7 ---------------- search ---------------- */

test('Log — Meal and Food search show the domain results in the domain order', () => {
  const { app } = setup();
  savedYogurt(app, 'Chicken yogurt bowl');
  const meals = mealResults(app, 'chicken');
  assert.deepEqual(meals.saved.map((x) => x.meal.id), app.searchMeals('chicken', { source: 'saved' }).map((h) => h.meal.id));
  assert.deepEqual(meals.library.map((x) => x.meal.id), app.searchMeals('chicken', { source: 'library' }).map((h) => h.meal.id));
  const mhtml = renderResults({ segment: 'meals', meals, foods: null, future: false });
  const rendered = ids(mhtml, 'meal-detail', 'meal').filter((id, i, a) => a.indexOf(id) === i);
  assert.deepEqual(rendered, [...meals.saved, ...meals.library].map((x) => x.meal.id), 'Saved matches, then Library matches, unchanged');

  const foods = foodResults(app, 'rice');
  assert.deepEqual(foods.hits.map((h) => h.food.id), app.searchFoods('rice').map((h) => h.food.id));
  const fhtml = renderResults({ segment: 'foods', meals: null, foods, future: false });
  assert.deepEqual(ids(fhtml, 'food', 'food'), app.searchFoods('rice').map((h) => h.food.id), 'no UI re-ranking');
  assert.match(fhtml, /Create a food named “rice”/, 'last row');
  for (const h of foods.hits) assert.ok(fhtml.includes(`<span class="state-chip">${h.food.state}</span>`), 'state always shown');
  assert.ok(fhtml.includes(`${macroLine(foods.hits[0].food.nutrition)} per 100 g`));

  const none = renderResults({ segment: 'foods', meals: null, foods: foodResults(app, 'zzqx'), future: false });
  assert.match(text(none), /No foods match “zzqx”\. Create a food named “zzqx”/);
  assert.match(text(renderResults({ segment: 'meals', meals: mealResults(app, 'zzqx'), foods: null, future: false })), /No meals match “zzqx”\./);
  const alias = foodResults(app, 'greek yoghurt');
  if (alias.hits.some((h) => h.matchedOn === 'alias')) assert.match(renderResults({ segment: 'foods', meals: null, foods: alias, future: false }), /matched: /);
});

/* 8 ---------------- browse order ---------------- */

test('Log — empty Meals query: Favourite Saved → Recently logged → Saved → Library; Library favourites stay in Library', () => {
  const { app, actions } = setup();
  let browse = mealResults(app, '');
  assert.equal(browse.libraryOpen, true, 'no Saved Meals: Library expanded');
  let html = renderResults({ segment: 'meals', meals: browse, foods: null, future: false });
  assert.match(html, /<details class="option-group" data-library open>/);
  assert.match(html, /No saved meals yet\. Start with a meal from the Library\./);
  assert.match(text(renderResults({ segment: 'foods', meals: null, foods: foodResults(app, ''), future: false })), /Search for a food\. Things you log will show up here\./, 'first run');

  const a = savedYogurt(app, 'A bowl');
  const b = savedYogurt(app, 'B bowl');
  app.setFavoriteMeal(b.id, true);
  app.setFavoriteMeal('meal_library_B1', true);
  actions.logMeal({ date: TODAY, mealSlot: 'breakfast', mealId: 'meal_library_L26', dayType: 'lift' });
  actions.logMeal({ date: TODAY, mealSlot: 'lunch', mealId: a.id });
  browse = mealResults(app, '');
  assert.deepEqual(browse.favorites.map((x) => x.meal.id), [b.id], 'Saved favourites only (A-15)');
  assert.deepEqual(browse.recent.map((x) => x.meal.id), app.getRecentMeals().map((m) => m.id));
  assert.ok(browse.recent.some((x) => x.meal.source === 'library'), 'Recently logged includes Library meals (§5.3)');
  assert.equal(browse.libraryOpen, false);
  html = renderResults({ segment: 'meals', meals: browse, foods: null, future: false });
  const headings = [...html.matchAll(/<h3 id="([a-z-]+)"/g)].map((m) => m[1]);
  assert.deepEqual(headings, ['meals-fav', 'meals-recent', 'meals-saved']);
  assert.ok(html.indexOf('meals-saved') < html.indexOf('data-library'), 'Library last');
  const library = html.slice(html.indexOf('data-library'));
  assert.match(library, /meal_library_B1[\s\S]*?aria-label="Favourite">★/, 'the favourited Library Meal is starred inside Library');
  assert.ok(!html.slice(0, html.indexOf('meals-recent')).includes('meal_library_B1'), 'and not under favourites');
  assert.deepEqual(ids(library, 'meal-detail', 'meal').filter((id, i, arr) => arr.indexOf(id) === i), app.getLibraryMeals().map((m) => m.id), 'Library in shipped order, retired hidden');

  const foods = foodResults(app, '');
  app.setFavoriteFood('food_core_banana', true);
  const foods2 = foodResults(app, '');
  assert.deepEqual(foods2.favorites.map((f) => f.id), ['food_core_banana']);
  assert.deepEqual(foods.recent.map((f) => f.id), app.getRecentFoods().map((f) => f.id));
  const fh = renderResults({ segment: 'foods', meals: null, foods: foods2, future: false });
  assert.ok(fh.indexOf('Favourite foods') < fh.indexOf('Recent foods'));
});

/* 9 ---------------- invalid Saved Meal ---------------- */

test('Log — an invalid Saved Meal shows Fix, opens its detail, and cannot be logged', () => {
  const { app, actions } = setup();
  const food = app.createCustomFood({ name: 'Test bar', category: 'snack bar', state: 'prepared', nutrition: { protein: 20, carbs: 40, fat: 10 } });
  const meal = app.createSavedMeal({ name: 'Bar snack', mealType: 'snack', ingredients: [{ foodId: food.id, quantity: 50 }, { foodId: 'food_core_banana', quantity: 100 }] });
  app.deleteCustomFood(food.id);
  const browse = mealResults(app, '');
  const row = browse.saved.find((x) => x.meal.id === meal.id);
  assert.equal(row.calc.valid, false);
  const html = renderResults({ segment: 'meals', meals: browse, foods: null, future: false });
  const rowHtml = html.slice(html.indexOf(`data-meal="${meal.id}"`), html.indexOf('</li>', html.indexOf(`data-meal="${meal.id}"`)));
  assert.match(rowHtml, /Needs a fix/);
  assert.match(rowHtml, /aria-label="Fix Bar snack">Fix</);
  assert.ok(!/log-meal-start/.test(rowHtml), 'no Log button');
  const detail = renderMealDetail({ meal: app.getMeal(meal.id), calc: app.calculateMealMacros(meal.id), foods: {}, isFavorite: false, model: logModel(app, resolveLogContext(app, '#/log')) });
  assert.match(text(detail), /Bar snack can’t be logged right now\. Test bar was deleted, so this meal needs a replacement\. Meals you’ve already logged aren’t affected\./);
  assert.match(detail, /<th scope="row">Deleted food: Test bar<\/th><td>50 g<\/td>/, 'the missing row keeps its name and grams');
  assert.match(text(detail), /Totals will show once every ingredient is fixed\./);
  assert.match(detail, /<button type="button" class="button primary" disabled aria-describedby="detail-why">Log this meal<\/button>/);
  assert.throws(() => actions.logMeal({ date: TODAY, mealSlot: 'snack_afternoon', mealId: meal.id, dayType: 'lift' }), (e) => e.code === 'MEAL_NEEDS_REPLACEMENT');
  assert.equal(app.getDay(TODAY), null, 'nothing created');
});

test('Log — Meal detail is read-only: totals, ingredients with state, how to make it; no legacy fields', () => {
  const { app } = setup();
  const meal = app.getMeal('meal_library_B1');
  const calc = app.calculateMealMacros(meal.id);
  const foods = Object.fromEntries(calc.ingredients.map((i) => [i.foodId, app.getFood(i.foodId)]));
  const html = renderMealDetail({ meal, calc, foods, isFavorite: true, model: logModel(app, resolveLogContext(app, '#/log')) });
  assert.ok(html.includes(macroLine(calc.totals)));
  assert.match(html, /Calculated from the ingredients below/);
  for (const ing of calc.ingredients) assert.ok(html.includes(`<span class="state-chip">${foods[ing.foodId].state}</span>`));
  assert.match(html, /How to make it/);
  assert.match(html, /★ Favourite/);
  for (const legacy of ['weightDescription', 'base']) assert.ok(!html.includes(escapeHtml(meal.metadata[legacy])), `${legacy} is not shown (I-29)`);
  assert.ok(!/nativeDayType|legacyId|batchSize|\blane\b/.test(html));
  assert.ok(!/data-action="(edit|duplicate|delete|save-copy)/.test(html), 'editing belongs to the Meals slice');
});

/* 10 ---------------- previews ---------------- */

test('Log — Food grams and adjusted Meal grams preview through the domain', () => {
  const { app } = setup();
  app.createDay(TODAY, 'lift');
  const model = logModel(app, resolveLogContext(app, fromToday(TODAY, 'lunch')));
  const food = app.getFood('food_core_banana');
  const preview = app.previewLogFood({ date: TODAY, foodId: food.id, quantity: 120 });
  const sheet = renderFoodSheet({ model, food, text: '120', preview, slot: 'lunch' });
  assert.ok(sheet.includes(macroLine(preview.totals)), 'this amount from previewLogFood');
  assert.match(sheet, /After this:/);
  assert.match(text(sheet), new RegExp(`${food.state} Weigh it ${food.state}\\.`), 'state chip and reminder; never converted');
  assert.match(sheet, /placeholder="grams"/);
  assert.match(sheet, /value=""|value="120"/);
  assert.match(renderFoodSheet({ model, food, text: '', preview: null, slot: null }), /id="qty-grams"[^>]*value=""/, 'empty by default');
  assert.match(renderFoodSheet({ model, food, text: '', preview: null, slot: null }), /data-action="log-food" disabled/);
  assert.match(renderFoodSheet({ model, food, text: '', preview: null, slot: null }), /data-action="add-to-tray" disabled/);

  const base = app.previewMealInstance({ date: TODAY, mealId: 'meal_library_B1' });
  const adjusted = app.previewMealInstance({ date: TODAY, mealId: 'meal_library_B1', ingredients: base.ingredients.map((i, k) => ({ foodId: i.foodId, unit: 'g', quantity: k === 0 ? 100 : i.quantity })) });
  const msheet = renderLogMealSheet({ model, preview: adjusted, slot: 'lunch', adjusting: true, quantities: adjusted.ingredients.map((i) => String(i.quantity)), foods: {} });
  assert.ok(msheet.includes(macroLine(adjusted.totals)));
  assert.match(msheet, /Grams for this time/);
  const noSlot = renderLogMealSheet({ model, preview: base, slot: null, adjusting: false, quantities: [], foods: {} });
  assert.ok(!/name="log-slot"[^>]*checked/.test(noSlot), 'no slot preselected when none was preset');
  assert.match(noSlot, /data-slot-error hidden>Choose a slot/);
  assert.equal(app.getMeal('meal_library_B1').ingredients[0].quantity, SEED.libraryMeals.find((m) => m.id === 'meal_library_B1').ingredients[0].quantity, 'the Library Meal is unchanged');
});

/* 11 ---------------- tray ---------------- */

test('Log — meal builder tray: add, remove, preview, name, log as one meal, optionally save', () => {
  const { app, actions } = setup();
  assert.equal(trayMealName([]), '');
  assert.equal(trayMealName(['Banana']), 'Banana');
  assert.equal(trayMealName(['Banana', 'Oats', 'Milk']), 'Banana + 2 more');
  const tray = [{ foodId: 'food_core_banana', text: '100' }, { foodId: 'food_core_fage_0_greek_yogurt', text: '150' }];
  assert.equal(trayIngredients([{ foodId: 'x', text: '0' }]), null);
  const ingredients = trayIngredients(tray);
  assert.deepEqual(ingredients, [{ foodId: 'food_core_banana', quantity: 100, unit: 'g' }, { foodId: 'food_core_fage_0_greek_yogurt', quantity: 150, unit: 'g' }]);
  const preview = app.previewMealInstance({ ingredients, mealName: 'x' });
  assert.match(renderTrayBar(tray, preview), new RegExp(`2 foods</span><span class="tray-totals">${macroLine(preview.totals).replace(/[·]/g, '.')}`));
  assert.equal(renderTrayBar([], null), '', 'no tray bar when empty');
  const model = logModel(app, resolveLogContext(app, '#/log'));
  const rows = tray.map((r) => ({ ...r, food: app.getFood(r.foodId) }));
  const sheet = renderTraySheet({ model, rows, preview: app.previewMealInstance({ date: TODAY, ingredients, mealName: 'x' }), name: 'Banana + 1 more', slot: null, alsoSave: false });
  assert.match(sheet, /value="Banana \+ 1 more"/);
  assert.equal((sheet.match(/data-action="tray-remove"/g) || []).length, 2);
  assert.match(sheet, /Also save as a Saved Meal/);

  const savedBefore = app.getSavedMeals().length;
  const r1 = actions.logTray({ date: TODAY, mealSlot: 'snack_afternoon', ingredients, mealName: 'Banana + 1 more', dayType: 'rest' });
  assert.equal(r1.instance.sourceMealId, null);
  assert.deepEqual(r1.instance.totals, preview.totals, 'logged totals are the previewed totals');
  assert.equal(app.getSavedMeals().length, savedBefore, 'no Saved Meal unless asked');
  const r2 = actions.logTray({ date: TODAY, mealSlot: 'dinner', ingredients, mealName: 'Yogurt and banana', alsoSave: true });
  assert.equal(r2.savedMeal.name, 'Yogurt and banana');
  assert.deepEqual(app.getMeal(r2.savedMeal.id).ingredients.map((i) => [i.foodId, i.quantity]), ingredients.map((i) => [i.foodId, i.quantity]));
  assert.match(r2.message, /^Logged Yogurt and banana to Dinner\. Saved “Yogurt and banana” as a saved meal\.$/);

  const src = fs.readFileSync(path.join(ROOT, 'app/session.js'), 'utf8');
  assert.ok(!/localStorage|sessionStorage|indexedDB|\bfetch\(/i.test(src), 'the tray is memory only: gone after a restart');
});

/* 12–14 ---------------- after logging, leaving ---------------- */

test('Log — from Today: back to Today on that date, highlight the row, announce what’s left', () => {
  const { app, actions } = setup();
  const ctx = resolveLogContext(app, fromToday(TODAY, 'lunch'));
  const result = actions.logMeal({ date: TODAY, mealSlot: 'lunch', mealId: 'meal_library_L26', dayType: 'lift' });
  const out = afterLogging(app, ctx, result);
  assert.equal(out.to, 'today');
  assert.equal(out.handoff.date, TODAY);
  assert.equal(out.handoff.highlightId, result.instance.id);
  assert.match(out.handoff.message, /^Logged .+ to Lunch\. Left today: P .+ · C .+ · F .+\.$/);
  const s = app.getDaySummary(TODAY);
  assert.ok(out.handoff.message.includes(s.reached.carbs ? 'C target reached' : `C ${macroLine(s.remaining).split(' · ')[1].replace(/^C /, '').replace(/ g$/, '')} g`));
  assert.deepEqual(returnToToday({ launchedFromToday: true }, ctx, TODAY), { method: 'back' }, 'one step back, no extra history');
  assert.deepEqual(returnToToday({ launchedFromToday: false }, ctx, TODAY), { method: 'replace', href: `#/today?date=${TODAY}` }, 'deep link: replace Log');
  assert.deepEqual(returnToToday({ launchedFromToday: true }, ctx, PAST), { method: 'replace', href: `#/today?date=${PAST}` }, 'date changed in Log: that date on Today');
  const past = afterLogging(app, { ...ctx, date: PAST }, actions.logFood({ date: PAST, mealSlot: 'dinner', foodId: 'food_core_banana', quantity: 100, dayType: 'rest' }));
  assert.match(past.handoff.message, new RegExp(`Left on ${formatDate(PAST)}: `));
});

test('Log — from the Log tab: stay, context unchanged, "Logged {name} to {Slot}" with View on Today and Edit', () => {
  const { app, actions } = setup();
  const ctx = resolveLogContext(app, '#/log');
  const result = actions.logFood({ date: TODAY, mealSlot: 'snack_night', foodId: 'food_core_banana', quantity: 100, dayType: 'rest' });
  const out = afterLogging(app, ctx, result);
  assert.equal(out.to, 'log');
  assert.deepEqual(out.confirmation, { message: 'Logged Banana to Night Snack.', instanceId: result.instance.id, date: TODAY });
  const html = renderConfirmation(out.confirmation);
  assert.match(html, /Logged Banana to Night Snack\. <button[^>]*data-action="view-today">View on Today<\/button> <button[^>]*data-action="edit-on-today">Edit<\/button>/);
  assert.deepEqual(ctx, resolveLogContext(app, '#/log'), 'context unchanged');
  const src = fs.readFileSync(path.join(ROOT, 'app/log.js'), 'utf8');
  assert.match(src, /showOnToday\(\{ openInstanceId: confirmation\.instanceId \}\)/, 'Edit opens the logged meal on Today');
  assert.ok(!/updateMealInstance|deleteMealInstance/.test(src), 'Log never edits logged meals (§5.7)');
});

test('Log — browsing, searching, previewing and leaving write nothing', () => {
  const { app, writes } = setup();
  app.createDay(TODAY, 'lift');
  const n = writes.length;
  const ctx = resolveLogContext(app, fromToday(TODAY, 'lunch'));
  const model = logModel(app, ctx);
  renderLogTop(model, { segment: 'meals', query: '' });
  for (const q of ['', 'chicken', 'zzqx']) { renderResults({ segment: 'meals', meals: mealResults(app, q), foods: null, future: false }); renderResults({ segment: 'foods', meals: null, foods: foodResults(app, q), future: false }); }
  app.previewMealInstance({ date: TODAY, mealId: 'meal_library_B1' });
  app.previewLogFood({ date: TODAY, foodId: 'food_core_banana', quantity: 50 });
  app.previewMealInstance({ date: PAST, ingredients: [{ foodId: 'food_core_banana', quantity: 50 }], mealName: 'x' });
  app.validateCustomFood(customFoodInput({ name: 'x', category: 'y', state: 'raw', protein: '1', carbs: '2', fat: '3' }));
  assert.deepEqual(returnToToday({ launchedFromToday: true }, ctx, ctx.launchDate), { method: 'back' });
  assert.equal(writes.length, n, 'no writes');
  assert.equal(app.getDay(PAST), null, 'no Day created by a preview');
});

/* Custom Food (§5.6, §7.4) */

test('Log — Create a food: domain validation per field, duplicate warning, then straight to grams', () => {
  const { app, actions } = setup();
  assert.equal(parseAmount(''), undefined);
  assert.equal(parseAmount(' 12,5 '), 12.5);
  assert.equal(parseAmount('0'), 0);
  assert.equal(parseAmount('abc'), 'abc');
  const blank = { name: 'Protein bar', category: '', state: '', brand: '', protein: '', carbs: '', fat: '', aliases: '' };
  let validation = app.validateCustomFood(customFoodInput(blank));
  assert.equal(validation.valid, false);
  let form = renderCustomFoodForm({ values: blank, validation, touched: new Set() });
  assert.match(form, /id="cf-name"[^>]*value="Protein bar"/, 'name prefilled from the query');
  assert.match(form, /data-action="cf-save" data-sync="cf-save" aria-describedby="cf-save-hint" disabled>/, 'Save is really disabled while invalid (§7.4)');
  assert.ok(!/aria-disabled/.test(form), 'not merely aria-disabled');
  assert.match(form, /id="cf-save-hint" class="hint" data-sync="cf-save-hint">Needed before saving: category, state, protein, carbs, fat\.</, 'what is still needed is visible without pressing Save');
  assert.ok(!/class="field-error" data-sync="cf-category-error">/.test(form), 'no field errors before a field is edited');
  form = renderCustomFoodForm({ values: blank, validation, touched: new Set(['category', 'state', 'protein', 'carbs', 'fat']) });
  assert.match(form, /Add a category, for example snack bar\./, 'errors show next to fields as they are edited');
  assert.match(form, /Choose a state\./);
  assert.equal((form.match(/>Required\.</g) || []).length, 3, 'empty macro fields read "Required", never NaN');

  const tooMuch = { ...blank, category: 'snack bar', state: 'prepared', protein: '60', carbs: '50', fat: '10' };
  validation = app.validateCustomFood(customFoodInput(tooMuch));
  form = renderCustomFoodForm({ values: tooMuch, validation, touched: new Set(['protein', 'carbs', 'fat']) });
  assert.match(form, /data-sync="cf-save" aria-describedby="cf-save-hint" disabled>/);
  assert.match(form, /Needed before saving: protein \+ carbs \+ fat\./);
  assert.match(form, /Protein \+ carbs \+ fat can’t be more than 100 g in 100 g\. Check the label — values per serving need converting to per 100 g\./);

  const dup = { ...tooMuch, name: 'Banana', protein: '1', carbs: '23', fat: '0.3' };
  validation = app.validateCustomFood(customFoodInput(dup));
  assert.equal(validation.valid, true);
  form = renderCustomFoodForm({ values: dup, validation, touched: new Set(['name']) });
  assert.match(form, /You already have a food called Banana\./, 'a warning, not an error');
  assert.match(form, /data-sync="cf-save" aria-describedby="cf-save-hint">Save and enter grams/, 'Save enabled once valid, duplicate name or not');
  assert.match(form, /id="cf-save-hint" class="hint" data-sync="cf-save-hint" hidden>/);

  const food = actions.createCustomFood({ ...tooMuch, protein: '20', carbs: '45', fat: '12,5', aliases: 'bar, snack' });
  assert.equal(food.source, 'custom');
  assert.equal(food.nutrition.fat, 12.5);
  assert.deepEqual(food.aliases, ['bar', 'snack']);
  const model = logModel(app, resolveLogContext(app, '#/log'));
  assert.match(renderFoodSheet({ model, food, text: '', preview: null, slot: null }), /<span class="state-chip">prepared<\/span>/);
  assert.ok(app.searchFoods('protein bar').some((h) => h.food.id === food.id));
});

/* 15 ---------------- history ---------------- */

test('Log — logged meals are snapshots: later Food and Saved Meal edits never change them', () => {
  const { app, actions } = setup();
  const food = actions.createCustomFood({ name: 'Granola X', category: 'cereal', state: 'dry', protein: '10', carbs: '60', fat: '15' });
  const meal = app.createSavedMeal({ name: 'Granola bowl', mealType: 'breakfast', ingredients: [{ foodId: food.id, quantity: 50 }] });
  const a = actions.logMeal({ date: TODAY, mealSlot: 'breakfast', mealId: meal.id, dayType: 'lift' }).instance;
  const b = actions.logFood({ date: TODAY, mealSlot: 'snack_afternoon', foodId: food.id, quantity: 30 }).instance;
  const c = actions.logTray({ date: TODAY, mealSlot: 'dinner', ingredients: [{ foodId: food.id, quantity: 20, unit: 'g' }], mealName: 'Tray' }).instance;
  const before = JSON.stringify(app.getDay(TODAY).mealInstances);
  app.updateCustomFood(food.id, { nutrition: { protein: 99, carbs: 0, fat: 0 } });
  app.updateSavedMeal(meal.id, { name: 'Renamed', ingredients: [{ foodId: 'food_core_banana', quantity: 100 }] });
  app.deleteCustomFood(food.id);
  assert.equal(JSON.stringify(app.getDay(TODAY).mealInstances), before, 'history unchanged');
  assert.deepEqual([a, b, c].map((x) => x.mealName), ['Granola bowl', 'Granola X', 'Tray']);
});

test('Log — adjusted grams on a Saved Meal leave the Saved Meal alone; a Library Meal never becomes Saved', () => {
  const { app, actions } = setup();
  const meal = savedYogurt(app);
  const r = actions.logMeal({ date: TODAY, mealSlot: 'snack_night', mealId: meal.id, ingredients: [{ foodId: 'food_core_fage_0_greek_yogurt', quantity: 200, unit: 'g' }, { foodId: 'food_core_blueberries_frozen', quantity: 75, unit: 'g' }], dayType: 'rest' });
  assert.equal(r.instance.ingredients[0].quantity, 200);
  assert.equal(app.getMeal(meal.id).ingredients[0].quantity, 150, 'Saved Meal unchanged');
  const before = app.getSavedMeals().length;
  actions.logMeal({ date: TODAY, mealSlot: 'lunch', mealId: 'meal_library_L26' });
  assert.equal(app.getSavedMeals().length, before);
});

/* 16 ---------------- architecture ---------------- */

test('Log — no macro arithmetic, no forbidden terms, no second store, domain via its entry point', () => {
  for (const f of ['app/log.js', 'app/session.js', 'app/view-host.js', 'app/app.css']) {
    const src = fs.readFileSync(path.join(ROOT, f), 'utf8');
    assert.deepEqual(macroArithmeticInSource(src, f), [], f);
    assert.ok(!FORBIDDEN_NUTRITION.test(src), f);
    assert.deepEqual(domainImportsBypassingIndex(src), [], f);
  }
  const src = fs.readFileSync(path.join(ROOT, 'app/log.js'), 'utf8');
  assert.deepEqual([...src.matchAll(/from '([^']+)'/g)].map((m) => m[1]).sort(), ['../src/domain/index.js', './session.js', './shell.js', './today.js', './view-host.js']);
  assert.ok(!/localStorage|sessionStorage|indexedDB|\bfetch\(|import\(/.test(src), 'no second persistence mechanism');
  assert.ok(!/\.sort\(|getMacroCoachSuggestions|score\s*[<>]/.test(src), 'no re-ranking; the Coach is not used here');
  assert.ok(!/\bunit\s*:\s*'(?!g')/.test(src), 'grams only');
  assert.ok(!/\byield/i.test(src), 'no yield factors (§7.7)');
});

/* ---------------- reconciliation of 4696ba5: responsive presentation, pushed Log, real disabled Save ---------------- */

test('Log — detail and editing views are pushed full screen (compact), a side panel (medium), a right-hand pane (wide)', () => {
  // em queries, evaluated with a text size (px per em): 16 is the default, 32 is 200 % text.
  const mm = (w, em = 16) => ({ matchMedia: (q) => ({ matches: q === LOG_WIDE_QUERY ? w / em >= 64 : q === LOG_COMPACT_QUERY ? w / em <= 37.49 : false }) });
  assert.deepEqual([320, 375, 599, 600, 800, 1023, 1024, 1280].map((w) => widthClass(mm(w))), ['compact', 'compact', 'compact', 'medium', 'medium', 'medium', 'wide', 'wide']);
  assert.equal(widthClass(mm(1280, 32)), 'medium', '200 % text: no room for two panes, so a side panel');
  assert.equal(widthClass(mm(375, 32)), 'compact');
  assert.deepEqual([...LOG_VIEW_TYPES], ['meal-detail', 'meal', 'food', 'tray', 'custom-food'], 'Meal detail, the confirm/adjust and quantity views, the tray and the Custom Food form');
  for (const type of LOG_VIEW_TYPES) {
    assert.equal(presentationFor(type, 'compact'), 'pushed', `${type}: full screen on phones, not a bottom sheet`);
    assert.equal(presentationFor(type, 'medium'), 'panel', `${type}: side panel`);
    assert.equal(presentationFor(type, 'wide'), 'pane', `${type}: two panes`);
  }
  for (const type of ['day-type', 'date', 'slot', 'followup']) {
    assert.equal(presentationFor(type, 'compact'), 'sheet', `${type}: a short choice stays a sheet`);
    assert.equal(presentationFor(type, 'wide'), 'pane', `${type}: anchored beside the results on wide screens`);
  }

  // Every view has a Back control (shown when pushed) and a Close control (shown otherwise).
  const { app } = setup();
  const model = logModel(app, resolveLogContext(app, '#/log'));
  const food = app.getFood('food_core_banana');
  const meal = app.getMeal('meal_library_B1');
  const views = [
    renderMealDetail({ meal, calc: app.calculateMealMacros(meal.id), foods: {}, isFavorite: false, model }),
    renderLogMealSheet({ model, preview: app.previewMealInstance({ date: TODAY, mealId: meal.id }), slot: null, adjusting: false, quantities: [], foods: {} }),
    renderFoodSheet({ model, food, text: '', preview: null, slot: null }),
    renderTraySheet({ model, rows: [{ foodId: food.id, text: '100', food }], preview: null, name: 'Banana', slot: null, alsoSave: false }),
    renderCustomFoodForm({ values: { name: '' }, validation: app.validateCustomFood({}), touched: new Set() })
  ];
  for (const html of views) {
    assert.match(html, /<button type="button" class="link-button view-back" data-action="close">[\s\S]*Back<\/button>/);
    assert.match(html, /class="icon-button view-close" data-action="close" aria-label="Close"/);
  }

  const css = fs.readFileSync(path.join(ROOT, 'app/app.css'), 'utf8');
  const block = (media) => { const i = css.indexOf(media, css.indexOf('Log detail and editing views by width')); return css.slice(i, css.indexOf('\n}\n', i)); };
  assert.equal(LOG_WIDE_QUERY, '(min-width: 64em)');
  assert.equal(LOG_COMPACT_QUERY, '(max-width: 37.49em)');
  assert.match(block('@media (max-width: 37.49em)'), /\.sheet\[data-present="pushed"\] \{[^}]*width: 100vw;[^}]*height: 100dvh;[^}]*border-radius: 0;/, 'compact: full screen');
  assert.match(block('@media (min-width: 37.5em) and (max-width: 63.99em)'), /\.sheet\[data-present="panel"\] \{[^}]*height: 100dvh;[^}]*margin: 0 0 0 auto;/, 'medium: side panel');
  const wide = block('@media (min-width: 64em)');
  assert.match(wide, /\.view-page\.has-view \{[^}]*grid-template-columns: minmax\(0, 1fr\) minmax\(20rem, 26rem\);/, 'wide: results left, detail right');
  assert.match(wide, /\.sheet\[data-present="pane"\] \{[^}]*position: sticky;[^}]*grid-column: 2;/);
  assert.match(css, /\.sheet\[data-present="pushed"\] \.view-close \{ display: none; \}/);
  assert.match(css, /\.view-back \{ display: none; \}/);

  const src = fs.readFileSync(path.join(ROOT, 'app/view-host.js'), 'utf8'); // shared with Meals
  assert.match(fs.readFileSync(path.join(ROOT, 'app/log.js'), 'utf8'), /createViewHost\(\{[\s\S]*?viewTypes: LOG_VIEW_TYPES/, 'Log presents through the shared view host');
  assert.match(src, /if \(modal\) dialog\.showModal\(\);\s*else \{ page\.classList\.add\('has-view'\); dialog\.show\(\); \}/, 'wide pane is non-modal, beside the list');
  assert.match(src, /if \(present === 'pushed' && !viewEntry\) \{ win\.history\.pushState/, 'a pushed view has its own history entry');
});

test('Log — opened from Today on a phone, Log is a pushed destination: no tab bar underneath; the Log tab is unchanged', () => {
  const css = fs.readFileSync(path.join(ROOT, 'app/app.css'), 'utf8');
  const i = css.indexOf('Log opened from Today is a pushed destination');
  const media = css.lastIndexOf('@media', i);
  assert.ok(css.slice(media, i).startsWith('@media (max-width: 599px)'), 'compact only');
  assert.match(css.slice(i, i + 400), /\.app-frame:has\(\.log-screen\[data-origin="today"\]\) \.primary-nav \{ display: none; \}/);
  assert.ok(!/data-origin="log"\]\) \.primary-nav/.test(css), 'the Log tab keeps the tab bar');
  const src = fs.readFileSync(path.join(ROOT, 'app/log.js'), 'utf8');
  assert.match(src, /data-log-body data-origin="\$\{ctx\.origin\}"/);
  const shell = fs.readFileSync(path.join(ROOT, 'app/shell.js'), 'utf8');
  assert.ok(!/data-origin|log-screen/.test(shell), 'the shell and its navigation structure are unchanged');
});

test('Log — Back and browser history: leaving from a pushed view unwinds its history entry too', () => {
  assert.match(fs.readFileSync(path.join(ROOT, 'app/log.js'), 'utf8'), /host\.leave\(nav\);/, 'Log leaves through the view host');
  const src = fs.readFileSync(path.join(ROOT, 'app/view-host.js'), 'utf8');
  assert.match(src, /if \(nav\.method === 'back'\) win\.history\.go\(hadViewEntry \? -2 : -1\);/, 'back to Today past the view entry and Log');
  assert.match(src, /else if \(hadViewEntry\) \{ replaceAfterPop = nav\.href; win\.history\.back\(\); \}/, 'otherwise drop the view entry, then replace Log');
  assert.match(src, /if \(viewEntry\) \{[\s\S]*?viewEntry = false;\s*closeDialog\(\);\s*\}/, 'browser Back closes a pushed view');
  assert.match(src, /win\.removeEventListener\('popstate', onPop\)/, 'the listener goes with the screen');
  const { app } = setup();
  const ctx = resolveLogContext(app, fromToday(TODAY, 'lunch'));
  assert.deepEqual(returnToToday({ launchedFromToday: true }, ctx, TODAY), { method: 'back' });
  assert.deepEqual(returnToToday({ launchedFromToday: false }, ctx, TODAY), { method: 'replace', href: `#/today?date=${TODAY}` });
});
