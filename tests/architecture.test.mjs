// Prompt 2 — architecture tests: one calculator (N), forbidden nutrition terms (O),
// no legacy runtime dependencies (P).
//
// Search patterns are assembled from pieces so this file does not itself contain the
// strings the Prompt 1 migration check (G12) and these scans look for.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { ROOT, makeApp, cleanup } from './helpers.mjs';
import * as runtimeMacros from '../src/domain/macros.js';

const require = createRequire(import.meta.url);

function walk(dir, filter) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p, filter));
    else if (filter(p)) out.push(p);
  }
  return out.sort();
}
const rel = (p) => path.relative(ROOT, p);
const stripComments = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:\\])\/\/.*$/gm, '$1');
const srcFiles = () => walk(path.join(ROOT, 'src'), (p) => p.endsWith('.js'));

test('N — one canonical P/C/F calculator', () => {
  const calculator = path.join(ROOT, 'src/domain/macros.js');
  const macroWord = '(protein|carbs|fat)';
  const patterns = [
    [/\/\s*100\b/, 'per-100 g division'],
    [new RegExp(`\\b${macroWord}\\b\\s*[-+*/]=?(?![/*])`), 'arithmetic after a macro field'],
    [new RegExp(`(?<![/*])[-+*/]=?\\s*[\\w$.]*\\b${macroWord}\\b`), 'arithmetic before a macro field'],
    [/\[\s*m\s*\]\s*[-+*/]=?/, 'arithmetic on [m]'],
    [/[-+*/]=?\s*[\w$.]+\[\s*m\s*\]/, 'arithmetic on [m]']
  ];
  const offenders = [];
  for (const f of srcFiles()) {
    if (f === calculator) continue;
    const code = stripComments(fs.readFileSync(f, 'utf8'));
    code.split('\n').forEach((line, i) => {
      for (const [re, why] of patterns) if (re.test(line)) offenders.push(`${rel(f)}:${i + 1} ${why}: ${line.trim()}`);
    });
  }
  assert.deepEqual(offenders, [], 'P/C/F arithmetic outside src/domain/macros.js');

  // The calculator itself has the formula exactly once.
  const calc = stripComments(fs.readFileSync(calculator, 'utf8'));
  assert.equal((calc.match(/\(quantity \/ 100\) \* food\.nutrition\[m\]/g) || []).length, 1);

  // Domain modules that need numbers import them from the calculator.
  for (const f of ['meals.js', 'days.js', 'progress.js', 'targets.js']) {
    assert.match(fs.readFileSync(path.join(ROOT, 'src/domain', f), 'utf8'), /from '\.\/macros\.js'/, `${f} uses macros.js`);
  }

  // The migration uses the same calculator: same function objects, no formula of its own.
  const mig = require(path.join(ROOT, 'migration/macro-calc.js'));
  assert.equal(mig.ingredientContribution, runtimeMacros.ingredientContribution);
  assert.equal(mig.MACROS, runtimeMacros.MACROS);
  for (const f of ['migration/macro-calc.js', 'migration/migrate.js', 'migration/validate.js']) {
    const code = stripComments(fs.readFileSync(path.join(ROOT, f), 'utf8'));
    assert.ok(!/\/\s*100\b/.test(code), `${f} has no per-100 g formula of its own`);
    assert.ok(!/nutrition\[\s*m\s*\]/.test(code), `${f} does not read nutrition[m]`);
  }

  // Same numbers from both entry points.
  const { app, dir } = makeApp();
  try {
    const meal = app.getMeal('meal_library_B1');
    const viaMigration = mig.calculateMealMacros(meal, (id) => app.getFood(id));
    assert.deepEqual(viaMigration.totals, app.calculateMealMacros(meal).totals);
    assert.throws(() => mig.calculateMealMacros({ id: 'x', ingredients: [{ foodId: 'food_nope', quantity: 1, unit: 'g' }] }, () => null), /unresolved foodId/);
    assert.equal(runtimeMacros.calculateMealMacros({ id: 'x', ingredients: [{ foodId: 'food_nope', quantity: 1, unit: 'g' }] }, () => null).valid, false, 'runtime reports instead of throwing');
  } finally { cleanup(dir); }
});

