/*
 * serving-screens.test.mjs — V3 Slice 1 · C7, Stage 3: Food detail serving management wired
 * into Log and Settings. Node has no DOM, so — as for A-42 / A-48 and C6 — the screens'
 * wiring is checked through their source, and every observable outcome (what is stored, what
 * Food detail shows, what the quantity sheet comes back to) is checked through the domain and
 * the shared renderers the screens call. The Coach (app/today.js) and the Food picker
 * (app/meals.js) stay read-only.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, macroArithmeticInSource, FORBIDDEN_NUTRITION, domainImportsBypassingIndex } from './helpers.mjs';
import { createDataLayer, createMemoryAdapter } from '../src/domain/index.js';
import { createFileAdapter } from '../src/node/file-adapter.js';
import { foodDetailModel, renderFoodDetail, renderDeleteServing, renderDeleteFood, servingFormValues, createFoodActions, foodUsageMeals } from '../app/foods.js';
import { renderServingForm, servingPatch, servingInput, servingFormDirty, emptyServingValues, restoreAmount, resolveDraft } from '../app/amount.js';
import { settingsFoodsModel, SETTINGS_VIEW_TYPES } from '../app/settings.js';
import { LOG_VIEW_TYPES } from '../app/log.js';

const TODAY = '2026-09-27';
const SEED = createFileAdapter(ROOT).load();
const CORE = 'food_core_fage_0_greek_yogurt';
const OATS = 'food_custom_oats_overnight';
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const SRC = { log: read('app/log.js'), settings: read('app/settings.js') };
/** A function's body (up to its closing brace at the screen's indent). */
const fn = (src, name) => { const i = src.indexOf(name); assert.ok(i >= 0, name); return src.slice(i, src.indexOf('\n    }\n', i)); };
/** One click-handler case (up to the next case). */
const caseBody = (src, label) => { const i = src.indexOf(`case '${label}':`); assert.ok(i >= 0, label); const j = src.indexOf('\n          case ', i + 10); return src.slice(i, j < 0 ? undefined : j); };
const text = (html) => html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();

