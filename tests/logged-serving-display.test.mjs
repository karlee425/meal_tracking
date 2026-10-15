/*
 * logged-serving-display.test.mjs — V3 Slice 1 · C8 Stage 4: a logged serving shown in the
 * logged-meal detail and editor (app/today.js), the domain's count text (formatServingCount), and
 * the editor's explicit row pairing (snapshotIndex). Synthetic data only.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, macroArithmeticInSource, FORBIDDEN_NUTRITION } from './helpers.mjs';
import { createDataLayer, createMemoryAdapter, formatServingCount } from '../src/domain/index.js';
import { createFileAdapter } from '../src/node/file-adapter.js';
import {
  renderInstanceDialog, renderEditDialog, loggedServingContext, editRowsOf, editIngredients, servingDropped,
  editKey, parseGrams, SERVING_TO_GRAMS_NOTE
} from '../app/today.js';
import { trayIngredients } from '../app/log.js';

const TODAY = '2026-09-27';
const SEED = createFileAdapter(ROOT).load();
const CORE = 'food_core_fage_0_greek_yogurt';
const OATS = 'food_custom_oats_overnight';
const uuid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const SRV = (n) => `srv_${uuid(n)}`;
const AT = '2026-09-01T00:00:00.000Z';
const code = (c) => (e) => e.code === c;
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const text = (html) => html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();

function setup({ userFoodData, days } = {}) {
  const inner = createMemoryAdapter({ ...SEED, ...(userFoodData ? { userFoodData } : {}), ...(days ? { days } : {}) });
  let t = Date.parse(`${TODAY}T12:00:00Z`);
  let next = 0;
  const app = createDataLayer({ adapter: inner, today: () => TODAY, clock: () => new Date((t += 60000)), newUuid: () => uuid(++next) });
  return app;
}
const detail = (instance) => renderInstanceDialog({ instance, slot: instance.mealSlot, date: TODAY, source: null, sourceName: '' });
const editOf = (instance, preview = null) => ({ instance, date: TODAY, name: instance.mealName, slot: instance.mealSlot, rows: editRowsOf(instance), preview });
/** What the editor's Save sends, from its rows as they stand (today.js editPatch). */
const patchOf = (rows, extra = {}) => ({ ...extra, ingredients: editIngredients(rows, rows.map((r) => parseGrams(r.text))) });

/** One logged meal with a Scoop of CORE (1 1/3 × 30 g = 40 g, not approximate) and grams of OATS. */
function scoopMeal() {
  const app = setup();
  const scoop = app.createServing(CORE, { label: 'Scoop', grams: 30 });
  app.createDay(TODAY, 'lift');
  const mi = app.logFood({ date: TODAY, mealSlot: 'breakfast', foodId: CORE, servingId: scoop.id, count: '1 1/3' });
  const both = app.updateMealInstance(TODAY, mi.id, { ingredients: [{ foodId: CORE, quantity: 40, snapshotIndex: 0 }, { foodId: OATS, quantity: 40 }] });
  return { app, scoop, instance: both };
}

/* ---------------- 1: the domain's count text ---------------- */

