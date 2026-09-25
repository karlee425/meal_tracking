// Prompt 3 — the V2 domain layer is the only runtime source of truth.
//
// Boundary: runtime-boundary.json classifies every file. Runtime code and canonical data may
// not reference legacy sources or rules; legacy reference files stay byte-for-byte; the
// runtime reads only canonical stores; P/C/F arithmetic lives only in src/domain/macros.js.
// Plus the historical-integrity and data rules Prompt 3 asks to keep proven.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  ROOT, makeApp, tempRepo, cleanup, readText, listRepoFiles, loadBoundary, classesOf, filesInClass,
  scanLegacy, LEGACY_CODE_PATTERNS, LEGACY_DATA_PATTERNS, macroArithmeticOffenders, FORBIDDEN_NUTRITION,
  gitBlobId, stripComments
} from './helpers.mjs';
import { DomainError } from '../src/domain/index.js';

const DATE = '2026-09-24';
const boundary = loadBoundary();
const RUNTIME_SCANNED = /\.(m?js|cjs|html|json)$/; // runtime code and config; .md docs are not runtime
const runtimeFiles = () => filesInClass('runtime', boundary).filter((f) => RUNTIME_SCANNED.test(f));
const throwsCode = (fn, code) => assert.throws(fn, (e) => e instanceof DomainError && e.code === code, `expected DomainError ${code}`);

function withApp(fn) {
  return () => {
    const dir = tempRepo();
    try { return fn(makeApp(dir)); } finally { cleanup(dir); } // cleaned up even if setup fails
  };
}

/* ------------------------------------------------------------------ */
/* Boundary                                                            */
/* ------------------------------------------------------------------ */

test('Boundary — every file belongs to exactly one class', () => {
  const problems = listRepoFiles()
    .map((f) => [f, classesOf(f, boundary)])
    .filter(([, c]) => c.length !== 1)
    .map(([f, c]) => `${f}: ${c.length ? `in ${c.join(' and ')}` : 'unclassified — add it to runtime-boundary.json'}`);
  assert.deepEqual(problems, []);
  assert.ok(runtimeFiles().length > 0, 'runtime class is not empty');
});

test('Boundary — legacy reference files are unchanged since upload (6d9e5bb)', async () => {
  const legacy = filesInClass('legacyReference', boundary);
  const blobs = await Promise.all(legacy.map(gitBlobId));
  const baseline = new Set(boundary.legacyReferenceBaseline.gitBlobs);
  const changed = legacy.filter((f, i) => !baseline.has(blobs[i]));
  assert.deepEqual(changed, [], 'legacy files modified');
  assert.equal(legacy.length, baseline.size, 'every baseline legacy file still present');
});

/* ------------------------------------------------------------------ */
/* 15 — Legacy runtime dependency scan                                 */
/* ------------------------------------------------------------------ */

test('15 — legacy identifiers appear only in migration/reference files, never in runtime code or canonical data', (t) => {
  const runtimeHits = scanLegacy(runtimeFiles(), LEGACY_CODE_PATTERNS);
  assert.deepEqual(runtimeHits, [], 'forbidden legacy dependency in runtime code (file:line identifier)');

  const dataHits = scanLegacy(filesInClass('canonicalData', boundary), LEGACY_DATA_PATTERNS);
  assert.deepEqual(dataHits, [], 'legacy structure in canonical data (file:line identifier)');

  // For the record: where legacy identifiers are allowed to live.
  const allowed = {};
  for (const cls of ['legacyReference', 'migration']) {
    for (const hit of scanLegacy(filesInClass(cls, boundary).filter((f) => /\.(m?js|html)$/.test(f)), LEGACY_CODE_PATTERNS)) {
      const [loc, ...rest] = hit.split(' ');
      const file = loc.split(':')[0];
      const label = rest.join(' ').split(':')[0];
      allowed[`${cls}: ${file}`] = allowed[`${cls}: ${file}`] || new Set();
      allowed[`${cls}: ${file}`].add(label);
    }
  }
  for (const [k, v] of Object.entries(allowed)) t.diagnostic(`allowed — ${k}: ${[...v].join(', ')}`);
  assert.ok(Object.keys(allowed).some((k) => k.includes('meal-bank.html')), 'scanner still sees the legacy identifiers where they are allowed');
});

/* ------------------------------------------------------------------ */
/* 17 — Runtime source of truth                                        */
/* ------------------------------------------------------------------ */