function setup({ failWrites = () => false } = {}) {
  let t = Date.parse(`${TODAY}T12:00:00Z`);
  let n = 0;
  const writes = [];
  const inner = createMemoryAdapter(SEED);
  const adapter = { load: () => inner.load(), save: (c, d) => inner.save(c, d), saveMany: (ch) => { if (failWrites(ch)) throw new Error('disk full'); writes.push(Object.keys(ch).sort()); inner.saveMany(ch); } };
  const app = createDataLayer({ adapter, today: () => TODAY, clock: () => new Date((t += 60000)), newUuid: () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}` });
  return { app, writes, actions: createFoodActions(app) };
}
const ufd = (app) => app.exportUserData().data.userFoodData;

/* ---------------- wiring: the same in Log and Settings ---------------- */

for (const screen of ['log', 'settings']) {
  const src = SRC[screen];
  test(`${screen}: every serving control is wired, by the ID it names, to the right domain operation`, () => {
    assert.match(src, /const currentServing = \(foodId, servingId\) => app\.getServings\(foodId\)\.find\(\(s\) => s\.id === servingId\) \|\| null;/, 'a serving is looked up by its exact ID, as stored now');
    for (const label of ['fd-serving-edit', 'fd-serving-default', 'fd-serving-delete']) {
      const body = caseBody(src, label);
      assert.match(body, /const serving = currentServing\(ui\.food\.id, el\.dataset\.serving\);\n\s*if \(!serving\) \{ servingGone\(ui\.food\.id[^)]*\); break; \}/, `${label}: a serving that's gone changes nothing`);
    }
    assert.match(caseBody(src, 'fd-serving-add'), /openDetailServingForm\('add'\)/);
    assert.match(caseBody(src, 'fd-serving-edit'), /openDetailServingForm\('edit', serving\)/);
    assert.match(caseBody(src, 'fd-serving-default'), /foodActions\.makeDefaultServing\(ui\.food, serving\)|makeDefaultServing\(serving\)/);
    assert.match(caseBody(src, 'fd-serving-delete'), /type: 'serving-delete', food: ui\.food, serving, servings: app\.getServings\(ui\.food\.id\)/, 'Delete asks first, naming that serving');
    assert.match(caseBody(src, 'fd-serving-delete-confirm'), /deleteServingConfirmed\(\)/);
    assert.match(fn(src, 'function deleteServingConfirmed('), /foodActions\.deleteServing\(food, serving\)/, 'deletes the serving the dialog named');
    const save = fn(src, 'function saveServingFromDetail(');
    assert.match(save, /form\.mode === 'edit'\n\s*\? foodActions\.updateServing\(form\.food, form\.servingId, servingPatch\(form\.values, form\.initial\)\)\n\s*: foodActions\.addServing\(form\.food, servingInput\(form\.values\)\);/);
    const open = fn(src, 'function openDetailServingForm(');
    assert.match(open, /const values = serving \? servingFormValues\(serving\) : emptyServingValues\(\);/, 'Edit opens with the stored values, Add blank');
    assert.match(open, /initial: \{ \.\.\.values \}/);
    assert.match(src, /case 'serving-form': dialog\.innerHTML = renderServingForm\(ui\); break;/);
    assert.match(src, /case 'serving-delete': dialog\.innerHTML = renderDeleteServing\(ui\); break;/);
    assert.match(caseBody(src, 'fd-delete'), /servingCount: app\.getServings\(ui\.food\.id\)\.length/, 'the food delete dialog says its servings go too');
  });

  test(`${screen}: success is announced only after the domain call returns; failures and stale IDs never read as success`, () => {
    const save = fn(src, 'function saveServingFromDetail(');
    assert.ok(save.indexOf('backToDetail(') > save.lastIndexOf('}\n'), 'the success path comes after the try/catch');
    assert.match(save, /if \(!e \|\| e\.code !== 'INVALID_SERVING'\) throw e;/, 'anything but a field problem goes to the screen’s error path');
    assert.match(save, /backToDetail\(form\.food\.id, (?:form\.quantity, )?`\[data-action="fd-serving-edit"\]\[data-serving="\$\{result\.serving\.id\}"\]`, result\.message\);/, 'back to Food detail, focus on the saved row, then the message');
    const del = fn(src, 'function deleteServingConfirmed(');
    assert.ok(del.indexOf('foodActions.deleteServing') < del.indexOf('backToDetail('), 'announced after the delete succeeded');
    assert.match(src, /if \(e && e\.code === 'SERVING_NOT_FOUND' && ui && \['food-detail', 'serving-form', 'serving-delete'\]\.includes\(ui\.type\)\) \{ servingGone\(ui\.food\.id[^)]*\); return; \}/, 'a serving deleted elsewhere: Food detail as it is now');
    assert.match(src, /'That serving no longer exists\.'/);
  });

  test(`${screen}: Cancel / Escape / Back and the leave guard — nothing saved, unsaved changes ask first`, () => {
    const leave = fn(src, 'function beforeLeave()');
    assert.match(leave, /ui\.type === 'serving-form'/);
    assert.match(leave, /servingFormDirty\(ui\)/, 'a changed form asks "Discard changes?"');
    assert.match(leave, /if \(ui\.type === 'serving-delete'\) \{ backToDetail\(ui\.food\.id, [^`]*`\[data-action="fd-serving-delete"\]\[data-serving="\$\{ui\.serving\.id\}"\]`\); return false; \}/, 'Cancel on Delete: back to Food detail, focus on that Delete');
    const deleteBranch = leave.slice(leave.indexOf("ui.type === 'serving-delete'"), leave.indexOf('\n', leave.indexOf("ui.type === 'serving-delete'")));
    assert.ok(!/foodActions|app\.(create|update|delete|set)/.test(deleteBranch), 'cancelling a delete changes nothing');
    assert.match(fn(src, 'function guardLeave('), /ui\.type === 'serving-form' && servingFormDirty\(ui\)/, 'leaving the screen with a changed form asks first');
    const discard = screen === 'log' ? fn(src, 'function discardChanges()') : src.slice(src.indexOf("case 'discard':\n"), src.indexOf("case 'food-detail': foodOrigin"));
    assert.match(discard, /form\.type === 'serving-form'/);
    assert.ok(!/foodActions\.|app\.(create|update|delete|set)/.test(discard), 'Discard saves nothing');
    assert.match(src, /editedServing: [^\n]*mode === 'edit'/, '"Your changes to this serving haven’t been saved." for an edit');
  });
}

test('Log: the quantity-sheet draft rides through Food detail, the serving form and the delete dialog, and back (A-42, C6)', () => {
  const src = SRC.log;
  assert.match(fn(src, 'function openDetailServingForm('), /quantity: ui\.quantity \};/, 'the form keeps the sheet Food detail came from');
  assert.match(caseBody(src, 'fd-serving-delete'), /quantity: ui\.quantity \};/);
  assert.match(fn(src, 'function backToDetail('), /openFoodDetail\(foodId, '', quantity\);/);
  for (const name of ['function saveServingFromDetail(', 'function deleteServingConfirmed(', 'function servingGone(']) assert.match(fn(src, name), /backToDetail\([^)]*quantity/, name);
  assert.match(fn(src, 'function beforeLeave()'), /const q = ui\.quantity;\n\s*openFood\(q\.foodId, q\.text, q\.intent, q\.slot, q\.amount\);/, 'Food detail → Back: the sheet as left, restored by restoreAmount');
  assert.match(fn(src, 'function saveServing('), /if \(ui\.type === 'serving-form'\) \{ saveServingFromDetail\(\); return; \}/, 'C6’s Add a serving from the sheet is unchanged otherwise');
  assert.ok(LOG_VIEW_TYPES.includes('serving-form') && !LOG_VIEW_TYPES.includes('serving-delete'), 'the form is a view; Delete is a short confirmation');
});

/* ---------------- outcomes, through the domain and the shared renderers ---------------- */

test('Add · Edit · Make default · Delete: what Food detail shows after each, and the messages', () => {
  const { app, actions, writes } = setup();
  const food = app.getFood(CORE);
  writes.length = 0;
  const tub = actions.addServing(food, servingInput({ label: 'Tub', grams: '170', approximate: false }));
  assert.equal(tub.message, 'Saved Tub.');
  const scoop = actions.addServing(food, servingInput({ label: 'Scoop', grams: '30', approximate: true })).serving;
  // Edit opens with the stored values; saving a label change keeps the ID.
  const values = servingFormValues(scoop);
  assert.match(renderServingForm({ food, values, mode: 'edit' }), /value="Scoop"[\s\S]*value="30"[\s\S]*checked/);
  const edited = actions.updateServing(food, scoop.id, servingPatch({ ...values, label: 'Big scoop' }, values));
  assert.equal(edited.message, 'Saved Big scoop.');
  assert.equal(edited.serving.id, scoop.id);
  let detail = renderFoodDetail({ ...foodDetailModel(app, CORE), context: 'log' });
  assert.match(text(detail), /Servings Tub 170 g Default Edit Delete Big scoop ≈ approximately 30 g estimate Edit Make default Delete Add a serving/);
  // Make default.
  assert.equal(actions.makeDefaultServing(food, edited.serving).message, 'Big scoop is now the default serving.');
  detail = renderFoodDetail({ ...foodDetailModel(app, CORE), context: 'settings' });
  assert.match(text(detail), /Servings Big scoop ≈ approximately 30 g estimate Default Edit Delete Tub 170 g Edit Make default Delete/);
  // Delete the default: the next one becomes the default.
  assert.match(text(renderDeleteServing({ food, serving: edited.serving, servings: app.getServings(CORE) })), /Tub becomes the default\./);
  assert.equal(actions.deleteServing(food, edited.serving).message, 'Deleted Big scoop.');
  assert.match(text(renderFoodDetail({ ...foodDetailModel(app, CORE), context: 'log' })), /Servings Tub 170 g Default Edit Delete Add a serving/);
  assert.deepEqual(writes, Array(5).fill(['userFoodData']), 'one write each');
});

test('deleting the last serving: the empty state and Add a serving; the Food stays, unchanged', () => {
  const { app, actions } = setup();
  const food = app.getFood(OATS);
  const before = JSON.stringify(app.getFood(OATS));
  const pouch = actions.addServing(food, servingInput({ label: 'Pouch', grams: '60', approximate: false })).serving;
  const result = actions.deleteServing(food, pouch);
  assert.deepEqual(result.remaining, []);
  const html = renderFoodDetail({ ...foodDetailModel(app, OATS), context: 'settings' });
  assert.match(html, /No servings yet\. Add one to log this food by serving as well as by weight\./);
  assert.match(html, /data-action="fd-serving-add"/);
  assert.ok(app.getFood(OATS));
  assert.equal(JSON.stringify(app.getFood(OATS)), before);
  assert.deepEqual(ufd(app).foods.filter((r) => r.foodId === OATS), [], 'its serving record is gone');
  assert.deepEqual(ufd(app).retiredServingIds, [pouch.id]);
  assert.ok(settingsFoodsModel(app).custom.some((f) => f.id === OATS), 'still in My foods');
});

test('cancelling a delete changes nothing; a stale serving ID can never touch another serving', () => {
  const { app, actions, writes } = setup();
  const food = app.getFood(CORE);
  const tub = actions.addServing(food, servingInput({ label: 'Tub', grams: '170', approximate: false })).serving;
  const cup = actions.addServing(food, servingInput({ label: 'Cup', grams: '245', approximate: false })).serving;
  const stored = JSON.stringify(ufd(app));
  writes.length = 0;
  renderDeleteServing({ food, serving: tub, servings: app.getServings(CORE) }); // the dialog itself writes nothing
  assert.equal(JSON.stringify(ufd(app)), stored);
  assert.deepEqual(writes, []);
  // Tub deleted elsewhere; the open dialog / form / row still names it.
  actions.deleteServing(food, tub);
  writes.length = 0;
  for (const attempt of [() => actions.deleteServing(food, tub), () => actions.updateServing(food, tub.id, { label: 'Pot' }), () => actions.makeDefaultServing(food, tub)]) {
    assert.throws(attempt, (e) => e.code === 'SERVING_NOT_FOUND');
  }
  assert.deepEqual(writes, [], 'nothing written');
  assert.deepEqual(app.getServings(CORE), [cup], 'Cup untouched');
});

test('a failed write is an error, never a "Saved" / "Deleted" message, and changes nothing', () => {
  let fail = false;
  const { app, actions } = setup({ failWrites: () => fail });
  const food = app.getFood(CORE);
  const tub = actions.addServing(food, servingInput({ label: 'Tub', grams: '170', approximate: false })).serving;
  const cup = actions.addServing(food, servingInput({ label: 'Cup', grams: '245', approximate: false })).serving;
  const stored = JSON.stringify(ufd(app));
  fail = true;
  for (const attempt of [
    () => actions.addServing(food, servingInput({ label: 'Spoon', grams: '15', approximate: false })),
    () => actions.updateServing(food, tub.id, { label: 'Pot' }),
    () => actions.makeDefaultServing(food, cup),
    () => actions.deleteServing(food, tub)
  ]) assert.throws(attempt, (e) => e.code === 'PERSIST_FAILED', 'thrown, so the screen shows its error and announces nothing');
  assert.equal(JSON.stringify(ufd(app)), stored);
});

test('Log: deleting the serving the quantity sheet had selected — back on the sheet it falls back to grams with its last quantity (C6)', () => {
  const { app, actions } = setup();
  const food = app.getFood(CORE);
  const tub = actions.addServing(food, servingInput({ label: 'Tub', grams: '170', approximate: false })).serving;
  // The sheet as left for Food detail: Tub × 1 1/2 (255 g), grams typed earlier "40".
  const draft = { mode: 'serving', gramsText: '40', servingId: tub.id, countText: '1 1/2', lastText: null };
  draft.lastText = resolveDraft(app, CORE, draft).amount.text;
  assert.equal(draft.lastText, '255');
  actions.deleteServing(food, tub);
  const back = restoreAmount(app, CORE, draft);
  assert.deepEqual(back.draft, { mode: 'grams', gramsText: '255', servingId: null, countText: '1 1/2', lastText: '255' });
  assert.equal(back.notice, 'That serving no longer exists, so this is in grams now.');
  // A serving renamed or made default meanwhile: the draft keeps its selection and count.
  const scoop = actions.addServing(food, servingInput({ label: 'Scoop', grams: '30', approximate: false })).serving;
  const cup = actions.addServing(food, servingInput({ label: 'Cup', grams: '245', approximate: false })).serving;
  const kept = { mode: 'serving', gramsText: '', servingId: cup.id, countText: '2', lastText: null };
  actions.makeDefaultServing(food, scoop);
  actions.updateServing(food, cup.id, { label: 'Mug' });
  assert.deepEqual(restoreAmount(app, CORE, kept), { draft: kept, notice: '' });
  assert.equal(resolveDraft(app, CORE, kept).amount.quantity, 490);
});

test('Delete food dialog in Log and Settings counts its servings explicitly', () => {
  const { app, actions } = setup();
  const food = app.getFood(OATS);
  actions.addServing(food, servingInput({ label: 'Pouch', grams: '60', approximate: false }));
  const meals = foodUsageMeals(app, OATS);
  assert.match(text(renderDeleteFood({ food, meals, servingCount: app.getServings(OATS).length })), /Its serving will be deleted too\./);
});

test('Settings navigation is unchanged: My foods is Custom Foods only, even when a Core Food has servings', () => {
  const { app, actions } = setup();
  actions.addServing(app.getFood(CORE), servingInput({ label: 'Tub', grams: '170', approximate: false }));
  const model = settingsFoodsModel(app);
  assert.ok(model.custom.every((f) => f.source === 'custom'));
  assert.ok(!model.custom.some((f) => f.id === CORE));
  assert.deepEqual([...SETTINGS_VIEW_TYPES], ['target-edit', 'food-detail', 'custom-food', 'serving-form']);
  assert.match(SRC.settings, /case 'food-detail': foodOrigin = el\.closest\('\[data-list\]'\) \? el\.closest\('\[data-list\]'\)\.dataset\.list : null; openFoodDetail\(el\.dataset\.food\); break;/, 'Food detail opens as before');
});

test('Coach and Food picker stay read-only; no serving wiring in today.js or meals.js; the screens add no arithmetic or second store', () => {
  for (const f of ['app/today.js', 'app/meals.js']) assert.ok(!/fd-serving|serving-form|serving-delete|updateServing|deleteServing|setDefaultServing/.test(read(f)), f);
  for (const f of ['app/log.js', 'app/settings.js']) {
    const src = read(f);
    assert.deepEqual(macroArithmeticInSource(src, f), [], f);
    assert.ok(!FORBIDDEN_NUTRITION.test(src), f);
    assert.deepEqual(domainImportsBypassingIndex(src), [], f);
    assert.ok(!/localStorage|sessionStorage|indexedDB|\bfetch\(/.test(src), f);
    assert.ok(!/parseServingCount|parseServingGrams|decimalPlaces|servingQuantity/.test(src), `${f}: no serving parsing or arithmetic of its own`);
    assert.ok(!/app\.(createServing|updateServing|deleteServing|setDefaultServing)\(/.test(src.replace(/function saveServing\([\s\S]*?\n    \}\n/, '')), `${f}: Food detail serving changes go through createFoodActions`);
  }
  assert.ok(servingFormDirty({ values: { ...emptyServingValues(), label: 'x' }, initial: emptyServingValues() }));
});
