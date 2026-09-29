/*
 * a48.test.mjs — A-48 (V2_UI_CONTRACT.md §7.4): a Custom Food edited from the Log flow returns
 * to the Log quantity sheet for that Food after Save changes, not to a standalone Food detail,
 * keeping the grams, slot and Log context. Cancel / Back / Escape keep the normal "Discard
 * changes?" rules and never save. Node has no DOM: the flow is checked through the Log screen's
 * source and the renderers; the real-browser path (Log → Custom Food → Edit → Save → quantity
 * sheet → Log) was checked at 320 / 375 / 800 / 1280 and 200% text (see the report).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, macroArithmeticInSource, FORBIDDEN_NUTRITION } from './helpers.mjs';
import { createDataLayer, createMemoryAdapter } from '../src/domain/index.js';
import { createFileAdapter } from '../src/node/file-adapter.js';
import { renderFoodSheet, logModel, resolveLogContext, customFoodPatch, customFoodValues } from '../app/log.js';
import { resetSession } from '../app/session.js';

const TODAY = '2026-09-27';
const SEED = createFileAdapter(ROOT).load();
const src = fs.readFileSync(path.join(ROOT, 'app/log.js'), 'utf8');
const fn = (name) => { const i = src.indexOf(name); assert.ok(i >= 0, name); return src.slice(i, src.indexOf('\n    }\n', i)); };
const caseBody = (label) => { const i = src.indexOf(`case '${label}':`); assert.ok(i >= 0, label); return src.slice(i, src.indexOf('\n          case ', i + 10)); };

function setup() {
  resetSession();
  let t = Date.parse(`${TODAY}T12:00:00Z`);
  const app = createDataLayer({ adapter: createMemoryAdapter(SEED), today: () => TODAY, clock: () => new Date((t += 60000)) });
  return app;
}

test('A-48 — Food details from the quantity sheet carries that sheet (Food, grams, slot, intent) through Food detail and Edit', () => {
  assert.match(src, /const quantityState = \(sheet\) => \(\{ foodId: sheet\.food\.id, text: sheet\.text \|\| '', slot: checkedSlot\('log-slot'\) \|\| sheet\.slot \|\| null, intent: sheet\.intent \|\| 'log' \}\);/,
    'the grams typed, the slot chosen on the sheet (or the Log context’s), and log vs add-to-meal');
  assert.match(src, /openFoodDetail\(el\.dataset\.food, '', ui && ui\.type === 'food' \? quantityState\(ui\) : null\)/);
  assert.match(fn('function openFoodDetail('), /ui = \{ type: 'food-detail', \.\.\.detail, note, quantity \};/);
  assert.match(caseBody('fd-edit'), /quantity: ui\.quantity \};/, 'the edit form knows where it came from');
  assert.match(caseBody('fd-delete'), /quantity: ui\.quantity \}/, 'so does the delete confirmation, which steps back to the detail');
});

test('A-48 — Save changes returns to the quantity sheet for the same Food with its grams, slot and intent', () => {
  const save = caseBody('cf-save');
  assert.match(save, /const food = foodActions\.updateCustomFood\(ui\.foodId, customFoodPatch\(ui\.values\)\);/, 'saved once, through the one Custom Food path');
  assert.match(save, /if \(q && q\.foodId === food\.id\) openFood\(food\.id, q\.text, q\.intent, q\.slot\);/);
  assert.match(save, /else openFoodDetail\(food\.id, 'Saved\.'\);/, 'without a quantity sheet behind it, §7.4’s Food detail as before');
  assert.ok(save.indexOf('openFood(food.id, q.text') < save.indexOf("openFoodDetail(food.id, 'Saved.')"));
  assert.match(fn('function openFood('), /function openFood\(foodId, text = '', intent = 'log', slot = ctx\.slot\) \{/, 'the date stays ctx.date; the slot defaults to the Log context');
  assert.match(fn('function openFood('), /previewLogFood\(\{ date: ctx\.date, foodId, quantity: q \}\)/, 'the preview reads the Food as just saved');
});

test('A-48 — the sheet it returns to shows the saved Food, the kept grams and slot, ready to Log', () => {
  const app = setup();
  const food = app.createCustomFood({ name: 'Zzq bar', category: 'snack bar', state: 'prepared', nutrition: { protein: 20, carbs: 40, fat: 10 } });
  app.createDay(TODAY, 'lift');
  const history = JSON.stringify(app.exportUserData().data.days);
  const values = { ...customFoodValues(food), name: 'Zzq bar plus', protein: '22' };
  const saved = app.updateCustomFood(food.id, customFoodPatch(values));
  assert.equal(saved.id, food.id, 'the same Food');
  const model = logModel(app, resolveLogContext(app, `#/log?from=today&date=${TODAY}&slot=dinner`));
  const sheet = renderFoodSheet({ model, food: app.getFood(food.id), text: '45', preview: app.previewLogFood({ date: TODAY, foodId: food.id, quantity: 45 }), slot: 'lunch', intent: 'log' });
  assert.match(sheet, /<h2 id="sheet-title" class="sheet-title">Zzq bar plus<\/h2>/);
  assert.match(sheet, /id="qty-grams"[^>]*value="45"/, 'grams kept');
  assert.match(sheet, /name="log-slot" value="lunch" checked/, 'the slot chosen on the sheet kept');
  assert.match(sheet, /data-action="log-food">Log</, 'ready to continue logging');
  assert.equal(JSON.stringify(app.exportUserData().data.days), history, 'editing a Food never touches history');
});

test('A-48 — Cancel, Back and Escape keep the normal discard rules and never save', () => {
  const leave = fn('function beforeLeave()');
  assert.match(leave, /if \(ui\.type === 'custom-food' && customFoodDirty\(ui\)\) \{ askDiscard\(ui, null\); return false; \}/, 'unsaved edits ask first');
  assert.match(leave, /if \(ui\.type === 'custom-food' && ui\.mode === 'edit'\) \{ openFoodDetail\(ui\.foodId, '', ui\.quantity\); return false; \}/, 'untouched: back to Food detail, still carrying the sheet');
  assert.match(fn('function discardChanges()'), /openFoodDetail\(form\.foodId, '', form\.quantity\);/);
  for (const f of ['function beforeLeave()', 'function discardChanges()', 'function guardLeave(', 'function askDiscard(', 'function reopenForm(']) {
    assert.ok(!/updateCustomFood|createCustomFood|app\.(update|create|set|delete)/.test(fn(f)), `${f} saves nothing`);
  }
  assert.equal((src.match(/updateCustomFood\(/g) || []).length, 1, 'one save path: Save changes');
});

test('A-48 — other contexts keep their behaviour; one Food detail, no second store', () => {
  for (const f of ['app/settings.js', 'app/today.js']) {
    const other = fs.readFileSync(path.join(ROOT, f), 'utf8');
    assert.match(other, /openFoodDetail\([^)]*'Saved\.'\)/, `${f}: Save changes still returns to Food detail`);
  }
  assert.ok(!/function renderFoodDetail/.test(src), 'the one Food detail (foods.js)');
  assert.ok(!/localStorage|sessionStorage|indexedDB|\bfetch\(/.test(src));
  assert.deepEqual(macroArithmeticInSource(src, 'app/log.js'), []);
  assert.ok(!FORBIDDEN_NUTRITION.test(src));
});
