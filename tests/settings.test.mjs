/*
 * settings.test.mjs — V2 UI Slice 6: Settings (§10), Backup / Restore (§11) and the start-up
 * recovery and save-error states (§4.8, §13.1). Pure renderers and domain / browser-layer
 * behaviour are tested here; the DOM wiring is exercised in a real browser (slice report).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, macroArithmeticInSource, FORBIDDEN_NUTRITION, domainImportsBypassingIndex } from './helpers.mjs';
import { createDataLayer, createMemoryAdapter, USER_COLLECTIONS, BACKUP_FORMAT, BACKUP_FORMAT_VERSION } from '../src/domain/index.js';
import { createFileAdapter } from '../src/node/file-adapter.js';
import { openBrowserDataLayer, recoverStoredData, validateRecoveryBackup, APP_DATA } from '../src/browser/app-data.js';
import { createMemorySnapshotStore } from '../src/browser/memory-snapshot-store.js';
import { todayModel } from '../app/today.js';
import { mealsList } from '../app/meals.js';
import { progressModel } from '../app/progress.js';
import { backupFile, downloadBackup, localStamp } from '../app/download.js';
import {
  renderApp, renderRecovery, saveBannerView, conflictDialogView, restoreErrorMessage, backupSummaryText, RECOVERABLE_CODES, createShell
} from '../app/shell.js';
import {
  SETTINGS_VIEW_TYPES, targetLine, parseTargetInput, parseTargets, saveStatusText, renderSettings, renderTargetForm,
  renderTargetConfirm, renderApplyToday, renderBackupSheet, renderRestorePreview, restoreMessage, settingsScreen
} from '../app/settings.js';

const TODAY = '2026-09-28';
const SEED = createFileAdapter(ROOT).load();
const CANONICAL = { lift: { protein: 150, carbs: 293, fat: 70 }, long_run: { protein: 150, carbs: 343, fat: 70 }, rest: { protein: 150, carbs: 218, fat: 70 } };

function setup() {
  const inner = createMemoryAdapter(SEED);
  const writes = [];
  const adapter = { load: () => inner.load(), save: (c, d) => inner.save(c, d), saveMany: (ch) => { writes.push(Object.keys(ch)); inner.saveMany(ch); } };
  let t = Date.parse(`${TODAY}T12:00:00Z`);
  const app = createDataLayer({ adapter, today: () => TODAY, clock: () => new Date((t += 60000)) });
  return { app, writes };
}
const text = (html) => html.replace(/<[^>]*>/g, ' ').replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').replace(/\s+/g, ' ');
const ago = (n) => new Date(Date.UTC(2026, 8, 28 - n)).toISOString().slice(0, 10);
function withHistory(app) {
  app.createDay(ago(2), 'lift');
  app.logFood({ date: ago(2), mealSlot: 'lunch', foodId: 'food_core_banana', quantity: 200 });
  app.setDayLoggingComplete(ago(2), true);
  const meal = app.createSavedMeal({ name: 'Yogurt bowl', mealType: 'snack', ingredients: [{ foodId: 'food_core_fage_0_greek_yogurt', quantity: 150 }] });
  app.createDay(TODAY, 'lift');
  app.createMealInstance({ date: TODAY, mealSlot: 'breakfast', mealId: meal.id });
  return meal;
}
const settingsHtml = (app, restore = null) => renderSettings({ targets: app.getAllCurrentTargets(), status: app.getPersistenceStatus(), lastBackupAt: (app.getPreferences().appPreferences || {}).lastBackupAt || null, restore });

/* ---------------- Settings ---------------- */

test('Settings — the route is built and reached from the header, not the tabs', () => {
  const main = fs.readFileSync(path.join(ROOT, 'app/main.js'), 'utf8');
  assert.match(main, /settings: settingsScreen/);
  assert.equal(typeof settingsScreen.mount, 'function');
  const html = renderApp({ route: 'settings', startup: 'ready', status: null });
  assert.match(html, /class="header-button" href="#\/settings" data-destination="settings" aria-current="page"/);
  assert.ok(!/class="nav-link" href="#\/settings"/.test(html), 'Settings is not a primary tab');
});