test('C8 display — 1: formatServingCount: whole, exact decimal (≤ 2 places), else a fraction; exact, never via floats', () => {
  const MAX = Number.MAX_SAFE_INTEGER;
  const cases = [
    [1, 1, '1'], [2, 1, '2'], [6, 3, '2'], [3, 2, '1.5'], [6, 4, '1.5'], [1, 2, '0.5'], [1, 4, '0.25'], [3, 4, '0.75'],
    [1, 20, '0.05'], [21, 20, '1.05'], [1, 25, '0.04'], [101, 100, '1.01'], [1, 3, '1/3'], [2, 3, '2/3'], [4, 3, '1 1/3'],
    [7, 3, '2 1/3'], [1, 8, '1/8'], [9, 8, '1 1/8'], [2, 7, '2/7'], [1, 6, '1/6'], [1, 200, '1/200'],
    [MAX, 1, '9007199254740991'], [MAX, 2, '4503599627370495.5'], [MAX, 100, '90071992547409.91'],
    [1, MAX, '1/9007199254740991'], [MAX, MAX - 1, '1 1/9007199254740990']
  ];
  for (const [numerator, denominator, want] of cases) assert.equal(formatServingCount({ numerator, denominator }), want, `${numerator}/${denominator}`);
  for (const bad of [undefined, null, 2, '1/2', {}, { numerator: 1 }, { numerator: 0, denominator: 1 }, { numerator: 1, denominator: 0 },
    { numerator: -1, denominator: 2 }, { numerator: 1.5, denominator: 1 }, { numerator: '1', denominator: 2 }, { numerator: 2 ** 53, denominator: 1 },
    { numerator: 1, denominator: 2 ** 53 }, { numerator: NaN, denominator: 1 }, { numerator: Infinity, denominator: 1 }]) {
    assert.throws(() => formatServingCount(bad), code('INVALID_SERVING_COUNT'), JSON.stringify(bad));
  }
});

/* ---------------- 2–5: the logged-meal detail ---------------- */

test('C8 display — 2–3: the detail shows a logged serving under the food name; grams rows show nothing new', () => {
  const { instance } = scoopMeal();
  const html = detail(instance);
  const [coreRow, oatsRow] = [...html.matchAll(/<tr><th scope="row">([\s\S]*?)<\/tr>/g)].map((m) => m[1]);
  assert.match(coreRow, /<span class="hint serving-context">1 1\/3 × Scoop · 30 g each<\/span><\/th><td>40 g<\/td>/, 'the context, then the logged grams as before');
  assert.ok(!oatsRow.includes('serving-context'), 'a grams row has no context');
  assert.equal((html.match(/serving-context/g) || []).length, 1);
  // a meal logged entirely in grams renders exactly as before C8
  const app = setup();
  app.createDay(TODAY, 'lift');
  const plain = app.logFood({ date: TODAY, mealSlot: 'lunch', foodId: CORE, quantity: 45 });
  assert.ok(!detail(plain).includes('serving-context'));
  assert.equal(loggedServingContext(undefined), '');
});

test('C8 display — 4: an approximate serving reads ≈ … estimate, and "approximately" to screen readers', () => {
  const app = setup();
  const spoon = app.createServing(CORE, { label: 'Spoon', grams: 12.5, approximate: true });
  app.createDay(TODAY, 'lift');
  const mi = app.logFood({ date: TODAY, mealSlot: 'lunch', foodId: CORE, servingId: spoon.id, count: '2' });
  const html = detail(mi);
  assert.ok(html.includes('2 × Spoon · <span aria-hidden="true">≈ </span><span class="visually-hidden">approximately </span>12.5 g each <span class="estimate-label">estimate</span>'));
  assert.ok(!detail(scoopMeal().instance).includes('≈'), 'no ≈ for a serving that isn’t an estimate');
});

test('C8 display — 5: the detail and editor read the snapshot, never the Food’s servings now', () => {
  const { app, scoop, instance } = scoopMeal();
  app.updateServing(CORE, scoop.id, { label: 'Big scoop', grams: 40, approximate: true });
  const after = app.getDay(TODAY).mealInstances[0];
  assert.ok(detail(after).includes('1 1/3 × Scoop · 30 g each'), 'renamed and reweighed: the record still says what was logged');
  app.deleteServing(CORE, scoop.id);
  app.deleteCustomFood(OATS);
  const html = detail(app.getDay(TODAY).mealInstances[0]);
  assert.ok(html.includes('1 1/3 × Scoop · 30 g each'));
  assert.ok(renderEditDialog(editOf(app.getDay(TODAY).mealInstances[0])).includes('Logged as 1 1/3 × Scoop · 30 g each'));
  assert.deepEqual(app.getDay(TODAY).mealInstances[0], instance, 'and the record itself is unchanged');
  const src = read('app/today.js');
  assert.ok(!/getServings|resolveAmount|createServing|updateServing|deleteServing/.test(src), 'today.js never looks servings up');
});

