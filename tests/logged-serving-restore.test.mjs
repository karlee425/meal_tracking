/*
 * logged-serving-restore.test.mjs — V3 Slice 1 · C8 Stage 3: serving IDs referred to by logged
 * meals stay reserved across backup and restore (serving-ids.js carryForwardServingIds with Days,
 * backup.js validateBackup / restoreUserData). L = live IDs, R = retired IDs, H = IDs in logged-meal
 * serving snapshots; after every successful restore H ⊆ L ∪ R. Synthetic data only.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from './helpers.mjs';
import { DomainError, createDataLayer, createMemoryAdapter, carryForwardServingIds, BACKUP_FORMAT } from '../src/domain/index.js';
import { createFileAdapter } from '../src/node/file-adapter.js';
import { storeArchiveKey, STORE_ARCHIVE_FORMAT } from '../src/browser/browser-adapter.js';
import { createMemorySnapshotStore } from '../src/browser/memory-snapshot-store.js';
import { openBrowserDataLayer } from '../src/browser/app-data.js';

const TODAY = '2026-09-27';
const SEED = createFileAdapter(ROOT).load(); // read-only
const V1_BACKUP = JSON.parse(fs.readFileSync(path.join(ROOT, 'tests/fixtures/v1/backup.json'), 'utf8'));
const V1_STORE = JSON.parse(fs.readFileSync(path.join(ROOT, 'tests/fixtures/v1/store-record.json'), 'utf8'));
const CORE = 'food_core_fage_0_greek_yogurt';
const OATS = 'food_custom_oats_overnight';
const fresh = (v) => JSON.parse(JSON.stringify(v));
const uuid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const SRV = (n) => `srv_${uuid(n)}`;
const code = (c) => (e) => e.code === c;
const AT = '2026-09-01T00:00:00.000Z';

function deepFreeze(v) {
  if (v && typeof v === 'object' && !Object.isFrozen(v)) { Object.freeze(v); for (const k of Object.keys(v)) deepFreeze(v[k]); }
  return v;
}

/** A data layer over memory (seed + overrides); UUIDs from `uuids`, then 1001, 1002 …; counts and can fail writes. */
function layer({ data = {}, uuids = [], failWrites = () => false } = {}) {
  const inner = createMemoryAdapter({ ...SEED, ...fresh(data) });
  const writes = [];
  const adapter = {
    load: () => inner.load(),
    save: (c, d) => adapter.saveMany({ [c]: d }),
    saveMany(ch) { if (failWrites(ch)) throw new Error('simulated storage failure'); writes.push(Object.keys(ch).sort()); inner.saveMany(ch); }
  };
  let t = Date.parse(`${TODAY}T12:00:00Z`);
  let next = 1000;
  const queue = [...uuids];
  const app = createDataLayer({ adapter, today: () => TODAY, clock: () => new Date((t += 60000)), newUuid: () => (queue.length ? queue.shift() : uuid(++next)) });
  return { app, writes, stored: () => inner.load() };
}
const userData = (app) => app.exportUserData().data;
const liveIds = (u) => u.foods.flatMap((r) => r.servings.map((s) => s.id));
const loggedIds = (days) => [...new Set(days.flatMap((d) => d.mealInstances.flatMap((mi) => mi.ingredients.filter((i) => i.serving).map((i) => i.serving.id))))];
const reserved = (u) => new Set([...liveIds(u), ...u.retiredServingIds]);
/** H ⊆ L ∪ R, with no duplicates and L ∩ R = ∅. */
function assertInvariant(data, why = '') {
  const u = data.userFoodData;
  const r = reserved(u);
  for (const id of loggedIds(data.days)) assert.ok(r.has(id), `${why}: logged ${id} is reserved`);
  assert.equal(new Set(u.retiredServingIds).size, u.retiredServingIds.length, `${why}: no duplicate retired IDs`);
  for (const id of liveIds(u)) assert.ok(!u.retiredServingIds.includes(id), `${why}: live and retired are disjoint`);
}

