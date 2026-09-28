// UI slice 2 — the Today screen (app/today.js). V2_UI_CONTRACT.md §4, §8, §5.4–5.5.
// The screen is tested through its model (domain reads), its pure renderers and its action
// layer (domain writes), against a real data layer on the memory adapter. DOM wiring was
// verified separately in Chromium.
// Run: node --test tests/

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, macroArithmeticInSource, FORBIDDEN_NUTRITION, domainImportsBypassingIndex } from './helpers.mjs';
import { createDataLayer, createMemoryAdapter, macros } from '../src/domain/index.js';
import { createFileAdapter } from '../src/node/file-adapter.js';
import {
  todayModel, renderToday, createTodayActions, renderDayTypeDialog, renderCoachDialog, renderInstanceDialog,
  renderMealConfirmDialog, defaultSlot, parseGrams, grams, macroLine, afterLine,
  coachVisibleCount, SLOT_LABELS, DAY_TYPE_LABELS, statusLine, formatDate, weekdayName, renderClearDayDialog,
  renderEditDialog, todayViewDate, dayHref, claimDoneEditNote, DONE_EDIT_NOTE, TODAY_VIEW_TYPES, TODAY_SHEET_TYPES
} from '../app/today.js';
import { createViewHost, WIDE_QUERY, COMPACT_QUERY } from '../app/view-host.js';
import { renderPicker, pickerResults, renderMealDetail } from '../app/log.js';
import { renderFoodDetail, foodDetailModel } from '../app/foods.js';

const TODAY = '2026-09-27';
const SEED = createFileAdapter(ROOT).load();

function setup() {
  const inner = createMemoryAdapter(SEED);
  const writes = [];
  const adapter = { load: () => inner.load(), save: (c, d) => inner.save(c, d), saveMany: (ch) => { writes.push(Object.keys(ch)); inner.saveMany(ch); } };
  let t = Date.parse(`${TODAY}T12:00:00Z`);
  let n = 0;
  const app = createDataLayer({ adapter, today: () => TODAY, clock: () => new Date((t += 60000)), newId: () => `t${String(++n).padStart(4, '0')}` });
  return { app, writes, actions: createTodayActions(app) };
}
const whole = (x) => macros.roundMacros(x, 0);
const text = (html) => html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ');
const savedYogurt = (app) => app.createSavedMeal({ name: 'Yogurt bowl', mealType: 'snack', ingredients: [{ foodId: 'food_core_fage_0_greek_yogurt', quantity: 150 }, { foodId: 'food_core_blueberries_frozen', quantity: 75 }] });

/* ---------------- rendering ---------------- */

test('Today — first use: choose a day type (no default), five empty slots, no invented data', () => {
  const { app } = setup();
  const html = renderToday(todayModel(app));
  assert.match(html, /<h1 id="screen-title"[^>]*>Today<\/h1>/);
  assert.match(html, /What kind of day is Sunday\?/, 'the chooser names the weekday (§4.5.1); 2026-09-27 is a Sunday');
  assert.match(renderDayTypeDialog({ model: todayModel(app), selected: null }), /What kind of day is Sunday\?/, 'the chooser sheet too');
  const current = app.getAllCurrentTargets();
  for (const type of ['lift', 'long_run', 'rest']) {
    assert.match(html, new RegExp(`data-type="${type}"`));
    assert.ok(html.includes(macroLine(current[type])), `${type} shows its current targets from the domain`);
  }
  assert.ok(!/data-type="[a-z_]+"[^>]*aria-pressed="true"|checked/.test(html), 'nothing preselected');
  assert.deepEqual([...html.matchAll(/<h3 id="slot-([a-z_]+)"[^>]*>([^<]+)<\/h3>/g)].map((m) => [m[1], m[2]]), Object.entries(SLOT_LABELS), 'five slots in canonical order');
  assert.equal((html.match(/Not logged/g) || []).length, 5);
  assert.ok(!/class="macro-panel"|data-action="coach"|data-action="done"/.test(html), 'no targets, Coach or Done Logging before a day type exists');
  assert.equal(app.getDay(TODAY), null, 'viewing creates nothing');
});

test('Today — day type, targets, logged and remaining all come from the domain', () => {
  const { app, actions } = setup();
  app.updateCurrentTargets('lift', { carbs: 301 }); // not a canonical figure: proves nothing is hard-coded
  actions.chooseDayType('lift');
  app.createMealInstance({ date: TODAY, mealSlot: 'lunch', mealId: 'meal_library_L26' });
  const model = todayModel(app);
  const html = renderToday(model);
  const s = app.getDaySummary(TODAY);
  assert.match(html, /aria-label="Day type: Lift\. Change day type">Lift<\/button>/);
  const r = whole(s.remaining);
  const l = whole(s.logged);
  const tg = whole(s.target);
  assert.equal(tg.carbs, 301);
  for (const key of ['protein', 'carbs', 'fat']) {
    assert.ok(html.includes(`<span class="macro-number">${grams(r[key])}</span>`), `${key} remaining`);
    assert.ok(html.includes(`${l[key]} of ${tg[key]} g logged`), `${key} logged of target`);
    assert.ok(html.includes(`--fill: ${s.progress[key]}`), `${key} bar uses the domain's progress`);
  }
  const order = [...html.matchAll(/<li class="macro" data-macro="([a-z]+)"/g)].map((m) => m[1]);
  assert.deepEqual(order, ['protein', 'carbs', 'fat']);
  assert.match(html, /1 meal logged · 1 of 5 slots/);
});

test('Today — below, exactly at and above target: "{n} g left" / "Target reached" + "+{overBy} g" (§4.2, I-07)', () => {
  const { app, actions } = setup();
  actions.chooseDayType('rest');
  app.logFood({ date: TODAY, mealSlot: 'dinner', foodId: 'food_core_fage_0_greek_yogurt', quantity: 2000 });
  // Farro (fat 2 g per 100 g) keeps logged fat whole, since targets are whole grams.
  app.logFood({ date: TODAY, mealSlot: 'lunch', foodId: 'food_core_farro_dry', quantity: 100 });
  // Make fat land exactly on target, through the domain (current targets → explicit apply).
  app.updateCurrentTargets('rest', { fat: app.getDaySummary(TODAY).logged.fat });
  app.applyCurrentTargetsToToday();
  const s = app.getDaySummary(TODAY);
  assert.deepEqual(s.reached, { protein: true, carbs: false, fat: true }, 'fixture: protein above, carbs below, fat exactly at');
  assert.ok(s.overBy.protein > 0 && s.overBy.fat === 0 && s.remaining.fat === 0);

  const html = renderToday(todayModel(app));
  const block = (key) => html.slice(html.indexOf(`data-macro="${key}"`), html.indexOf('</li>', html.indexOf(`data-macro="${key}"`)));
  const over = whole(s.overBy);
  const r = whole(s.remaining);
  const l = whole(s.logged);
  const tg = whole(s.target);

  // Below target: remaining grams with "left"; no +overBy.
  assert.ok(block('carbs').includes(`<span class="macro-number">${grams(r.carbs)}</span> <span class="macro-caption">left</span>`));
  assert.ok(!block('carbs').includes('data-over-by') && !block('carbs').includes('Target reached'));
  assert.ok(block('carbs').includes(`Carbs: ${r.carbs} grams left of ${tg.carbs}.`), 'screen-reader phrase (§14)');

  // Above target: "Target reached" + "+{overBy} g" from the domain's overBy; the negative remaining is not shown.
  assert.ok(block('protein').includes('<span class="macro-number is-reached">Target reached</span>'));
  assert.ok(block('protein').includes(`<p class="macro-over" data-over-by>+${over.protein} g</p>`), 'the contract\'s +overBy, not clamped');
  assert.ok(!block('protein').includes('−'), 'no negative remaining on screen once reached');
  assert.ok(block('protein').includes(`${l.protein} of ${tg.protein} g logged`), 'logged of target stays visible');
  assert.ok(block('protein').includes(`Protein: target reached, ${over.protein} grams past.`), 'screen-reader phrase (§14)');

  // Exactly at target: reached, +0 g.
  assert.ok(block('fat').includes('Target reached'));
  assert.ok(block('fat').includes('<p class="macro-over" data-over-by>+0 g</p>'));

  assert.ok(!/\b(over|missed|failed|below target|bad|good day|score|compliance|adherence)\b/i.test(text(html)), 'no judgmental language');
  assert.ok(!/warning|danger/.test(html.slice(html.indexOf('macro-panel'), html.indexOf('</section>', html.indexOf('macro-panel')))), 'neutral styling');
});

