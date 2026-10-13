/*
 * amount-control.test.mjs — V3 Slice 1 · C6: the shared amount control on Log's quantity sheet
 * and the Add a serving round trip (V2_UI_CONTRACT.md §5.5, §5.5.1, §5.5.2).
 * Pure renderers and draft helpers are checked directly; the DOM wiring in log.js is checked
 * through its source, as for A-42 / A-48 (Node has no DOM).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, macroArithmeticInSource, FORBIDDEN_NUTRITION, domainImportsBypassingIndex } from './helpers.mjs';
import { createDataLayer, createMemoryAdapter } from '../src/domain/index.js';
import { createFileAdapter } from '../src/node/file-adapter.js';
import { resetSession } from '../app/session.js';
import { parseGrams } from '../app/today.js';
import { renderDiscardFood } from '../app/foods.js';
import { renderFoodSheet, logModel, resolveLogContext, trayIngredients } from '../app/log.js';
import {
  startAmount, restoreAmount, resolveDraft, switchAmount, renderAmountControl, renderGramsField, renderServingGrams,
  renderServingForm, emptyServingValues, servingFormDirty, servingInput, AMOUNT_MESSAGES,
  renderActionsHint, servingActionsBlocked, SERVING_ACTIONS_HINT
} from '../app/amount.js';

const TODAY = '2026-09-27';
const SEED = createFileAdapter(ROOT).load();
const CORE = 'food_core_fage_0_greek_yogurt';
const OATS = 'food_custom_oats_overnight';
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const logSrc = read('app/log.js');
const fn = (name) => { const i = logSrc.indexOf(name); assert.ok(i >= 0, name); return logSrc.slice(i, logSrc.indexOf('\n    }\n', i)); };
const caseBody = (label) => { const i = logSrc.indexOf(`case '${label}':`); assert.ok(i >= 0, label); return logSrc.slice(i, logSrc.indexOf('\n          case ', i + 10)); };
const text = (html) => html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();

function setup() {
  resetSession();
  let t = Date.parse(`${TODAY}T12:00:00Z`);
  let n = 0;
  const app = createDataLayer({
    adapter: createMemoryAdapter(SEED), today: () => TODAY, clock: () => new Date((t += 60000)),
    newUuid: () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`
  });
  app.createDay(TODAY, 'lift');
  const model = logModel(app, resolveLogContext(app, `#/log?from=today&date=${TODAY}&slot=lunch`));
  return { app, model };
}
/** What log.js renders for an open sheet: the draft resolved and previewed through the domain. */
function sheetFor(app, model, foodId, draft, extra = {}) {
  const { gramsText, ...amount } = draft;
  const { amount: resolved, error } = resolveDraft(app, foodId, draft);
  const preview = resolved ? app.previewLogFood({ date: TODAY, foodId, quantity: resolved.quantity }) : null;
  return { html: renderFoodSheet({ model, food: app.getFood(foodId), text: gramsText, preview, slot: 'lunch', servings: app.getServings(foodId), amount, resolved, amountError: error, ...extra }), resolved, preview };
}

/* ---------------- a Food without servings keeps the grams sheet ---------------- */

const OLD_GRAMS_FIELD = `<label class="field" for="qty-grams">Grams</label>
<span class="grams-input"><input id="qty-grams" type="text" inputmode="decimal" autocomplete="off" data-grams value="" placeholder="grams" aria-describedby="qty-error"><span aria-hidden="true">g</span></span>
<p id="qty-error" class="field-error" data-grams-error hidden>Enter a weight above 0 g</p>`;

test('gram-only Food — the grams field exactly as before, empty by default; the one addition is Add a serving', () => {
  const { app, model } = setup();
  const draft = startAmount(app, OATS, '');
  assert.deepEqual(draft, { mode: 'grams', gramsText: '', servingId: null, countText: '1', lastText: null });
  const { html } = sheetFor(app, model, OATS, draft);
  assert.equal(renderGramsField(''), OLD_GRAMS_FIELD);
  assert.ok(html.includes(OLD_GRAMS_FIELD), 'the same grams markup');
  assert.ok(html.includes(`aria-label="Details for Oats overnight">Food details</button></p>
<p><button type="button" class="link-button" data-action="add-serving" data-food="${OATS}" aria-label="Add a serving for Oats overnight">Add a serving</button></p>
${OLD_GRAMS_FIELD}
<div class="preview"`), 'Food details, then Add a serving, then the grams field and the preview, nothing else between');
  for (const marker of ['amount-mode', 'data-serving', 'data-count', 'count-pick', 'data-amount-status', '≈', 'estimate']) assert.ok(!html.includes(marker), marker);
  assert.match(html, /data-action="log-food" disabled/);
  assert.match(html, /data-action="add-to-tray" disabled/);
  // Sheets rendered without the new fields (as every existing caller does) are the same.
  assert.equal(renderFoodSheet({ model, food: app.getFood(OATS), text: '', preview: null, slot: 'lunch' }), html);
});

