/*
 * log-serving-logging.test.mjs — V3 Slice 1 · C8 Stage 4 follow-up: Log's quantity sheet logs a
 * named serving through the domain (app/log.js createLogActions.logFood and the log-food action).
 * The domain resolves the grams and writes the serving snapshot; Log only passes the serving and
 * the count as typed. Grams logging and the tray are unchanged. Synthetic data only.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, macroArithmeticInSource, FORBIDDEN_NUTRITION } from './helpers.mjs';
import { createDataLayer, createMemoryAdapter } from '../src/domain/index.js';
import { createFileAdapter } from '../src/node/file-adapter.js';
import { createLogActions, logErrorMessage, trayIngredients } from '../app/log.js';
import { resolveDraft, AMOUNT_MESSAGES } from '../app/amount.js';

const TODAY = '2026-09-27';
const SEED = createFileAdapter(ROOT).load();
const CORE = 'food_core_fage_0_greek_yogurt';
const OATS = 'food_custom_oats_overnight';
const code = (c) => (e) => e.code === c;
const src = fs.readFileSync(path.join(ROOT, 'app/log.js'), 'utf8');
/** The body of one `case '<name>':` in log.js's click handler. */
const caseBody = (name) => { const i = src.indexOf(`case '${name}': {`); return src.slice(i, src.indexOf('\n          }', i)); };