test('Today — Night Snack is visibly optional; slots never decide completion', () => {
  const { app, actions } = setup();
  actions.chooseDayType('lift');
  for (const slot of ['breakfast', 'lunch', 'snack_afternoon', 'dinner']) app.logFood({ date: TODAY, mealSlot: slot, foodId: 'food_core_banana', quantity: 100 });
  let html = renderToday(todayModel(app));
  assert.match(text(html), /No slot is required, including Night Snack/);
  assert.match(html, /4 meals logged · 4 of 5 slots/, 'slot coverage shown as information (§4.4.1)');
  assert.ok(!/incomplete|required slot|missing/i.test(text(html)));
  assert.match(html, /data-action="done">Done Logging</, 'Done Logging available with Night Snack empty');

  // All five slots filled is still not done: completion is explicit.
  app.logFood({ date: TODAY, mealSlot: 'snack_night', foodId: 'food_core_banana', quantity: 50 });
  assert.equal(app.getDaySummary(TODAY).status, 'partial');
  html = renderToday(todayModel(app));
  assert.match(html, /5 meals logged · 5 of 5 slots/);
  assert.match(html, /data-action="done">Done Logging</, 'five of five slots is still not done');
  assert.ok(!/Done logging/.test(html) && !/class="badge"/.test(html), 'no done state from slot coverage');

  // Status line: the day's state decides the wording; slot coverage never does.
  const base = app.getDaySummary(TODAY);
  assert.equal(statusLine({ ...base, status: 'no_data', instanceCount: 0, loggedSlots: [] }), 'Nothing logged yet');
  assert.equal(statusLine({ ...base, status: 'partial', instanceCount: 1, loggedSlots: ['breakfast'] }), '1 meal logged · 1 of 5 slots');
  assert.match(statusLine({ ...base, status: 'complete', instanceCount: 1, loggedSlots: ['breakfast'] }), /^Done logging /, 'Done with one slot: completion comes from Done Logging alone');
});

/* ---------------- day type ---------------- */

test('Today — day-type changes go through the domain: same type is a no-op, switching back restores', () => {
  const { app, actions, writes } = setup();
  actions.chooseDayType('lift');
  const lunch = app.createMealInstance({ date: TODAY, mealSlot: 'lunch', mealId: 'meal_library_L26' });
  app.updateCurrentTargets('lift', { carbs: 320 });
  const n = writes.length;
  assert.deepEqual(actions.changeDayType('lift'), { noOp: true, message: '' });
  assert.equal(writes.length, n, 'same type writes nothing');

  const model = todayModel(app);
  const preview = app.previewDayTypeChange(TODAY, 'rest');
  const dlg = renderDayTypeDialog({ model, selected: 'rest', preview, applyPreview: app.previewApplyCurrentTargetsToToday() });
  assert.ok(dlg.includes(`${macroLine(preview.from.target)} → ${macroLine(preview.to.target)}`), 'old → new targets from the domain preview');
  assert.match(dlg, /Logged food stays exactly the same/);
  assert.match(dlg, /Change to Rest/);

  actions.changeDayType('rest');
  assert.equal(app.getDay(TODAY).dayType, 'rest');
  assert.deepEqual(app.getDay(TODAY).mealInstances, [lunch], 'logged food intact');
  const back = renderDayTypeDialog({ model: todayModel(app), selected: 'lift', preview: app.previewDayTypeChange(TODAY, 'lift'), applyPreview: null });
  assert.match(back, /Uses the Lift targets this day had before/);
  actions.changeDayType('lift');
  assert.equal(app.getDay(TODAY).targetSnapshot.carbs, 293, 'restored — not the new current 320');
  assert.deepEqual(app.getDay(TODAY).mealInstances, [lunch]);
});

test('Today — adopting current targets is explicit, previewed, and never automatic', () => {
  const { app, actions, writes } = setup();
  actions.chooseDayType('lift');
  app.updateCurrentTargets('lift', { carbs: 310 });
  todayModel(app); // opening Today…
  assert.equal(app.getDay(TODAY).targetSnapshot.carbs, 293, '…does not change the snapshot');

  const n = writes.length;
  const preview = app.previewApplyCurrentTargetsToToday();
  assert.equal(writes.length, n, 'the preview writes nothing');
  assert.equal(preview.applies, true);
  assert.deepEqual([preview.from.carbs, preview.to.carbs], [293, 310]);
  const dlg = renderDayTypeDialog({ model: todayModel(app), selected: 'lift', preview: null, applyPreview: preview });
  assert.match(dlg, /Your Lift targets have changed since today was set up/);
  const confirm = renderDayTypeDialog({ model: todayModel(app), applyPreview: preview, confirmingApply: true });
  assert.ok(confirm.includes(macroLine(preview.to)) && confirm.includes(macroLine(preview.from)), 'the effect is shown before confirming');

  actions.applyCurrentTargets();
  assert.equal(app.getDay(TODAY).targetSnapshot.carbs, 310);
  assert.equal(app.previewApplyCurrentTargetsToToday().applies, false);
  assert.doesNotMatch(renderDayTypeDialog({ model: todayModel(app), selected: 'lift', applyPreview: app.previewApplyCurrentTargetsToToday() }), /have changed since/);
  assert.equal(setup().app.previewApplyCurrentTargetsToToday().exists, false, 'no Day: nothing to apply');
});

/* ---------------- logging ---------------- */

