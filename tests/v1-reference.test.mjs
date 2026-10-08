// C1 — the frozen V1 reference, the synthetic V1 fixture and the read-only backup checker.
//
// tests/fixtures/v1-app holds byte copies of commit 936753b (the V2 baseline, "V1" storage
// format) plus two synthetic exceptions; tests/fixtures/v1/manifest.json pins every file.
// These tests only read the committed files. Anything they alter is a copy in the OS temp
// directory. Nothing here touches browser storage or the network.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { ROOT, FORBIDDEN_NUTRITION } from './helpers.mjs';

const FROZEN_COMMIT = '936753bd4bb07ff9a5047cc60c6271a6165a487b';
const MANIFEST = 'tests/fixtures/v1/manifest.json';
const TOOL = path.join(ROOT, 'tests/tools/backup-report.mjs');
const APPROVED_SYNTHETIC = ['data/targets.json', 'user-data/custom-foods.json'];
const COLLECTIONS = ['targets', 'customFoods', 'savedMeals', 'days', 'preferences'];

const read = (rel) => fs.readFileSync(path.join(ROOT, rel));
const readJSON = (rel) => JSON.parse(read(rel).toString('utf8'));
const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const gitBlobId = (buf) => crypto.createHash('sha1').update(Buffer.concat([Buffer.from(`blob ${buf.length}\0`), buf])).digest('hex');
const git = (...args) => execFileSync('git', ['-C', ROOT, ...args], { maxBuffer: 64 * 1024 * 1024 });
const manifest = readJSON(MANIFEST);
const refPath = (p) => `${manifest.referenceRoot}/${p}`;
const listFiles = (dir, base = dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
  const p = path.join(dir, e.name);
  return e.isDirectory() ? listFiles(p, base) : [path.relative(base, p).split(path.sep).join('/')];
}).sort();
const runTool = (...args) => spawnSync(process.execPath, [TOOL, ...args], { encoding: 'utf8' });
/** SHA-256 of every committed C1 file, to prove a test changed none of them. */
const c1Fingerprint = () => Object.fromEntries(listFiles(path.join(ROOT, 'tests/fixtures')).map((f) => [f, sha256(read(`tests/fixtures/${f}`))]));

const frozenApp = async () => ({
  ...(await import('./fixtures/v1-app/src/browser/app-data.js')),
  ...(await import('./fixtures/v1-app/src/browser/memory-snapshot-store.js'))
});

test('C1 — the manifest pins the frozen commit and lists every reference file exactly once', () => {
  assert.equal(manifest.format, 'v1-frozen-reference-manifest');
  assert.equal(manifest.manifestVersion, 1);
  assert.equal(manifest.frozenCommit, FROZEN_COMMIT);
  assert.equal(manifest.referenceRoot, 'tests/fixtures/v1-app');
  const frozen = manifest.frozen.map((e) => e.path);
  const synthetic = manifest.syntheticExceptions.map((e) => e.path);
  assert.deepEqual([...synthetic].sort(), APPROVED_SYNTHETIC, 'exactly the two approved synthetic exceptions');
  assert.equal(frozen.filter((p) => synthetic.includes(p)).length, 0, 'a path is either frozen or synthetic, never both');
  assert.equal(new Set(frozen).size, frozen.length, 'no duplicate frozen paths');
  assert.ok(frozen.filter((p) => p.startsWith('src/')).length > 0, 'the V1 source is frozen');
  for (const e of manifest.frozen) {
    assert.match(e.gitBlob, /^[0-9a-f]{40}$/, e.path);
    assert.match(e.sha256, /^[0-9a-f]{64}$/, e.path);
  }
  for (const e of manifest.syntheticExceptions) {
    assert.match(e.originalGitBlob, /^[0-9a-f]{40}$/, e.path);
    assert.ok(e.reason && e.reason.length > 20, `${e.path} documents why it is synthetic`);
  }
  assert.deepEqual(manifest.fixtures.map((f) => [f.path, f.kind]), [
    ['tests/fixtures/v1/backup.json', 'v1-backup'],
    ['tests/fixtures/v1/store-record.json', 'v1-store-record']
  ]);
  assert.ok(manifest.excluded.length > 0, 'intentional exclusions are documented');
});

