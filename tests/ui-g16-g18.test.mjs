/*
 * ui-g16-g18.test.mjs — the last contract-audit gaps (V2_UI_CONTRACT.md §2.1, §5.5, §7.3, §7.5, §13.2).
 *   G16  Food detail from the Food picker: the one Food detail, information-only (A-42, A-46)
 *   G17  a Custom Food deleted while it's in the Log tray: "No longer available", Remove (A-43)
 *   G18  Log's results follow the current Foods after a deletion (§13.2, I-10)
 * Node has no DOM: renderers are tested as HTML, flows through the domain and the screens'
 * source; the real-browser flows at 320 / 375 / 800 / 1280 and 200% text were checked
 * separately (see the slice report).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, macroArithmeticInSource, FORBIDDEN_NUTRITION, domainImportsBypassingIndex } from './helpers.mjs';
import { createDataLayer, createMemoryAdapter } from '../src/domain/index.js';
import { createFileAdapter } from '../src/node/file-adapter.js';
import { renderFoodDetail, foodDetailModel, createFoodActions } from '../app/foods.js';
import {
  pickerResults, renderPicker, renderResults, foodResults, trayView, trayUnavailableReason, trayIngredients, trayMealName,
  renderTrayBar, renderTraySheet, renderLogTop, logModel, resolveLogContext, createLogActions
} from '../app/log.js';
import { MEALS_VIEW_TYPES } from '../app/meals.js';
import { resetSession } from '../app/session.js';

const TODAY = '2026-09-27';
const SEED = createFileAdapter(ROOT).load();
const CORE = 'food_core_banana';
const CUSTOM = 'food_custom_oats_overnight';
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const text = (html) => html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
const actionsOf = (html) => [...html.matchAll(/data-action="([^"]+)"/g)].map((m) => m[1]);

function setup() {
  resetSession();
  const inner = createMemoryAdapter(SEED);
  let t = Date.parse(`${TODAY}T12:00:00Z`);
  let n = 0;
  const app = createDataLayer({ adapter: inner, today: () => TODAY, clock: () => new Date((t += 60000)), newId: () => `g${String(++n).padStart(4, '0')}` });
  return { app, actions: createLogActions(app), foodActions: createFoodActions(app) };
}
const bar = (app) => app.createCustomFood({ name: 'Zzq bar', category: 'snack bar', state: 'prepared', nutrition: { protein: 20, carbs: 40, fat: 10 } });
const bites = (app) => app.createCustomFood({ name: 'Zzq bites', category: 'snack', state: 'prepared', nutrition: { protein: 10, carbs: 50, fat: 20 } });
const history = (app) => JSON.stringify(app.exportUserData().data.days);

/* ======================= G16 — Food detail from the Food picker ======================= */

test('G16 — every Food row in the picker has a Details action beside the row that chooses it; Log’s own list does not', () => {
  const { app } = setup();
  const picker = pickerResults(app, 'banana');
  assert.match(picker, new RegExp(`data-action="food" data-food="${CORE}" aria-label="Banana, raw: choose"`), 'the row still chooses the Food');
  assert.match(picker, new RegExp(`<button type="button" class="button" data-action="picker-food-detail" data-food="${CORE}" aria-label="Food details: Banana, raw">Details</button>`));
  const browse = pickerResults(app, ''); // favourites / recents in the picker get it too
  assert.equal((browse.match(/data-action="food"/g) || []).length, (browse.match(/data-action="picker-food-detail"/g) || []).length);
  const log = renderResults({ segment: 'foods', meals: null, foods: foodResults(app, 'banana'), future: false });
  assert.ok(!/picker-food-detail/.test(log), 'Log’s rows open the quantity sheet, whose Food details action is unchanged (I-58)');
  assert.match(log, /aria-label="Banana, raw: enter grams"/);
  assert.match(renderPicker({ title: 'Add an ingredient', query: 'banana', results: picker }), /id="pick-query"[^>]*value="banana"/);
});