test('Today — logging a Saved Meal creates a historical Meal Instance and leaves the Saved Meal alone', () => {
  const { app, actions } = setup();
  actions.chooseDayType('lift');
  const meal = savedYogurt(app);
  const before = app.getMeal(meal.id);
  const preview = app.previewMealInstance({ date: TODAY, mealId: meal.id });
  const confirm = renderMealConfirmDialog({ preview, slot: 'snack_afternoon', adjusting: false, quantities: [], foods: {} });
  assert.ok(confirm.includes(macroLine(preview.totals)) && confirm.includes(afterLine(preview.day.after)), 'totals and after-this from the domain preview');
  assert.match(confirm, /value="snack_afternoon" checked/);

  const { instance, message } = actions.logMeal({ mealId: meal.id, mealSlot: 'snack_afternoon' });
  assert.equal(message, 'Logged Yogurt bowl to Afternoon Snack.');
  assert.equal(instance.mealSlot, 'snack_afternoon');
  assert.equal(instance.sourceMealId, meal.id);
  assert.deepEqual(instance.totals, preview.totals, 'same numbers as previewed');
  assert.deepEqual(app.getMeal(meal.id), before, 'Saved Meal not mutated');
  const html = renderToday(todayModel(app));
  assert.match(html, new RegExp(`data-id="${instance.id}"[\\s\\S]*?Yogurt bowl</span><span class="marker">Saved</span>`));

  // Adjusted grams: one-off, and the follow-up choices act only when chosen.
  const adjusted = actions.logMeal({ mealId: meal.id, mealSlot: 'snack_night', ingredients: [{ foodId: 'food_core_fage_0_greek_yogurt', quantity: 250, unit: 'g' }, { foodId: 'food_core_blueberries_frozen', quantity: 75, unit: 'g' }] });
  assert.deepEqual(app.getMeal(meal.id), before, 'adjusting for this time leaves the recipe alone');
  const created = actions.saveAsNewSavedMeal({ name: 'Big yogurt bowl', mealType: 'snack', ingredients: adjusted.instance.ingredients });
  assert.equal(created.meal.ingredients[0].quantity, 250);
  actions.updateSavedMeal(meal.id, adjusted.instance.ingredients);
  assert.equal(app.getMeal(meal.id).ingredients[0].quantity, 250, 'updated only on explicit choice');
  assert.deepEqual(app.getDay(TODAY).mealInstances.find((mi) => mi.id === instance.id), instance, 'history unchanged by the recipe update');
});

test('Today — Library Meals log as Library Meals and never become Saved Meals', () => {
  const { app, actions } = setup();
  actions.chooseDayType('lift');
  const savedBefore = app.getSavedMeals().length;
  const { instance } = actions.logMeal({ mealId: 'meal_library_L26', mealSlot: 'lunch' });
  assert.equal(app.getMeal(instance.sourceMealId).source, 'library');
  assert.equal(app.getSavedMeals().length, savedBefore, 'no Saved Meal created');
  assert.match(renderToday(todayModel(app)), /<span class="marker">Library<\/span>/);
  const coach = app.getMacroCoachSuggestions({ date: TODAY, mealSlot: 'dinner' });
  assert.ok(!coach.tiers.find((t) => t.tier === 'recent').items.some((i) => i.mealId === 'meal_library_L26'), 'not a recent Saved Meal');
});