test('C1 — every frozen file is byte-identical to the frozen commit (checked against the Git object database, not the working tree)', () => {
  const tree = git('ls-tree', '-r', '--name-only', '--full-tree', FROZEN_COMMIT, '--', ...manifest.includedPaths).toString('utf8').split('\n').filter(Boolean).sort();
  const listed = [...manifest.frozen, ...manifest.syntheticExceptions].map((e) => e.path).sort();
  assert.deepEqual(listed, tree, 'the manifest covers exactly the frozen commit\'s files under includedPaths');
  for (const e of manifest.frozen) {
    const buf = read(refPath(e.path));
    const atCommit = git('rev-parse', '--verify', `${FROZEN_COMMIT}:${e.path}`).toString('utf8').trim();
    assert.equal(e.gitBlob, atCommit, `${e.path}: manifest blob is the frozen commit's blob`);
    assert.equal(gitBlobId(buf), atCommit, `${e.path}: reference copy is byte-identical to the frozen commit`);
    assert.equal(sha256(buf), e.sha256, `${e.path}: sha256`);
    assert.equal(buf.length, e.bytes, `${e.path}: size`);
  }
});

test('C1 — the reference directory holds exactly the manifest\'s files', () => {
  const present = listFiles(path.join(ROOT, manifest.referenceRoot));
  const listed = [...manifest.frozen, ...manifest.syntheticExceptions].map((e) => e.path).sort();
  assert.deepEqual(present, listed);
});

test('C1 — synthetic exceptions are pinned, differ from the originals, and carry none of the original Custom Foods or target values', () => {
  const originals = {};
  for (const e of manifest.syntheticExceptions) {
    const buf = read(refPath(e.path));
    assert.equal(sha256(buf), e.sha256, `${e.path}: pinned synthetic sha256`);
    assert.equal(gitBlobId(buf), e.gitBlob, `${e.path}: pinned synthetic blob`);
    assert.notEqual(e.gitBlob, e.originalGitBlob, `${e.path}: not the original`);
    assert.equal(git('rev-parse', '--verify', `${FROZEN_COMMIT}:${e.path}`).toString('utf8').trim(), e.originalGitBlob, `${e.path}: original blob ID traces to the frozen commit`);
    originals[e.path] = JSON.parse(git('cat-file', 'blob', e.originalGitBlob).toString('utf8'));
  }
  // Read the originals from Git only to compare; nothing of them is written anywhere.
  const realFoods = originals['user-data/custom-foods.json'];
  const realWords = new Set(realFoods.flatMap((f) => [f.id, f.name, f.brand, ...(f.aliases || [])]).filter(Boolean).map((s) => s.toLowerCase()));
  const realTargets = new Set(Object.values(originals['data/targets.json']).flatMap((t) => Object.values(t)));

  const backup = readJSON('tests/fixtures/v1/backup.json');
  const syntheticFoods = readJSON(refPath('user-data/custom-foods.json'));
  for (const f of [...syntheticFoods, ...backup.data.customFoods]) {
    for (const w of [f.id, f.name, f.brand, ...(f.aliases || [])].filter(Boolean)) assert.ok(!realWords.has(w.toLowerCase()), `synthetic food reuses a real value: ${f.id}`);
  }
  const corpus = [read(refPath('user-data/custom-foods.json')), read(refPath('data/targets.json')), read('tests/fixtures/v1/backup.json'), read('tests/fixtures/v1/store-record.json')].join('\n').toLowerCase();
  for (const w of realWords) assert.ok(!corpus.includes(w), 'no real Custom Food id, name, brand or alias appears in the synthetic files');

  const targetSets = [readJSON(refPath('data/targets.json')), backup.data.targets];
  for (const d of backup.data.days) targetSets.push({ day: d.targetSnapshot }, d.priorTargetSnapshots || {});
  for (const set of targetSets) {
    for (const macros of Object.values(set)) for (const v of Object.values(macros)) assert.ok(!realTargets.has(v), 'no real target value appears in synthetic targets or snapshots');
  }
});