/* ---------------- 6–9: the editor and its pairing ---------------- */

test('C8 display — 6: every existing edit row carries its index in the logged meal; added rows carry none', () => {
  const { app, instance } = scoopMeal();
  const rows = editRowsOf(instance);
  assert.deepEqual(rows.map((r) => r.snapshotIndex), [0, 1]);
  assert.deepEqual(rows[0].serving, instance.ingredients[0].serving, 'the snapshot, for display');
  assert.ok(!('serving' in rows[1]));
  rows.push({ foodId: CORE, unit: 'g', foodName: 'x', state: 'raw', text: '10' }); // as pickIngredient adds it
  const ings = editIngredients(rows, [40, 40, 10]);
  assert.deepEqual(ings, [{ foodId: CORE, unit: 'g', quantity: 40, snapshotIndex: 0 }, { foodId: OATS, unit: 'g', quantity: 40, snapshotIndex: 1 }, { foodId: CORE, unit: 'g', quantity: 10 }]);
  assert.equal(editKey(editOf(instance)), editKey({ name: instance.mealName, slot: instance.mealSlot, rows: editRowsOf(instance) }), 'the discard check still compares Food and grams text');
  // the source: editPatch sends editIngredients, and the editor opens on editRowsOf
  const src = read('app/today.js');
  assert.match(src, /ingredients: editIngredients\(ui\.rows, parsed\)/);
  assert.match(src, /rows: editRowsOf\(instance\)/);
  const edited = app.updateMealInstance(TODAY, instance.id, patchOf(rows));
  assert.deepEqual(edited.ingredients[0], instance.ingredients[0], 'the serving row, unchanged');
  assert.ok(!('serving' in edited.ingredients[2]), 'the added row is grams');
});

test('C8 display — 7: rows of one Food keep their own snapshots when rows are removed, reordered or added', () => {
  // A meal with Scoop (serving, 40 g) and 40 g typed as grams, both CORE, plus OATS.
  const fresh = () => {
    const { app, instance } = scoopMeal();
    const three = app.updateMealInstance(TODAY, instance.id, { ingredients: [...editIngredients(editRowsOf(instance), [40, 40]), { foodId: CORE, quantity: 40 }] });
    return { app, instance: three };
  };
  {
    const { app, instance } = fresh();
    assert.deepEqual(instance.ingredients.map((i) => !!i.serving), [true, false, false]);
    const rows = editRowsOf(instance);
    rows.splice(0, 1); // remove the Scoop row
    const out = app.updateMealInstance(TODAY, instance.id, patchOf(rows));
    assert.ok(out.ingredients.every((i) => !i.serving), 'the other 40 g CORE row does not take the Scoop snapshot');
    assert.equal(out.ingredients.length, 2);
  }
  {
    const { app, instance } = fresh();
    const rows = editRowsOf(instance);
    rows.splice(2, 1); // remove the grams CORE row
    const out = app.updateMealInstance(TODAY, instance.id, patchOf(rows));
    assert.deepEqual(out.ingredients[0], instance.ingredients[0], 'the Scoop row keeps its snapshot');
  }
  {
    const { app, instance } = fresh();
    const rows = editRowsOf(instance).reverse();
    const out = app.updateMealInstance(TODAY, instance.id, patchOf(rows));
    assert.deepEqual(out.ingredients, [...instance.ingredients].reverse(), 'reordered: each snapshot follows its row');
  }
  {
    // the Scoop row removed and CORE added again at the same grams: an added row, never the old snapshot
    const { app, instance } = scoopMeal();
    const rows = editRowsOf(instance);
    rows.splice(0, 1);
    rows.push({ foodId: CORE, unit: 'g', foodName: 'x', state: 'raw', text: '40' });
    const out = app.updateMealInstance(TODAY, instance.id, patchOf(rows));
    assert.ok(!out.ingredients[1].serving, 'the added CORE row is grams');
    assert.ok(out.ingredients.every((i) => !i.serving));
  }
});