test('gram-only Food — grams resolve to exactly the number typed (parseGrams), as before', () => {
  const { app } = setup();
  for (const t of ['120', '45.123', '1,5', ' 80 ']) {
    const { amount, error } = resolveDraft(app, OATS, { mode: 'grams', gramsText: t, servingId: null, countText: '1' });
    assert.equal(error, null);
    assert.equal(amount.quantity, parseGrams(t), t);
    assert.equal(amount.text, String(parseGrams(t)));
    assert.equal(amount.serving, null);
  }
  assert.deepEqual(resolveDraft(app, OATS, { mode: 'grams', gramsText: '' }), { amount: null, error: null }, 'nothing typed: no error yet');
  for (const t of ['0', '-3', 'abc']) assert.deepEqual(resolveDraft(app, OATS, { mode: 'grams', gramsText: t }), { amount: null, error: 'INVALID_QUANTITY' }, t);
});

/* ---------------- a Food with servings ---------------- */

test('serving mode — opens on the first serving × 1; the preview is of the canonical grams', () => {
  const { app, model } = setup();
  const scoop = app.createServing(CORE, { label: 'Scoop', grams: 30 });
  app.createServing(CORE, { label: 'Tub', grams: 170, approximate: true });
  const draft = startAmount(app, CORE, '');
  assert.deepEqual(draft, { mode: 'serving', gramsText: '', servingId: scoop.id, countText: '1', lastText: null });
  const { html, resolved, preview } = sheetFor(app, model, CORE, draft);
  assert.equal(resolved.quantity, 30);
  assert.equal(preview.ingredients[0].quantity, 30);
  assert.match(html, /<input type="radio" name="amount-mode" value="serving" data-amount-mode checked><span>Servings<\/span>/);
  assert.match(html, /<input type="radio" name="amount-mode" value="grams" data-amount-mode><span>Grams<\/span>/, 'grams one tap away');
  assert.match(html, new RegExp(`<option value="${scoop.id}" selected>Scoop</option>`));
  assert.match(html, /<option value="srv_[^"]+">Tub \(estimate\)<\/option>/);
  assert.match(html, /id="qty-count"[^>]*value="1"/);
  assert.match(html, /data-count-pick="1" aria-label="1 serving" aria-pressed="true">1</);
  assert.match(html, /data-count-pick="1\/2" aria-label="half a serving" aria-pressed="false">½</);
  assert.deepEqual([...html.matchAll(/data-count-pick="([^"]+)"/g)].map((m) => m[1]), ['1/4', '1/2', '3/4', '1', '2']);
  assert.match(html, /<p id="qty-serving-grams" class="serving-grams" data-serving-grams>Logs as 30 g<\/p>/);
  assert.match(html, /data-amount-status role="status"/);
  assert.match(html, /<button type="button" class="button primary" data-action="log-food">Log</);
  assert.ok(!html.includes('qty-grams'), 'the grams field is behind the Grams choice');
});

test('serving mode — count errors next to the count; nothing typed shows no error; actions disabled', () => {
  const { app, model } = setup();
  const s = app.createServing(CORE, { label: 'Scoop', grams: 30 });
  const d = (countText) => ({ mode: 'serving', gramsText: '', servingId: s.id, countText, lastText: null });
  assert.deepEqual(resolveDraft(app, CORE, d('')), { amount: null, error: null });
  assert.deepEqual(resolveDraft(app, CORE, d('0')), { amount: null, error: null }, 'a lone 0 may still become 0.5: no error yet, no amount');
  assert.equal(resolveDraft(app, CORE, d('0.0')).error, 'INVALID_SERVING_COUNT');
  assert.equal(resolveDraft(app, CORE, d('1/2/3')).error, 'INVALID_SERVING_COUNT');
  const tiny = app.createServing(CORE, { label: 'Pinch', grams: 0.01 });
  assert.equal(resolveDraft(app, CORE, { ...d('1/4'), servingId: tiny.id }).error, 'AMOUNT_TOO_SMALL');
  assert.equal(resolveDraft(app, CORE, { ...d('1'), servingId: 'srv_gone' }).error, 'SERVING_NOT_FOUND');
  const { html } = sheetFor(app, model, CORE, d('0/3'));
  assert.match(html, /<p id="qty-count-error" class="field-error" data-count-error>Enter a number of servings above 0, like 1, 1\.5 or 1\/2\.<\/p>/);
  assert.match(html, /data-action="log-food" disabled/);
  assert.match(html, /data-action="add-to-tray" disabled/);
  assert.match(sheetFor(app, model, CORE, d('')).html, /data-count-error hidden>/);
  assert.equal(AMOUNT_MESSAGES.AMOUNT_TOO_SMALL, 'That comes to less than 0.01 g. Enter more servings.');
  assert.throws(() => resolveDraft(app, 'food_nope', d('1')), (e) => e.code === 'FOOD_NOT_FOUND', 'a deleted Food is not an amount error');
});

test('approximate wording — ≈ and "estimate" only for an approximate serving, spoken as "approximately"; rounding is said plainly', () => {
  const { app } = setup();
  const tub = app.createServing(CORE, { label: 'Tub', grams: 100, approximate: true });
  const cup = app.createServing(CORE, { label: 'Cup', grams: 100 });
  const approx = renderServingGrams(app.resolveAmount(CORE, { servingId: tub.id, count: '1' }));
  assert.equal(approx, 'Logs as <span aria-hidden="true">≈ </span><span class="visually-hidden">approximately </span>100 g <span class="estimate-label">estimate</span>');
  assert.equal(text(approx.replace(/<span aria-hidden="true">[^<]*<\/span>/g, '')), 'Logs as approximately 100 g estimate', 'what a screen reader hears');
  const plain = renderServingGrams(app.resolveAmount(CORE, { servingId: cup.id, count: '1/3' }));
  assert.equal(plain, 'Logs as 33.33 g <span class="hint">(rounded to 0.01 g)</span>');
  assert.ok(!plain.includes('≈') && !plain.includes('estimate') && !plain.includes('approximately'), 'rounding is not an estimate');
  assert.equal(renderServingGrams(app.resolveAmount(CORE, { quantity: 50 })), '', 'nothing for grams');
  assert.equal(renderServingGrams(null), '');
});

/* ---------------- switching modes (D9) and restoring a draft ---------------- */

test('switching — serving → grams fills the canonical grams; grams → serving takes the last one chosen in this sheet, count 1', () => {
  const { app } = setup();
  const a = app.createServing(CORE, { label: 'Scoop', grams: 30 });
  const b = app.createServing(CORE, { label: 'Cup', grams: 100 });
  let draft = { mode: 'serving', gramsText: '12', servingId: b.id, countText: '1/3', lastText: null };
  const resolved = resolveDraft(app, CORE, draft).amount;
  draft = switchAmount(app, CORE, draft, 'grams', resolved);
  assert.deepEqual(draft, { mode: 'grams', gramsText: '33.33', servingId: b.id, countText: '1/3', lastText: null }, 'the same number either way; the serving is remembered in the sheet');
  assert.equal(resolveDraft(app, CORE, draft).amount.quantity, resolved.quantity);
  draft = switchAmount(app, CORE, { ...draft, gramsText: '50' }, 'serving');
  assert.deepEqual(draft, { mode: 'serving', gramsText: '50', servingId: b.id, countText: '1', lastText: null }, 'last chosen, count reset to 1');
  // An unresolved serving → grams keeps whatever grams were typed.
  assert.equal(switchAmount(app, CORE, { ...draft, countText: '' }, 'grams', null).gramsText, '50');
  // The last chosen serving gone (or never chosen): the first.
  assert.equal(switchAmount(app, CORE, { mode: 'grams', gramsText: '', servingId: 'srv_gone', countText: '2' }, 'serving').servingId, a.id);
  assert.equal(switchAmount(app, CORE, { mode: 'grams', gramsText: '', servingId: null, countText: '2' }, 'serving').countText, '1');
  // A Food with no servings stays in grams.
  assert.equal(switchAmount(app, OATS, { mode: 'grams', gramsText: '', servingId: null, countText: '1' }, 'serving').mode, 'grams');
});

test('restoring — a draft comes back as left; a serving that has gone falls back to grams with its last quantity and a notice', () => {
  const { app } = setup();
  const a = app.createServing(CORE, { label: 'Scoop', grams: 30 });
  const kept = { mode: 'serving', gramsText: '7', servingId: a.id, countText: '1 1/2', lastText: '45' };
  assert.deepEqual(restoreAmount(app, CORE, kept), { draft: kept, notice: '' });
  const gone = restoreAmount(app, CORE, { ...kept, servingId: 'srv_gone' });
  assert.deepEqual(gone.draft, { mode: 'grams', gramsText: '45', servingId: null, countText: '1 1/2', lastText: '45' });
  assert.equal(gone.notice, 'That serving no longer exists, so this is in grams now.');
  assert.equal(restoreAmount(app, CORE, { ...kept, servingId: 'srv_gone', lastText: null }).draft.gramsText, '7', 'never resolved: the grams typed');
  assert.deepEqual(restoreAmount(app, CORE, { ...kept, mode: 'grams', servingId: 'srv_gone' }).draft.servingId, null);
  const sheet = sheetFor(app, setup().model, CORE, gone.draft, { notice: gone.notice }).html;
  assert.match(sheet, /data-amount-status role="status" aria-live="polite">That serving no longer exists, so this is in grams now\.</);
});

/* ---------------- one canonical quantity: preview, Log and the tray ---------------- */

test('preview, Log and Add to a meal all get the same canonical grams', () => {
  const { app } = setup();
  const cases = [[100, '1/3', 33.33], [12.5, '3/4', 9.38], [0.1, '3', 0.3], [45, '1.5', 67.5], [30, '1/3', 10], [200, '2/3', 133.33]];
  for (const [grams, count, expected] of cases) {
    const s = app.createServing(CORE, { label: `S ${grams} ${count}`, grams });
    const { amount } = resolveDraft(app, CORE, { mode: 'serving', gramsText: '', servingId: s.id, countText: count, lastText: null });
    assert.equal(amount.quantity, expected, `${grams} × ${count}`);
    const preview = app.previewLogFood({ date: TODAY, foodId: CORE, quantity: amount.quantity });
    assert.equal(preview.ingredients[0].quantity, expected, 'preview');
    // The tray row is the text log.js pushes; logging the tray reads it back as the same number.
    assert.deepEqual(trayIngredients([{ foodId: CORE, foodName: 'x', text: amount.text }]), [{ foodId: CORE, quantity: expected, unit: 'g' }], 'tray');
    const logged = app.logFood({ date: TODAY, mealSlot: 'lunch', foodId: CORE, quantity: amount.quantity });
    assert.equal(logged.ingredients[0].quantity, expected, 'Log');
  }
  // log.js takes the number from the same resolved amount in all three places.
  assert.match(fn('function resolveSheet('), /previewLogFood\(\{ date: ctx\.date, foodId: sheet\.food\.id, quantity: amount\.quantity \}\)/);
  assert.match(caseBody('log-food'), /resolveSheet\(ui\);[^\n]*\n\s*if \(!ui\.resolved\) \{ showAmountError\(\); break; \}[\s\S]*commit\(\{ kind: 'food', slot, foodId: ui\.food\.id, quantity: ui\.resolved\.quantity \}\);/);
  assert.match(caseBody('add-to-tray'), /state\.tray\.push\(\{ foodId: ui\.food\.id, foodName: ui\.food\.name, text: added\.text \}\);\n\s*confirmation = \{ message: `Added \$\{ui\.food\.name\} as \$\{added\.text\} g\.` \};/);
  assert.match(caseBody('add-to-tray'), /const q = added\.quantity; \/\/ grams as typed, exactly as before\n\s*state\.tray\.push\(\{ foodId: ui\.food\.id, foodName: ui\.food\.name, text: String\(q\) \}\);/, 'grams mode adds what it always did, silently');
  assert.ok(!/serving|approximate|≈|estimate/.test(caseBody('add-to-tray').replace(/added\.serving|\/\/[^\n]*/g, '')), 'no serving metadata goes into the tray');
});

/* ---------------- Add a serving ---------------- */

test('Add a serving — the form: name, grams, estimate; errors by field after Save; dirty means anything typed', () => {
  const { app } = setup();
  const food = app.getFood(CORE);
  const values = emptyServingValues();
  const html = renderServingForm({ food, values });
  assert.match(html, /<h2 id="sheet-title" class="sheet-title">Add a serving<\/h2>/);
  assert.match(html, /<label class="field" for="srv-label">Name<\/label>\n<input id="srv-label" type="text" data-srv="label" value=""/);
  assert.match(html, /<label class="field" for="srv-grams">Grams in one serving<\/label>/);
  assert.match(html, /<input type="checkbox" data-srv="approximate">/);
  assert.match(html, /data-action="srv-save">Save serving</);
  assert.match(html, /data-action="close">Cancel</);
  assert.match(html, /role="alert" data-error hidden/);
  const bad = renderServingForm({ food, values: { label: 'g', grams: '1.234', approximate: false }, errors: [{ field: 'label', code: 'SERVING_LABEL_RESERVED' }, { field: 'grams', code: 'INVALID_SERVING_GRAMS' }] });
  assert.match(bad, /aria-invalid="true"/);
  assert.match(bad, /<p id="srv-label-error" class="field-error">Grams are always available\. Use another name\.<\/p>/);
  assert.match(bad, /<p id="srv-grams-error" class="field-error">Enter grams above 0, with up to 2 decimal places\.<\/p>/);
  const form = { values: emptyServingValues(), initial: emptyServingValues() };
  assert.equal(servingFormDirty(form), false);
  for (const change of [{ label: 'x' }, { grams: '3' }, { approximate: true }]) assert.equal(servingFormDirty({ ...form, values: { ...form.values, ...change } }), true, JSON.stringify(change));
  assert.deepEqual(servingInput({ label: ' Scoop ', grams: '1,5', approximate: true }), { label: ' Scoop ', grams: 1.5, approximate: true });
  assert.deepEqual(servingInput({ label: 'Scoop', grams: 'abc', approximate: false }), { label: 'Scoop', grams: null, approximate: false }, 'the domain reports it');
  for (const g of ['45.', '1e2', '0x10']) {
    assert.equal(servingInput({ label: 'Scoop', grams: g, approximate: false }).grams, null, `${g}: unfinished or malformed weights are never saved`);
    assert.throws(() => app.createServing(CORE, servingInput({ label: 'Scoop', grams: g, approximate: false })), (e) => e.code === 'INVALID_SERVING' && e.details[0].code === 'INVALID_SERVING_GRAMS', g);
  }
  assert.deepEqual(app.getServings(CORE), []);
  assert.throws(() => app.createServing(CORE, servingInput({ label: 'Scoop', grams: '', approximate: false })), (e) => e.code === 'INVALID_SERVING');
  assert.match(text(renderDiscardFood({ serving: true })), /Discard changes\? This new serving hasn’t been saved\. Keep editing Discard/);
});

test('Add a serving — Save: one domain call, back to the sheet as it was left with the new serving × 1', () => {
  assert.match(fn('function openServingForm('), /ui = \{ type: 'add-serving', food: ui\.food, values, initial: \{ \.\.\.values \}, errors: \[\], quantity: quantityState\(ui\) \};/, 'carries the sheet as it was left');
  const save = fn('function saveServing(');
  assert.equal((save.match(/app\.createServing\(/g) || []).length, 1);
  assert.equal((logSrc.match(/app\.createServing\(/g) || []).length, 1, 'the one path that creates a serving');
  assert.match(save, /if \(!e \|\| e\.code !== 'INVALID_SERVING'\) throw e;\n\s*form\.errors = e\.details \|\| \[\];/, 'field problems stay on the form; anything else goes to the error path');
  assert.match(save, /openFood\(q\.foodId, q\.text, q\.intent, q\.slot, \{ \.\.\.q\.amount, mode: 'serving', servingId: serving\.id, countText: '1' \}\);/);
  assert.match(save, /announceAmount\(`Serving added: \$\{serving\.label\}\.`\);/);
  assert.match(logSrc, /const quantityState = \(sheet\) => \(\{ foodId: sheet\.food\.id, text: sheet\.text \|\| '', slot: checkedSlot\('log-slot'\) \|\| sheet\.slot \|\| null, intent: sheet\.intent \|\| 'log', date: ctx\.date, amount: \{ \.\.\.sheet\.amount \} \}\);/,
    'Food, grams typed, slot, log or add-to-meal, date, mode, serving, count');
  assert.match(logSrc, /case 'add-serving': openServingForm\(\); break;\n\s*case 'srv-save': saveServing\(\); break;/);
});

test('Add a serving — Cancel / Back / Escape return to the sheet exactly; anything typed asks "Discard changes?" first; nothing is saved', () => {
  const leave = fn('function beforeLeave()');
  assert.match(leave, /if \(ui\.type === 'add-serving' && servingFormDirty\(ui\)\) \{ askDiscard\(ui, null\); return false; \}\n\s*if \(ui\.type === 'add-serving'\) \{ returnToSheet\(ui\.quantity\); return false; \}/);
  assert.match(fn('function guardLeave('), /if \(ui\.type === 'add-serving' && servingFormDirty\(ui\)\) \{ askDiscard\(ui, proceed\); return false; \}/, 'leaving Log asks too');
  assert.match(fn('function discardChanges()'), /\} else if \(form\.type === 'add-serving'\) \{\n\s*returnToSheet\(form\.quantity\);/);
  assert.match(fn('function returnToSheet('), /openFood\(q\.foodId, q\.text, q\.intent, q\.slot, q\.amount\);/);
  assert.match(logSrc, /case 'discard-food': dialog\.innerHTML = renderDiscardFood\(\{\n\s*created: ui\.form\.mode !== 'edit',\n\s*serving: ui\.form\.type === 'add-serving' \|\| \(ui\.form\.type === 'serving-form' && ui\.form\.mode === 'add'\),\n\s*editedServing: ui\.form\.type === 'serving-form' && ui\.form\.mode === 'edit'\n\s*\}\); break;/, 'the new-serving wording for Add a serving (C6), and for the Food detail serving form (C7)');
  for (const f of ['function beforeLeave()', 'function discardChanges()', 'function guardLeave(', 'function returnToSheet(', 'function openServingForm(']) {
    assert.ok(!/app\.(create|update|set|delete|log)|actions\./.test(fn(f)), `${f} saves nothing`);
  }
});

test('round trips — Food detail and the Custom Food edit carry the whole draft back; a deleted Food keeps its handling', () => {
  assert.match(fn('function beforeLeave()'), /const q = ui\.quantity;\n\s*openFood\(q\.foodId, q\.text, q\.intent, q\.slot, q\.amount\);/, 'A-42');
  assert.match(caseBody('cf-save'), /openFood\(food\.id, q\.text, q\.intent, q\.slot, q\.amount\);/, 'A-48');
  const open = fn('function openFood(');
  assert.match(open, /if \(!food\) \{ foodGone\(\); return; \}/);
  assert.match(open, /const start = amount \? restoreAmount\(app, foodId, \{ \.\.\.amount, gramsText: text \}\) : \{ draft: startAmount\(app, foodId, text\), notice: '' \};/);
  assert.match(logSrc, /const foodSurface = \(\) => !ui \|\| \['food', 'food-detail', 'tray', 'add-serving', 'serving-form', 'serving-delete'\]\.includes\(ui\.type\)/, 'a Food deleted under Add a serving (or a C7 serving form / dialog) reads as "That food no longer exists."');
  assert.match(logSrc, /else if \(ui\.type === 'food' && el\.matches\('\[data-amount-mode\]'\)\) \{\n\s*\/\/[^\n]*\n\s*ui\.slot = checkedSlot\('log-slot'\) \|\| ui\.slot;/, 'switching mode keeps the slot chosen');
});

/* ---------------- boundaries ---------------- */

test('amount control — no conversion, rounding, formatting or macro arithmetic in the UI; memory only; domain via its entry point', () => {
  for (const f of ['app/amount.js', 'app/log.js', 'app/foods.js', 'app/app.css']) {
    const src = read(f);
    assert.deepEqual(macroArithmeticInSource(src, f), [], f);
    assert.ok(!FORBIDDEN_NUTRITION.test(src), f);
    assert.deepEqual(domainImportsBypassingIndex(src), [], f);
    assert.ok(!/localStorage|sessionStorage|indexedDB|\bfetch\(/.test(src), `${f}: no second store; drafts stay in memory`);
  }
  const code = read('app/amount.js').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/`(?:\\.|[^`\\])*`|'(?:\\.|[^'\\\n])*'|"(?:\\.|[^"\\\n])*"/g, '""');
  assert.ok(!/[^*/]\*[^*/]|\/(?![/*])\s*\d|\bMath\.|toFixed|toPrecision|BigInt|parseFloat|Number\(/.test(code), 'no arithmetic or number formatting in amount.js');
  for (const f of ['app/amount.js', 'app/log.js']) assert.ok(!/servingQuantity|decimalPlaces|parseServingCount/.test(read(f)), `${f}: resolution goes through resolveAmount`);
  assert.ok(!/\b(?:s|serving|amount\.serving)\.grams\b/.test(read('app/amount.js').replace(/\/\*[\s\S]*?\*\//g, '')), 'amount.js never reads a serving weight');
});

/* ---------------- audit: unfinished counts can be typed through, never logged ---------------- */

test('unfinished counts — no error while typing, no amount, no preview, Log and Add to a meal off; pressing them says why', () => {
  const { app, model } = setup();
  const s = app.createServing(CORE, { label: 'Tub', grams: 170 });
  for (const countText of ['1.', '1,', '.', '0.', '1/', '1 1', '1 1/']) {
    const draft = { mode: 'serving', gramsText: '', servingId: s.id, countText, lastText: null };
    assert.deepEqual(resolveDraft(app, CORE, draft), { amount: null, error: null }, `${countText}: still typing`);
    const { html, preview } = sheetFor(app, model, CORE, draft);
    assert.equal(preview, null);
    assert.match(html, /data-count-error hidden>/, `${countText}: no error shown`);
    assert.match(html, /data-action="log-food" disabled/, `${countText}: can't be logged`);
    assert.match(html, /data-action="add-to-tray" disabled/, `${countText}: can't be added to a meal`);
    assert.match(html, /data-serving-grams><\/p>/, 'no "Logs as" line');
  }
  // Finished, the same field resolves; a finished but invalid count still shows the message.
  assert.equal(resolveDraft(app, CORE, { mode: 'serving', gramsText: '', servingId: s.id, countText: '1.5', lastText: null }).amount.quantity, 255);
  assert.equal(resolveDraft(app, CORE, { mode: 'serving', gramsText: '', servingId: s.id, countText: '1/0', lastText: null }).error, 'INVALID_SERVING_COUNT');
  assert.equal(resolveDraft(app, CORE, { mode: 'serving', gramsText: '', servingId: s.id, countText: '0 1/2', lastText: null }).amount.quantity, 85);
  // The action paths re-resolve and refuse without an amount, showing the count message.
  for (const label of ['log-food', 'add-to-tray']) assert.match(caseBody(label), /resolveSheet\(ui\);[^\n]*\n\s*if \(!ui\.resolved\) \{ showAmountError\(\); break; \}/, label);
  assert.match(fn('function showAmountError('), /countError\.textContent = AMOUNT_MESSAGES\[ui\.amountError\] \|\| AMOUNT_MESSAGES\.INVALID_SERVING_COUNT;/);
});

/* ---------------- browser smoke-test follow-up: a leading 0 (option a) ---------------- */

test('leading 0 — "0" and "0 " while editing: no error, no amount, no preview, actions off', () => {
  const { app, model } = setup();
  const s = app.createServing(CORE, { label: 'Tub', grams: 170 });
  for (const countText of ['0', '0 ', ' 0']) {
    const draft = { mode: 'serving', gramsText: '', servingId: s.id, countText, lastText: null };
    assert.deepEqual(resolveDraft(app, CORE, draft), { amount: null, error: null }, JSON.stringify(countText));
    const { html, preview } = sheetFor(app, model, CORE, draft);
    assert.equal(preview, null);
    assert.match(html, /data-count-error hidden>/);
    assert.match(html, /data-serving-grams><\/p>/);
    assert.match(html, /data-action="log-food" disabled/);
    assert.match(html, /data-action="add-to-tray" disabled/);
  }
});

test('leading 0 — "0" can never be logged or added: Log and Add to a meal re-resolve, refuse and show the message; the domain refuses directly', () => {
  const { app } = setup();
  const s = app.createServing(CORE, { label: 'Tub', grams: 170 });
  // The two action paths (even with the buttons forced on) resolve through the domain and stop without an amount.
  for (const label of ['log-food', 'add-to-tray']) {
    const body = caseBody(label);
    assert.match(body, /resolveSheet\(ui\);[^\n]*\n\s*if \(!ui\.resolved\) \{ showAmountError\(\); break; \}/, `${label}: refused without an amount`);
    assert.ok(body.indexOf('showAmountError()') < body.search(/commit\(|state\.tray\.push/), `${label}: refused before anything is logged or added`);
  }
  // …and showAmountError reveals the count message even though nothing was shown while typing.
  assert.match(fn('function showAmountError('), /if \(ui\.amount\.mode === 'serving'\) \{\n\s*const countError = dialog\.querySelector\('\[data-count-error\]'\);\n\s*if \(countError\) \{ countError\.textContent = AMOUNT_MESSAGES\[ui\.amountError\] \|\| AMOUNT_MESSAGES\.INVALID_SERVING_COUNT; countError\.hidden = false; \}/);
  assert.equal(AMOUNT_MESSAGES.INVALID_SERVING_COUNT, 'Enter a number of servings above 0, like 1, 1.5 or 1/2.');
  // Direct invocation: the domain never accepts a zero count or a zero quantity.
  for (const count of ['0', '0 ', '00', '0.0', '0/3']) assert.throws(() => app.resolveAmount(CORE, { servingId: s.id, count }), (e) => e.code === 'INVALID_SERVING_COUNT', JSON.stringify(count));
  assert.throws(() => app.logFood({ date: TODAY, mealSlot: 'lunch', foodId: CORE, quantity: 0 }), (e) => ['INVALID_QUANTITY', 'MEAL_INVALID'].includes(e.code), 'a zero quantity is refused (§13.3 maps both to the weight message)');
  assert.deepEqual(app.getDaySummary(TODAY).exists ? app.getDay(TODAY).mealInstances : [], [], 'nothing logged');
});

test('leading 0 — 0.5, 0,5, 0.25 and 0 1/2 resolve normally, with no error at any step on the way', () => {
  const { app } = setup();
  const s = app.createServing(CORE, { label: 'Tub', grams: 170 });
  const want = { '0.5': 85, '0,5': 85, '0.25': 42.5, '0 1/2': 85 };
  for (const [full, grams] of Object.entries(want)) {
    for (let i = 1; i <= full.length; i++) {
      const countText = full.slice(0, i);
      const r = resolveDraft(app, CORE, { mode: 'serving', gramsText: '', servingId: s.id, countText, lastText: null });
      assert.equal(r.error, null, `no error at ${JSON.stringify(countText)} on the way to ${full}`);
      if (i === full.length) assert.equal(r.amount.quantity, grams, full);
    }
  }
});

test('leading 0 — grams mode is unchanged: "0" in the grams field is still an error at once', () => {
  const { app } = setup();
  assert.deepEqual(resolveDraft(app, CORE, { mode: 'grams', gramsText: '0', servingId: null, countText: '1' }), { amount: null, error: 'INVALID_QUANTITY' });
  assert.ok(!/isUnfinishedServingCount/.test(read('app/log.js')) && !/isUnfinishedServingCount/.test(read('app/today.js')), 'only the serving count uses it');
});

/* ---------------- why the actions are off: the serving-count hint (§5.5.1) ---------------- */

const HINT_SHOWN = /<p id="qty-actions-hint" class="hint actions-hint" data-actions-hint>Enter a number of servings greater than 0 to continue\.<\/p>\n<div class="sheet-actions">/;
const HINT_HIDDEN = /<p id="qty-actions-hint" class="hint actions-hint" data-actions-hint hidden>/;

test('actions hint — "0" and "0 ": hint shown above the actions, no amount, actions disabled and described by it, no error', () => {
  const { app, model } = setup();
  const s = app.createServing(CORE, { label: 'Tub', grams: 170 });
  assert.equal(SERVING_ACTIONS_HINT, 'Enter a number of servings greater than 0 to continue.');
  for (const countText of ['0', '0 ']) {
    const draft = { mode: 'serving', gramsText: '', servingId: s.id, countText, lastText: null };
    const { html, resolved } = sheetFor(app, model, CORE, draft);
    assert.equal(resolved, null);
    assert.match(html, HINT_SHOWN, JSON.stringify(countText));
    assert.match(html, /data-action="log-food" disabled aria-describedby="qty-actions-hint">Log</);
    assert.match(html, /data-action="add-to-tray" disabled aria-describedby="qty-actions-hint">Add to a meal</);
    assert.match(html, /data-count-error hidden>/, 'no error flash');
    assert.match(html, /aria-describedby="qty-count-error qty-serving-grams qty-actions-hint"/, 'the count field is described by the hint');
    assert.ok(!/data-actions-hint[^>]*(role=|aria-live)/.test(html), 'not a live region');
  }
});

test('actions hint — other unfinished counts: hint, no error; invalid counts: hint and the count message', () => {
  const { app, model } = setup();
  const s = app.createServing(CORE, { label: 'Tub', grams: 170 });
  const d = (countText) => ({ mode: 'serving', gramsText: '', servingId: s.id, countText, lastText: null });
  for (const c of ['', '.', '0.', '1.', '1,', '1/', '1 1', '1 1/']) {
    const { html } = sheetFor(app, model, CORE, d(c));
    assert.match(html, HINT_SHOWN, JSON.stringify(c));
    assert.match(html, /data-count-error hidden>/, `${JSON.stringify(c)}: no error flash`);
    assert.match(html, /data-action="log-food" disabled/);
    assert.match(html, /data-action="add-to-tray" disabled/);
  }
  for (const c of ['00', '0.0', '0/3', '-1', '1/0', 'abc', '1/2/3']) {
    const { html } = sheetFor(app, model, CORE, d(c));
    assert.match(html, HINT_SHOWN, c);
    assert.match(html, /data-count-error>Enter a number of servings above 0/, `${c}: the message shows`);
    assert.match(html, /aria-describedby="qty-count-error qty-serving-grams"/, `${c}: the count field is described by the message, not twice`);
  }
});

test('actions hint — valid counts hide it and enable the actions', () => {
  const { app, model } = setup();
  const s = app.createServing(CORE, { label: 'Tub', grams: 170 });
  for (const c of ['0.5', '0,5', '0.25', '0 1/2', '1', '1.5']) {
    const { html, resolved } = sheetFor(app, model, CORE, { mode: 'serving', gramsText: '', servingId: s.id, countText: c, lastText: null });
    assert.ok(resolved && resolved.quantity > 0, c);
    assert.match(html, HINT_HIDDEN, c);
    assert.match(html, /data-action="log-food">Log</, `${c}: Log on, no description`);
    assert.match(html, /data-action="add-to-tray">Add to a meal</, `${c}: Add to a meal on`);
  }
  // With "Add to a meal" as the main action (tray intent), the same.
  const tray = renderFoodSheet({ model, food: app.getFood(CORE), text: '', preview: null, slot: null, intent: 'tray', servings: app.getServings(CORE), amount: { mode: 'serving', servingId: s.id, countText: '0', lastText: null }, resolved: null });
  assert.match(tray, /class="button primary" data-action="add-to-tray" disabled aria-describedby="qty-actions-hint">Add to a meal</);
});

test('actions hint — grams mode never shows it, and gram-only Foods have no hint at all', () => {
  const { app, model } = setup();
  const s = app.createServing(CORE, { label: 'Tub', grams: 170 });
  for (const gramsText of ['', '0', 'abc', '45']) {
    const { html } = sheetFor(app, model, CORE, { mode: 'grams', gramsText, servingId: s.id, countText: '0', lastText: null });
    assert.match(html, HINT_HIDDEN, `grams "${gramsText}"`);
    assert.ok(!/aria-describedby="qty-actions-hint"/.test(html));
  }
  assert.equal(servingActionsBlocked({ mode: 'grams' }, null), false);
  const plain = sheetFor(app, model, OATS, startAmount(app, OATS, '')).html;
  assert.ok(!plain.includes('data-actions-hint') && !plain.includes(SERVING_ACTIONS_HINT), 'a Food without servings: unchanged');
});

test('actions hint — decided from the domain result only; actions stay refused by the domain-backed checks; synced without re-rendering', () => {
  assert.equal(servingActionsBlocked({ mode: 'serving' }, null), true);
  assert.equal(servingActionsBlocked({ mode: 'serving' }, { quantity: 85 }), false);
  assert.equal(servingActionsBlocked(null, null), false);
  const amountSrc = read('app/amount.js');
  const body = amountSrc.slice(amountSrc.indexOf('export const servingActionsBlocked'), amountSrc.indexOf('export function renderServingGrams'));
  assert.ok(!/parse|isUnfinished|RegExp|\.test\(|\/\^/.test(body), 'no second parser or validator for the hint');
  assert.equal(renderActionsHint({ draft: { mode: 'serving' }, resolved: { quantity: 1 } }), '<p id="qty-actions-hint" class="hint actions-hint" data-actions-hint hidden>Enter a number of servings greater than 0 to continue.</p>');
  const sync = fn('function syncFoodSheet(');
  assert.match(sync, /const blocked = servingActionsBlocked\(ui\.amount, ui\.resolved\);\n\s*hint\.hidden = !blocked;/);
  for (const label of ['log-food', 'add-to-tray']) assert.match(caseBody(label), /resolveSheet\(ui\);[^\n]*\n\s*if \(!ui\.resolved\) \{ showAmountError\(\); break; \}/, `${label}: forced presses are still refused`);
});
