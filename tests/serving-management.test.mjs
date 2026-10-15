/*
 * serving-management.test.mjs — V3 Slice 1 · C7, Stage 2: the shared Food detail UI for
 * servings (app/foods.js, app/amount.js). Pure renderers and the thin actions are checked
 * here; Log and Settings wiring comes in Stage 3–4. The Coach (app/today.js) is not changed:
 * its Food detail shows servings read-only (an exception to A-47), like the Food picker (A-46).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, macroArithmeticInSource, FORBIDDEN_NUTRITION, domainImportsBypassingIndex } from './helpers.mjs';
import { createDataLayer, createMemoryAdapter } from '../src/domain/index.js';
import { createFileAdapter } from '../src/node/file-adapter.js';
import {
  foodDetailModel, renderFoodDetail, renderServingsSection, renderDeleteServing, renderDeleteFood, renderDiscardFood,
  servingWeight, servingFormValues, createFoodActions, foodUsageMeals, SERVING_MANAGEMENT_CONTEXTS
} from '../app/foods.js';
import { renderServingForm, servingPatch, servingInput, servingFormDirty, emptyServingValues } from '../app/amount.js';

const TODAY = '2026-09-27';
const SEED = createFileAdapter(ROOT).load();
const CORE = 'food_core_fage_0_greek_yogurt';
const OATS = 'food_custom_oats_overnight';
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const text = (html) => html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
const actionsOf = (html) => [...html.matchAll(/data-action="([^"]+)"/g)].map((m) => m[1]);
const SERVING_ACTIONS = ['fd-serving-add', 'fd-serving-edit', 'fd-serving-default', 'fd-serving-delete'];

function setup(userFoodData) {
  let t = Date.parse(`${TODAY}T12:00:00Z`);
  let n = 0;
  const writes = [];
  const inner = createMemoryAdapter(userFoodData ? { ...SEED, userFoodData } : SEED);
  const adapter = { load: () => inner.load(), save: (c, d) => inner.save(c, d), saveMany: (ch) => { writes.push(Object.keys(ch).sort()); inner.saveMany(ch); } };
  const app = createDataLayer({ adapter, today: () => TODAY, clock: () => new Date((t += 60000)), newUuid: () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}` });
  return { app, writes };
}
/** Tub 170 g (default) · Scoop ≈ 30 g · Cup 245 g on the Core Food. */
function withServings() {
  const env = setup();
  const { app } = env;
  env.tub = app.createServing(CORE, { label: 'Tub', grams: 170 });
  env.scoop = app.createServing(CORE, { label: 'Scoop', grams: 30, approximate: true });
  env.cup = app.createServing(CORE, { label: 'Cup', grams: 245 });
  return env;
}
const section = (html) => html.slice(html.indexOf('<section class="food-servings"'), html.indexOf('</section>', html.indexOf('<section class="food-servings"')) + 10);

/* ---------------- the Servings section in each context ---------------- */

test('Food detail model carries the Food’s servings, default first', () => {
  const { app, tub, scoop, cup } = withServings();
  assert.deepEqual(foodDetailModel(app, CORE).servings, [tub, scoop, cup]);
  assert.deepEqual(foodDetailModel(app, OATS).servings, []);
  assert.deepEqual([...SERVING_MANAGEMENT_CONTEXTS], ['log', 'settings']);
});