function setup() {
  const inner = createMemoryAdapter(SEED);
  const writes = [];
  const adapter = { load: () => inner.load(), save: (c, d) => inner.save(c, d), saveMany: (ch) => { writes.push(Object.keys(ch)); inner.saveMany(ch); } };
  let t = Date.parse(`${TODAY}T12:00:00Z`);
  let n = 0;
  const app = createDataLayer({ adapter, today: () => TODAY, clock: () => new Date((t += 60000)), newUuid: () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}` });
  return { app, writes, actions: createLogActions(app) };
}
const live = (app, foodId, id) => app.getServings(foodId).find((s) => s.id === id);
/** What the log-food case sends for a sheet draft (the same branch, from the domain's resolved amount). */
const amountFor = (app, foodId, draft) => {
  const { amount } = resolveDraft(app, foodId, draft);
  return amount.serving ? { servingId: amount.serving.id, count: draft.countText } : { quantity: amount.quantity };
};

test('C8 Log — 1–3: a serving and a typed count log through the domain, which keeps the serving’s snapshot and the exact count', () => {
  const { app, actions, writes } = setup();
  const scoop = app.createServing(CORE, { label: 'Scoop', grams: 30 });
  app.createDay(TODAY, 'lift');
  const draft = { mode: 'serving', gramsText: '', servingId: scoop.id, countText: '1 1/3', lastText: null };
  const n = writes.length;
  const result = actions.logFood({ date: TODAY, mealSlot: 'breakfast', foodId: CORE, ...amountFor(app, CORE, draft) });
  assert.equal(writes.length, n + 1, 'one write');
  const ing = result.instance.ingredients[0];
  const { createdAt: _c, updatedAt: _u, ...definition } = live(app, CORE, scoop.id);
  assert.deepEqual(ing.serving, { ...definition, count: { numerator: 4, denominator: 3 } }, 'the serving as defined now, and the count exactly');
  assert.equal(ing.quantity, resolveDraft(app, CORE, draft).amount.quantity, 'the grams the sheet previewed');
  assert.equal(result.message, `Logged ${app.getFood(CORE).name} to Breakfast.`);
  for (const [count, numerator, denominator] of [['0.25', 1, 4], ['1/2', 1, 2], ['2', 2, 1], ['1,5', 3, 2]]) {
    const r = actions.logFood({ date: TODAY, mealSlot: 'lunch', foodId: CORE, servingId: scoop.id, count });
    assert.deepEqual(r.instance.ingredients[0].serving.count, { numerator, denominator }, count);
  }
});

test('C8 Log — 2: snapshot values come from the domain’s serving, never from anything the caller adds', () => {
  const { app, actions } = setup();
  const scoop = app.createServing(CORE, { label: 'Scoop', grams: 30 });
  app.createDay(TODAY, 'lift');
  const r = actions.logFood({ date: TODAY, mealSlot: 'lunch', foodId: CORE, servingId: scoop.id, count: '1', serving: { id: scoop.id, label: 'Forged', grams: 99, approximate: true }, label: 'Forged', grams: 99, approximate: true });
  assert.deepEqual(r.instance.ingredients[0].serving, { id: scoop.id, label: 'Scoop', grams: 30, approximate: false, count: { numerator: 1, denominator: 1 } });
  assert.equal(r.instance.ingredients[0].quantity, 30);
  // the action has no way to pass a snapshot: it forwards only quantity, servingId and count
  const body = src.slice(src.indexOf('    logFood({ date, mealSlot, foodId, quantity, servingId, count, dayType }) {'), src.indexOf('    /** The tray as one logged meal'));
  assert.ok(!/label|grams|approximate|numerator|snapshot/.test(body.replace(/\/\/[^\n]*|\/\*[\s\S]*?\*\//g, '')), 'no serving metadata built in Log');
});

test('C8 Log — 4: an approximate serving keeps its approximate flag', () => {
  const { app, actions } = setup();
  const spoon = app.createServing(OATS, { label: 'Heaped spoon', grams: 12.5, approximate: true });
  const r = actions.logFood({ date: TODAY, mealSlot: 'snack_afternoon', foodId: OATS, servingId: spoon.id, count: '1.5', dayType: 'rest' });
  assert.deepEqual(r.instance.ingredients[0].serving, { id: spoon.id, label: 'Heaped spoon', grams: 12.5, approximate: true, count: { numerator: 3, denominator: 2 } });
  assert.equal(r.instance.ingredients[0].quantity, 18.75);
  assert.equal(app.getDay(TODAY).dayType, 'rest', 'the day-type step still creates the Day in the same write');
});

test('C8 Log — 5: grams logging is unchanged and creates no snapshot, even for a Food with servings', () => {
  const { app, actions } = setup();
  const scoop = app.createServing(CORE, { label: 'Scoop', grams: 30 });
  app.createDay(TODAY, 'lift');
  const draft = { mode: 'grams', gramsText: '45', servingId: scoop.id, countText: '1', lastText: null };
  assert.deepEqual(amountFor(app, CORE, draft), { quantity: 45 }, 'grams mode sends grams, though a serving was chosen before');
  const r = actions.logFood({ date: TODAY, mealSlot: 'lunch', foodId: CORE, ...amountFor(app, CORE, draft) });
  assert.ok(!('serving' in r.instance.ingredients[0]));
  assert.equal(r.instance.ingredients[0].quantity, 45);
  const plain = actions.logFood({ date: TODAY, mealSlot: 'lunch', foodId: OATS, quantity: 40 });
  assert.deepEqual(Object.keys(plain.instance.ingredients[0]), ['foodId', 'foodName', 'quantity', 'unit', 'protein', 'carbs', 'fat']);
});

test('C8 Log — 6: invalid or incomplete amounts can’t be logged, even calling the action directly; nothing is written', () => {
  const { app, actions, writes } = setup();
  const scoop = app.createServing(CORE, { label: 'Scoop', grams: 30 });
  const pouch = app.createServing(OATS, { label: 'Pouch', grams: 60 });
  app.createDay(TODAY, 'lift');
  const n = writes.length;
  const log = (amount) => () => actions.logFood({ date: TODAY, mealSlot: 'lunch', foodId: CORE, ...amount });
  for (const count of ['', '0', '1.', '1/', '1 1/', 'abc', '-1', '1/0', '1e2', '1.0000000000000000000001']) assert.throws(log({ servingId: scoop.id, count }), code('INVALID_SERVING_COUNT'), JSON.stringify(count));
  assert.throws(log({ servingId: scoop.id }), code('INVALID_SERVING_COUNT'), 'a serving without a count');
  assert.throws(log({ count: '1' }), code('SERVING_NOT_FOUND'), 'a count without a serving');
  assert.throws(log({ servingId: pouch.id, count: '1' }), code('SERVING_NOT_FOUND'), 'another Food’s serving');
  assert.throws(log({ servingId: 'srv_gone', count: '1' }), code('SERVING_NOT_FOUND'));
  assert.throws(log({ servingId: scoop.id, count: '1/10000' }), code('AMOUNT_TOO_SMALL'));
  assert.throws(log({ quantity: 30, servingId: scoop.id, count: '1' }), code('AMOUNT_AMBIGUOUS'), 'both forms');
  assert.throws(log({}), (e) => ['INVALID_QUANTITY', 'MEAL_INVALID'].includes(e.code), 'no amount at all');
  assert.equal(writes.length, n);
  assert.equal(app.getDay(TODAY).mealInstances.length, 0);
  // the sheet itself never gets that far: no resolved amount, no Log (showAmountError)
  assert.match(caseBody('log-food'), /resolveSheet\(ui\);[^\n]*\n\s*if \(!ui\.resolved\) \{ showAmountError\(\); break; \}/);
  for (const countText of ['', '0', '1.', '1/']) assert.equal(resolveDraft(app, CORE, { mode: 'serving', gramsText: '', servingId: scoop.id, countText, lastText: null }).amount, null, countText);
  // if one ever reached the domain, the message is the sheet's own
  assert.equal(logErrorMessage({ code: 'INVALID_SERVING_COUNT' }), AMOUNT_MESSAGES.INVALID_SERVING_COUNT);
  assert.equal(logErrorMessage({ code: 'AMOUNT_TOO_SMALL' }), AMOUNT_MESSAGES.AMOUNT_TOO_SMALL);
});

test('C8 Log — 7: the log-food action and the day-type step carry the serving; Add a serving still returns to the sheet with the new serving × 1', () => {
  assert.match(caseBody('log-food'), /const amount = ui\.resolved\.serving \? \{ servingId: ui\.resolved\.serving\.id, count: ui\.amount\.countText \} : \{ quantity: ui\.resolved\.quantity \};\n\s*commit\(\{ kind: 'food', slot, foodId: ui\.food\.id, amount \}\);/);
  assert.match(src, /else if \(spec\.kind === 'food'\) result = actions\.logFood\(\{ date: ctx\.date, mealSlot: spec\.slot, foodId: spec\.foodId, \.\.\.spec\.amount, dayType \}\);/, 'run() — also after the day-type step (continueTo keeps the spec)');
  assert.match(src, /continueTo: spec \}\); return; \}/);
  // C6 round trip, unchanged: the sheet reopens with its draft, the new serving selected × 1
  assert.match(src, /openFood\(q\.foodId, q\.text, q\.intent, q\.slot, \{ \.\.\.q\.amount, mode: 'serving', servingId: serving\.id, countText: '1' \}\);/);
});

test('C8 Log — 8: the tray stays grams only', () => {
  const { app, actions } = setup();
  const scoop = app.createServing(CORE, { label: 'Scoop', grams: 30 });
  app.createDay(TODAY, 'lift');
  const { amount } = resolveDraft(app, CORE, { mode: 'serving', gramsText: '', servingId: scoop.id, countText: '1 1/3', lastText: null });
  // add-to-tray pushes the serving's grams as text; logging the tray sends grams only
  const ingredients = trayIngredients([{ foodId: CORE, foodName: 'Fage', text: amount.text }, { foodId: OATS, foodName: 'Oats', text: '40' }]);
  assert.deepEqual(ingredients, [{ foodId: CORE, quantity: 40, unit: 'g' }, { foodId: OATS, quantity: 40, unit: 'g' }]);
  const r = actions.logTray({ date: TODAY, mealSlot: 'lunch', ingredients, mealName: 'Bowl', alsoSave: false });
  assert.ok(r.instance.ingredients.every((i) => !('serving' in i)));
  assert.match(caseBody('add-to-tray'), /state\.tray\.push\(\{ foodId: ui\.food\.id, foodName: ui\.food\.name, text: added\.text \}\);/);
  assert.ok(!/servingId|count:/.test(caseBody('add-to-tray')), 'no serving or count goes into the tray');
});

test('C8 Log — 9: no macro or serving-count arithmetic, and no forbidden terms, in Log', () => {
  assert.deepEqual(macroArithmeticInSource(src, 'app/log.js'), []);
  assert.ok(!FORBIDDEN_NUTRITION.test(src));
  assert.ok(!/servingQuantity|parseServingCount|formatServingCount|numerator|denominator|BigInt/.test(src), 'resolution and counts stay in the domain');
});