/**
 * This device: serving 1 (Tub, CORE) live and logged; serving 2 (Spoon, CORE) logged, then deleted
 * (retired); serving 3 (Cup, CORE) live, never logged. H = {1, 2}, L = {1, 3}, R = {2}.
 */
function deviceWithHistory(opts = {}) {
  const l = layer({ uuids: [uuid(1), uuid(2), uuid(3)], ...opts });
  const { app } = l;
  app.createServing(CORE, { label: 'Tub', grams: 170 });
  app.createServing(CORE, { label: 'Spoon', grams: 15, approximate: true });
  app.createServing(CORE, { label: 'Cup', grams: 245 });
  app.createDay(TODAY, 'lift');
  app.logFood({ date: TODAY, mealSlot: 'breakfast', foodId: CORE, servingId: SRV(1), count: '1' });
  app.logFood({ date: TODAY, mealSlot: 'snack_night', foodId: CORE, servingId: SRV(2), count: '2 1/2' });
  app.deleteServing(CORE, SRV(2));
  return l;
}

/** A backup from another device: serving 50 (Pouch, OATS) live and logged on 2026-09-20. */
function backupWithHistory() {
  const { app } = layer({ uuids: [uuid(50)] });
  app.createServing(OATS, { label: 'Pouch', grams: 60 });
  app.logFood({ date: '2026-09-20', mealSlot: 'lunch', foodId: OATS, servingId: SRV(50), count: '1/2', dayType: 'rest' });
  return app.exportUserData();
}
const v2Backup = (data) => ({ format: BACKUP_FORMAT, formatVersion: 2, exportedAt: AT, data: fresh(data) });
/** A format-2 backup from before C8: V1 data plus servings, and no logged serving snapshots. */
const preC8Backup = (userFoodData = { foods: [], retiredServingIds: [] }) => v2Backup({ ...V1_BACKUP.data, userFoodData });

/* ---------------- 1–5: round trips, older backups, preview and restore ---------------- */

test('C8 restore — 1: a backup round trip keeps every logged serving snapshot exactly', () => {
  const { app } = deviceWithHistory();
  const before = userData(app);
  assert.deepEqual(loggedIds(before.days), [SRV(1), SRV(2)]);
  const result = app.restoreUserData(JSON.stringify(app.exportUserData()));
  assert.deepEqual(userData(app), before, 'everything, snapshots included, exactly as it was');
  assert.deepEqual(result.servingIds, { carriedForward: 0, revived: 0 });
  // and onto another device: the backup's Days, snapshots and all
  const backup = backupWithHistory();
  const other = layer().app;
  other.restoreUserData(backup);
  assert.deepEqual(userData(other).days, backup.data.days);
  assert.deepEqual(userData(other).days[0].mealInstances[0].ingredients[0].serving, { id: SRV(50), label: 'Pouch', grams: 60, approximate: false, count: { numerator: 1, denominator: 2 } });
  assertInvariant(userData(other), 'restored elsewhere');
});

test('C8 restore — 2: a format-1 backup over a device with logged servings keeps every ID it had reserved', () => {
  const { app, writes } = deviceWithHistory({ uuids: [uuid(1), uuid(2), uuid(3), uuid(1), uuid(2), uuid(3), uuid(4)] });
  const n = writes.length;
  const result = app.restoreUserData(JSON.stringify(V1_BACKUP));
  assert.equal(writes.length, n + 1, 'one write');
  const after = userData(app);
  assert.deepEqual(after.days, V1_BACKUP.data.days, 'the backup’s Days exactly; no history is invented');
  assert.deepEqual(loggedIds(after.days), []);
  assert.deepEqual(after.userFoodData, { foods: [], retiredServingIds: [SRV(1), SRV(2), SRV(3)] }, 'live, retired and logged IDs all kept reserved');
  assert.deepEqual(result.servingIds, { carriedForward: 2, revived: 0 }, 'C5 counts: the two live servings here');
  assertInvariant(after, 'after a format-1 restore');
  assert.equal(app.createServing(CORE, { label: 'Tub', grams: 170 }).id, SRV(4), 'none of them is drawn again');
});