test('C8 display — 8: name-only and slot-only edits from the editor keep every snapshot', () => {
  const { app, instance } = scoopMeal();
  const rows = editRowsOf(instance);
  const renamed = app.updateMealInstance(TODAY, instance.id, patchOf(rows, { mealName: 'Breakfast yogurt' }));
  assert.deepEqual(renamed.ingredients, instance.ingredients);
  const moved = app.updateMealInstance(TODAY, instance.id, patchOf(editRowsOf(renamed), { mealSlot: 'snack_night' }));
  assert.deepEqual(moved.ingredients, instance.ingredients);
  assert.deepEqual([moved.mealName, moved.mealSlot], ['Breakfast yogurt', 'snack_night']);
});

test('C8 display — 9: changed grams drop only that row’s snapshot, and the editor says so from the preview', () => {
  const rowOf = (n, foodId, quantity, label, grams, numerator, denominator) => ({ foodId, foodName: foodId, quantity, unit: 'g', protein: 1, carbs: 1, fat: 1, serving: { id: SRV(n), label, grams, approximate: false, count: { numerator, denominator } } });
  const days = [{ id: `day_${TODAY}`, date: TODAY, dayType: 'lift', targetSnapshot: { protein: 150, carbs: 250, fat: 70 }, loggingComplete: false,
    mealInstances: [{ id: 'mi_two', sourceMealId: null, mealName: 'Two', mealSlot: 'lunch', ingredients: [rowOf(1, CORE, 45, 'Scoop', 30, 3, 2), rowOf(2, OATS, 30, 'Pouch', 60, 1, 2)], totals: { protein: 2, carbs: 2, fat: 2 }, loggedAt: AT }] }];
  const userFoodData = { foods: [{ foodId: CORE, servings: [{ id: SRV(1), label: 'Scoop', grams: 30, approximate: false, createdAt: AT, updatedAt: AT }] }, { foodId: OATS, servings: [{ id: SRV(2), label: 'Pouch', grams: 60, approximate: false, createdAt: AT, updatedAt: AT }] }], retiredServingIds: [] };
  const app = setup({ userFoodData, days });
  const instance = app.getDay(TODAY).mealInstances[0];
  const rows = editRowsOf(instance);
  // nothing changed yet: both contexts, no notes
  const untouched = app.previewMealInstanceUpdate(TODAY, instance.id, patchOf(rows));
  let html = renderEditDialog(editOf(instance, untouched));
  assert.ok(html.includes('Logged as 1.5 × Scoop · 30 g each'));
  assert.ok(html.includes('Logged as 0.5 × Pouch · 60 g each'));
  assert.equal((html.match(/data-serving-note="\d" hidden>/g) || []).length, 2, 'both notes hidden');
  assert.match(html, /id="edit-q-0"[^>]*aria-describedby="edit-srv-0"/);
  // the Scoop row's grams change
  rows[0].text = '50';
  const preview = app.previewMealInstanceUpdate(TODAY, instance.id, patchOf(rows));
  assert.deepEqual([servingDropped(rows[0], preview, 0), servingDropped(rows[1], preview, 1)], [true, false]);
  html = renderEditDialog({ ...editOf(instance, preview), rows });
  assert.ok(html.includes(`<p class="hint serving-context" id="edit-srv-note-0" data-serving-note="0">${SERVING_TO_GRAMS_NOTE}</p>`), 'shown for the changed row');
  assert.ok(html.includes('data-serving-note="1" hidden>'), 'hidden for the other');
  assert.match(html, /id="edit-q-0"[^>]*aria-describedby="edit-srv-0 edit-srv-note-0"/);
  assert.ok(!/aria-live[^>]*>[^<]*Grams changed/.test(html), 'the note is not a live region');
  const saved = app.updateMealInstance(TODAY, instance.id, patchOf(rows));
  assert.ok(!('serving' in saved.ingredients[0]));
  assert.equal(saved.ingredients[0].quantity, 50);
  assert.deepEqual(saved.ingredients[1], instance.ingredients[1], 'the other row and its snapshot are unchanged');
  assert.equal(servingDropped({ foodId: CORE }, preview, 0), false, 'a row without a snapshot never shows the note');
  assert.equal(servingDropped(editRowsOf(instance)[0], null, 0), false, 'no preview yet: no note');
});

