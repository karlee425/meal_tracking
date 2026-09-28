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
  coachVisibleCount, SLOT_LABELS, DAY_TYPE_LABELS, statusLine, formatDate, weekdayName, renderClearDayDialog
} from '../app/today.js';

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
  assert.deepEqual([...src.matchAll(/from '([^']+)'/g)].map((m) => m[1]).sort(), ['../src/domain/index.js', './session.js', './shell.js']);
  assert.ok(!/localStorage|sessionStorage|indexedDB|\.mealInstances\s*\.push|targetSnapshot\s*=/.test(src), 'no second store; no direct record mutation');
});