test('C8 restore — 3: a pre-C8 format-2 backup behaves the same way', () => {
  const { app } = deviceWithHistory();
  const backupFoods = { foods: [{ foodId: CORE, servings: [{ id: SRV(3), label: 'Big cup', grams: 250, approximate: false, createdAt: AT, updatedAt: AT }] }, { foodId: OATS, servings: [{ id: SRV(60), label: 'Pouch', grams: 60, approximate: false, createdAt: AT, updatedAt: AT }] }], retiredServingIds: [SRV(70)] };
  const result = app.restoreUserData(preC8Backup(backupFoods));
  const after = userData(app);
  assert.deepEqual(after.userFoodData.foods, backupFoods.foods, 'active definitions are the backup’s (Cup → Big cup, same ID)');
  assert.deepEqual(after.userFoodData.retiredServingIds, [SRV(70), SRV(1), SRV(2)], 'the backup’s retired first, then this device’s, sorted');
  assert.deepEqual(result.servingIds, { carriedForward: 1, revived: 0 });
  assert.deepEqual(after.days, V1_BACKUP.data.days);
  assertInvariant(after, 'after a pre-C8 restore');
});

test('C8 restore — 4: the preview reports the carry-forward against this device, logged IDs included, and writes nothing', () => {
  const { app, writes } = deviceWithHistory();
  const n = writes.length;
  const before = userData(app);
  assert.deepEqual(app.validateBackup(preC8Backup()).servingIds, { carriedForward: 2, revived: 0 });
  // serving 2 is retired and logged here; a backup with it active brings the definition back
  const spoon = { foods: [{ foodId: CORE, servings: [{ id: SRV(2), label: 'Spoon', grams: 15, approximate: true, createdAt: AT, updatedAt: AT }] }], retiredServingIds: [] };
  const check = app.validateBackup(preC8Backup(spoon));
  assert.equal(check.valid, true);
  assert.deepEqual(check.servingIds, { carriedForward: 2, revived: 1 });
  assert.deepEqual(app.validateBackup(app.exportUserData()).servingIds, { carriedForward: 0, revived: 0 });
  assert.equal(writes.length, n, 'previewing writes nothing');
  assert.deepEqual(userData(app), before);
  const result = app.restoreUserData(preC8Backup(spoon));
  assert.deepEqual(result.servingIds, check.servingIds, 'nothing changed in between: the restore matches the preview');
  assert.deepEqual(userData(app).userFoodData, { foods: spoon.foods, retiredServingIds: [SRV(1), SRV(3)] });
});

test('C8 restore — 5: if the device changes after the preview, the restore recomputes against it', () => {
  const { app } = deviceWithHistory({ uuids: [uuid(1), uuid(2), uuid(3), uuid(8)] });
  const target = preC8Backup();
  const preview = app.validateBackup(target).servingIds;
  assert.deepEqual(preview, { carriedForward: 2, revived: 0 });
  // meanwhile: a new serving is made, logged and deleted; serving 3 is deleted
  app.createServing(OATS, { label: 'Pouch', grams: 60 });
  app.logFood({ date: TODAY, mealSlot: 'lunch', foodId: OATS, servingId: SRV(8), count: '1' });
  app.deleteServing(OATS, SRV(8));
  app.deleteServing(CORE, SRV(3));
  const result = app.restoreUserData(target);
  assert.deepEqual(result.servingIds, { carriedForward: 1, revived: 0 }, 'counted against the data at restore time, not the preview');
  assert.deepEqual(userData(app).userFoodData.retiredServingIds, [SRV(1), SRV(2), SRV(3), SRV(8)], 'the ID logged after the preview is kept too');
});

/* ---------------- 6–9: invalid backups and the postcondition ---------------- */