test('17 — the runtime reads and writes only the canonical V2 stores', () => {
  // A temp repo that ALSO contains every legacy file, so reading one would be possible.
  const dir = tempRepo();
  for (const f of filesInClass('legacyReference', boundary)) fs.copyFileSync(path.join(ROOT, f), path.join(dir, f));

  const touched = [];
  const spy = {};
  for (const fn of ['readFileSync', 'readdirSync', 'writeFileSync', 'renameSync', 'openSync', 'existsSync', 'statSync']) {
    spy[fn] = fs[fn];
    fs[fn] = function (p, ...rest) {
      if (typeof p === 'string' && p.startsWith(dir)) touched.push(path.relative(dir, p).split(path.sep).join('/'));
      return spy[fn].call(this, p, ...rest);
    };
  }
  try {
    const { app } = makeApp(dir);
    const saved = app.createSavedMeal({ fromMealId: 'meal_library_L26' });
    app.createMealInstance({ date: DATE, mealSlot: 'lunch', mealId: saved.id, dayType: 'lift' });
    app.logFood({ date: DATE, mealSlot: 'snack_night', foodId: 'food_core_banana', quantity: 90 });
    const bar = app.createCustomFood({ name: 'Boundary Bar', category: 'cereal', state: 'prepared', nutrition: { protein: 5, carbs: 50, fat: 5 } });
    app.updateCustomFood(bar.id, { nutrition: { carbs: 55 } });
    app.updateCurrentTargets('rest', { carbs: 220 });
    app.setFavoriteMeal(saved.id, true);
    app.getProgress({ period: 7, endDate: DATE });
    app.getMacroCoachContext({ date: DATE, mealSlot: 'dinner' });
  } finally {
    for (const [fn, orig] of Object.entries(spy)) fs[fn] = orig;
    cleanup(dir);
  }
  const outside = [...new Set(touched)].filter((p) => !/^(data|user-data)(\/|$)/.test(p));
  assert.deepEqual(outside, [], 'runtime touched a non-canonical file');
  const legacy = new Set(filesInClass('legacyReference', boundary));
  assert.ok(!touched.some((p) => legacy.has(p)), 'no legacy file read');
  assert.ok(!touched.some((p) => p.startsWith('data/reference/')), 'yield/portion reference data is not read at runtime');

  // Only the file adapter touches the filesystem; no network, no dynamic imports, no AI.
  for (const f of runtimeFiles().filter((x) => /\.m?js$/.test(x))) {
    const code = stripComments(fs.readFileSync(path.join(ROOT, f), 'utf8'));
    if (f !== 'src/node/file-adapter.js') assert.ok(!/\bfs\b|node:fs|readFileSync|writeFileSync/.test(code), `${f} must not use the filesystem directly`);
    assert.ok(!/\bfetch\s*\(|XMLHttpRequest|\bimport\s*\(/.test(code), `${f} must not fetch or import dynamically`);
  }
});

/* ------------------------------------------------------------------ */
/* 18 — One calculator across the whole runtime class                  */
/* ------------------------------------------------------------------ */

test('18 — all runtime P/C/F arithmetic routes through src/domain/macros.js', () => {
  assert.deepEqual(macroArithmeticOffenders(runtimeFiles()), []);
});

/* ------------------------------------------------------------------ */
/* 14 — Forbidden nutrition concepts (runtime class + canonical data)  */
/* ------------------------------------------------------------------ */

test('14 — no forbidden nutrition field or concept in runtime code, canonical data or schemas', () => {
  const files = [...runtimeFiles(), ...filesInClass('canonicalData', boundary)];
  const hits = files.filter((f) => FORBIDDEN_NUTRITION.test(fs.readFileSync(path.join(ROOT, f), 'utf8')));
  assert.deepEqual(hits, []);
});

/* ------------------------------------------------------------------ */
/* Historical integrity and data rules                                 */
/* ------------------------------------------------------------------ */

test('Historical integrity — renaming a Food never rewrites the logged foodName', withApp(({ app }) => {
  const bar = app.createCustomFood({ name: 'Original Bar Name', category: 'cereal', state: 'prepared', nutrition: { protein: 8, carbs: 40, fat: 6 } });
  const saved = app.createSavedMeal({ name: 'Bar', mealType: 'snack', ingredients: [{ foodId: bar.id, quantity: 50 }] });
  const mi = app.createMealInstance({ date: DATE, mealSlot: 'snack_afternoon', mealId: saved.id, dayType: 'lift' });
  app.updateCustomFood(bar.id, { name: 'Renamed Bar' });
  assert.equal(app.getDay(DATE).mealInstances[0].ingredients[0].foodName, 'Original Bar Name');
  assert.deepEqual(app.getDay(DATE).mealInstances[0], mi);
  assert.equal(app.createMealInstance({ date: DATE, mealSlot: 'snack_night', mealId: saved.id }).ingredients[0].foodName, 'Renamed Bar', 'future logs use the new name');
  assert.equal(app.getFood(bar.id).id, bar.id, 'ID unchanged by rename');
}));

test('9 — duplicate Foods are never auto-merged', withApp(({ app }) => {
  const core = app.getFood('food_core_banana');
  const dup = app.createCustomFood({ name: core.name, category: core.category, state: core.state, nutrition: { protein: core.nutrition.protein, carbs: core.nutrition.carbs, fat: core.nutrition.fat } });
  assert.notEqual(dup.id, core.id);
  assert.equal(dup.id, 'food_custom_banana');
  const hits = app.searchFoods('banana').map((r) => r.food.id);
  assert.ok(hits.includes(core.id) && hits.includes(dup.id), 'both returned separately');
  const a = app.logFood({ date: DATE, mealSlot: 'breakfast', foodId: core.id, quantity: 100, dayType: 'lift' });
  const b = app.logFood({ date: DATE, mealSlot: 'breakfast', foodId: dup.id, quantity: 100 });
  assert.equal(a.ingredients[0].foodId, core.id);
  assert.equal(b.ingredients[0].foodId, dup.id);
  const again = app.createCustomFood({ name: 'Banana', category: 'fruit', state: 'raw', nutrition: { protein: 1, carbs: 23, fat: 0.3 } });
  assert.equal(again.id, 'food_custom_banana_2', 'a second duplicate also stays separate');
}));

test('10 — raw and cooked Foods stay separate; no silent yield conversion', withApp(({ app }) => {
  const raw = app.getFood('food_core_chicken_breast_raw');
  assert.equal(raw.state, 'raw');
  const cooked = app.createCustomFood({ name: 'Chicken breast, cooked', category: 'meat', state: 'cooked', nutrition: { protein: 31, carbs: 0, fat: 3.6 } });
  assert.notEqual(cooked.id, raw.id);
  const r = app.calculateMealMacros({ id: 'x', ingredients: [{ foodId: raw.id, quantity: 100, unit: 'g' }] }).totals;
  const c = app.calculateMealMacros({ id: 'y', ingredients: [{ foodId: cooked.id, quantity: 100, unit: 'g' }] }).totals;
  assert.equal(r.protein, raw.nutrition.protein, '100 g raw = raw nutrition');
  assert.equal(c.protein, 31, '100 g cooked = cooked nutrition');

  // A Food with a yield factor is still calculated from its stored basis only.
  const rice = app.getFood('food_core_white_rice_dry');
  assert.ok(rice.metadata.yieldFactor > 1, 'fixture has a yield factor');
  const t = app.calculateMealMacros({ id: 'z', ingredients: [{ foodId: rice.id, quantity: 100, unit: 'g' }] }).totals;
  assert.deepEqual(t, { protein: rice.nutrition.protein, carbs: rice.nutrition.carbs, fat: rice.nutrition.fat });
  const mi = app.logFood({ date: DATE, mealSlot: 'lunch', foodId: rice.id, quantity: 100, dayType: 'lift' });
  assert.equal(mi.totals.carbs, rice.nutrition.carbs, 'logging applies no yield either');
  assert.equal(app.calculateMealMacros({ id: 'u', ingredients: [{ foodId: rice.id, quantity: 100, unit: 'cooked g' }] }).problems[0].code, 'UNSUPPORTED_UNIT', 'no cooked-basis unit');
}));

test('13 — every Library Meal resolves and calculates; no stored meal totals anywhere', withApp(({ app }) => {
  const all = app.getLibraryMeals({ includeRetired: true });
  assert.equal(all.length, 84);
  const bad = [];
  const macroKey = /^(p|f|c|protein|carbs|fat|totals|macros|nutrition)$/;
  const walk = (o, where, hits) => {
    if (Array.isArray(o)) return o.forEach((v, i) => walk(v, `${where}[${i}]`, hits));
    if (!o || typeof o !== 'object') return;
    for (const [k, v] of Object.entries(o)) { if (macroKey.test(k)) hits.push(`${where}.${k}`); walk(v, `${where}.${k}`, hits); }
  };
  for (const m of all) {
    const calc = app.calculateMealMacros(m);
    if (!calc.valid || !calc.totals) bad.push(`${m.id}: ${JSON.stringify(calc.problems)}`);
    walk(m, m.id, bad);
  }
  const saved = app.createSavedMeal({ fromMealId: all[0].id });
  walk(app.getMeal(saved.id), saved.id, bad);
  assert.deepEqual(bad, []);
}));

test('16 — target snapshots survive current-target changes for every day type (and a reload)', withApp(({ app, reopen }) => {
  const want = { lift: { protein: 150, carbs: 293, fat: 70 }, long_run: { protein: 150, carbs: 343, fat: 70 }, rest: { protein: 150, carbs: 218, fat: 70 } };
  const dates = { lift: '2026-09-21', long_run: '2026-09-26', rest: '2026-09-27' };
  for (const [type, date] of Object.entries(dates)) assert.deepEqual(app.createDay(date, type).targetSnapshot, want[type]);
  for (const type of Object.keys(want)) app.updateCurrentTargets(type, { carbs: 400, protein: 160, fat: 80 });
  const reloaded = reopen();
  for (const [type, date] of Object.entries(dates)) {
    assert.deepEqual(app.getDay(date).targetSnapshot, want[type], `${type} snapshot unchanged`);
    assert.deepEqual(reloaded.getDay(date).targetSnapshot, want[type], `${type} snapshot unchanged after reload`);
  }
  assert.deepEqual(reloaded.createDay('2026-09-28', 'rest').targetSnapshot, { protein: 160, carbs: 400, fat: 80 });
}));

test('Legacy rules are gone at runtime: no legacy day-type keys, no night-snack rule, no slot targets', withApp(({ app }) => {
  for (const legacyKey of ['long', 'lifting', 'longrun']) {
    throwsCode(() => app.getCurrentTargets(legacyKey), 'INVALID_DAY_TYPE');
    throwsCode(() => app.createDay('2026-09-01', legacyKey), 'INVALID_DAY_TYPE');
  }
  assert.deepEqual(Object.keys(app.getAllCurrentTargets()).sort(), ['lift', 'long_run', 'rest'], 'daily targets only');
  for (const t of Object.values(app.getAllCurrentTargets())) assert.deepEqual(Object.keys(t).sort(), ['carbs', 'fat', 'protein']);

  // Everything but the night snack logged: the Day is partial, nothing is added for the night slot.
  const logged = [];
  for (const slot of ['breakfast', 'lunch', 'snack_afternoon', 'dinner']) logged.push(app.logFood({ date: DATE, mealSlot: slot, foodId: 'food_core_banana', quantity: 100, dayType: 'lift' }));
  const s = app.getDaySummary(DATE);
  assert.equal(s.status, 'partial');
  assert.deepEqual(s.unloggedSlots, ['snack_night']);
  assert.ok(Math.abs(s.logged.carbs - logged.reduce((a, mi) => a + mi.totals.carbs, 0)) < 1e-9, 'logged = exactly what was logged');
  assert.deepEqual(s.target, { protein: 150, carbs: 293, fat: 70 }, 'no per-slot allocation in the target');
  const snack = app.getLibraryMeals().find((m) => m.mealType === 'snack');
  assert.equal(app.createMealInstance({ date: DATE, mealSlot: 'snack_night', mealId: snack.id }).mealSlot, 'snack_night', 'any snack can go in the night slot');
}));

test('Favourites live only in preferences; the runtime never reads or writes a Meal "favorite" field', withApp(({ app, dir }) => {
  const libraryBefore = readText(dir, 'data/meals/library-meals.json');
  const savedFile = () => readText(dir, 'user-data/saved-meals.json');
  const saved = app.createSavedMeal({ fromMealId: 'meal_library_B1' });
  const before = savedFile();
  app.setFavoriteMeal('meal_library_B1', true);
  app.setFavoriteMeal(saved.id, true);
  assert.deepEqual(app.getPreferences().favoriteMeals, ['meal_library_B1', saved.id]);
  assert.equal(savedFile(), before, 'Saved Meals file untouched by favouriting');
  assert.equal(readText(dir, 'data/meals/library-meals.json'), libraryBefore, 'Library file untouched');
  assert.equal(app.getMeal(saved.id).favorite, undefined, 'no favorite field written on Saved Meals');
  for (const f of runtimeFiles().filter((x) => /\.m?js$/.test(x))) {
    // property access (meal.favorite / meal['favorite']) or an object key (favorite: …)
    assert.ok(!/\.favorite\b|\[\s*['"]favorite['"]\s*\]|\bfavorite\s*:/.test(stripComments(fs.readFileSync(path.join(ROOT, f), 'utf8'))), `${f} does not use Meal.favorite`);
  }
}));