test('O — no forbidden nutrition fields in runtime code, canonical data or runtime output', () => {
  const forbidden = new RegExp(['calor', 'kcal', 'energ' + 'y'].join('|'), 'i');
  const files = [
    ...srcFiles(),
    ...walk(path.join(ROOT, 'data'), (p) => p.endsWith('.json')),
    ...walk(path.join(ROOT, 'user-data'), (p) => p.endsWith('.json')),
    ...walk(path.join(ROOT, 'migration'), (p) => p.endsWith('.json'))
  ];
  const hits = files.filter((f) => forbidden.test(fs.readFileSync(f, 'utf8'))).map(rel);
  assert.deepEqual(hits, []);

  const { app, dir } = makeApp();
  try {
    app.createMealInstance({ date: '2026-09-24', mealSlot: 'lunch', mealId: 'meal_library_L26', dayType: 'lift' });
    const outputs = [
      app.getDaySummary('2026-09-24'),
      app.getProgress({ period: 30, endDate: '2026-09-24' }),
      app.getMacroCoachContext({ date: '2026-09-24', mealSlot: 'dinner' }),
      app.calculateMealMacros('meal_library_L26'),
      app.getDay('2026-09-24')
    ];
    assert.ok(!forbidden.test(JSON.stringify(outputs)), 'runtime output');
    assert.throws(() => app.createCustomFood({ name: 'x', category: 'x', state: 'prepared', nutrition: { protein: 1, carbs: 1, fat: 1, ['k' + 'cal']: 5 } }), /only has protein, carbs and fat/);
  } finally { cleanup(dir); }
});

test('P — no runtime dependency on legacy data or rules', () => {
  const words = [
    ['live-settings', 'doc'].join('-'),
    ['CTC', 'FOOD'].join('_'),
    ['SLOT', 'TARGET'].join('_'),
    ['SHIFT', 'FOOD'].join('_'),
    'carbShift' + 'ByDayType'
  ];
  const patterns = [
    ...words.map((w) => [new RegExp(w.replace(/[-]/g, '\\-')), w]),
    [new RegExp('\\bvar ' + 'M\\s*='), 'embedded M array'],
    [new RegExp('\\b' + 'TARGET' + '\\b'), 'legacy TARGET constant'],
    [new RegExp('\\b' + 'SHIFT' + '\\b'), 'legacy SHIFT constant'],
    [/['"]long['"]/, 'legacy "long" day-type key'],
    [/migration\//, 'import from migration/'],
    [/meal-options\.json|meal-bank\.html|close-the-carbs\.html|recost|ingredient-name-map|ingredients-flat|fibre\.json/, 'legacy file'],
    [/['"](\.\.\/)*foods\.json|['"](\.\.\/)*targets\.json/, 'legacy root JSON']
  ];
  const offenders = [];
  for (const f of srcFiles()) {
    const code = stripComments(fs.readFileSync(f, 'utf8'));
    for (const [re, why] of patterns) if (re.test(code)) offenders.push(`${rel(f)}: ${why}`);
  }
  assert.deepEqual(offenders, []);

  // The file adapter only touches canonical V2 files.
  const adapter = fs.readFileSync(path.join(ROOT, 'src/node/file-adapter.js'), 'utf8');
  const paths = [...adapter.matchAll(/'((?:data|user-data)\/[^']+)'/g)].map((m) => m[1]);
  assert.ok(paths.length >= 7);
  for (const p of paths) assert.match(p, /^(data\/(foods|meals|schemas)|data\/targets\.json|user-data\/)/, p);
});