/** validateBackup refuses it as BACKUP_INVALID (no counts), restoreUserData throws it, and nothing is written. */
function assertRefused(backup, pattern, why) {
  const { app, writes } = deviceWithHistory();
  const n = writes.length;
  const before = userData(app);
  const check = app.validateBackup(backup);
  assert.equal(check.valid, false, why);
  assert.equal(check.code, 'BACKUP_INVALID', why);
  assert.equal(check.servingIds, null, `${why}: no carry-forward for rejected data`);
  assert.equal(check.summary, null, why);
  if (pattern) assert.ok(check.errors.some((e) => pattern.test(e)), `${why}: ${check.errors.join(' | ')}`);
  assert.throws(() => app.restoreUserData(backup), (e) => e instanceof DomainError && e.code === 'BACKUP_INVALID', why);
  assert.throws(() => app.restoreUserData(JSON.stringify(backup)), code('BACKUP_INVALID'), `${why} (as text)`);
  assert.equal(writes.length, n, `${why}: nothing written`);
  assert.deepEqual(userData(app), before, `${why}: nothing changed`);
}
const ingredientOf = (backup) => backup.data.days[0].mealInstances[0].ingredients[0];

test('C8 restore — 6: a backup whose logged meals refer to an orphan serving ID is refused before writing', () => {
  const orphan = backupWithHistory();
  orphan.data.userFoodData = { foods: [], retiredServingIds: [] };
  assertRefused(orphan, /neither a live nor a retired/, 'serving 50 dropped from the backup');
  const unknown = backupWithHistory();
  ingredientOf(unknown).serving.id = SRV(77);
  assertRefused(unknown, /neither a live nor a retired/, 'a logged ID the backup never had');
  // even when this device has the ID reserved: the backup must be consistent on its own
  const reservedHere = backupWithHistory();
  ingredientOf(reservedHere).serving.id = SRV(2);
  assertRefused(reservedHere, /neither a live nor a retired/, 'an ID reserved only on this device');
});

test('C8 restore — 7: an internally inconsistent snapshot is refused before writing', () => {
  const cases = [
    ['a quantity the serving does not come to', (ing) => { ing.quantity += 1; }, /is not what the serving comes to/],
    ['a count not in lowest terms', (ing) => { ing.serving.count = { numerator: 2, denominator: 4 }; }, /lowest terms/],
    ['an unsafe count', (ing) => { ing.serving.count = { numerator: 2 ** 53, denominator: 1 }; }, /positive whole numbers/],
    ['a blank label', (ing) => { ing.serving.label = '  '; }, /must not be blank/],
    ['a serving on a non-gram row', (ing) => { ing.unit = 'ml'; }, /only be logged in grams/],
    ['a malformed ID', (ing) => { ing.serving.id = 'srv_50'; }, /not srv_<uuid>/],
    ['an extra snapshot field', (ing) => { ing.serving.text = '1/2'; }, /unexpected property "text"/],
    ['a null snapshot', (ing) => { ing.serving = null; }, null]
  ];
  for (const [why, mutate, pattern] of cases) {
    const backup = backupWithHistory();
    mutate(ingredientOf(backup));
    assertRefused(backup, pattern, why);
  }
});

test('C8 restore — 8: a backup whose logged ID disagrees with its serving / Food association is refused', () => {
  const moved = backupWithHistory();
  moved.data.userFoodData.foods[0].foodId = CORE; // serving 50 now live under another Food
  assertRefused(moved, /is a live serving of/, 'live under a different Food');
  const twoFoods = backupWithHistory();
  const extra = fresh(twoFoods.data.days[0].mealInstances[0]);
  extra.id = 'mi_extra';
  extra.ingredients[0].foodId = CORE;
  twoFoods.data.days[0].mealInstances.push(extra);
  assertRefused(twoFoods, /more than one Food/, 'one logged ID for two Foods');
});