test('Settings — sections: Targets (the seeded canonical values), Data on this device, About', () => {
  const { app } = setup();
  assert.deepEqual(app.getAllCurrentTargets(), CANONICAL, 'seeded targets unchanged');
  const html = settingsHtml(app);
  assert.deepEqual([...html.matchAll(/<h2 id="[a-z-]+" class="section-title">([^<]+)<\/h2>/g)].map((m) => m[1]), ['Targets', 'Data on this device', 'About']);
  assert.match(html, /<h1 id="screen-title"[^>]*>Settings<\/h1>/);
  assert.deepEqual([...html.matchAll(/<p class="target-values">([^<]+)<\/p>/g)].map((m) => m[1]), ['P 150 · C 293 · F 70 g', 'P 150 · C 343 · F 70 g', 'P 150 · C 218 · F 70 g']);
  assert.match(html, /aria-label="Edit Long Run targets">Edit</);
  assert.match(text(html), /Last backup Never/);
  assert.match(html, /data-action="backup">Download backup</);
  assert.match(html, /data-action="restore">Restore from backup</);
  assert.match(html, /accept="\.json,application\/json" data-restore-file/);
  assert.match(text(html), new RegExp(`Data format version ${BACKUP_FORMAT_VERSION}`));
  assert.match(text(html), /Macros only: protein, carbs and fat, in grams\./);
  assert.match(text(html), /The app doesn’t back up automatically, and nothing leaves this device\./, 'manual and local, no cloud claim');
  assert.ok(!FORBIDDEN_NUTRITION.test(html));
  assert.ok(!/sync|cloud|account|notification|theme|reset everything/i.test(text(html)), 'nothing beyond the contract');
});

test('Settings — targets are checked by the domain (validateTargets), the same rules updateCurrentTargets enforces', () => {
  const { app, writes } = setup();
  assert.deepEqual(app.validateTargets({ protein: 150, carbs: 310, fat: 70 }), { valid: true, errors: [] });
  for (const bad of [Number.NaN, Infinity, -Infinity, -1, undefined, '310', null]) {
    const v = app.validateTargets({ protein: 150, carbs: bad, fat: 70 });
    assert.equal(v.valid, false, String(bad));
    assert.deepEqual(v.errors.map((e) => [e.field, e.code]), [['carbs', 'TARGET_NOT_A_VALID_NUMBER']]);
    assert.throws(() => app.updateCurrentTargets('lift', { protein: 150, carbs: bad, fat: 70 }), (e) => e.code === 'INVALID_TARGETS' && e.details[0].field === 'carbs');
  }
  assert.equal(app.validateTargets({ calcium: 1 }).errors[0].code, 'TARGET_UNKNOWN_FIELD');
  assert.equal(app.validateTargets(null).errors[0].code, 'TARGETS_REQUIRED');
  assert.equal(writes.length, 0, 'validation and rejected updates write nothing');
  assert.deepEqual(app.getAllCurrentTargets(), CANONICAL);
  assert.equal(parseTargetInput(''), undefined, 'empty is "required", never NaN');
  assert.equal(parseTargetInput(' 12,5 '), 12.5);
  assert.ok(Number.isNaN(parseTargetInput('abc')), 'garbage stays NaN for the domain to reject');
  assert.equal(parseTargetInput('Infinity'), Infinity);
  assert.deepEqual(parseTargets({ protein: '150', carbs: '', fat: '70' }), { protein: 150, carbs: undefined, fat: 70 });
});

test('Settings — the target form: domain errors per field, Save disabled while invalid or unchanged; Cancel keeps nothing', () => {
  const { app } = setup();
  const original = app.getCurrentTargets('lift');
  const values = { protein: '150', carbs: '293', fat: '70' };
  let html = renderTargetForm({ dayType: 'lift', values, original, validation: app.validateTargets(parseTargets(values)), touched: new Set() });
  assert.equal(SETTINGS_VIEW_TYPES.includes('target-edit'), true, 'an editing view (pushed / panel / pane like Log and Meals)');
  assert.match(html, /Edit Lift targets/);
  assert.match(html, /<label class="field" for="tf-carbs">Carbs<\/label>/);
  assert.match(html, /data-action="target-save" data-sync="tf-save" aria-describedby="tf-needs" disabled>Save/, 'unchanged: nothing to save');
  assert.match(html, /No changes yet\./);
  const bad = { ...values, carbs: 'abc' };
  html = renderTargetForm({ dayType: 'lift', values: bad, original, validation: app.validateTargets(parseTargets(bad)), touched: new Set(['carbs']) });
  assert.match(html, /id="tf-carbs"[^>]*aria-describedby="tf-carbs-error"[^>]*aria-invalid="true"/);
  assert.match(html, /<p id="tf-carbs-error" class="field-error" data-sync="tf-carbs-error">Enter whole grams, 0 or more\.<\/p>/);
  assert.match(html, /Needed before saving: carbs as whole grams, 0 or more\./);
  assert.match(html, /data-action="target-save"[^>]*disabled>Save/);
  const good = { ...values, carbs: '310' };
  html = renderTargetForm({ dayType: 'lift', values: good, original, validation: app.validateTargets(parseTargets(good)), touched: new Set(['carbs']) });
  assert.match(html, /data-action="target-save" data-sync="tf-save" aria-describedby="tf-needs">Save/);
  assert.match(text(renderTargetConfirm({ dayType: 'lift', parsed: parseTargets(good) })), /Change Lift targets to P 150 · C 310 · F 70\? This applies to days you set up from now on\. Days already set up keep their targets\./, '§10.2 copy');
  assert.deepEqual(app.getAllCurrentTargets(), CANONICAL, 'rendering and cancelling change nothing');
});