test('C1 — fixture hashes match the manifest; the store record and the backup hold the same five collections', () => {
  for (const f of manifest.fixtures) assert.equal(sha256(read(f.path)), f.sha256, f.path);
  const backup = readJSON('tests/fixtures/v1/backup.json');
  const record = readJSON('tests/fixtures/v1/store-record.json');
  assert.equal(backup.format, 'macro-tracker-v2-backup');
  assert.equal(backup.formatVersion, 1);
  assert.deepEqual(Object.keys(backup.data), COLLECTIONS);
  assert.equal(record.format, 'macro-tracker-v2-store');
  assert.equal(record.version, 1);
  assert.deepEqual(record.data, backup.data);
});

test('C1 — fixtures are deterministic: regenerating through the frozen V1 app reproduces them byte for byte', async () => {
  const before = c1Fingerprint();
  const { buildV1Fixture } = await import('./fixtures/v1/generate.mjs');
  const json = (v) => `${JSON.stringify(v, null, 2)}\n`;
  const first = await buildV1Fixture();
  const second = await buildV1Fixture();
  assert.equal(json(first.backup), json(second.backup), 'two runs agree');
  assert.equal(json(first.backup), read('tests/fixtures/v1/backup.json').toString('utf8'), 'backup.json');
  assert.equal(json(first.storeRecord), read('tests/fixtures/v1/store-record.json').toString('utf8'), 'store-record.json');
  assert.deepEqual(c1Fingerprint(), before, 'generating wrote nothing');
});

test('C1 — the fixture covers the V1 cases later migration and recovery tests need', () => {
  const { data } = readJSON('tests/fixtures/v1/backup.json');
  const days = data.days;
  const instances = days.flatMap((d) => d.mealInstances);
  assert.deepEqual([...new Set(days.map((d) => d.dayType))].sort(), ['lift', 'long_run', 'rest'], 'all three day types');
  assert.ok(days.some((d) => d.loggingComplete) && days.some((d) => !d.loggingComplete && d.mealInstances.length), 'done and in-progress days');
  assert.ok(days.some((d) => d.mealInstances.length === 0), 'an empty day');
  assert.ok(days.some((d) => d.priorTargetSnapshots && Object.keys(d.priorTargetSnapshots).length), 'a corrected day type keeps its prior snapshot');
  const liftSnapshots = new Set(days.filter((d) => d.dayType === 'lift').map((d) => JSON.stringify(d.targetSnapshot)));
  assert.ok(liftSnapshots.size >= 2, 'targets changed between days');
  const library = new Set(JSON.parse(read(refPath('data/meals/library-meals.json'))).map((m) => m.id));
  const saved = new Set(data.savedMeals.map((m) => m.id));
  assert.ok(instances.some((i) => library.has(i.sourceMealId)), 'logged from a Library Meal');
  assert.ok(instances.some((i) => saved.has(i.sourceMealId)), 'logged from a Saved Meal');
  assert.ok(instances.some((i) => i.sourceMealId === null && i.ingredients.length > 1), 'an ad-hoc multi-food meal');
  assert.ok(instances.some((i) => i.sourceMealId === null && i.ingredients.length === 1), 'a single logged food');
  assert.ok(instances.some((i) => i.mealName.endsWith('(edited)')), 'an edited logged meal');
  assert.ok(instances.some((i) => i.ingredients.some((g) => !data.customFoods.some((f) => f.id === g.foodId) && g.foodId.startsWith('food_custom_'))), 'history keeps a since-deleted Custom Food');
  assert.ok(data.savedMeals.some((m) => m.metadata && m.metadata.unresolvedFoods), 'a Saved Meal needing a replacement');
  assert.ok(data.savedMeals.some((m) => m.metadata && m.metadata.copiedFromMealId), 'a Library copy');
  assert.ok(data.preferences.favoriteFoods.length && data.preferences.favoriteMeals.length && data.preferences.dislikedFoods.length, 'favourites and dislikes');
});