test('Log and Settings: rows with stored grams, Default on the first, ≈ / estimate on approximate ones, and every management action', () => {
  const { app, tub, scoop, cup } = withServings();
  for (const context of ['log', 'settings']) {
    const html = renderFoodDetail({ ...foodDetailModel(app, CORE), context });
    const sec = section(html);
    assert.match(sec, /<h3 id="fd-servings-title" class="group-title">Servings<\/h3>/);
    assert.match(sec, /data-sync="fd-servings"/, 'replaced as a whole when servings change');
    assert.deepEqual([...sec.matchAll(/data-serving-row="([^"]+)"/g)].map((m) => m[1]), [tub.id, scoop.id, cup.id], `${context}: stored order`);
    assert.match(sec, /<span class="serving-label">Tub<\/span> <span class="serving-weight">170 g<\/span> <span class="marker">Default<\/span>/);
    assert.equal((sec.match(/>Default</g) || []).length, 1, 'only the first is the default');
    assert.match(sec, /<span class="serving-label">Scoop<\/span> <span class="serving-weight"><span aria-hidden="true">≈ <\/span><span class="visually-hidden">approximately <\/span>30 g <span class="estimate-label">estimate<\/span><\/span>/);
    assert.match(sec, /<span class="serving-label">Cup<\/span> <span class="serving-weight">245 g<\/span><\/span>/, 'no ≈ or estimate on an exact serving');
    for (const s of [tub, scoop, cup]) {
      assert.match(sec, new RegExp(`data-action="fd-serving-edit" data-serving="${s.id}" aria-label="Edit ${s.label}">Edit<`));
      assert.match(sec, new RegExp(`data-action="fd-serving-delete" data-serving="${s.id}" aria-label="Delete ${s.label}">Delete<`));
    }
    assert.ok(!sec.includes(`data-action="fd-serving-default" data-serving="${tub.id}"`), 'no Make default on the default');
    for (const s of [scoop, cup]) assert.match(sec, new RegExp(`data-action="fd-serving-default" data-serving="${s.id}" aria-label="Make ${s.label} the default">Make default<`));
    assert.match(sec, /<button type="button" class="button" data-action="fd-serving-add" aria-label="Add a serving for Fage 0% Greek yogurt">Add a serving<\/button>/);
    assert.ok(html.indexOf('food-servings') > html.indexOf('per-100-table') && html.indexOf('food-servings') < html.indexOf('food-prefs'), 'after Per 100 g, before Your lists');
  }
});

test('Coach and Food picker: the same list read-only — no management actions at all', () => {
  const { app } = withServings();
  for (const context of ['coach', 'picker']) {
    const html = renderFoodDetail({ ...foodDetailModel(app, CORE), context });
    const sec = section(html);
    assert.match(sec, /<span class="serving-label">Tub<\/span> <span class="serving-weight">170 g<\/span> <span class="marker">Default<\/span>/, context);
    assert.match(sec, /approximately <\/span>30 g <span class="estimate-label">estimate/, context);
    assert.deepEqual(actionsOf(sec), [], `${context}: read-only`);
    assert.ok(!actionsOf(html).some((a) => SERVING_ACTIONS.includes(a)));
  }
  assert.deepEqual([...new Set(actionsOf(renderFoodDetail({ ...foodDetailModel(app, CORE), context: 'picker' })))], ['close'], 'the picker is still information-only (A-46)');
  assert.ok(!/fd-serving/.test(read('app/today.js')), 'app/today.js is not changed for servings');
});

test('empty state: managed contexts invite Add a serving; read-only contexts just say so', () => {
  const { app } = setup();
  for (const context of ['log', 'settings']) {
    const sec = section(renderFoodDetail({ ...foodDetailModel(app, OATS), context }));
    assert.match(sec, /<p class="hint">No servings yet\. Add one to log this food by serving as well as by weight\.<\/p>/);
    assert.match(sec, /data-action="fd-serving-add"/);
    assert.ok(!/serving-list/.test(sec));
  }
  for (const context of ['coach', 'picker']) {
    const sec = section(renderFoodDetail({ ...foodDetailModel(app, OATS), context }));
    assert.match(sec, /<p class="hint">No servings\.<\/p>/);
    assert.deepEqual(actionsOf(sec), []);
  }
});

test('Core Foods: servings are managed, nutrition stays read-only with the new subtitle; Custom Foods keep "My food"', () => {
  const { app } = withServings();
  for (const context of ['log', 'settings', 'coach', 'picker']) {
    const html = renderFoodDetail({ ...foodDetailModel(app, CORE), context });
    assert.match(html, /<p class="sheet-subtitle">App food · nutrition can’t be edited<\/p>/, context);
    assert.ok(!/data-action="fd-edit"|data-action="fd-delete"/.test(html), `${context}: no Edit / Delete for the Core Food itself`);
  }
  assert.ok(actionsOf(renderFoodDetail({ ...foodDetailModel(app, CORE), context: 'log' })).includes('fd-serving-edit'), 'Core Food servings are editable');
  assert.match(renderFoodDetail({ ...foodDetailModel(app, OATS), context: 'settings' }), /<p class="sheet-subtitle">My food<\/p>/);
});

test('stored grams are shown as stored (a restored 3-place weight too); labels are escaped', () => {
  const restored = { foods: [{ foodId: CORE, servings: [{ id: 'srv_00000000-0000-4000-8000-000000000077', label: '<b>Pinch</b>', grams: 1.005, approximate: false, createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-01T00:00:00.000Z' }] }], retiredServingIds: [] };
  const { app } = setup(restored);
  const sec = section(renderFoodDetail({ ...foodDetailModel(app, CORE), context: 'settings' }));
  assert.match(sec, /<span class="serving-weight">1\.005 g<\/span>/);
  assert.match(sec, /&lt;b&gt;Pinch&lt;\/b&gt;/);
  assert.ok(!sec.includes('<b>Pinch'));
  assert.equal(servingWeight({ grams: 22.5, approximate: false }), '22.5 g');
  assert.deepEqual(actionsOf(renderServingsSection({ food: app.getFood(CORE), servings: [], manage: false })), [], 'read-only by default');
});

/* ---------------- the serving form: add (C6, unchanged) and edit ---------------- */

test('Add mode is exactly C6’s Add a serving form', () => {
  const { app } = setup();
  const food = app.getFood(CORE);
  const html = renderServingForm({ food, values: emptyServingValues() });
  assert.equal(renderServingForm({ food, values: emptyServingValues(), mode: 'add' }), html);
  assert.match(html, /<h2 id="sheet-title" class="sheet-title">Add a serving<\/h2>/);
  assert.match(html, /data-action="srv-save">Save serving</);
  assert.ok(!/Changing the weight/.test(html));
});

test('Edit mode: prefilled with the stored values, "Edit serving", "Save changes", and the logged-meals note', () => {
  const { app, scoop } = withServings();
  const values = servingFormValues(scoop);
  assert.deepEqual(values, { label: 'Scoop', grams: '30', approximate: true });
  const html = renderServingForm({ food: app.getFood(CORE), values, mode: 'edit' });
  assert.match(html, /<h2 id="sheet-title" class="sheet-title">Edit serving<\/h2>/);
  assert.match(html, /<p class="sheet-subtitle">Fage 0% Greek yogurt<\/p>/);
  assert.match(html, /<p class="hint">Changing the weight doesn’t change meals you’ve already logged\.<\/p>/);
  assert.match(html, /id="srv-label" type="text" data-srv="label" value="Scoop"/);
  assert.match(html, /id="srv-grams" type="text" inputmode="decimal" data-srv="grams" value="30"/);
  assert.match(html, /<input type="checkbox" data-srv="approximate" checked>/);
  assert.match(html, /data-action="srv-save">Save changes</);
  assert.equal(servingFormDirty({ values, initial: { ...values } }), false, 'opened as stored: not dirty');
  assert.equal(servingFormDirty({ values: { ...values, approximate: false }, initial: values }), true);
  assert.match(text(renderDiscardFood({ editedServing: true })), /Discard changes\? Your changes to this serving haven’t been saved\. Keep editing Discard/);
  assert.match(text(renderDiscardFood({ serving: true })), /This new serving hasn’t been saved\./, 'C6 wording unchanged');
});

test('Edit mode keeps a restored high-precision weight exactly when the weight isn’t touched; a changed weight is checked', () => {
  const id = 'srv_00000000-0000-4000-8000-000000000077';
  const restored = { foods: [{ foodId: CORE, servings: [{ id, label: 'Pinch', grams: 1.005, approximate: false, createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-01T00:00:00.000Z' }] }], retiredServingIds: [] };
  const { app } = setup(restored);
  const actions = createFoodActions(app);
  const food = app.getFood(CORE);
  const initial = servingFormValues(app.getServings(CORE)[0]);
  assert.deepEqual(initial, { label: 'Pinch', grams: '1.005', approximate: false });
  // Label and estimate edits: the weight isn't sent, so it stays 1.005 exactly.
  const patch = servingPatch({ ...initial, label: 'Big pinch', approximate: true }, initial);
  assert.deepEqual(patch, { label: 'Big pinch', approximate: true });
  const saved = actions.updateServing(food, id, patch).serving;
  assert.equal(saved.grams, 1.005);
  assert.equal(saved.createdAt, '2026-09-01T00:00:00.000Z');
  assert.notEqual(saved.updatedAt, '2026-09-01T00:00:00.000Z');
  // A changed weight goes through the domain's parser and its 2-place rule.
  assert.deepEqual(servingPatch({ ...initial, grams: '1,25' }, initial), { label: 'Pinch', approximate: false, grams: 1.25 });
  assert.throws(() => actions.updateServing(food, id, servingPatch({ ...initial, grams: '1.006' }, initial)), (e) => e.code === 'INVALID_SERVING' && e.details[0].code === 'INVALID_SERVING_GRAMS');
  assert.throws(() => actions.updateServing(food, id, servingPatch({ ...initial, grams: '1e2' }, initial)), (e) => e.code === 'INVALID_SERVING');
  assert.equal(app.getServings(CORE)[0].grams, 1.005, 'refused changes leave it as it was');
  assert.deepEqual(servingInput({ label: 'X', grams: '45', approximate: false }), { label: 'X', grams: 45, approximate: false }, 'C6 add input unchanged');
});

/* ---------------- dialogs ---------------- */

test('Delete serving dialog: names the serving and the Food, says logged meals are unaffected, Cancel first; names the next default', () => {
  const { app, tub, scoop, cup } = withServings();
  const food = app.getFood(CORE);
  const servings = app.getServings(CORE);
  const html = renderDeleteServing({ food, serving: scoop, servings });
  assert.equal(text(html), 'Delete serving? Delete Scoop from Fage 0% Greek yogurt? Meals you’ve already logged aren’t affected. Cancel Delete serving');
  assert.match(html, /<button type="button" class="button" data-action="close" data-autofocus>Cancel<\/button><button type="button" class="button danger" data-action="fd-serving-delete-confirm" data-serving="[^"]+">Delete serving<\/button>/);
  assert.match(html, /role="alert" data-error hidden/);
  assert.match(text(renderDeleteServing({ food, serving: tub, servings })), /Delete Tub from Fage 0% Greek yogurt\? Scoop becomes the default\. Meals you’ve already logged aren’t affected\./);
  assert.ok(!/becomes the default/.test(renderDeleteServing({ food, serving: cup, servings })));
  assert.ok(!/becomes the default/.test(renderDeleteServing({ food, serving: tub, servings: [tub] })), 'the last one: no next default');
});

test('Delete food dialog: says its servings are deleted too, from an explicit count or the Food detail it came from', () => {
  const { app } = setup();
  const food = app.getFood(OATS);
  const meals = foodUsageMeals(app, OATS);
  const none = text(renderDeleteFood({ food, meals }));
  assert.ok(!/servings? will be deleted/.test(none), 'no servings: unchanged wording');
  assert.match(text(renderDeleteFood({ food, meals, servingCount: 1 })), /Its serving will be deleted too\. Meals you’ve already logged aren’t affected\./);
  assert.match(text(renderDeleteFood({ food, meals, servingCount: 3 })), /Its 3 servings will be deleted too\./);
  assert.ok(!/will be deleted too/.test(text(renderDeleteFood({ food, meals, servingCount: 0 }))));
  // The Coach opens it as { food, meals, detail } (app/today.js, unchanged): the fallback reads detail.servings.
  app.createServing(OATS, { label: 'Pouch', grams: 60 });
  app.createServing(OATS, { label: 'Half pouch', grams: 30 });
  const detail = { type: 'food-detail', ...foodDetailModel(app, OATS), back: null };
  assert.match(text(renderDeleteFood({ food, meals, detail })), /Its 2 servings will be deleted too\./, 'fallback: detail.servings');
  assert.ok(!/will be deleted too/.test(text(renderDeleteFood({ food, meals, servingCount: 0, detail }))), 'an explicit count wins');
  assert.match(read('app/today.js'), /case 'fd-delete': openDialog\(\{ type: 'food-delete', food: ui\.food, meals: foodUsageMeals\(app, ui\.food\.id\), detail: ui \}\); break;/, 'the Coach passes the detail it came from');
  assert.match(read('app/today.js'), /case 'food-delete': dialog\.innerHTML = renderDeleteFood\(ui\); break;/);
});

/* ---------------- actions: one domain call each ---------------- */

test('actions: add, edit, make default and delete go through the domain, one write each, and say what happened', () => {
  const { app, writes } = setup();
  const actions = createFoodActions(app);
  const food = app.getFood(CORE);
  const before = JSON.stringify(app.getFood(CORE));
  writes.length = 0;
  const added = actions.addServing(food, servingInput({ label: 'Tub', grams: '170', approximate: false }));
  assert.equal(added.message, 'Saved Tub.');
  const second = actions.addServing(food, servingInput({ label: 'Scoop', grams: '30', approximate: true })).serving;
  const edited = actions.updateServing(food, second.id, { label: 'Big scoop' });
  assert.equal(edited.message, 'Saved Big scoop.');
  assert.equal(edited.serving.id, second.id);
  const made = actions.makeDefaultServing(food, edited.serving);
  assert.equal(made.message, 'Big scoop is now the default serving.');
  assert.equal(made.changed, true);
  assert.deepEqual(app.getServings(CORE).map((s) => s.label), ['Big scoop', 'Tub']);
  const deleted = actions.deleteServing(food, added.serving);
  assert.equal(deleted.message, 'Deleted Tub.');
  assert.deepEqual(deleted.remaining.map((s) => s.label), ['Big scoop']);
  assert.deepEqual(writes, Array(5).fill(['userFoodData']), 'one write per change, userFoodData only');
  assert.equal(JSON.stringify(app.getFood(CORE)), before, 'the Core Food itself never changes');
  assert.deepEqual(app.exportUserData().data.userFoodData.retiredServingIds, [added.serving.id]);
});

test('shared serving UI: no macro arithmetic, no conversion or parsing of its own, no second store; domain via its entry point', () => {
  for (const f of ['app/foods.js', 'app/amount.js', 'app/app.css']) {
    const src = read(f);
    assert.deepEqual(macroArithmeticInSource(src, f), [], f);
    assert.ok(!FORBIDDEN_NUTRITION.test(src), f);
    assert.deepEqual(domainImportsBypassingIndex(src), [], f);
    assert.ok(!/localStorage|sessionStorage|indexedDB|\bfetch\(/.test(src), f);
  }
  const foods = read('app/foods.js').replace(/\/\*[\s\S]*?\*\//g, '');
  const servingCode = foods.slice(foods.indexOf('export const SERVING_MANAGEMENT_CONTEXTS'), foods.indexOf('export function renderFoodDetail'));
  assert.ok(!/parseFloat|Number\(|Math\.|toFixed|toPrecision|BigInt|parseServing|\bgrams\s*[-+*/]/.test(servingCode), 'the servings UI shows stored values; it never converts or parses');
  const patch = read('app/amount.js').slice(read('app/amount.js').indexOf('export function servingPatch'));
  assert.match(patch.slice(0, patch.indexOf('\n}')), /parseServingGrams\(values\.grams\)/, 'a changed weight is read by the domain parser only');
  for (const f of ['app/today.js', 'app/meals.js']) assert.ok(!/fd-serving|renderDeleteServing|servingPatch/.test(read(f)), `${f}: Coach and Food picker stay read-only — no serving wiring`);
});