test('Settings — changing current targets never rewrites a Day; today changes only on "Use for today"', () => {
  const { app } = setup();
  withHistory(app);
  const pastBefore = JSON.stringify(app.getDay(ago(2)));
  const progressBefore = progressModel(app, { period: 7 });
  app.updateCurrentTargets('lift', { protein: 150, carbs: 310, fat: 70 });
  assert.equal(JSON.stringify(app.getDay(ago(2))), pastBefore, 'a past Day keeps its snapshot');
  assert.deepEqual(app.getDay(TODAY).targetSnapshot, CANONICAL.lift, 'today keeps its snapshot until the user chooses');
  assert.deepEqual(progressModel(app, { period: 7 }).daily, progressBefore.daily, 'Progress history unchanged');
  assert.equal(todayModel(app).summary.target.carbs, 293);
  const preview = app.previewApplyCurrentTargetsToToday();
  assert.equal(preview.applies, true);
  assert.match(text(renderApplyToday({ dayType: 'lift', preview })), /Today is a Lift day set up with P 150 · C 293 · F 70 g\. Using the new targets changes today only: P 150 · C 310 · F 70 g\./);
  assert.match(renderApplyToday({ dayType: 'lift', preview }), /data-action="close" data-autofocus>Not now/);
  app.applyCurrentTargetsToToday();
  assert.equal(todayModel(app).summary.target.carbs, 310, 'only on explicit request');
  assert.equal(JSON.stringify(app.getDay(ago(2))), pastBefore, 'past days never change');
  app.createDay(ago(1), 'lift');
  assert.equal(app.getDay(ago(1)).targetSnapshot.carbs, 310, 'new days use the new current targets');
  assert.match(settingsHtml(app), /P 150 · C 310 · F 70 g/);
});

test('Settings — targets are whole grams: one domain rule for validateTargets, updateCurrentTargets and the schema', () => {
  const { app, writes } = setup();
  for (const ok of [150, 293, 0, 150.0, Number('150.0'), parseTargetInput('150.0')]) {
    assert.deepEqual(app.validateTargets({ protein: 150, carbs: ok, fat: 70 }), { valid: true, errors: [] }, `${ok} is a whole number`);
  }
  for (const dec of [150.5, 0.3, parseTargetInput('150.5'), parseTargetInput('293,4'), 1e-7]) {
    const v = app.validateTargets({ protein: 150, carbs: dec, fat: 70 });
    assert.equal(v.valid, false, `${dec} rejected`);
    assert.deepEqual(v.errors.map((e) => [e.field, e.code]), [['carbs', 'TARGET_NOT_A_WHOLE_NUMBER']]);
    assert.throws(() => app.updateCurrentTargets('lift', { carbs: dec }),
      (e) => e.code === 'INVALID_TARGETS' && e.details.length === 1 && e.details[0].field === 'carbs' && e.details[0].code === 'TARGET_NOT_A_WHOLE_NUMBER' && /whole number/.test(e.message));
  }
  // NaN / ±Infinity / negative / text / empty keep their existing code; negative decimals are "not a valid number".
  for (const bad of [Number.NaN, Infinity, -Infinity, -1, -0.5, parseTargetInput('abc'), parseTargetInput('')]) {
    assert.deepEqual(app.validateTargets({ protein: 150, carbs: bad, fat: 70 }).errors.map((e) => e.code), ['TARGET_NOT_A_VALID_NUMBER'], String(bad));
  }
  assert.deepEqual(app.validateTargets({ protein: 150.5, carbs: 'x', fat: 70.25 }).errors.map((e) => [e.field, e.code]),
    [['protein', 'TARGET_NOT_A_WHOLE_NUMBER'], ['carbs', 'TARGET_NOT_A_VALID_NUMBER'], ['fat', 'TARGET_NOT_A_WHOLE_NUMBER']], 'every problem reported at once');
  assert.equal(writes.length, 0, 'nothing is written for a rejected value');
  assert.deepEqual(app.getAllCurrentTargets(), CANONICAL, 'canonical seeded targets unchanged');
  // A whole-number save still works, and 150.0 is stored as 150.
  app.updateCurrentTargets('lift', { protein: 150.0, carbs: 310, fat: 70 });
  assert.deepEqual(app.getCurrentTargets('lift'), { protein: 150, carbs: 310, fat: 70 });
  assert.deepEqual(writes, [['targets']], 'one write, targets only');
  // The schema says the same thing (the store validates every commit against it).
  const schema = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/schemas/targets.schema.json'), 'utf8'));
  for (const key of ['protein', 'carbs', 'fat']) assert.deepEqual(schema.$defs.macros.properties[key], { type: 'integer', minimum: 0 });
  const seed = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/targets.json'), 'utf8'));
  assert.deepEqual(seed, CANONICAL, 'data/targets.json (the canonical seed) is untouched');
});