test('G16 — from the picker, Food detail is information-only for Core and Custom Foods (A-46)', () => {
  const { app } = setup();
  for (const id of [CORE, CUSTOM]) {
    const food = app.getFood(id);
    const html = renderFoodDetail({ ...foodDetailModel(app, id), context: 'picker' });
    assert.match(html, new RegExp(`<h2 id="sheet-title" class="sheet-title">${food.name}</h2>`));
    assert.match(text(html), new RegExp(`State ${food.state} Category ${food.category}`));
    assert.match(html, /<caption class="group-title">Per 100 g<\/caption>/);
    assert.match(text(html), new RegExp(`Source ${food.source === 'custom' ? 'My food' : 'App food'}`));
    assert.deepEqual([...new Set(actionsOf(html))], ['close'], `${id}: Back / Close only`);
    for (const word of ['Log this food', 'Add to a meal', 'Favourite', 'Don’t suggest', 'Edit', 'Delete', 'Select', 'Choose']) {
      assert.ok(!text(html).replace('can’t be edited', '').includes(word), `${id}: no "${word}"`);
    }
  }
  assert.match(renderFoodDetail({ ...foodDetailModel(app, CORE), context: 'picker' }), /App food · can’t be edited/, 'Core Foods stay read-only');
});

test('G16 — the other contexts keep their approved actions (§7.3 table)', () => {
  const { app } = setup();
  const acts = (id, context) => new Set(actionsOf(renderFoodDetail({ ...foodDetailModel(app, id), context })));
  const log = acts(CUSTOM, 'log');
  for (const a of ['fd-log', 'fd-add', 'fd-favorite', 'fd-suggest', 'fd-edit', 'fd-delete']) assert.ok(log.has(a), `log: ${a}`);
  for (const context of ['coach', 'settings']) {
    const a = acts(CUSTOM, context);
    for (const x of ['fd-favorite', 'fd-suggest', 'fd-edit', 'fd-delete']) assert.ok(a.has(x), `${context}: ${x}`);
    assert.ok(!a.has('fd-log') && !a.has('fd-add'), `${context}: no Log / Add`);
  }
  const core = acts(CORE, 'log');
  assert.ok(!core.has('fd-edit') && !core.has('fd-delete'), 'Core Foods never get Edit / Delete');
});