test('C8 display — 9b: once rows name their logged row, an added row never takes over a snapshot (domain)', () => {
  const { app, instance } = scoopMeal();
  // explicit for OATS, nothing for a re-added CORE: an added ingredient
  const out = app.updateMealInstance(TODAY, instance.id, { ingredients: [{ foodId: OATS, quantity: 40, snapshotIndex: 1 }, { foodId: CORE, quantity: 40 }] });
  assert.ok(!out.ingredients[1].serving);
  // with no snapshotIndex anywhere, the Stage 2 rule is unchanged: a single certain row keeps it
  const { app: app2, instance: i2 } = scoopMeal();
  const kept = app2.updateMealInstance(TODAY, i2.id, { ingredients: [{ foodId: CORE, quantity: 40 }, { foodId: OATS, quantity: 40 }] });
  assert.deepEqual(kept.ingredients[0].serving, i2.ingredients[0].serving);
});

/* ---------------- 10–11: the tray, and no arithmetic in the UI ---------------- */

test('C8 display — 10: the tray stays grams only', () => {
  assert.deepEqual(trayIngredients([{ foodId: CORE, foodName: 'Yogurt', text: '45' }]), [{ foodId: CORE, quantity: 45, unit: 'g' }]);
  const log = read('app/log.js');
  assert.match(log, /state\.tray\.push\(\{ foodId: ui\.food\.id, foodName: ui\.food\.name, text: added\.text \}\)/, 'a serving joins the tray as its grams');
  assert.ok(!/snapshotIndex|formatServingCount|numerator|denominator/.test(log), 'no serving metadata in Log or its tray');
  assert.ok(!/serving: /.test(log.slice(log.indexOf('export function trayIngredients'), log.indexOf('export function trayView'))));
});

test('C8 display — 11: no macro arithmetic, count formatting or forbidden terms in the UI', () => {
  for (const f of ['app/today.js', 'app/app.css', 'app/log.js', 'app/foods.js', 'app/amount.js']) {
    const src = read(f);
    assert.deepEqual(macroArithmeticInSource(src, f), [], f);
    assert.ok(!FORBIDDEN_NUTRITION.test(src), f);
    assert.ok(!/numerator|denominator/.test(src), `${f}: the count's text comes from the domain`);
  }
  assert.match(read('app/today.js'), /formatServingCount\(serving\.count\)/);
});

test('C8 display — 12: after Remove the editor keeps focus on a grams field; the grams column stays on one line', () => {
  const src = read('app/today.js');
  const i = src.indexOf("case 'remove-ingredient': {");
  const body = src.slice(i, src.indexOf('break;', i));
  assert.match(body, /ui\.rows\.splice\(Number\(el\.dataset\.index\), 1\);\n\s*drawDialog\(\);\n\s*updateEditPreview\(\);\n[^\n]*\n\s*dialog\.querySelector\(`#edit-q-\$\{Math\.min\(Number\(el\.dataset\.index\), ui\.rows\.length - 1\)\}`\)\?\.focus\(\);/);
  assert.match(read('app/app.css'), /\.ingredients tbody td:first-of-type \{ white-space: nowrap; \}/);
});
