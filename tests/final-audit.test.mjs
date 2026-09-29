/*
 * final-audit.test.mjs — the contract gaps found by the final audit (V2_UI_CONTRACT.md), each
 * pinned so it can't regress:
 *   A-44    About shows "Version unavailable" (no invented version)
 *   A-42    Food detail opened from Log's quantity sheet: Back returns to that sheet
 *   §3.2    Meals and Settings ask "Discard changes?" before a route change / a control beside a pane
 *   §7.4    the Meals picker's new-food form asks before discarding
 *   I-24    a favourited retired Library Meal still shows under Favourites, marked "Retired"
 *   A-14    after editing a Library-sourced logged meal: Just this time · Save as new only
 *   I-53    Today's adds/edits/moves/deletes announce the new remaining values
 *   §4.5.2  a past day's day-type sheet shows the date
 *   §16     Coach item → Log sheet cancel → Coach; logged-meal edit → back to its detail;
 *           Edit Saved Meal → back to the logged-meal detail
 *   I-03    rollover also on window focus, never closing a form with unsaved edits
 * Node has no DOM: renderers are tested as HTML, flows through the screens' source; every flow
 * was exercised in a real browser at 320 / 375 / 800 / 1280 and 200% text (probe/final.mjs,
 * probe/rollover.mjs and the updated g11 / esc / today5 / meals probes).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, macroArithmeticInSource, FORBIDDEN_NUTRITION, domainImportsBypassingIndex } from './helpers.mjs';
import { createDataLayer, createMemoryAdapter } from '../src/domain/index.js';
import { createFileAdapter } from '../src/node/file-adapter.js';
import { renderSettings, settingsFoodsModel, settingsScreen } from '../app/settings.js';
import { mealsList, renderMealsList, mealsScreen } from '../app/meals.js';
import { renderFollowUpDialog, renderDayTypeDialog, todayModel } from '../app/today.js';
import { resetSession, session } from '../app/session.js';

const TODAY = '2026-09-27';
const SEED = createFileAdapter(ROOT).load();
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const text = (html) => html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
function setup() {
  resetSession();
  let t = Date.parse(`${TODAY}T12:00:00Z`);
  return createDataLayer({ adapter: createMemoryAdapter(SEED), today: () => TODAY, clock: () => new Date((t += 60000)) });
}

test('A-44 — About shows "Version unavailable" and invents no version', () => {
  const app = setup();
  const html = renderSettings({ targets: app.getAllCurrentTargets(), status: null, lastBackupAt: null, restore: null, foods: settingsFoodsModel(app) });
  const about = text(html.slice(html.indexOf('id="about-title"')));
  assert.match(about, /App Macro Tracker App version Version unavailable Data format version 1/);
  assert.ok(!/\(V2\)|v\d+\.\d/.test(about), 'no app version number of any kind');
});

test('I-24 — a favourited retired Library Meal shows under Favourites with "Retired"; browsing still hides it', () => {
  const app = setup();
  const retired = app.getLibraryMeals({ includeRetired: true }).find((m) => m.metadata && m.metadata.retired);
  assert.ok(retired, 'the shipped data has retired meals');
  app.setFavoriteMeal(retired.id, true);
  const browse = mealsList(app, { segment: 'library' });
  assert.ok(!browse.items.some((i) => i.meal.id === retired.id), 'hidden from browsing');
  const fav = mealsList(app, { segment: 'library', favorites: true });
  assert.ok(fav.items.some((i) => i.meal.id === retired.id), 'still shown under Favourites');
  const html = renderMealsList(fav);
  const card = html.slice(html.indexOf(`data-meal="${retired.id}"`), html.indexOf('</li>', html.indexOf(`data-meal="${retired.id}"`)));
  assert.match(card, /<span class="marker">Retired<\/span>/, 'marked Retired');
});

test('A-14 — the follow-up for a Library source offers Just this time and Save as new only', () => {
  const saved = text(renderFollowUpDialog({ savedName: 'Oats', mode: 'choice', newName: 'x' }));
  assert.match(saved, /Just this time Save as a new saved meal Also update “Oats”/);
  const library = renderFollowUpDialog({ savedName: 'Oats', mode: 'choice', newName: 'x', library: true });
  assert.match(text(library), /Just this time Save as a new saved meal/);
  assert.ok(!/followup-confirm-update|Also update/.test(library));
  const src = read('app/today.js');
  assert.match(src, /function followUpFor\(instance, changed, \{ editing = false \} = \{\}\)/);
  assert.match(src, /meal\.source === 'saved' \|\| \(editing && meal\.source === 'library'\)/, 'Library only after editing (§4.3.4); Log’s adjusted logging stays Saved-only (§5.4)');
  assert.match(src, /followUpFor\(result\.instance, changed, \{ editing: true \}\)/);
});

test('§4.5.2 — a past day’s day-type sheet shows its date; today’s doesn’t', () => {
  const app = setup();
  app.createDay('2026-09-20', 'lift');
  app.createDay(TODAY, 'rest');
  const past = renderDayTypeDialog({ model: todayModel(app, '2026-09-20'), selected: 'lift', preview: null, applyPreview: null });
  assert.match(past, /<h2 id="sheet-title" class="sheet-title">Day type · [^<]*20[^<]*<\/h2>/);
  const today = renderDayTypeDialog({ model: todayModel(app, TODAY), selected: 'rest', preview: null, applyPreview: null });
  assert.match(today, /<h2 id="sheet-title" class="sheet-title">Day type<\/h2>/);
});

test('I-53 / §16 / I-03 — Today: remaining values announced; edits return to the detail; Coach sheets return to the Coach; rollover on focus', () => {
  const src = read('app/today.js');
  assert.match(src, /say\(dayEdit && summary\.exists \? `\$\{result\.message\} \$\{remainingSummary\(summary, \{ isToday: model\.isToday, date: model\.date \}\)\}` : result\.message\);/);
  assert.match(src, /if \(!editDirty\(ui\)\) \{ openInstance\(ui\.instance\.id\); return false; \}/, 'cancel an untouched edit → the detail');
  assert.match(src, /if \(ui\.type === 'discard-edit'\) \{ openInstance\(ui\.back\.instance\.id\); return; \}/, 'Discard → the detail, unchanged');
  assert.match(src, /dayEdit: true, reopen: result\.instance\.id \}\);/, 'saved → the detail (then the follow-up)');
  assert.match(src, /if \(ui\.type === 'followup' && ui\.instanceId && model\.day/, 'the follow-up ends on the detail');
  assert.match(src, /case 'coach-log-meal': openMeal\(el\.dataset\.meal, null, ui\); break;/);
  assert.match(src, /type: 'quantity', food: app\.getFood\(el\.dataset\.food\), slot: defaultSlot\(model\.day\), text: '', preview: null, back: ui \}/);
  assert.match(src, /if \(\(ui\.type === 'meal' \|\| ui\.type === 'quantity'\) && ui\.back\) \{ stepBackTo\(ui\.back\); return false; \}/);
  assert.match(src, /win\.addEventListener\('focus', onVisible\);/);
  assert.match(src, /app\.getToday\(\) !== model\.date && !unsaved\(\)\)/, 'a form with unsaved edits is never closed by the rollover');
  assert.match(src, /win\.removeEventListener\('focus', onVisible\);/);
});

test('§16 — Edit Saved Meal from a logged meal comes back to that logged meal’s detail', () => {
  resetSession();
  assert.equal(session.savedMealEdit, null);
  const today = read('app/today.js');
  assert.match(today, /case 'edit-saved-meal': session\.savedMealEdit = \{ mealId: el\.dataset\.meal, date: model\.date, instanceId: ui && ui\.instance \? ui\.instance\.id : null \}; break;/);
  const meals = read('app/meals.js');
  assert.match(meals, /fromToday = handback && handback\.mealId === linked\.id && handback\.instanceId \? handback : null;/);
  assert.match(meals, /openEditor\(draftFromMeal\(linked\), \{ returnTo: fromToday \? 'today' : 'detail' \}\);/, 'cancel goes straight back; save shows the Meal detail first');
  assert.match(meals, /session\.handoff = \{ date: f\.date, openInstanceId: f\.instanceId \};\n\s*host\.leave\(\{ method: 'back' \}\);/, 'closing Meals hands back to Today, which opens that logged meal');
  assert.match(meals, /fromToday = null; \/\/ going somewhere else instead/, 'leaving for another destination after Discard doesn’t also step back');
});

test('§3.2 / §7.4 — Meals and Settings guard route changes and controls beside a pane; the Meals picker’s new-food form asks', () => {
  for (const [file, screen] of [['app/meals.js', mealsScreen], ['app/settings.js', settingsScreen]]) {
    const src = read(file);
    assert.equal(typeof screen.leaveGuard, 'function', `${file}: the shell can ask`);
    assert.equal(screen.leaveGuard(() => {}), true, `${file}: not mounted → nothing to lose`);
    assert.match(src, /if \(dialog\.open && !dialog\.contains\(el\) && !guardLeave\(/, `${file}: a control beside an open pane asks first`);
    const at = src.indexOf('if (ui.proceed) {');
    assert.ok(at > 0, `${file}: after Discard, goes where the user was heading`);
    const discard = src.slice(at, src.indexOf('break;', at));
    assert.match(discard, /win\.setTimeout\(proceed, 0\)/);
    assert.ok(!/app\.(create|update|delete|set|save)|actions\.|saveDraft/.test(discard), `${file}: Discard saves nothing`);
  }
  const meals = read('app/meals.js');
  assert.match(meals, /if \(draft && draftDirty\(draft\)\) \{ show\(\{ type: 'discard', proceed \}\); return false; \}/);
  assert.match(meals, /if \(customFoodDirty\(ui\)\) \{ show\(\{ type: 'discard-food', form: ui, proceed: null \}\); return false; \}/);
  assert.match(meals, /values, initial: \{ \.\.\.values \}, touched: new Set\(\)/, 'the new-food form knows what it opened with');
  const settings = read('app/settings.js');
  assert.match(settings, /if \(ui\.type === 'target-edit' && formDirty\(ui\)\) \{ show\(\{ type: 'discard', form: ui, proceed \}\); return false; \}/);
  assert.match(settings, /if \(ui\.type === 'custom-food' && customFoodDirty\(ui\)\) \{ show\(\{ type: 'discard-food', form: ui, proceed \}\); return false; \}/);
});

test('A-42 — Log: Food detail opened from the quantity sheet goes back to that sheet as it was left', () => {
  const src = read('app/log.js');
  assert.match(src, /if \(ui\.type === 'food-detail' && ui\.quantity\) \{\n\s*const q = ui\.quantity;\n\s*openFood\(q\.foodId, q\.text, q\.intent, q\.slot\);/);
});

test('final audit — no macro arithmetic, forbidden terms, domain bypass or second store in the changed files', () => {
  for (const f of ['app/today.js', 'app/meals.js', 'app/settings.js', 'app/log.js', 'app/session.js', 'app/shell.js']) {
    const src = read(f);
    assert.deepEqual(macroArithmeticInSource(src, f), [], f);
    assert.ok(!FORBIDDEN_NUTRITION.test(src), f);
    assert.deepEqual(domainImportsBypassingIndex(src), [], f);
    assert.ok(!/localStorage|sessionStorage|indexedDB/.test(src), f);
  }
});

test('§3.2 — switching tabs keeps each tab’s scroll position (memory only); a deep link starts at the top', async () => {
  const { createShell } = await import('../app/shell.js');
  const listeners = {};
  const scrolled = [];
  const win = {
    location: { hash: '#/meals', get href() { return `http://app/${this.hash}`; } },
    history: { replaceState() {}, pushState() {} },
    scrollY: 0,
    scrollTo(x, y) { scrolled.push(y); this.scrollY = y; },
    addEventListener(type, fn) { (listeners[type] ||= []).push(fn); },
    setTimeout: () => 0, clearTimeout() {}
  };
  const focusCalls = [];
  const root = { innerHTML: '', querySelector: (sel) => (sel === '#screen-title' ? { focus: (o) => focusCalls.push(o) } : null), addEventListener() {} };
  const shell = createShell({ root, win, doc: { title: '', addEventListener() {} } });
  shell.start();
  shell.setDataLayer({ getPersistenceStatus: () => ({ state: 'saved', lastSavedAt: 'x' }), onPersistenceChange: () => () => {}, flushPersistence: () => Promise.resolve() });
  const go = (hash) => { win.location.hash = hash; for (const fn of listeners.hashchange) fn(); };
  win.scrollY = 900;
  go('#/today');
  assert.deepEqual(scrolled, [], 'a tab not visited yet starts at the top');
  win.scrollY = 40;
  go('#/meals');
  assert.deepEqual(scrolled, [900], 'Meals comes back where it was');
  assert.deepEqual(focusCalls.at(-1), { preventScroll: true }, 'focus moves to the heading without jumping to the top');
  go('#/today?date=2026-09-01');
  assert.deepEqual(scrolled, [900], 'a deep link starts at the top');
  assert.ok(!/localStorage|sessionStorage/.test(read('app/shell.js')));
});

test('A-45 — Edit logged meal: Save stays disabled while the name is empty, and the name is marked for Enter (§14)', () => {
  const src = read('app/today.js');
  assert.match(src, /const noName = !String\(ui\.name \|\| ''\)\.trim\(\);/);
  assert.match(src, /dialog\.querySelector\('\[data-action="save-instance"\]'\)\.disabled = !patch \|\| noName;/);
  assert.match(src, /nameEl\.toggleAttribute\('data-invalid', noName\)/);
  assert.match(src, /ui\.name = el\.value;\n\s*updateEditPreview\(\);/, 'checked as the name changes');
});