test('Today — Add and slot + open Log with this date and slot; a past date shown via the route (Slice 3 integration)', () => {
  const src = fs.readFileSync(path.join(ROOT, 'app/today.js'), 'utf8');
  assert.match(src, /win\.location\.hash = `#\/log\?from=today&date=\$\{model\.date\}\$\{slot \? `&slot=\$\{slot\}` : ''\}`/, 'Add routes into Log with date and slot');
  assert.ok(!/renderPickerDialog|pickerData/.test(src), 'no second meal picker on Today');

  const { app } = setup();
  app.createDay('2026-09-20', 'rest');
  const inst = app.logFood({ date: '2026-09-20', mealSlot: 'dinner', foodId: 'food_core_banana', quantity: 100 });
  const past = todayModel(app, '2026-09-20');
  assert.equal(past.isToday, false);
  const html = renderToday(past);
  assert.match(html, new RegExp(`<h1 id="screen-title"[^>]*>${formatDate('2026-09-20')}</h1>`), 'a past day is titled with its date');
  assert.match(html, /<a class="chip" href="#\/today" aria-label="Go to today">Today<\/a>/, 'a way back to today');
  assert.ok(html.includes(`data-id="${inst.id}"`));
  const acts = createTodayActions(app, () => '2026-09-20');
  assert.equal(acts.setDone(true).message, `Marked ${formatDate('2026-09-20')} as done. It now counts as a complete day in Progress.`);
  assert.equal(app.getDaySummary('2026-09-20').status, 'complete');
  assert.equal(app.getDay(TODAY), null, 'today untouched');
  assert.match(renderDayTypeDialog({ model: past, selected: 'lift', preview: app.previewDayTypeChange('2026-09-20', 'lift') }), /Targets from .+ aren't on record for Lift\./, '§4.5.2 past-day note');
});

test('Today — inspecting, editing, moving and removing a logged meal use domain operations only', () => {
  const { app, actions } = setup();
  actions.chooseDayType('lift');
  const meal = savedYogurt(app);
  const { instance } = actions.logMeal({ mealId: meal.id, mealSlot: 'lunch' });
  app.updateSavedMeal(meal.id, { name: 'Renamed bowl', ingredients: [{ foodId: 'food_core_banana', quantity: 100 }] });

  const detail = renderInstanceDialog({ instance: app.getDay(TODAY).mealInstances[0], slot: 'lunch', date: TODAY, source: 'saved', sourceName: 'Renamed bowl' });
  assert.match(detail, /<caption class="visually-hidden">Ingredients as logged<\/caption>/);
  assert.ok(detail.includes('150 g') && detail.includes('Fage'), 'the snapshot, not the current recipe');
  assert.match(detail, /Later changes to foods or saved meals don't change it/);
  const t = whole(instance.totals);
  assert.ok(detail.includes(`<td>${t.protein}</td><td>${t.carbs}</td><td>${t.fat}</td>`), 'stored totals');

  const edited = actions.updateInstance(instance.id, { mealName: 'Yogurt', ingredients: [{ foodId: 'food_core_fage_0_greek_yogurt', quantity: 300, unit: 'g' }] });
  assert.deepEqual(edited.instance, app.getDay(TODAY).mealInstances[0]);
  assert.deepEqual(app.previewMealInstanceUpdate(TODAY, instance.id, {}).instance, edited.instance);
  actions.moveInstance(instance.id, 'dinner');
  assert.equal(app.getDay(TODAY).mealInstances[0].mealSlot, 'dinner');

  actions.setDone(true);
  const result = actions.deleteInstance(instance.id);
  assert.equal(result.reopened, true);
  assert.match(result.message, /no longer marked done, because nothing is logged/);
  assert.equal(app.getDay(TODAY).mealInstances.length, 0);
});

/* ---------------- completion ---------------- */

test('Today — Done Logging is explicit; empty Night Snack does not prevent it', () => {
  const { app, actions } = setup();
  actions.chooseDayType('long_run');
  let html = renderToday(todayModel(app));
  assert.match(html, /data-action="done" disabled aria-describedby="done-hint">Done Logging<\/button><span id="done-hint" class="hint">Log something first/);
  actions.logMeal({ mealId: 'meal_library_B1', mealSlot: 'breakfast' });
  assert.equal(app.getDaySummary(TODAY).status, 'partial');
  const done = actions.setDone(true);
  assert.equal(done.message, 'Marked today as done. It now counts as a complete day in Progress.');
  assert.equal(app.getDaySummary(TODAY).status, 'complete');
  html = renderToday(todayModel(app));
  assert.match(html, /<p class="day-status" data-day-status>Done logging <span aria-hidden="true">✓<\/span><\/p>/);
  assert.match(html, /<span class="badge">Done<\/span>/);
  assert.match(html, /data-action="reopen">Reopen day</);
  assert.match(html, /Still eating\? Build my next meal/);
  actions.setDone(false);
  assert.equal(app.getDaySummary(TODAY).status, 'partial');
});

test('Today — Clear this day: header overflow → confirmation → deleteDay; other days untouched (§4.6)', () => {
  const { app, actions } = setup();
  assert.ok(!/data-action="day-menu"/.test(renderToday(todayModel(app))), 'nothing to clear before a Day exists');
  app.createDay('2026-09-26', 'long_run');
  app.logFood({ date: '2026-09-26', mealSlot: 'lunch', foodId: 'food_core_banana', quantity: 100 });
  const yesterday = JSON.stringify(app.getDay('2026-09-26'));
  actions.chooseDayType('lift');
  actions.logMeal({ mealId: 'meal_library_B1', mealSlot: 'breakfast' });
  app.logFood({ date: TODAY, mealSlot: 'snack_afternoon', foodId: 'food_core_banana', quantity: 100 });
  assert.match(renderToday(todayModel(app)), /data-action="day-menu" aria-haspopup="dialog" aria-label="More actions for this day"/);

  const confirm = renderClearDayDialog({ date: TODAY, instanceCount: app.getDaySummary(TODAY).instanceCount });
  assert.match(text(confirm), /This deletes its day type and all 2 logged meals\. Other days aren't affected\./);
  assert.ok(confirm.indexOf('data-autofocus') < confirm.indexOf('confirm-clear-day'), 'Cancel takes focus on a destructive dialog');
  assert.match(text(renderClearDayDialog({ date: TODAY, instanceCount: 1 })), /its day type and its 1 logged meal\./);
  assert.match(text(renderClearDayDialog({ date: TODAY, instanceCount: 0 })), /This deletes its day type\. Other/);

  const result = actions.clearDay();
  assert.match(result.message, /^Cleared .+\. Other days weren't affected\.$/);
  assert.equal(app.getDay(TODAY), null, 'the Day is gone');
  assert.equal(JSON.stringify(app.getDay('2026-09-26')), yesterday, 'other days untouched');
  assert.match(renderToday(todayModel(app)), /What kind of day is Sunday\?/, 'Today returns to the chooser');
  const src = fs.readFileSync(path.join(ROOT, 'app/today.js'), 'utf8');
  assert.match(src, /app\.deleteDay\(/, 'uses the existing domain operation');
});

/* ---------------- Coach ---------------- */

test('Today — Coach renders the domain order untouched and logs through the normal path', () => {
  const { app, actions } = setup();
  actions.chooseDayType('lift');
  const fav = savedYogurt(app);
  app.setFavoriteMeal(fav.id, true);
  const other = app.createSavedMeal({ name: 'Other', mealType: 'lunch', ingredients: [{ foodId: 'food_core_banana', quantity: 100 }] });
  actions.logMeal({ mealId: other.id, mealSlot: 'lunch' });
  actions.logMeal({ mealId: 'meal_library_B1', mealSlot: 'breakfast' });
  const suggestions = app.getMacroCoachSuggestions({ date: TODAY, mealSlot: defaultSlot(app.getDay(TODAY)) });
  const expanded = { favoriteSaved: true, recent: true, saved: true, library: true, topUp: true };
  const html = renderCoachDialog({ suggestions, expanded });
  const rendered = [...html.matchAll(/data-action="coach-log-meal" data-meal="([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(rendered, suggestions.tiers.flatMap((t) => t.items.map((i) => i.mealId)), 'exactly the domain order');
  const headings = [...html.matchAll(/<h3 id="coach-([a-zA-Z]+)"/g)].map((m) => m[1]);
  assert.deepEqual(headings, ['favoriteSaved', 'recent', 'library', 'topup'].filter((h) => h === 'topup' || suggestions.tiers.find((t) => t.tier === h).items.length));
  const recentTier = suggestions.tiers.find((t) => t.tier === 'recent');
  assert.ok(!recentTier.items.some((i) => i.mealId === 'meal_library_B1'), 'a logged Library Meal is not a recent Saved Meal');
  const retired = app.getLibraryMeals({ includeRetired: true }).filter((m) => m.metadata && m.metadata.retired).map((m) => m.id);
  assert.ok(!rendered.some((id) => retired.includes(id)));
  assert.ok(!/score|best|rank|winner|recommended/i.test(text(html)), 'no ranking language');

  const collapsed = renderCoachDialog({ suggestions, expanded: {} });
  const shown = [...collapsed.matchAll(/data-action="coach-log-meal" data-meal="([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(shown, suggestions.tiers.flatMap((t) => t.items.slice(0, coachVisibleCount(t.tier, suggestions)).map((i) => i.mealId)), 'Show all only trims, never reorders');
  assert.match(collapsed, /Show all \d+/);

  // A Coach pick is logged with the same action as any meal.
  const src = fs.readFileSync(path.join(ROOT, 'app/today.js'), 'utf8');
  assert.equal((src.match(/app\.createMealInstance\(/g) || []).length, 1, 'one logging path for meals');
  assert.equal((src.match(/app\.logFood\(/g) || []).length, 1, 'one logging path for foods');
  assert.ok(!/getMacroCoachContext|\.sort\(/.test(src), 'no re-ordering of domain lists in the UI');
});

test('Today — new-user Coach says it is not personal yet', () => {
  const { app, actions } = setup();
  actions.chooseDayType('rest');
  const html = renderCoachDialog({ suggestions: app.getMacroCoachSuggestions({ date: TODAY, mealSlot: 'breakfast' }), expanded: {} });
  assert.match(html, /Not enough history yet for personal suggestions/);
  assert.match(html, /Starter meals from the Library/);
  assert.equal((html.match(/data-action="coach-log-meal"/g) || []).length, 5, 'five starters while history is thin');
  assert.match(html, /Top up with a food/);
  assert.match(html, /Common in Library meals/);
});

/* ---------------- helpers ---------------- */

test('Today — small presentation helpers', () => {
  assert.equal(parseGrams('120'), 120);
  assert.equal(parseGrams(' 12,5 '), 12.5);
  for (const bad of ['', '0', '-5', 'abc', 'NaN', 'Infinity', null]) assert.equal(parseGrams(bad), null, String(bad));
  assert.equal(grams(-12), '−12 g');
  assert.equal(defaultSlot(null), 'breakfast');
  assert.equal(defaultSlot({ mealInstances: [{ mealSlot: 'lunch', loggedAt: '2026-09-27T12:00:00Z' }, { mealSlot: 'breakfast', loggedAt: '2026-09-27T08:00:00Z' }] }), 'snack_afternoon');
  assert.deepEqual(Object.keys(DAY_TYPE_LABELS), ['lift', 'long_run', 'rest']);
  assert.deepEqual(['2026-09-25', '2026-09-27', '2026-09-28', '2026-03-01'].map(weekdayName), ['Friday', 'Sunday', 'Monday', 'Sunday'], 'local calendar date, not UTC');
});

/* ---------------- safety ---------------- */

test('Today — no macro arithmetic, no forbidden terms, no second store, domain via its entry point', () => {
  for (const f of ['app/today.js', 'app/app.css', 'app/shell.js', 'app/main.js']) {
    const src = fs.readFileSync(path.join(ROOT, f), 'utf8');
    assert.deepEqual(macroArithmeticInSource(src, f), [], f);
    assert.ok(!FORBIDDEN_NUTRITION.test(src), f);
    assert.deepEqual(domainImportsBypassingIndex(src), [], f);
  }
  const src = fs.readFileSync(path.join(ROOT, 'app/today.js'), 'utf8');
  assert.deepEqual([...src.matchAll(/from '([^']+)'/g)].map((m) => m[1]).sort(), ['../src/domain/index.js', './foods.js', './log.js', './session.js', './shell.js', './view-host.js']);
  assert.ok(!/localStorage|sessionStorage|indexedDB|\.mealInstances\s*\.push|targetSnapshot\s*=/.test(src), 'no second store; no direct record mutation');
});

/* ---------------- G1–G5: date controls, future days, the Done-day note, add ingredient, views ---------------- */

const PAST = '2026-09-20';
const FUTURE = '2026-09-28';

test('Today G1 — ◀ ▶ step one calendar day through the domain’s date arithmetic; each day has its own URL', () => {
  const { app } = setup();
  const m = todayModel(app);
  assert.deepEqual([m.prevDate, m.nextDate], ['2026-09-26', FUTURE], 'previous and next from today');
  assert.deepEqual([todayModel(app, PAST).prevDate, todayModel(app, PAST).nextDate], ['2026-09-19', '2026-09-21'], 'next from a prior day');
  assert.deepEqual([todayModel(app, '2026-03-01').prevDate, todayModel(app, '2024-02-28').nextDate], ['2026-02-28', '2024-02-29'], 'month and leap-year edges');
  const html = renderToday(m);
  assert.match(html, /<div class="date-nav" role="group" aria-label="Change day">/);
  assert.match(html, new RegExp(`data-action="prev-day" aria-label="Previous day, ${formatDate('2026-09-26')}"`));
  assert.match(html, new RegExp(`data-action="next-day" aria-label="Next day, ${formatDate(FUTURE)}"`));
  assert.ok(html.indexOf('data-action="prev-day"') < html.indexOf('data-action="next-day"'), '◀ before ▶');
  assert.equal(dayHref(TODAY, TODAY), '#/today', 'today keeps the plain route, so it follows midnight (§4.5.6)');
  assert.equal(dayHref(PAST, TODAY), `#/today?date=${PAST}`);
  const src = fs.readFileSync(path.join(ROOT, 'app/today.js'), 'utf8');
  assert.match(src, /import \{ macros, constants, addDays \} from '\.\.\/src\/domain\/index\.js';/, 'date stepping is the domain’s addDays');
  assert.match(src, /win\.location\.replace\(dayHref\(date, app\.getToday\(\)\)\)/, '◀ ▶ replace the entry, so Back still returns to where Today was opened from (§16)');
  assert.ok(!/setDate\(|getTime\(\) \+|86400000/.test(src), 'no date arithmetic of its own');
});

test('Today G2 — a future day is viewable and empty (I-04): no chooser, no add actions, never created', () => {
  const { app, writes } = setup();
  assert.equal(todayViewDate(app, `#/today?date=${FUTURE}`), FUTURE, 'a future route shows that day');
  assert.equal(todayViewDate(app, `#/today?date=${PAST}`), PAST);
  assert.equal(todayViewDate(app, '#/today?date=2026-02-30'), TODAY, 'an invalid date shows today');
  assert.equal(todayViewDate(app, '#/today'), TODAY);
  const future = todayModel(app, todayModel(app).nextDate);
  assert.equal(future.isFuture, true);
  const html = renderToday(future);
  assert.match(html, /<p class="note future-note">You can log this day when it arrives\.<\/p>/);
  assert.match(html, /<p class="today-date">Future day<\/p>/);
  assert.ok(!/What kind of day is|data-action="choose-day-type"|data-action="add"|data-action="coach"|data-action="done"|data-action="day-menu"/.test(html), 'nothing to create or log');
  assert.equal((html.match(/<p class="slot-empty">Not logged<\/p>/g) || []).length, 5, 'the five slots, empty');
  assert.match(html, /data-action="prev-day"/, 'and a way back');
  assert.match(html, /<a class="chip" href="#\/today" aria-label="Go to today">Today<\/a>/);
  assert.equal(app.getDay(FUTURE), null, 'viewing creates nothing');
  assert.equal(writes.length, 0, 'nothing written');
});

test('Today G1/G2 — moving between days never changes a stored day', () => {
  const { app } = setup();
  app.createDay(PAST, 'rest');
  app.logFood({ date: PAST, mealSlot: 'dinner', foodId: 'food_core_banana', quantity: 100 });
  app.setDayLoggingComplete(PAST, true);
  const before = JSON.stringify(app.exportUserData().data.days);
  for (const d of [PAST, '2026-09-21', TODAY, FUTURE, PAST]) renderToday(todayModel(app, d));
  assert.equal(JSON.stringify(app.exportUserData().data.days), before, 'type, targets, meals and Done state untouched');
  const html = renderToday(todayModel(app, PAST));
  assert.match(html, /<p class="today-date">Past day <span class="badge">Done<\/span><\/p>/);
  assert.match(html, /data-action="day-type" aria-label="Day type: Rest\./);
});

test('Today G3 — the Done-day note appears once per day, on the first add/edit/move/delete, never on marking done', () => {
  const { app, actions } = setup();
  actions.chooseDayType('lift');
  const { instance } = actions.logMeal({ mealId: 'meal_library_B1', mealSlot: 'breakfast' });
  const state = { doneNotes: [] };
  assert.equal(claimDoneEditNote(state, TODAY, app.getDaySummary(TODAY)), false, 'not while the day isn’t Done');
  actions.setDone(true);
  assert.ok(!renderToday(todayModel(app)).includes(DONE_EDIT_NOTE), 'marking done or rendering a Done day shows no note');
  const src = fs.readFileSync(path.join(ROOT, 'app/today.js'), 'utf8');
  assert.match(src, /case 'done': afterChange\(actions\.setDone\(true\)\); break;/, 'marking done is not a day edit');
  const before = JSON.stringify(app.getDay(TODAY));
  actions.moveInstance(instance.id, 'lunch'); // the first edit of a Done day
  assert.equal(claimDoneEditNote(state, TODAY, app.getDaySummary(TODAY)), true);
  assert.equal(DONE_EDIT_NOTE, 'This day is marked done. Changes are saved and it stays done.', '§4.4.2 wording');
  const html = renderToday(todayModel(app), { doneNote: true });
  assert.match(html, /<p class="note done-note" data-done-note>This day is marked done\. Changes are saved and it stays done\.<\/p>/);
  assert.equal(app.getDaySummary(TODAY).status, 'complete', 'the day stays Done');
  assert.equal(claimDoneEditNote(state, TODAY, app.getDaySummary(TODAY)), false, 'a second edit: no new note');
  assert.equal(claimDoneEditNote(state, TODAY, app.getDaySummary(TODAY)), false, 'coming back to Today: still none');
  const after = app.getDay(TODAY);
  assert.deepEqual(after.mealInstances.map((mi) => [mi.totals, mi.ingredients]), JSON.parse(before).mealInstances.map((mi) => [mi.totals, mi.ingredients]), 'the note changes no food, macros or targets');
  assert.deepEqual(after.targetSnapshot, JSON.parse(before).targetSnapshot);
  app.createDay(PAST, 'rest');
  app.logFood({ date: PAST, mealSlot: 'lunch', foodId: 'food_core_banana', quantity: 100 });
  app.setDayLoggingComplete(PAST, true);
  assert.equal(claimDoneEditNote(state, PAST, app.getDaySummary(PAST)), true, 'once per day: another Done day gets its own');
  assert.match(fs.readFileSync(path.join(ROOT, 'app/session.js'), 'utf8'), /today: \{\n\s+doneNotes: \[\]/, 'remembered in the session (memory) only');
  assert.match(src, /claimDoneEditNote\(session\.today, model\.date/, 'Today uses the session record, nothing stored');
});

test('Today G4 — editing a logged meal can add an ingredient through the shared Food picker; save updates Today; cancel changes nothing', () => {
  const { app, actions } = setup();
  actions.chooseDayType('lift');
  const meal = savedYogurt(app);
  const { instance } = actions.logMeal({ mealId: meal.id, mealSlot: 'snack_afternoon' });
  const original = JSON.stringify(app.getDay(TODAY));
  const edit = { instance, date: TODAY, name: instance.mealName, slot: instance.mealSlot, rows: instance.ingredients.map((i) => ({ foodId: i.foodId, unit: i.unit, foodName: i.foodName, text: String(i.quantity) })), preview: null };
  const form = renderEditDialog(edit);
  assert.match(form, /<button type="button" class="button add-ingredient" data-action="add-ingredient">Add an ingredient<\/button>/);
  // The picker is the Log Foods list in pick mode (§7.5), the same one the Meals editor uses.
  const picker = renderPicker({ title: 'Add an ingredient', query: 'banana', results: pickerResults(app, 'banana') });
  assert.match(picker, /Choose a food\. Nothing is logged\./);
  assert.match(picker, /data-action="food" data-food="food_core_banana"/);
  const banana = app.getFood('food_core_banana');
  edit.rows.push({ foodId: banana.id, unit: 'g', foodName: banana.name, state: banana.state, text: '' });
  assert.match(renderEditDialog(edit), new RegExp(`<label for="edit-q-2">${banana.name} <span class="state-chip">${banana.state}</span></label>`), 'the new row shows its state; grams start empty');
  assert.equal(JSON.stringify(app.getDay(TODAY)), original, 'picking changes nothing yet (cancel leaves the logged meal as it was)');
  edit.rows[2].text = '120';
  const patch = { ingredients: edit.rows.map((r) => ({ foodId: r.foodId, unit: r.unit, quantity: Number(r.text) })) };
  const preview = app.previewMealInstanceUpdate(TODAY, instance.id, patch);
  assert.equal(preview.instance.ingredients.length, 3);
  assert.equal(JSON.stringify(app.getDay(TODAY)), original, 'a preview writes nothing');
  const saved = actions.updateInstance(instance.id, { mealName: edit.name, mealSlot: edit.slot, ...patch });
  assert.deepEqual(saved.instance.totals, preview.instance.totals, 'the domain calculated the totals');
  assert.deepEqual(app.getDaySummary(TODAY).logged, saved.instance.totals, 'Today shows the updated macros');
  assert.ok(renderToday(todayModel(app)).includes(macroLine(saved.instance.totals)));
  assert.deepEqual(saved.instance.ingredients.slice(0, 2), JSON.parse(original).mealInstances[0].ingredients, 'existing ingredients keep their snapshot');
  assert.equal(app.getMeal(meal.id).ingredients.length, 2, 'the Saved Meal is untouched (A-13)');
  const src = fs.readFileSync(path.join(ROOT, 'app/today.js'), 'utf8');
  assert.match(src, /import \{\s*renderPicker, pickerResults,[^}]*\} from '\.\/log\.js';/, 'the shared picker, not a second one');
  assert.ok(!/function renderPicker/.test(src) && !/function renderPicker/.test(fs.readFileSync(path.join(ROOT, 'app/meals.js'), 'utf8')), 'one picker implementation (log.js)');
});

function fakeHost(width, em = 16) {
  const w = { 1280: 1280, 800: 800, 375: 375 }[width];
  const classes = new Set();
  const dialog = {
    open: false, modal: false, dataset: {}, innerHTML: '', listeners: {},
    showModal() { this.open = true; this.modal = true; }, show() { this.open = true; this.modal = false; },
    close() { this.open = false; (this.listeners.close || []).forEach((f) => f()); },
    addEventListener(t, f) { (this.listeners[t] = this.listeners[t] || []).push(f); },
    querySelector() { return null; }
  };
  const win = { matchMedia: (q) => ({ matches: q === WIDE_QUERY ? w / em >= 64 : q === COMPACT_QUERY ? w / em <= 37.49 : false }), addEventListener() {}, removeEventListener() {}, location: { href: '#/today' }, history: { pushState() {}, back() {} } };
  const page = { classList: { add: (c) => classes.add(c), remove: (c) => classes.delete(c) } };
  const host = createViewHost({ page, dialog, win, doc: { activeElement: null }, viewTypes: TODAY_VIEW_TYPES, sheetTypes: TODAY_SHEET_TYPES, fallbackFocus: () => null, onClose() {} });
  return { host, dialog, classes };
}

test('Today G5 — logged-meal detail, edit and picker are views in the shared view host; Today’s sheets stay sheets', () => {
  assert.deepEqual([...TODAY_VIEW_TYPES], ['instance', 'edit', 'picker', 'custom-food', 'meal-detail', 'food-detail']);
  assert.deepEqual([...TODAY_SHEET_TYPES], ['day-type', 'day-menu', 'clear-day']);
  const draw = () => {};
  for (const [width, present, modal, pane] of [[1280, 'pane', false, true], [800, 'panel', true, false], [375, 'pushed', true, false]]) {
    const { host, dialog, classes } = fakeHost(width);
    host.open('instance', draw);
    assert.deepEqual([dialog.dataset.present, dialog.modal, classes.has('has-view')], [present, modal, pane], `detail at ${width}px`);
    host.open('edit', draw);
    assert.equal(dialog.dataset.present, present, `edit at ${width}px`);
    host.open('picker', draw);
    assert.equal(dialog.dataset.present, present, `picker at ${width}px`);
    host.close();
    assert.equal(classes.has('has-view'), false, 'closing returns to Today alone');
  }
  // 200 % text on a wide window: no room for two panes, so a side panel.
  { const { host, dialog } = fakeHost(1280, 32); host.open('instance', draw); assert.equal(dialog.dataset.present, 'panel'); }
  // Today's day-level sheets stay modal sheets at every width, and what opens on top of them too.
  for (const width of [1280, 800, 375]) {
    const { host, dialog, classes } = fakeHost(width);
    host.open('day-type', draw);
    assert.deepEqual([dialog.dataset.present, dialog.modal, classes.has('has-view')], ['sheet', true, false], `day type at ${width}px`);
    host.open('clear-day', draw);
    assert.equal(dialog.dataset.present, 'sheet', 'what a day sheet opens stays a sheet');
    host.close();
    host.open('instance', draw);
    assert.notEqual(dialog.dataset.present, 'sheet', 'the sheet rule ends when it closes');
  }
  // Screens without sheetTypes (Log, Meals, Settings) are unchanged: a non-view type is a pane on wide screens.
  const plain = fakeHost(1280);
  const { host: logLike, dialog: logDialog } = (() => {
    const d = plain.dialog;
    return { host: createViewHost({ page: { classList: { add() {}, remove() {} } }, dialog: d, win: { matchMedia: (q) => ({ matches: q === WIDE_QUERY }), addEventListener() {}, removeEventListener() {}, location: { href: '#/log' }, history: { pushState() {}, back() {} } }, doc: { activeElement: null }, viewTypes: ['x'], fallbackFocus: () => null, onClose() {} }), dialog: d };
  })();
  logLike.open('day-type', draw);
  assert.equal(logDialog.dataset.present, 'pane');
  const src = fs.readFileSync(path.join(ROOT, 'app/today.js'), 'utf8');
  assert.match(src, /createViewHost\(\{[\s\S]*?viewTypes: TODAY_VIEW_TYPES,\s*sheetTypes: TODAY_SHEET_TYPES/, 'Today presents through the shared view host');
  assert.ok(!/showModal\(/.test(src), 'no dialog handling of its own');
  const { app, actions } = setup();
  actions.chooseDayType('lift');
  const { instance } = actions.logMeal({ mealId: 'meal_library_B1', mealSlot: 'breakfast' });
  const detail = renderInstanceDialog({ instance, slot: 'breakfast', date: TODAY, source: 'library', sourceName: 'x' });
  assert.match(detail, /class="link-button view-back" data-action="close"/, 'a Back control when pushed, Close otherwise');
  assert.match(renderEditDialog({ instance, date: TODAY, name: instance.mealName, slot: 'breakfast', rows: [{ foodId: 'a', unit: 'g', foodName: 'A', text: '1' }], preview: null }), /class="link-button view-back"/);
  assert.match(renderToday(todayModel(app)), /data-action="open-instance"/);
});

/* ---------------- G6–G10: Coach panel, Coach items → detail, needs-a-fix footer, empty state, source line ---------------- */

test('Today G6 — the Coach is a right-hand pane on wide screens and a sheet otherwise; what it opens follows it', () => {
  const draw = () => {};
  for (const [width, present, modal, pane] of [[1280, 'pane', false, true], [800, 'sheet', true, false], [375, 'sheet', true, false]]) {
    const { host, dialog, classes } = fakeHost(width);
    host.open('coach', draw);
    assert.deepEqual([dialog.dataset.present, dialog.modal, classes.has('has-view')], [present, modal, pane], `Coach at ${width}px (§8.2)`);
    host.open('meal-detail', draw);
    assert.equal(dialog.dataset.present, { 1280: 'pane', 800: 'panel', 375: 'pushed' }[width], `Meal detail from the Coach at ${width}px`);
    host.open('coach', draw);
    assert.equal(dialog.dataset.present, present, 'Back: the Coach again, in the same place');
    host.open('meal', draw);
    assert.equal(dialog.dataset.present, width === 1280 ? 'pane' : 'sheet', 'its Log confirmation stays in the pane on wide screens');
    host.close();
  }
  { const { host, dialog } = fakeHost(1280, 32); host.open('coach', draw); assert.equal(dialog.dataset.present, 'sheet', '200 % text on a wide window: no room for two panes'); }
  const src = fs.readFileSync(path.join(ROOT, 'app/today.js'), 'utf8');
  assert.ok(!TODAY_SHEET_TYPES.includes('coach'), 'the Coach is no longer forced to a modal sheet');
  assert.match(src, /case 'coach': \{\n\s+const suggestions = app\.getMacroCoachSuggestions\(\{ date: model\.date, mealSlot: defaultSlot\(model\.day\) \}\);/, 'same suggestions, same order');
});

test('Today G7 — every Coach item opens its Meal or Food detail; Log stays on the item; Back returns to the Coach', () => {
  const { app, actions } = setup();
  actions.chooseDayType('lift');
  const fav = savedYogurt(app);
  app.setFavoriteMeal(fav.id, true);
  app.setFavoriteFood('food_custom_oats_overnight', true);
  const suggestions = app.getMacroCoachSuggestions({ date: TODAY, mealSlot: 'lunch' });
  const html = renderCoachDialog({ suggestions, expanded: { favoriteSaved: true, recent: true, saved: true, library: true, topUp: true } });
  const detailMeals = [...html.matchAll(/data-action="coach-meal-detail" data-meal="([^"]+)"/g)].map((m) => m[1]);
  const logMeals = [...html.matchAll(/data-action="coach-log-meal" data-meal="([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(detailMeals, logMeals, 'each meal item: details and Log, in the domain order');
  const foods = [...suggestions.topUpFoods.personalized, ...suggestions.topUpFoods.starter].map((x) => x.food.id);
  assert.deepEqual([...html.matchAll(/data-action="coach-food-detail" data-food="([^"]+)"/g)].map((m) => m[1]), foods, 'each top-up Food: details and Log');
  assert.match(html, new RegExp(`class="option-main" data-action="coach-meal-detail" data-meal="${fav.id}" aria-label="Yogurt bowl: details"`));
  // Meal detail: the one read-only Meal detail Log and Meals share (§6.4).
  const meal = app.getMeal(fav.id);
  const detail = renderMealDetail({ meal, calc: app.calculateMealMacros(fav.id), foods: {}, isFavorite: true, model: { future: false } });
  assert.match(detail, /data-action="log-meal-start" data-meal="[^"]+">Log this meal/);
  assert.match(detail, /class="link-button view-back" data-action="close"/);
  // Food detail from the Coach (§7.3 table): Favourite, Don't suggest, Custom Food Edit · Delete; no Log this food.
  const custom = renderFoodDetail({ ...foodDetailModel(app, 'food_custom_oats_overnight'), context: 'coach' });
  assert.ok(!/data-action="fd-log"|data-action="fd-add"/.test(custom), 'no Log this food, no Add to a meal');
  assert.match(custom, /data-action="fd-favorite"/);
  assert.match(custom, /data-action="fd-suggest"/);
  assert.match(custom, /data-action="fd-edit">Edit</);
  assert.match(custom, /data-action="fd-delete">Delete</);
  const core = renderFoodDetail({ ...foodDetailModel(app, 'food_core_banana'), context: 'coach' });
  assert.match(core, /<p class="sheet-subtitle">App food · can’t be edited<\/p>/, 'Core Foods stay read-only');
  assert.ok(!/data-action="fd-(log|add|edit|delete)"/.test(core));
  const src = fs.readFileSync(path.join(ROOT, 'app/today.js'), 'utf8');
  assert.match(src, /case 'coach-meal-detail': openMealDetail\(el\.dataset\.meal, ui\); break;/);
  assert.match(src, /case 'coach-food-detail': openFoodDetail\(el\.dataset\.food, ui\); break;/);
  assert.match(src, /\(ui\.type === 'meal-detail' \|\| ui\.type === 'food-detail'\) && ui\.back\) \{ returnTo\(ui\.back, ui\); return false; \}/, 'Back / Escape / Close return to where the detail was opened');
  assert.match(src, /back\.suggestions = app\.getMacroCoachSuggestions/, 'the Coach is re-queried on return, its expanded groups kept');
  assert.match(src, /case 'food-detail': dialog\.innerHTML = renderFoodDetail\(\{ \.\.\.ui, context: ui\.pickUi \? 'picker' : 'coach' \}\)/, 'the one Food detail (foods.js): the Coach context, or the picker’s (G16)');
  assert.ok(!/function renderFoodDetail|function renderMealDetail/.test(src), 'no second detail implementation');
});

test('Today G7 — deleting a Custom Food from the Coach follows §7.6 and leaves history alone', () => {
  const { app, actions } = setup();
  actions.chooseDayType('lift');
  const meal = app.createSavedMeal({ name: 'Oats bowl', mealType: 'breakfast', ingredients: [{ foodId: 'food_custom_oats_overnight', quantity: 80 }] });
  app.logFood({ date: TODAY, mealSlot: 'breakfast', foodId: 'food_custom_oats_overnight', quantity: 90 });
  const history = JSON.stringify(app.getDay(TODAY));
  app.deleteCustomFood('food_custom_oats_overnight');
  assert.equal(JSON.stringify(app.getDay(TODAY)), history, 'logged meals keep their snapshot');
  const suggestions = app.getMacroCoachSuggestions({ date: TODAY, mealSlot: 'lunch' });
  assert.deepEqual(suggestions.excluded.needsReplacement, [meal.id], 'the Saved Meal now needs a fix (A-18)');
  const html = renderCoachDialog({ suggestions, expanded: {}, note: { message: 'Deleted Oats overnight. 1 Saved Meal needs a fix:', links: [{ href: `#/meals?meal=${meal.id}`, label: 'Oats bowl' }] } });
  assert.match(html, /<div class="foods-message" role="status"><p>Deleted Oats overnight\. 1 Saved Meal needs a fix: <a href="#\/meals\?meal=[^"]+">Oats bowl<\/a><\/p><\/div>/);
});

test('Today G8 — the needs-a-fix footer appears only when a Saved Meal needs a fix, and goes to Meals filtered to those meals', () => {
  const { app, actions } = setup();
  actions.chooseDayType('lift');
  const ok = savedYogurt(app);
  const bar = app.createCustomFood({ name: 'Test bar', category: 'snack bar', state: 'prepared', nutrition: { protein: 20, carbs: 40, fat: 10 } });
  const broken = app.createSavedMeal({ name: 'Bar snack', mealType: 'snack', ingredients: [{ foodId: bar.id, quantity: 50 }] });
  let html = renderCoachDialog({ suggestions: app.getMacroCoachSuggestions({ date: TODAY, mealSlot: 'lunch' }), expanded: {} });
  assert.ok(!/coach-fix/.test(html), 'no footer while every Saved Meal can be calculated');
  app.deleteCustomFood(bar.id);
  const suggestions = app.getMacroCoachSuggestions({ date: TODAY, mealSlot: 'lunch' });
  html = renderCoachDialog({ suggestions, expanded: {} });
  assert.match(html, /<p class="note coach-fix"><button type="button" class="link-button" data-action="coach-fix">1 saved meal needs a fix<\/button> It isn’t suggested until it’s fixed\.<\/p>/);
  assert.ok(!html.includes(`data-meal="${broken.id}"`), 'the meal itself isn’t suggested');
  assert.ok(html.includes(`data-meal="${ok.id}"`));
  const src = fs.readFileSync(path.join(ROOT, 'app/today.js'), 'utf8');
  assert.match(src, /case 'coach-fix': host\.leave\(\{ method: 'push', href: '#\/meals\?filter=needs-fix' \}\); break;/);
  assert.equal(app.getMeal(broken.id).ingredients.length, 1, 'nothing is repaired or removed automatically');
});

test('Today G9 — the Coach empty state offers Add food (Log’s Foods) and Browse meals (Meals)', () => {
  const { app, actions } = setup();
  actions.chooseDayType('rest');
  // Only reachable when every Library starter uses a Food the user asked not to suggest, and there's no history (§8.6).
  const used = new Set(app.getLibraryMeals().flatMap((m) => m.ingredients.map((i) => i.foodId)));
  for (const id of used) if (app.getFood(id)) app.setDislikedFood(id, true);
  const suggestions = app.getMacroCoachSuggestions({ date: TODAY, mealSlot: 'breakfast' });
  assert.ok(suggestions.tiers.every((t) => !t.items.length) && !suggestions.topUpFoods.personalized.length && !suggestions.topUpFoods.starter.length, 'fixture: nothing to suggest');
  const html = renderCoachDialog({ suggestions, expanded: {} });
  assert.match(text(html), /Nothing to suggest right now\. Suggestions come from your saved and recently logged meals\./);
  assert.match(html, /<button type="button" class="button" data-action="coach-add-food">Add food<\/button><button type="button" class="button" data-action="coach-browse-meals">Browse meals<\/button>/);
  const src = fs.readFileSync(path.join(ROOT, 'app/today.js'), 'utf8');
  assert.match(src, /case 'coach-add-food': \{\n\s+session\.log\.segment = 'foods';\n\s+session\.log\.launchedFromToday = true;\n\s+host\.leave\(\{ method: 'push', href: `#\/log\?from=today&date=\$\{model\.date\}` \}\);/, 'Log’s own food search, with this date, returning to Today after logging');
  assert.match(src, /case 'coach-browse-meals': host\.leave\(\{ method: 'push', href: '#\/meals' \}\); break;/, 'the existing Meals screen');
  const withHistory = renderCoachDialog({ suggestions: setup().app.getMacroCoachSuggestions({ date: TODAY, mealSlot: 'breakfast', dayType: 'lift' }), expanded: {} });
  assert.ok(!/coach-add-food/.test(withHistory), 'only when there is nothing to suggest');
});

test('Today G10 — the source line opens the current recipe while it exists; history never changes', () => {
  const { app, actions } = setup();
  actions.chooseDayType('lift');
  const meal = savedYogurt(app);
  const { instance } = actions.logMeal({ mealId: meal.id, mealSlot: 'lunch' });
  const lib = actions.logMeal({ mealId: 'meal_library_B1', mealSlot: 'breakfast' }).instance;
  const direct = actions.logFood({ foodId: 'food_core_banana', quantity: 100, mealSlot: 'dinner' }).instance;
  const snapshot = JSON.stringify(app.getDay(TODAY));
  let m = todayModel(app);
  const detail = (inst) => renderInstanceDialog({ instance: inst, slot: inst.mealSlot, date: TODAY, source: m.sourceOf[inst.id], sourceName: inst.sourceMealId && app.getMeal(inst.sourceMealId) ? app.getMeal(inst.sourceMealId).name : '' });
  assert.match(detail(instance), new RegExp(`From Saved Meal <button type="button" class="link-button" data-action="source-meal" data-meal="${meal.id}" aria-label="Saved Meal Yogurt bowl: open the current recipe">“Yogurt bowl”</button>`));
  assert.match(detail(lib), /From Library Meal <button type="button" class="link-button" data-action="source-meal" data-meal="meal_library_B1"/, 'a Library source opens the Library meal (not as a Saved Meal)');
  assert.ok(!/source-line/.test(detail(direct)), 'a Food logged directly has no source line');
  // The recipe changes: the link shows the current recipe; the logged meal stays as logged.
  app.updateSavedMeal(meal.id, { name: 'Yogurt bowl v2', ingredients: [{ foodId: 'food_core_banana', quantity: 150 }] });
  const current = renderMealDetail({ meal: app.getMeal(meal.id), calc: app.calculateMealMacros(meal.id), foods: {}, isFavorite: false, model: { future: false } });
  assert.match(current, /Yogurt bowl v2/);
  assert.equal(JSON.stringify(app.getDay(TODAY)), snapshot, 'history unchanged by the recipe edit');
  assert.equal(app.getMeal('meal_library_B1').source, 'library');
  // The Saved Meal is deleted: plain text, no broken link, history intact.
  app.deleteSavedMeal(meal.id);
  m = todayModel(app);
  const gone = detail(app.getDay(TODAY).mealInstances.find((mi) => mi.id === instance.id));
  assert.match(gone, /<p class="source-line">From a meal that’s since been deleted<\/p>/);
  assert.ok(!/data-action="source-meal"/.test(gone));
  assert.equal(JSON.stringify(app.getDay(TODAY)), snapshot, 'historical macros unchanged');
  const src = fs.readFileSync(path.join(ROOT, 'app/today.js'), 'utf8');
  assert.match(src, /case 'source-meal': openMealDetail\(el\.dataset\.meal, ui\); break;/, 'opened as a view on top of the logged meal; Back returns to it');
});