test('G16 — Meals and Today open the one Food detail from the shared picker and step back to it', () => {
  assert.ok(MEALS_VIEW_TYPES.includes('food-detail'), 'a view, presented like the picker it came from');
  const meals = read('app/meals.js');
  assert.match(meals, /import \{ foodDetailModel, renderFoodDetail, renderDiscardFood \} from '\.\/foods\.js';/);
  assert.match(meals, /case 'food-detail': dialog\.innerHTML = renderFoodDetail\(\{ \.\.\.ui, context: 'picker' \}\); break;/);
  assert.match(meals, /case 'picker-food-detail': openPickerFoodDetail\(el\.dataset\.food, ui\); break;/);
  assert.match(meals, /show\(\{ type: 'food-detail', \.\.\.detail, pickUi \}/, 'the picker object itself (search, mode, row) rides along');
  assert.match(meals, /case 'food-detail': backToPicker\(ui\); return false;/, 'Back / Close / Escape return to the picker');
  assert.match(meals, /function backToPicker\(detailUi\) \{\n\s*show\(detailUi\.pickUi\);/);
  assert.ok(!/renderResults|foodResults/.test(meals), 'Meals uses the shared picker results, not its own');
  const openDetail = meals.slice(meals.indexOf('function openPickerFoodDetail'), meals.indexOf('function backToPicker'));
  assert.ok(!/draft\s*=|app\.(create|update|delete|set)/.test(openDetail), 'the Saved Meal draft is untouched');
  const today = read('app/today.js');
  assert.match(today, /renderFoodDetail\(\{ \.\.\.ui, context: ui\.pickUi \? 'picker' : 'coach' \}\)/);
  assert.match(today, /if \(ui\.type === 'food-detail' && ui\.pickUi\) \{ backToPicker\(ui\); return false; \}/);
  for (const f of ['app/meals.js', 'app/today.js', 'app/log.js', 'app/settings.js']) assert.ok(!/function renderFoodDetail/.test(read(f)), `${f}: no second Food detail`);
});

/* ======================= G17 — a deleted Custom Food in the tray ======================= */

test('G17 — the tray row stays, named as it was added, "No longer available", with Remove; the rest is kept', () => {
  const { app, foodActions } = setup();
  const a = bar(app);
  const b = bites(app);
  const tray = [{ foodId: a.id, foodName: 'Zzq bar', text: '50' }, { foodId: CORE, foodName: 'Banana', text: '100' }, { foodId: b.id, foodName: 'Zzq bites', text: '30' }];
  assert.equal(trayView(app, tray).unavailable.length, 0);
  foodActions.deleteCustomFood(a);
  const view = trayView(app, tray);
  assert.deepEqual(view.rows.map((r) => [r.name, r.unavailable]), [['Zzq bar', true], ['Banana', false], ['Zzq bites', false]], 'only that row, the others intact');
  assert.equal(view.unavailable.length, 1);
  assert.equal(tray.length, 3, 'never silently dropped');
  assert.equal(trayView(app, [{ foodId: 'food_custom_gone', text: '1' }]).rows[0].name, 'A deleted food', 'no remembered name: still never the ID');
  assert.equal(trayMealName(view.rows.map((r) => r.name)), 'Zzq bar + 2 more', 'the prefilled name uses names, not IDs');

  const model = logModel(app, resolveLogContext(app, '#/log'));
  const sheet = renderTraySheet({ model, rows: view.rows, preview: null, name: 'Zzq bar + 2 more', slot: 'lunch', alsoSave: false });
  assert.ok(!sheet.includes(a.id), 'the internal ID appears nowhere');
  assert.match(sheet, /<div class="adjust-row tray-unavailable" data-unavailable>\n<span class="tray-food"><span class="meal-name">Zzq bar<\/span> <span class="marker">No longer available<\/span><\/span>\n<button type="button" class="button" data-action="tray-remove" data-index="0" aria-label="Remove Zzq bar, no longer available">Remove<\/button><\/div>/);
  assert.ok(!/id="tray-q-0"/.test(sheet), 'no grams field for it');
  assert.match(sheet, /id="tray-q-1"[^>]*value="100"/);
  assert.match(sheet, /id="tray-q-2"[^>]*value="30"/);
  assert.match(sheet, /<p id="tray-why" class="note" data-tray-why>Zzq bar is no longer available\. Remove it to log this meal\.<\/p>/, 'the reason is shown');
  assert.match(sheet, /data-action="tray-log" disabled aria-describedby="tray-why">Log as one meal</);
  assert.match(sheet, /<div class="preview" data-preview aria-live="polite" hidden><\/div>/, 'no totals as if still valid');
  assert.match(renderTrayBar(tray, null, { unavailable: 1 }), /<span class="tray-count">3 foods<\/span><span class="tray-totals">1 no longer available<\/span>/);
  assert.equal(trayUnavailableReason([{ name: 'A' }, { name: 'B' }]), '2 foods are no longer available. Remove them to log this meal.');
});

test('G17 — after Remove the rest logs normally; history, Saved Meals and the deleted Food stay as they are', () => {
  const { app, actions, foodActions } = setup();
  const a = bar(app);
  const b = bites(app);
  app.createDay(TODAY, 'lift');
  const earlier = app.logFood({ date: TODAY, mealSlot: 'breakfast', foodId: a.id, quantity: 40 });
  const earlierId = (earlier.instance || earlier).id;
  const saved = app.createSavedMeal({ name: 'Bar snack', mealType: 'snack', ingredients: [{ foodId: a.id, quantity: 50 }] });
  const tray = [{ foodId: a.id, foodName: 'Zzq bar', text: '50' }, { foodId: CORE, foodName: 'Banana', text: '100' }, { foodId: b.id, foodName: 'Zzq bites', text: '30' }];
  foodActions.deleteCustomFood(a);
  const historyBefore = history(app);
  const savedBefore = JSON.stringify(app.getMeal(saved.id));
  assert.throws(() => actions.logTray({ date: TODAY, mealSlot: 'lunch', ingredients: trayIngredients(tray), mealName: 'x' }), (e) => e.code === 'MEAL_NEEDS_REPLACEMENT', 'the domain refuses it too');
  assert.equal(history(app), historyBefore, 'a refused log writes nothing');
  tray.splice(trayView(app, tray).rows.findIndex((r) => r.unavailable), 1); // Remove
  const view = trayView(app, tray);
  assert.equal(view.unavailable.length, 0);
  const model = logModel(app, resolveLogContext(app, '#/log'));
  const ingredients = trayIngredients(tray);
  const preview = app.previewMealInstance({ date: TODAY, ingredients, mealName: 'Banana + 1 more' });
  assert.match(renderTraySheet({ model, rows: view.rows, preview, name: 'Banana + 1 more', slot: 'lunch', alsoSave: false }), /data-action="tray-log">Log as one meal</, 'available again');
  const r = actions.logTray({ date: TODAY, mealSlot: 'lunch', ingredients, mealName: 'Banana + 1 more' });
  assert.deepEqual(r.instance.ingredients.map((i) => i.foodName), ['Banana', 'Zzq bites']);
  const logged = app.getDay(TODAY).mealInstances.find((mi) => mi.id === earlierId);
  assert.deepEqual(logged, JSON.parse(historyBefore).find((d) => d.date === TODAY).mealInstances.find((mi) => mi.id === earlierId), 'the earlier logged meal keeps its snapshot');
  assert.equal(logged.mealName, 'Zzq bar');
  assert.equal(JSON.stringify(app.getMeal(saved.id)), savedBefore, 'the Saved Meal is not changed by the tray');
  assert.equal(app.getFood(a.id), null, 'the deleted Food is not brought back');
});

test('G17 — Log wiring: names captured when added, logging blocked while unavailable, the bar follows deletions; memory only', () => {
  const src = read('app/log.js');
  assert.match(src, /state\.tray\.push\(\{ foodId: ui\.food\.id, foodName: ui\.food\.name, text: String\(q\) \}\);/);
  assert.match(src, /case 'tray-log': \{\n\s*\/\/ A-43[^\n]*\n\s*if \(trayRows\(\)\.some\(\(r\) => r\.unavailable\)\) \{ refreshTraySheet\(\);/);
  assert.match(src, /if \(trayRows\(\)\.some\(\(r\) => r\.unavailable\)\) return null; \/\/ no totals while a Food is gone/);
  assert.match(src, /confirmation = foodActions\.deleteCustomFood\(ui\.food\);\n\s*renderList\(\);[^\n]*\n\s*renderTray\(\);/);
  assert.ok(!/localStorage|sessionStorage|indexedDB/.test(src), 'the tray stays in session memory');
});

/* ======================= G18 — Log results after a deletion ======================= */

test('G18 — results are read from the current Foods each time: the deleted Food is gone, the query and the rest stay', () => {
  const { app, foodActions } = setup();
  const a = bar(app);
  const b = bites(app);
  const before = renderResults({ segment: 'foods', meals: null, foods: foodResults(app, 'Zzq'), future: false });
  assert.ok(before.includes(`data-food="${a.id}"`) && before.includes(`data-food="${b.id}"`));
  const historyBefore = history(app);
  foodActions.deleteCustomFood(a);
  const after = renderResults({ segment: 'foods', meals: null, foods: foodResults(app, 'Zzq'), future: false });
  assert.ok(!after.includes(a.id), 'nothing left to select for it');
  assert.ok(after.includes(`data-food="${b.id}"`), 'other matching Custom Foods stay');
  assert.match(renderResults({ segment: 'foods', meals: null, foods: foodResults(app, 'banana'), future: false }), new RegExp(`data-food="${CORE}"`), 'Core Foods unaffected');
  const model = logModel(app, resolveLogContext(app, '#/log'));
  assert.match(renderLogTop(model, { segment: 'foods', query: 'Zzq' }), /id="log-query"[^>]*value="Zzq"/, 'the search text is kept');
  assert.equal(history(app), historyBefore, 'deleting a Food never touches history');
});

test('G18 — Log re-renders after a deletion and on FOOD_NOT_FOUND ("That food no longer exists."), with no cache of its own', () => {
  const src = read('app/log.js');
  const gone = src.slice(src.indexOf('function foodGone()'), src.indexOf('function refreshTraySheet()'));
  assert.match(gone, /renderList\(\);\n\s*renderTray\(\);\n\s*confirmation = \{ message: 'That food no longer exists\.' \};/);
  assert.match(src, /if \(!food\) \{ foodGone\(\); return; \}/, 'a row whose Food is gone');
  assert.match(src, /if \(!detail\) \{ foodGone\(\); return; \}/, 'Food details for a Food that is gone');
  assert.match(src, /if \(e && \(e\.code === 'FOOD_NOT_FOUND' \|\| \(e\.code === 'MEAL_NEEDS_REPLACEMENT' && ui && ui\.type === 'tray'\)\) && foodSurface\(\)\) foodGone\(\);/, 'logging a Food (or a tray) whose Food is gone');
  assert.ok(!/new Map\(|cache/i.test(src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')), 'no second index or cache');
  assert.match(src, /foods: state\.segment === 'foods' \? foodResults\(app, state\.query\) : null/, 'results come from the domain search with the kept query');
});

/* ======================= architecture ======================= */

test('G16–G18 — no macro arithmetic, no forbidden terms, domain only through its entry point, no second store', () => {
  for (const f of ['app/foods.js', 'app/log.js', 'app/meals.js', 'app/today.js', 'app/app.css']) {
    const src = read(f);
    assert.deepEqual(macroArithmeticInSource(src, f), [], f);
    assert.ok(!FORBIDDEN_NUTRITION.test(src), f);
    assert.deepEqual(domainImportsBypassingIndex(src), [], f);
  }
});