test('C8 restore — 9: the carry-forward’s postcondition refuses a result that would leave a restored logged ID unreserved', () => {
  const EMPTY = { foods: [], retiredServingIds: [] };
  const daysWith = (...ids) => [{ date: TODAY, mealInstances: [{ ingredients: ids.map((id) => ({ foodId: CORE, serving: { id } })) }] }];
  assert.throws(() => carryForwardServingIds(EMPTY, EMPTY, { restoredDays: daysWith(SRV(77)) }), (e) => e instanceof DomainError && e.code === 'BACKUP_INVALID' && /neither active nor retired after the restore/.test(e.details[0]));
  // reserved by the backup itself, or carried forward from this device: the result is consistent
  assert.deepEqual(carryForwardServingIds({ foods: [], retiredServingIds: [SRV(77)] }, EMPTY, { restoredDays: daysWith(SRV(77)) }).userFoodData.retiredServingIds, [SRV(77)]);
  assert.deepEqual(carryForwardServingIds(EMPTY, { foods: [], retiredServingIds: [SRV(77)] }, { restoredDays: daysWith(SRV(77)) }).userFoodData.retiredServingIds, [SRV(77)]);
  assert.deepEqual(carryForwardServingIds(EMPTY, EMPTY, { currentDays: daysWith(SRV(77)), restoredDays: daysWith(SRV(77)) }).userFoodData.retiredServingIds, [SRV(77)]);
  // unreadable Days are refused, never repaired: the backup's as BACKUP_INVALID, this device's as DATA_INVALID
  for (const bad of ['x', [null], [{ date: TODAY }], [{ mealInstances: [{}] }], [{ mealInstances: [{ ingredients: [7] }] }], daysWith(42), [{ mealInstances: [{ ingredients: [{ serving: null }] }] }]]) {
    assert.throws(() => carryForwardServingIds(EMPTY, EMPTY, { restoredDays: bad }), code('BACKUP_INVALID'), JSON.stringify(bad));
    assert.throws(() => carryForwardServingIds(EMPTY, EMPTY, { currentDays: bad }), code('DATA_INVALID'), JSON.stringify(bad));
  }
  // and the data layer reports it like any other problem with the backup
  const backup = backupWithHistory();
  ingredientOf(backup).serving.id = SRV(77);
  const { app } = layer();
  const check = app.validateBackup(backup);
  assert.equal(check.code, 'BACKUP_INVALID');
});

/* ---------------- 10–11: C5 counts and determinism ---------------- */

test('C8 restore — 10: carriedForward and revived keep their C5 meaning; a logged reference is never a definition', () => {
  const STATES_B = ['absent', 'active', 'retired'];
  const STATES_C = ['absent', 'active', 'retired', 'active+logged', 'retired+logged', 'logged only'];
  const ids = [1, 2, 3];
  const serving = (n) => ({ id: SRV(n), label: `s${n}`, grams: 30, approximate: false, createdAt: AT, updatedAt: AT });
  const ufd = (active, retired) => ({ foods: active.map((n) => ({ foodId: `food_test_${n}`, servings: [serving(n)] })), retiredServingIds: retired.map(SRV) });
  const days = (logged) => [{ date: TODAY, mealInstances: [{ ingredients: logged.map((n) => ({ foodId: `food_test_${n}`, serving: { id: SRV(n) } })) }] }];
  let combos = 0;
  for (let mask = 0; mask < (3 * 6) ** ids.length; mask += 1) {
    let m = mask;
    const b = {}; const c = {};
    for (const id of ids) { b[id] = STATES_B[m % 3]; m = Math.floor(m / 3); c[id] = STATES_C[m % 6]; m = Math.floor(m / 6); }
    const pick = (place, test) => ids.filter((id) => test(place[id]));
    const backup = ufd(pick(b, (s) => s === 'active'), pick(b, (s) => s === 'retired'));
    const current = ufd(pick(c, (s) => s.startsWith('active')), pick(c, (s) => s.startsWith('retired')));
    const logged = pick(c, (s) => s.includes('logged'));
    const out = carryForwardServingIds(backup, current, { currentDays: days(logged) });
    const L = pick(b, (s) => s === 'active');
    assert.equal(out.carriedForward, pick(c, (s) => s.startsWith('active')).filter((id) => !L.includes(id)).length, 'live here, not in the backup');
    assert.equal(out.revived, L.filter((id) => c[id].startsWith('retired')).length, 'retired here, active in the backup — a logged-only ID is not revived');
    assert.deepEqual(out.userFoodData.foods, backup.foods);
    const R2 = out.userFoodData.retiredServingIds;
    assert.equal(new Set(R2).size, R2.length);
    for (const id of [...liveIds(current), ...current.retiredServingIds, ...logged.map(SRV)]) assert.ok(liveIds(out.userFoodData).includes(id) || R2.includes(id), 'everything reserved here stays reserved');
    if (!pick(c, (s) => s === 'logged only').length) {
      assert.deepEqual(out, carryForwardServingIds(backup, current), 'a consistent device: the same result as without its Days');
    }
    combos += 1;
  }
  assert.equal(combos, 5832);
});

