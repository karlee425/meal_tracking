'use strict';
/*
 * test-target-preservation.js — regression test for the seed-once rule.
 *
 *   node migration/test-target-preservation.js
 *
 * Runs against a throwaway copy of the repository (never the working tree) and proves:
 *   1. Clean run: a missing data/targets.json is seeded with the approved initial targets
 *      (Lift 150/293/70, Long Run 150/343/70, Rest 150/218/70).
 *   2. Changed current targets are preserved byte-for-byte by a re-run, and --check and
 *      validate.js still pass (no false mismatch).
 *   3. The migration report is byte-identical whether targets were changed or not.
 *   4. Changed user records (user-data) are likewise preserved and do not break --check.
 *   5. Negative: a data/targets.json with legacy keys fails validation (shape is still enforced).
 *   6. Clean run with no user-data/ at all: every seed-once user file is created, including
 *      user-data/user-food-data.json (user-data format 2), and the result is a complete
 *      current-format checkout that validate.js, --check and the Node file adapter accept.
 * Exit 0 when every case passes, 1 otherwise.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const SEED_TEXT = JSON.stringify({
  lift: { protein: 150, carbs: 293, fat: 70 },
  long_run: { protein: 150, carbs: 343, fat: 70 },
  rest: { protein: 150, carbs: 218, fat: 70 }
}, null, 2) + '\n';
// Deliberately changed values AND unusual formatting, so byte-for-byte preservation is visible.
const CHANGED_TARGETS = '{"lift":{"protein":150,"carbs":310,"fat":72},"long_run":{"protein":150,"carbs":360,"fat":72},"rest":{"protein":150,"carbs":230,"fat":72}}\n';

let failures = 0;
const results = [];
function expect(name, ok, detail) {
  results.push(`${ok ? 'PASS' : 'FAIL'}  ${name}${!ok && detail ? `\n        ${detail}` : ''}`);
  if (!ok) failures++;
}

function freshCopy() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mt-target-test-'));
  fs.cpSync(ROOT, dir, { recursive: true, filter: (src) => !/[\\/](\.git|node_modules)([\\/]|$)/.test(src) });
  return dir;
}
function node(dir, ...args) {
  const r = spawnSync(process.execPath, args, { cwd: dir, encoding: 'utf8' });
  return { code: r.status, out: (r.stdout || '') + (r.stderr || '') };
}
const read = (dir, p) => fs.readFileSync(path.join(dir, p), 'utf8');

const dirs = [];
try {
  // Case 1 — clean migration seeds the approved values
  const a = freshCopy(); dirs.push(a);
  fs.rmSync(path.join(a, 'data/targets.json'));
  const r1 = node(a, 'migration/migrate.js');
  expect('clean run exits 0', r1.code === 0, r1.out.slice(-400));
  expect('clean run seeds data/targets.json with the approved initial targets', read(a, 'data/targets.json') === SEED_TEXT, read(a, 'data/targets.json'));
  expect('clean run reports seeding', /seed-once: seeded data\/targets\.json/.test(r1.out));
  const reportClean = read(a, 'migration/migration-report.json');

  // Case 2 — changed current targets survive a re-run, byte-for-byte
  const b = freshCopy(); dirs.push(b);
  fs.writeFileSync(path.join(b, 'data/targets.json'), CHANGED_TARGETS);
  const r2 = node(b, 'migration/migrate.js');
  expect('re-run with changed targets exits 0', r2.code === 0, r2.out.slice(-400));
  expect('re-run preserves changed data/targets.json byte-for-byte', read(b, 'data/targets.json') === CHANGED_TARGETS, read(b, 'data/targets.json'));
  const r2b = node(b, 'migration/migrate.js');
  expect('second re-run still preserves it', r2b.code === 0 && read(b, 'data/targets.json') === CHANGED_TARGETS);
  const c2 = node(b, 'migration/migrate.js', '--check');
  expect('--check passes with changed targets (no false mismatch)', c2.code === 0, c2.out.slice(-400));
  expect('--check still reads the file as changed-and-kept', /data\/targets\.json — present, changed since seeding/.test(c2.out));
  const v2 = node(b, 'migration/validate.js');
  expect('validate.js passes with changed targets', v2.code === 0, v2.out.slice(-400));

  // Case 3 — the report does not depend on current targets
  expect('migration report identical with seeded vs changed targets', read(b, 'migration/migration-report.json') === reportClean);

  // Case 4 — changed user records are preserved and do not break --check
  const day = [{
    id: 'day_2026-09-25', date: '2026-09-25', dayType: 'lift',
    targetSnapshot: { protein: 150, carbs: 310, fat: 72 },
    loggingComplete: false,
    mealInstances: [{
      id: 'mi_test', sourceMealId: null, mealName: 'Test', mealSlot: 'snack_afternoon',
      ingredients: [{ foodId: 'food_core_banana', foodName: 'Banana', quantity: 120, unit: 'g', protein: 1.3, carbs: 27.6, fat: 0.4 }],
      totals: { protein: 1.3, carbs: 27.6, fat: 0.4 }, loggedAt: '2026-09-25T15:30:00Z'
    }]
  }];
  const logsText = JSON.stringify(day, null, 2) + '\n';
  fs.writeFileSync(path.join(b, 'user-data/daily-logs.json'), logsText);
  const r4 = node(b, 'migration/migrate.js');
  expect('re-run preserves changed user-data/daily-logs.json', r4.code === 0 && read(b, 'user-data/daily-logs.json') === logsText, r4.out.slice(-400));
  const c4 = node(b, 'migration/migrate.js', '--check');
  expect('--check passes with changed user records', c4.code === 0, c4.out.slice(-400));
  expect('migration report still identical', read(b, 'migration/migration-report.json') === reportClean);

  // Case 5 — negative: legacy-shaped targets are still rejected
  const c = freshCopy(); dirs.push(c);
  const legacyShaped = '{"lift":{"p":150,"f":70,"c":293},"long_run":{"p":150,"f":70,"c":343},"rest":{"p":150,"f":70,"c":218}}\n';
  fs.writeFileSync(path.join(c, 'data/targets.json'), legacyShaped);
  const r5 = node(c, 'migration/migrate.js');
  expect('migration fails when data/targets.json uses legacy p/f/c keys', r5.code !== 0);
  expect('…and leaves that file untouched', read(c, 'data/targets.json') === legacyShaped);
  const v5 = node(c, 'migration/validate.js');
  expect('validate.js fails on legacy-shaped targets', v5.code !== 0 && /G09/.test(v5.out));

  // Case 6 — a clean migration produces a complete current-format checkout
  const d = freshCopy(); dirs.push(d);
  fs.rmSync(path.join(d, 'user-data'), { recursive: true });
  const r6 = node(d, 'migration/migrate.js');
  expect('clean run without user-data/ exits 0', r6.code === 0, r6.out.slice(-400));
  const userFiles = fs.readdirSync(path.join(d, 'user-data')).sort();
  expect('clean run seeds every user-data file', JSON.stringify(userFiles) === JSON.stringify(['custom-foods.json', 'daily-logs.json', 'preferences.json', 'saved-meals.json', 'user-food-data.json']), userFiles.join(', '));
  expect('user-food-data.json is seeded empty', read(d, 'user-data/user-food-data.json') === JSON.stringify({ foods: [], retiredServingIds: [] }, null, 2) + '\n', read(d, 'user-data/user-food-data.json'));
  expect('clean run reports seeding user-food-data.json', /seed-once: seeded user-data\/user-food-data\.json/.test(r6.out));
  expect('the report lists user-food-data.json as seed-once', JSON.parse(read(d, 'migration/migration-report.json')).seedOnceFiles.files.includes('user-data/user-food-data.json'));
  expect('report identical to a run over existing user files', read(d, 'migration/migration-report.json') === reportClean);
  const c6 = node(d, 'migration/migrate.js', '--check');
  expect('--check passes on the clean checkout', c6.code === 0, c6.out.slice(-400));
  const v6 = node(d, 'migration/validate.js');
  expect('validate.js passes on the clean checkout', v6.code === 0, v6.out.slice(-400));
  const open6 = node(d, '--input-type=module', '-e', [
    "import { createFileAdapter } from './src/node/file-adapter.js';",
    "import { createDataLayer } from './src/domain/index.js';",
    "const data = createDataLayer({ adapter: createFileAdapter(process.cwd()) }).exportUserData().data;",
    "console.log(JSON.stringify(Object.keys(data)) + ' ' + JSON.stringify(data.userFoodData));"
  ].join('\n'));
  expect('the Node file adapter opens the clean checkout in the current format',
    open6.code === 0 && open6.out.trim() === '["targets","customFoods","savedMeals","days","preferences","userFoodData"] {"foods":[],"retiredServingIds":[]}', open6.out.slice(-400));
} catch (e) {
  expect('test harness', false, e.stack);
} finally {
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
}

console.log(results.join('\n'));
console.log(failures ? `\n${failures} FAILED` : `\nAll ${results.length} target-preservation checks passed.`);
process.exit(failures ? 1 : 0);