test('C1 — the frozen V1 app validates and restores the fixture backup; all five collections round-trip', async () => {
  const { openBrowserDataLayer, createMemorySnapshotStore } = await frozenApp();
  const backup = readJSON('tests/fixtures/v1/backup.json');
  const store = createMemorySnapshotStore();
  const { app } = await openBrowserDataLayer({ snapshotStore: store });
  const check = app.validateBackup(JSON.stringify(backup));
  assert.equal(check.valid, true, JSON.stringify(check.errors));
  assert.equal(check.formatVersion, 1);
  app.restoreUserData(JSON.stringify(backup));
  await app.flushPersistence();
  const record = store.peek();
  assert.equal(record.version, 1);
  for (const c of COLLECTIONS) assert.deepEqual(record.data[c], backup.data[c], c);
  assert.deepEqual(app.exportUserData().data, backup.data);
});

test('C1 — the frozen V1 recovery path restores the fixture over unreadable stored data', async () => {
  const { openBrowserDataLayer, recoverStoredData, validateRecoveryBackup, createMemorySnapshotStore } = await frozenApp();
  const backup = readJSON('tests/fixtures/v1/backup.json');
  const store = createMemorySnapshotStore({ format: 'something-else', version: 1, revision: 3, data: {} });
  await assert.rejects(openBrowserDataLayer({ snapshotStore: store }), (e) => e.code === 'STORED_DATA_UNRECOGNIZED');
  assert.equal(validateRecoveryBackup(JSON.stringify(backup)).valid, true);
  const { app } = await recoverStoredData({ snapshotStore: store, backup: JSON.stringify(backup) });
  await app.flushPersistence();
  const record = store.peek();
  assert.equal(record.version, 1);
  for (const c of COLLECTIONS) assert.deepEqual(record.data[c], backup.data[c], c);
});

test('C1 — the frozen V1 app opens the fixture store record and exports the fixture backup data', async () => {
  const { openBrowserDataLayer, createMemorySnapshotStore } = await frozenApp();
  const record = readJSON('tests/fixtures/v1/store-record.json');
  const backup = readJSON('tests/fixtures/v1/backup.json');
  const store = createMemorySnapshotStore(record);
  const { app } = await openBrowserDataLayer({ snapshotStore: store });
  assert.deepEqual(app.exportUserData().data, backup.data);
  assert.equal(store.writeCount(), 0, 'opening wrote nothing');
});

test('C1 — backup-report verify passes on the committed reference, with the Git cross-check', () => {
  const before = c1Fingerprint();
  const r = runTool('verify', '--git');
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /RESULT: OK/);
  assert.match(r.stdout, /frozen files \d+ · synthetic exceptions 2 · fixtures 2 · git cross-check on/);
  assert.deepEqual(c1Fingerprint(), before, 'the tool changed nothing');
});