test('C8 restore — 11: repeated restores are deterministic and never duplicate an ID', () => {
  const { app } = deviceWithHistory();
  const backup = deepFreeze(backupWithHistory());
  const r1 = app.restoreUserData(backup);
  const first = userData(app);
  assert.deepEqual(first.userFoodData.retiredServingIds, [SRV(1), SRV(2), SRV(3)]);
  assert.deepEqual(r1.servingIds, { carriedForward: 2, revived: 0 });
  const r2 = app.restoreUserData(backup);
  assert.deepEqual(userData(app), first, 'the same backup again: the same data');
  assert.deepEqual(r2.servingIds, { carriedForward: 0, revived: 0 });
  // round trips through older and newer backups
  for (const b of [V1_BACKUP, backup, preC8Backup(), backup, V1_BACKUP]) {
    app.restoreUserData(b);
    assertInvariant(userData(app), 'after each restore');
  }
  assert.deepEqual(userData(app).userFoodData.retiredServingIds, [SRV(1), SRV(2), SRV(3), SRV(50)]);
  const input = deepFreeze({ backup: backup.data.userFoodData, current: userData(app).userFoodData, days: backup.data.days });
  const a = carryForwardServingIds(input.backup, input.current, { currentDays: input.days, restoredDays: input.days });
  const b2 = carryForwardServingIds(fresh(input.backup), fresh(input.current), { currentDays: fresh(input.days), restoredDays: fresh(input.days) });
  assert.equal(JSON.stringify(a), JSON.stringify(b2), 'deterministic; inputs (frozen) unchanged');
});

/* ---------------- 12–14: stored record, archives, ordinary backups ---------------- */

let tick = 0;
const now = () => new Date(Date.parse('2026-09-27T12:00:00Z') + 60000 * ++tick).toISOString();
const v2Record = (data, revision = 30) => ({ format: 'macro-tracker-v2-store', version: 2, revision, savedAt: AT, data: fresh(data) });

test('C8 restore — 12: an invalid backup or a failed write leaves the stored record and archives unchanged', async () => {
  const deviceData = userData(deviceWithHistory().app);
  const archiveKey = storeArchiveKey(1, 7);
  const archive = { format: STORE_ARCHIVE_FORMAT, archiveVersion: 1, archivedAt: 't', reason: 'upgrade-to-format-2', replacedByRevision: 8, original: { ...fresh(V1_STORE), revision: 7 } };
  const store = createMemorySnapshotStore(v2Record(deviceData), { archives: { [archiveKey]: archive } });
  const { app, adapter } = await openBrowserDataLayer({ snapshotStore: store, today: () => TODAY, now });
  const record = store.peek();
  const archives = store.peekArchives();
  // invalid: refused before anything is written
  const orphan = backupWithHistory();
  orphan.data.userFoodData = { foods: [], retiredServingIds: [] };
  assert.throws(() => app.restoreUserData(orphan), code('BACKUP_INVALID'));
  await app.flushPersistence();
  assert.equal(store.writeCount(), 0);
  assert.deepEqual(store.peek(), record);
  assert.deepEqual(store.peekArchives(), archives);
  assert.deepEqual(userData(app), deviceData);
  // a write that fails: the stored record and archives stay; retry writes the carried-forward result
  store.failNextWrites(1);
  const result = app.restoreUserData(fresh(V1_BACKUP));
  assert.equal((await app.flushPersistence()).state, 'error');
  assert.deepEqual(store.peek(), record, 'stored record unchanged');
  assert.deepEqual(store.peekArchives(), archives, 'archives unchanged');
  assert.equal((await adapter.retry()).state, 'saved');
  const written = store.peek().data;
  assert.deepEqual(written.userFoodData, { foods: [], retiredServingIds: [SRV(1), SRV(2), SRV(3)] }, 'the logged and live IDs, reserved');
  assert.deepEqual(written.days, V1_BACKUP.data.days);
  assert.deepEqual(result.servingIds, { carriedForward: 2, revived: 0 });
  assert.deepEqual(store.peekArchives(), archives, 'a version 2 restore creates or changes no archive');
});