test('Settings — the save path rejects decimals: whole-grams message, Save disabled, nothing reaches the confirmation', () => {
  const { app, writes } = setup();
  const original = app.getCurrentTargets('lift');
  const values = { protein: '150', carbs: '293.5', fat: '70' };
  const validation = app.validateTargets(parseTargets(values));
  assert.equal(validation.valid, false);
  const html = renderTargetForm({ dayType: 'lift', values, original, validation, touched: new Set(['carbs']) });
  assert.match(html, /<p id="tf-carbs-error" class="field-error" data-sync="tf-carbs-error">Use whole grams, no decimals\.<\/p>/);
  assert.match(html, /id="tf-carbs"[^>]*aria-invalid="true"/);
  assert.match(html, /Needed before saving: carbs as whole grams, 0 or more\./);
  assert.match(html, /data-action="target-save"[^>]*disabled>Save/);
  assert.match(html, /id="tf-carbs" type="text" inputmode="numeric"/, 'a whole-number keypad');
  // The confirmation step saves through updateCurrentTargets, which refuses the same value.
  assert.throws(() => app.updateCurrentTargets('lift', parseTargets(values)), (e) => e.code === 'INVALID_TARGETS');
  assert.equal(writes.length, 0);
  assert.deepEqual(app.getAllCurrentTargets(), CANONICAL);
  // The mount has no rule of its own: it asks validateTargets on input and on Save, and the domain again on confirm.
  const src = fs.readFileSync(path.join(ROOT, 'app/settings.js'), 'utf8');
  assert.ok(!/isInteger|Number\.isFinite|% ?1\b|Math\.(floor|round|trunc)/.test(src), 'no integer check in the UI');
  assert.equal((src.match(/app\.validateTargets\(/g) || []).length, 3, 'input, open and Save all use the domain');
  assert.match(src, /app\.updateCurrentTargets\(dayType, parsed\)/);
});

test('Settings — tightening the rule never re-judges history: stored Day snapshots with decimals still open and stay as stored', () => {
  const daySchema = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/schemas/day.schema.json'), 'utf8'));
  for (const key of ['protein', 'carbs', 'fat']) assert.equal(daySchema.$defs.macros.properties[key].type, 'number', 'Day snapshots keep the existing number rule');
  const { app } = setup();
  withHistory(app);
  const past = app.getDay(ago(2));
  // A Day recorded under the old rule, e.g. a snapshot of 292.5 g carbs.
  const legacy = { ...SEED, days: [...app.exportUserData().data.days].map((d) => (d.date === ago(2) ? { ...d, targetSnapshot: { ...d.targetSnapshot, carbs: 292.5 } } : d)) };
  const reopened = createDataLayer({ adapter: createMemoryAdapter({ ...SEED, ...legacy, targets: CANONICAL }), today: () => TODAY });
  assert.equal(reopened.getDay(ago(2)).targetSnapshot.carbs, 292.5, 'opened and read back unchanged');
  reopened.updateCurrentTargets('lift', { carbs: 300 });
  assert.equal(reopened.getDay(ago(2)).targetSnapshot.carbs, 292.5, 'a target edit leaves it alone');
  assert.equal(JSON.stringify(app.getDay(ago(2))), JSON.stringify(past));
});

/* ---------------- Backup ---------------- */

test('Backup — the domain’s backup format, user-owned collections only, re-validated as the saved text', () => {
  const { app } = setup();
  withHistory(app);
  const file = backupFile(app);
  assert.equal(file.filename, `macro-tracker-backup-${TODAY}.json`);
  const doc = JSON.parse(file.text);
  assert.equal(doc.format, BACKUP_FORMAT);
  assert.equal(doc.formatVersion, BACKUP_FORMAT_VERSION);
  assert.deepEqual(Object.keys(doc).sort(), ['data', 'exportedAt', 'format', 'formatVersion']);
  assert.deepEqual(Object.keys(doc.data), [...USER_COLLECTIONS], 'targets, customFoods, savedMeals, days, preferences');
  assert.ok(!/coreFoods|libraryMeals|schemas|legacyId|nativeDayType|migration/.test(JSON.stringify(Object.keys(doc.data))), 'no app data or migration state');
  assert.equal(doc.data.customFoods.every((f) => f.source === 'custom'), true, 'only the user’s own foods');
  assert.deepEqual(file.summary, { customFoods: doc.data.customFoods.length, savedMeals: 1, days: 2, mealInstances: 2 });
  assert.equal(app.validateBackup(file.text).valid, true);
  assert.match(text(renderBackupSheet({ summary: file.summary, note: '' })), /Backup of everything you’ve entered on this device: 2 logged days, 1 saved meal, \d+ of your foods\./);
  assert.match(localStamp(new Date(2026, 0, 5)), /^2026-01-05$/);
});

test('Backup — a value that would serialise badly can never be handed out as a valid backup', () => {
  const { app } = setup();
  const broken = app.exportUserData();
  broken.data.targets.lift.carbs = Number.NaN; // JSON turns this into null
  const liar = { ...app, exportUserData: () => broken, validateBackup: (t) => app.validateBackup(t), getToday: () => TODAY };
  assert.throws(() => backupFile(liar), (e) => e.code === 'BACKUP_INVALID' && e.errors.length > 0);
  assert.equal(JSON.parse(JSON.stringify(broken)).data.targets.lift.carbs, null, 'why: NaN → null');
  assert.equal(app.validateBackup(JSON.stringify(broken)).code, 'BACKUP_INVALID');
});

test('Backup — download remembers when (appPreferences.lastBackupAt), and only after the file was offered', () => {
  const { app } = setup();
  const clicked = [];
  const fakeDoc = {
    defaultView: { URL: { createObjectURL: () => 'blob:x', revokeObjectURL() {} }, Blob: function Blob(parts) { this.parts = parts; }, setTimeout: () => 0 },
    createElement: () => ({ click() { clicked.push(this.download); }, remove() {} }),
    body: { appendChild() {} }
  };
  const file = downloadBackup(fakeDoc, app);
  assert.deepEqual(clicked, [file.filename]);
  assert.equal(app.getPreferences().appPreferences.lastBackupAt, file.exportedAt);
  assert.match(text(settingsHtml(app)), /Last backup [A-Z][a-z]{2} \d+, 2026/);
  const refusing = { ...fakeDoc, defaultView: { ...fakeDoc.defaultView, URL: { createObjectURL: () => { throw new Error('blocked'); } } } };
  const before = app.getPreferences().appPreferences.lastBackupAt;
  assert.throws(() => downloadBackup(refusing, app));
  assert.equal(app.getPreferences().appPreferences.lastBackupAt, before, 'not recorded when the download failed');
});

/* ---------------- Restore ---------------- */

test('Restore — malformed, unrecognised and invalid backups fail safely: nothing changes, nothing partial', () => {
  const { app, writes } = setup();
  withHistory(app);
  const good = backupFile(app).text;
  const snapshot = JSON.stringify(app.exportUserData().data);
  const n = writes.length;
  const doc = JSON.parse(good);
  const cases = [
    ['{not json', 'BACKUP_UNREADABLE'],
    ['[1,2,3]', 'BACKUP_UNREADABLE'],
    [JSON.stringify({ format: 'other-app', formatVersion: 1, data: {} }), 'BACKUP_INCOMPATIBLE'],
    [JSON.stringify({ ...doc, formatVersion: 99 }), 'BACKUP_INCOMPATIBLE'],
    [JSON.stringify({ ...doc, data: { ...doc.data, days: 'nope' } }), 'BACKUP_INVALID'],
    // valid targets but a broken Day: all-or-nothing, so the targets must not be applied either
    [JSON.stringify({ ...doc, data: { ...doc.data, targets: { ...doc.data.targets, lift: { protein: 1, carbs: 1, fat: 1 } }, days: [{ ...doc.data.days[0], dayType: 'someday' }] } }), 'BACKUP_INVALID'],
    [JSON.stringify({ ...doc, data: { ...doc.data, savedMeals: [{ ...doc.data.savedMeals[0], ingredients: [{ foodId: 'food_missing', quantity: 10, unit: 'g' }] }] } }), 'BACKUP_INVALID']
  ];
  for (const [input, code] of cases) {
    const v = app.validateBackup(input);
    assert.equal(v.code, code, input.slice(0, 40));
    assert.throws(() => app.restoreUserData(input), (e) => e.code === code);
    assert.equal(JSON.stringify(app.exportUserData().data), snapshot, `${code}: untouched`);
    assert.ok(restoreMessage({ tone: 'error', message: restoreErrorMessage(code), code, errors: v.errors }).includes(restoreErrorMessage(code)));
  }
  assert.equal(writes.length, n, 'no write at all');
  assert.equal(restoreErrorMessage('BACKUP_UNREADABLE'), 'This file isn’t a backup this app can read.');
  assert.equal(restoreErrorMessage('BACKUP_INCOMPATIBLE'), 'This backup is from a different or newer version of the app and can’t be restored here.');
  assert.equal(restoreErrorMessage('BACKUP_INVALID'), 'This backup has problems, so it wasn’t restored. Your current data is untouched.');
  assert.match(restoreMessage({ tone: 'error', message: 'x', code: 'BACKUP_INVALID', errors: ['a', 'b'] }), /<details class="error-details"><summary>Details<\/summary><p><code>BACKUP_INVALID<\/code><\/p><ul><li>a<\/li><li>b<\/li><\/ul><\/details>/);
});

test('Restore — preview and explicit confirmation; then the whole state is replaced and every screen reads it', () => {
  const source = setup().app;
  withHistory(source);
  source.updateCurrentTargets('rest', { protein: 140, carbs: 200, fat: 65 });
  const backup = backupFile(source);
  const { app } = setup(); // a different device: seed data only
  const current = app.validateBackup(app.exportUserData()).summary;
  const preview = renderRestorePreview({ summary: backup.summary, current, exportedAt: backup.exportedAt, note: '' });
  assert.match(text(preview), /Backup from .+: 2 logged days · 2 logged meals · 1 saved meal · \d+ of your foods\./);
  assert.match(text(preview), /On this device now: 0 logged days · 0 logged meals · 0 saved meals/);
  assert.match(text(preview), /Restoring replaces everything in the app on this device: targets, your foods, saved meals, every logged day and your preferences\. It can’t be undone\./);
  assert.match(preview, /data-action="download-current">Download current data first/);
  assert.match(preview, /data-action="close" data-autofocus>Cancel<\/button><button type="button" class="button danger" data-action="restore-confirm">Replace my data/, 'Cancel is the default focus');
  assert.equal(app.getSavedMeals().length, 0, 'previewing changes nothing');

  const { restored } = app.restoreUserData(backup.text);
  assert.equal(backupSummaryText(restored), '2 logged days · 2 logged meals · 1 saved meal · 2 of your foods');
  assert.deepEqual(app.exportUserData().data, JSON.parse(backup.text).data, 'exactly the backup');
  assert.deepEqual(app.getCurrentTargets('rest'), { protein: 140, carbs: 200, fat: 65 });
  assert.equal(todayModel(app).summary.exists, true, 'Today reads the restored day');
  assert.deepEqual(todayModel(app).summary.target, CANONICAL.lift, 'with its own stored snapshot');
  assert.deepEqual(mealsList(app, { segment: 'saved' }).items.map((x) => x.meal.name), ['Yogurt bowl'], 'Meals');
  assert.equal(progressModel(app, { period: 7 }).counts.complete, 1, 'Progress');
  assert.deepEqual(app.getLibraryMeals(), source.getLibraryMeals(), 'app-managed Library untouched');
});

test('Restore — a durable-save failure afterwards keeps the stored data intact and surfaces the save error', async () => {
  const store = createMemorySnapshotStore();
  const { app: first } = await openBrowserDataLayer({ snapshotStore: store, today: () => TODAY });
  first.updateCurrentTargets('lift', { carbs: 300 });
  await first.flushPersistence();
  const storedBefore = store.peek();
  const source = setup().app;
  withHistory(source);
  const backup = backupFile(source).text;
  store.failNextWrites(1);
  first.restoreUserData(backup);
  const status = await first.flushPersistence();
  assert.equal(status.state, 'error', 'the save error banner applies');
  assert.deepEqual(store.peek(), storedBefore, 'the stored record is still the old one: nothing partial');
  assert.match(saveBannerView(status), /Your latest changes aren’t saved on this device yet/);
  const retried = await first.retryPersistence();
  assert.equal(retried.state, 'saved');
  assert.deepEqual(store.peek().data, JSON.parse(backup).data, 'Try again writes the whole restored state at once');
});

/* ---------------- start-up error states and recovery (§13.1) ---------------- */

test('Errors — STORAGE_UNAVAILABLE, STORED_DATA_UNRECOGNIZED and DATA_INVALID from the browser data layer', async () => {
  const unreadable = { read: async () => { throw new Error('denied'); }, write: async () => {} };
  await assert.rejects(openBrowserDataLayer({ snapshotStore: unreadable }), (e) => e.code === 'STORAGE_UNAVAILABLE');
  const odd = { format: 'another-app', version: 3, data: {} };
  await assert.rejects(openBrowserDataLayer({ snapshotStore: createMemorySnapshotStore(odd) }), (e) => e.code === 'STORED_DATA_UNRECOGNIZED' && typeof e.readStoredRecord === 'function');
  const invalid = { format: 'macro-tracker-v2-store', version: 1, revision: 2, savedAt: '2026-09-01T00:00:00Z', data: { ...APP_DATA.seed, targets: { lift: { protein: 'lots' } } } };
  const invalidError = await openBrowserDataLayer({ snapshotStore: createMemorySnapshotStore(invalid) }).then(() => null, (e) => e);
  assert.equal(invalidError?.code, 'DATA_INVALID');
  assert.deepEqual(await invalidError.readStoredRecord(), invalid, 'the stored record is offered for download unchanged');
  assert.deepEqual([...RECOVERABLE_CODES], ['DATA_INVALID', 'STORED_DATA_UNRECOGNIZED']);
});

test('Errors — the shell shows recovery only for stored data that can’t be opened; STORAGE_UNAVAILABLE stays blocking', () => {
  const unavailable = renderApp({ route: 'today', startup: 'error', errorCode: 'STORAGE_UNAVAILABLE', recoveryAvailable: false });
  assert.match(text(unavailable), /This browser isn't letting the app save your data/);
  assert.ok(!/class="recovery"|primary-nav/.test(unavailable), 'no recovery, no "continue without saving", no navigation');
  for (const code of RECOVERABLE_CODES) {
    const html = renderApp({ route: 'today', startup: 'error', errorCode: code, recoveryAvailable: true, recovery: null });
    assert.match(text(html), /Your saved data couldn't be opened/);
    assert.match(html, /data-shell-action="download-stored"/);
    assert.match(html, /data-shell-action="choose-backup"/);
    assert.match(html, /data-shell-action="start-fresh" disabled/, 'Start over only after the download');
  }
  const r = { downloaded: true, stage: 'confirm-fresh', busy: false, message: '', errors: [] };
  const confirmFresh = renderRecovery(r);
  assert.match(confirmFresh, /Start over with empty data\?/);
  assert.match(confirmFresh, /data-shell-action="recovery-cancel">Cancel<\/button><button type="button" class="button danger" data-shell-action="recovery-fresh">Start over/);
  const preview = renderRecovery({ ...r, stage: 'preview', summary: { days: 3, mealInstances: 5, savedMeals: 1, customFoods: 2 }, exportedAt: '2026-09-20T10:00:00Z' });
  assert.match(text(preview), /Restore this backup\? Backup from .+: 3 logged days · 5 logged meals · 1 saved meal · 2 of your foods\./);
  assert.match(preview, /data-shell-action="recovery-restore">Replace stored data/);
});

test('Errors — recovery validates in full before replacing the stored record; an invalid backup writes nothing', async () => {
  const odd = { format: 'another-app', version: 3, data: {} };
  const store = createMemorySnapshotStore(odd);
  const source = setup().app;
  withHistory(source);
  const good = backupFile(source).text;
  assert.equal(validateRecoveryBackup('{bad').code, 'BACKUP_UNREADABLE');
  assert.equal(validateRecoveryBackup(good).valid, true);
  await assert.rejects(recoverStoredData({ snapshotStore: store, backup: JSON.stringify({ format: 'macro-tracker-v2-backup', formatVersion: 1, data: {} }) }), (e) => e.code === 'BACKUP_INVALID');
  assert.deepEqual(store.peek(), odd, 'untouched');
  assert.equal(store.writeCount(), 0);
  const { app } = await recoverStoredData({ snapshotStore: store, backup: good, today: () => TODAY });
  assert.equal(store.writeCount(), 1, 'one write');
  assert.equal(app.getSavedMeals().length, 1);
  const fresh = createMemorySnapshotStore(odd);
  const { app: seeded } = await recoverStoredData({ snapshotStore: fresh, startFresh: true });
  assert.deepEqual(seeded.getAllCurrentTargets(), CANONICAL, 'start over = the shipped seed');
});

test('Errors — §4.8 save-error banner and conflict dialog; the shell stays free of imports', () => {
  assert.equal(saveBannerView({ state: 'saved' }), '');
  const banner = saveBannerView({ state: 'error', error: 'QuotaExceededError: quota' });
  assert.match(banner, /role="alert"/);
  assert.match(text(banner), /Your latest changes aren’t saved on this device yet\. They’re still here, but will be lost if you close the app\. Your device may be low on storage\./);
  assert.match(banner, /data-shell-action="retry">Try again<\/button><button type="button" class="button" data-shell-action="download-backup">Download a backup/);
  assert.ok(!/low on storage/.test(saveBannerView({ state: 'error', error: 'disk went away' })));
  const conflict = conflictDialogView();
  assert.match(text(conflict), /This app is open in another tab or window, and that one saved more recently\. To avoid overwriting it, this tab can’t save\./);
  assert.match(conflict, /data-shell-action="download-conflict">Download this tab’s data<\/button><button type="button" class="button primary" data-shell-action="reload">Reload/);
  assert.match(renderApp({ route: 'today', startup: 'ready', status: { state: 'error', error: 'x' } }), /data-shell-banner><div class="save-banner"/);
  assert.match(renderApp({ route: 'today', startup: 'ready', status: null }), /<dialog class="sheet conflict-dialog" data-conflict/);
  assert.equal(saveStatusText({ state: 'saved', lastSavedAt: null }), 'Nothing has needed saving yet.');
  assert.match(saveStatusText({ state: 'saved', lastSavedAt: '2026-09-28T10:00:00Z' }), /^All changes saved · /);
  assert.equal(saveStatusText({ state: 'error' }), 'Your latest changes aren’t saved on this device yet.');
  const shellSrc = fs.readFileSync(path.join(ROOT, 'app/shell.js'), 'utf8');
  assert.ok(!/^import /m.test(shellSrc), 'the shell still imports nothing');
  assert.equal(typeof createShell, 'function');
});

/* ---------------- architecture ---------------- */

test('Settings — one persistence path, no UI schema checks, no macro arithmetic, no forbidden terms', () => {
  for (const f of ['app/settings.js', 'app/download.js', 'app/shell.js', 'app/main.js', 'app/app.css']) {
    const src = fs.readFileSync(path.join(ROOT, f), 'utf8');
    assert.deepEqual(macroArithmeticInSource(src, f), [], f);
    assert.ok(!FORBIDDEN_NUTRITION.test(src), f);
    assert.deepEqual(domainImportsBypassingIndex(src), [], f);
    assert.ok(!/localStorage|sessionStorage|indexedDB|\bfetch\(|import\(/.test(src), `${f}: no second store`);
  }
  const settings = fs.readFileSync(path.join(ROOT, 'app/settings.js'), 'utf8');
  assert.deepEqual([...settings.matchAll(/from '([^']+)'/g)].map((m) => m[1]).sort(), ['../src/domain/index.js', './session.js', './shell.js', './today.js', './view-host.js']);
  assert.ok(!/app-data|browser-adapter|snapshotStore|\$schema|minimum|additionalProperties/.test(settings), 'no storage access or schema checks in the screen');
  assert.match(settings, /app\.validateBackup\(text\)/, 'restore validates through the domain');
  assert.match(settings, /app\.restoreUserData\(text\)/, 'and replaces through the domain');
  assert.ok(settings.indexOf('app.validateBackup(text)') < settings.indexOf("show({ type: 'restore-preview'"), 'validate before the preview; replace only on confirm');
  assert.match(settings, /case 'restore-confirm': \{/);
  const main = fs.readFileSync(path.join(ROOT, 'app/main.js'), 'utf8');
  assert.match(main, /import \{ openBrowserDataLayer, recoverStoredData, validateRecoveryBackup \} from '\.\.\/src\/browser\/app-data\.js';/, 'only main.js touches the browser layer');
});