test('C1 — backup-report fails when integrity is altered in a temporary copy; the committed files are untouched', () => {
  const before = c1Fingerprint();
  const fresh = () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'c1-ref-'));
    fs.cpSync(path.join(ROOT, 'tests/fixtures'), path.join(dir, 'tests/fixtures'), { recursive: true });
    return dir;
  };
  const cases = [
    ['a frozen source byte', (d) => fs.appendFileSync(path.join(d, 'tests/fixtures/v1-app/src/domain/macros.js'), ' '), /frozen file changed \(sha256\): src\/domain\/macros\.js/],
    ['a synthetic exception', (d) => fs.writeFileSync(path.join(d, 'tests/fixtures/v1-app/data/targets.json'), '{}\n'), /synthetic file changed \(sha256\): data\/targets\.json/],
    ['a fixture', (d) => fs.appendFileSync(path.join(d, 'tests/fixtures/v1/backup.json'), '\n'), /fixture changed \(sha256\): tests\/fixtures\/v1\/backup\.json/],
    ['an extra reference file', (d) => fs.writeFileSync(path.join(d, 'tests/fixtures/v1-app/src/extra.js'), ''), /unexpected file in reference: src\/extra\.js/],
    ['a missing reference file', (d) => fs.rmSync(path.join(d, 'tests/fixtures/v1-app/src/domain/util.js')), /missing frozen file: src\/domain\/util\.js/]
  ];
  for (const [label, alter, expected] of cases) {
    const dir = fresh();
    try {
      assert.equal(runTool('verify', '--root', dir).status, 0, `${label}: the unaltered copy passes`);
      alter(dir);
      const r = runTool('verify', '--root', dir);
      assert.equal(r.status, 1, `${label}: exit 1`);
      assert.match(r.stdout, expected, label);
      assert.match(r.stdout, /RESULT: FAIL/, label);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
  assert.deepEqual(c1Fingerprint(), before, 'only temporary copies were altered');
});

test('C1 — backup-report report prints counts and hashes only, and refuses non-fixture files inside the repository', () => {
  const backup = readJSON('tests/fixtures/v1/backup.json');
  const r = runTool('report', path.join(ROOT, 'tests/fixtures/v1/backup.json'));
  assert.equal(r.status, 0, r.stdout);
  assert.match(r.stdout, /sha256 data\s+[0-9a-f]{64}/);
  const names = [
    ...backup.data.customFoods.map((f) => f.name),
    ...backup.data.savedMeals.map((m) => m.name),
    ...backup.data.days.flatMap((d) => d.mealInstances.flatMap((i) => [i.mealName, ...i.ingredients.map((g) => g.foodName)]))
  ];
  for (const n of names) assert.ok(!r.stdout.includes(n), 'no food, meal or ingredient name in the output');
  assert.doesNotMatch(r.stdout, /protein|carbs|\bfat\b/i, 'no nutrition or target values in the output');
  assert.ok(!FORBIDDEN_NUTRITION.test(r.stdout), 'no forbidden nutrition terms in the output');

  const refused = runTool('report', path.join(ROOT, 'user-data/preferences.json'));
  assert.equal(refused.status, 2);
  assert.match(refused.stdout, /REFUSED/);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'c1-report-'));
  try {
    fs.copyFileSync(path.join(ROOT, 'tests/fixtures/v1/backup.json'), path.join(dir, 'backup-copy.json'));
    const outside = runTool('report', path.join(dir, 'backup-copy.json'));
    assert.equal(outside.status, 0);
    const dataHash = (out) => out.match(/sha256 data\s+([0-9a-f]{64})/)[1];
    assert.equal(dataHash(outside.stdout), dataHash(r.stdout), 'same data, same hash');
    fs.writeFileSync(path.join(dir, 'not-a-backup.json'), '{"format":"something-else"}');
    assert.equal(runTool('report', path.join(dir, 'not-a-backup.json')).status, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('C1 — backup-report is read-only and offline by construction', () => {
  const src = read('tests/tools/backup-report.mjs').toString('utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
  assert.doesNotMatch(src, /\b(writeFile|writeFileSync|appendFile|appendFileSync|mkdir|mkdirSync|rmSync|rmdir|unlink|unlinkSync|rename|renameSync|copyFile|copyFileSync|cpSync|createWriteStream)\b/, 'no file-writing calls');
  assert.doesNotMatch(src, /\bfetch\s*\(|node:https?|node:net|node:dgram|XMLHttpRequest|WebSocket/, 'no network');
  const gitCalls = [...src.matchAll(/execFileSync\('git'/g)].length;
  assert.equal(gitCalls, 1, 'one git helper');
  assert.doesNotMatch(src, /'(add|commit|push|fetch|pull|checkout|switch|reset|rm|mv|gc|update-ref|config)'/, 'only read-only git commands');
  assert.match(src, /'ls-tree'/);
  assert.match(src, /'rev-parse'/);
});