test('C8 restore — 13: a pending V1 record — archived on the first save, or left alone on an archive conflict', async () => {
  const backup = backupWithHistory();
  // no conflict: the restore's write keeps the V1 record, exactly as read, as its archive
  {
    const store = createMemorySnapshotStore(fresh(V1_STORE));
    const { app } = await openBrowserDataLayer({ snapshotStore: store, today: () => TODAY, now });
    assert.equal(store.writeCount(), 0, 'opening writes nothing');
    app.restoreUserData(backup);
    assert.equal((await app.flushPersistence()).state, 'saved');
    const key = storeArchiveKey(1, V1_STORE.revision);
    assert.deepEqual(Object.keys(store.peekArchives()), [key]);
    assert.deepEqual(store.peekArchives()[key].original, V1_STORE, 'the V1 record, unchanged');
    assert.equal(store.peek().version, 2);
    assert.deepEqual(store.peek().data.days, backup.data.days, 'the snapshots, stored');
    assertInvariant(store.peek().data, 'stored');
  }
  // conflict: nothing is written, the V1 record and the existing archive stay as they were
  {
    const key = storeArchiveKey(1, V1_STORE.revision);
    const other = fresh(V1_STORE);
    other.data.targets.rest.carbs += 1;
    const conflicting = { format: STORE_ARCHIVE_FORMAT, archiveVersion: 1, archivedAt: 't', reason: 'upgrade-to-format-2', replacedByRevision: V1_STORE.revision + 1, original: other };
    const store = createMemorySnapshotStore(fresh(V1_STORE), { archives: { [key]: conflicting } });
    const { app } = await openBrowserDataLayer({ snapshotStore: store, today: () => TODAY, now });
    app.restoreUserData(backup);
    assert.equal((await app.flushPersistence()).code, 'STORAGE_ARCHIVE_CONFLICT');
    assert.deepEqual(store.peek(), V1_STORE);
    assert.deepEqual(store.peekArchives(), { [key]: conflicting });
    assert.equal(store.writeCount(), 0);
  }
});

test('C8 restore — 14: ordinary backups without logged servings restore exactly as before', () => {
  const { app, writes } = layer();
  const result = app.restoreUserData(JSON.stringify(V1_BACKUP));
  assert.deepEqual(Object.keys(result), ['restored', 'servingIds']);
  assert.deepEqual(result.servingIds, { carriedForward: 0, revived: 0 });
  assert.deepEqual(userData(app).userFoodData, { foods: [], retiredServingIds: [] });
  assert.deepEqual(userData(app).days, V1_BACKUP.data.days);
  assert.equal(writes.length, 1);
  const servings = { foods: [{ foodId: CORE, servings: [{ id: SRV(5), label: 'Tub', grams: 170, approximate: false, createdAt: AT, updatedAt: AT }] }], retiredServingIds: [SRV(6)] };
  const check = app.validateBackup(preC8Backup(servings));
  assert.deepEqual({ valid: check.valid, code: check.code, servingIds: check.servingIds }, { valid: true, code: null, servingIds: { carriedForward: 0, revived: 0 } });
  app.restoreUserData(preC8Backup(servings));
  assert.deepEqual(userData(app).userFoodData, servings, 'the backup’s servings exactly');
  assert.equal(writes.length, 2);
});
