/*
 * serving-ids.test.mjs — V3 Slice 1 · C5: reserved serving IDs are carried forward on restore.
 *   active R′/L′ rule (serving-ids.js), its wiring through validateBackup / restoreUserData, the
 *   Settings preview and result text, and failure safety. Synthetic data only.
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
import { servingIdsText, renderRestorePreview } from '../app/settings.js';

const TODAY = '2026-09-24';
const SEED = createFileAdapter(ROOT).load(); // read-only
const V1_BACKUP = JSON.parse(fs.readFileSync(path.join(ROOT, 'tests/fixtures/v1/backup.json'), 'utf8'));
const V1_STORE = JSON.parse(fs.readFileSync(path.join(ROOT, 'tests/fixtures/v1/store-record.json'), 'utf8'));
const fresh = (v) => JSON.parse(JSON.stringify(v));
const sid = (n) => `srv_00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const serving = (n, label = `s${n}`, extra = {}) => ({ id: sid(n), label, grams: 30, approximate: false, createdAt: '2026-08-01T10:00:00.000Z', updatedAt: '2026-08-01T10:00:00.000Z', ...extra });
/** userFoodData with each active serving on its own Food record, so labels never collide. */
const ufd = (active = [], retired = []) => ({
  foods: active.map((x) => { const s = typeof x === 'object' ? x : serving(x); return { foodId: `food_test_${s.id.slice(-4)}`, servings: [s] }; }),
  retiredServingIds: retired.map(sid)
});
const EMPTY = { foods: [], retiredServingIds: [] };
const v2Backup = (userFoodData) => ({ format: BACKUP_FORMAT, formatVersion: 2, exportedAt: '2026-09-01T00:00:00.000Z', data: { ...fresh(V1_BACKUP.data), userFoodData: fresh(userFoodData) } });
const activeIds = (u) => u.foods.flatMap((r) => r.servings.map((s) => s.id));

function deepFreeze(v) {
  if (v && typeof v === 'object' && !Object.isFrozen(v)) { Object.freeze(v); for (const k of Object.keys(v)) deepFreeze(v[k]); }
  return v;
}

/** A data layer over memory with this device's userFoodData; counts writes; can fail them. */
function layer(current = EMPTY, { failWrites = false } = {}) {
  const inner = createMemoryAdapter({ ...SEED, userFoodData: fresh(current) });
  const writes = [];
  const adapter = {
    load: () => inner.load(),
    save: (c, d) => adapter.saveMany({ [c]: d }),
    saveMany(ch) { if (failWrites) throw new Error('simulated storage failure'); writes.push(ch); inner.saveMany(ch); }
  };
  const app = createDataLayer({ adapter, today: () => TODAY });
  return { app, writes, stored: () => inner.load() };
}
const userFoodDataOf = (app) => app.exportUserData().data.userFoodData;

/* ------------------------------------------------------------------ */
/* The rule                                                            */
/* ------------------------------------------------------------------ */

test('C5 — 1: IDs retired here stay reserved when the backup omits them', () => {
  const out = carryForwardServingIds(EMPTY, ufd([], [1, 2]));
  assert.deepEqual(out.userFoodData, { foods: [], retiredServingIds: [sid(1), sid(2)] });
  assert.equal(out.carriedForward, 0, 'already retired: nothing newly carried');
  assert.equal(out.revived, 0);
});

test('C5 — 2: servings active here and missing from the backup are retired, IDs kept (fails without the rule)', () => {
  const { app } = layer(ufd([2, 3]));
  const result = app.restoreUserData(v2Backup(ufd([3])));
  const after = userFoodDataOf(app);
  assert.deepEqual(activeIds(after), [sid(3)]);
  // Without carry-forward the restore would write the backup's retired list ([]) and sid(2) could be reused.
  assert.ok(after.retiredServingIds.includes(sid(2)), 'the omitted active ID is retired, not forgotten');
  assert.deepEqual(after.retiredServingIds, [sid(2)]);
  assert.deepEqual(result.servingIds, { carriedForward: 1, revived: 0 });
});

test('C5 — 3: a serving active in both keeps the backup’s definition and is not retired', () => {
  const here = serving(3, 'cup', { grams: 240 });
  const there = serving(3, 'mug', { grams: 300, approximate: true, updatedAt: '2026-08-20T10:00:00.000Z' });
  const { app } = layer(ufd([here]));
  const result = app.restoreUserData(v2Backup(ufd([there])));
  const after = userFoodDataOf(app);
  assert.deepEqual(after.foods, ufd([there]).foods, 'the backup’s definition, exactly');
  assert.deepEqual(after.retiredServingIds, []);
  assert.deepEqual(result.servingIds, { carriedForward: 0, revived: 0 });
});

test('C5 — 4: a serving retired here but active in the backup comes back, leaves the retired list, and is reported', () => {
  const { app } = layer(ufd([], [4, 5]));
  const backup = v2Backup(ufd([serving(4, 'bar', { grams: 45 })]));
  assert.deepEqual(app.validateBackup(backup).servingIds, { carriedForward: 0, revived: 1 }, 'the preview says so');
  const result = app.restoreUserData(backup);
  const after = userFoodDataOf(app);
  assert.deepEqual(after.foods, backup.data.userFoodData.foods, 'revived with the backup’s definition, never dropped or rewritten');
  assert.deepEqual(after.retiredServingIds, [sid(5)], 'removed from the retired list; the other stays');
  assert.deepEqual(result.servingIds, { carriedForward: 0, revived: 1 });
});

test('C5 — 5: a V1 backup, or a V2 backup with no servings, keeps every ID reserved here', () => {
  for (const [what, backup] of [['V1 backup', V1_BACKUP], ['V2 backup without servings', v2Backup(EMPTY)]]) {
    const { app } = layer(ufd([7, 2], [9]));
    const result = app.restoreUserData(JSON.stringify(backup));
    const after = userFoodDataOf(app);
    assert.deepEqual(after.foods, [], what);
    assert.deepEqual(after.retiredServingIds, [sid(2), sid(7), sid(9)], `${what}: all reserved, sorted`);
    assert.deepEqual(result.servingIds, { carriedForward: 2, revived: 0 }, what);
  }
});

test('C5 — 6: restoring the same backup again changes nothing further', () => {
  const { app } = layer(ufd([1, 2], [3]));
  const backup = v2Backup(ufd([2, 4], [5]));
  const first = app.restoreUserData(backup);
  const once = userFoodDataOf(app);
  const second = app.restoreUserData(backup);
  assert.deepEqual(userFoodDataOf(app), once);
  assert.deepEqual(first.servingIds, { carriedForward: 1, revived: 0 });
  assert.deepEqual(second.servingIds, { carriedForward: 0, revived: 0 });
});

test('C5 — 7: an older backup restored after a newer one keeps every ID reserved', () => {
  const { app } = layer();
  app.restoreUserData(v2Backup(ufd([5, 6])));   // newer state: two servings
  app.restoreUserData(v2Backup(ufd([5])));      // an older backup: only one
  const after = userFoodDataOf(app);
  assert.deepEqual(activeIds(after), [sid(5)]);
  assert.deepEqual(after.retiredServingIds, [sid(6)]);
  app.restoreUserData(JSON.stringify(V1_BACKUP)); // older still: no servings at all
  assert.deepEqual(userFoodDataOf(app).retiredServingIds, [sid(5), sid(6)]);
});

test('C5 — 8: an invalid backup is rejected before any carry-forward and writes nothing', () => {
  const { app, writes } = layer(ufd([1], [2]));
  const before = app.exportUserData().data;
  for (const [what, bad] of [
    ['active and retired', { foods: ufd([3]).foods, retiredServingIds: [sid(3)] }],
    ['an ID used twice', { foods: [...ufd([3]).foods, { foodId: 'other', servings: [serving(3)] }], retiredServingIds: [] }],
    ['a retired ID listed twice', { foods: [], retiredServingIds: [sid(4), sid(4)] }],
    ['a malformed ID', { foods: [], retiredServingIds: ['srv_1'] }]
  ]) {
    const check = app.validateBackup(v2Backup(bad));
    assert.equal(check.code, 'BACKUP_INVALID', what);
    assert.equal(check.servingIds, null, `${what}: no carry-forward computed for rejected data`);
    assert.throws(() => app.restoreUserData(v2Backup(bad)), (e) => e.code === 'BACKUP_INVALID', what);
  }
  assert.equal(writes.length, 0);
  assert.deepEqual(app.exportUserData().data, before);
  // The rule itself refuses an inconsistent backup rather than repairing it.
  assert.throws(() => carryForwardServingIds({ foods: ufd([3]).foods, retiredServingIds: [sid(3)] }, EMPTY), (e) => e instanceof DomainError && e.code === 'BACKUP_INVALID');
});

test('C5 — 9: an invalid device state is refused, never repaired', () => {
  for (const bad of [
    { foods: ufd([1]).foods, retiredServingIds: [sid(1)] },
    { foods: [...ufd([1]).foods, ...ufd([1]).foods], retiredServingIds: [] },
    { foods: 'x', retiredServingIds: [] },
    { foods: [], retiredServingIds: [42] },
    null
  ]) {
    const input = deepFreeze(fresh(bad));
    assert.throws(() => carryForwardServingIds(EMPTY, input), (e) => e instanceof DomainError && e.code === 'DATA_INVALID', JSON.stringify(bad));
  }
  // And the data layer won't even start on such a state, so a restore never meets one.
  assert.throws(() => layer({ foods: ufd([1]).foods, retiredServingIds: [sid(1)] }), (e) => e.code === 'DATA_INVALID');
});

/* ------------------------------------------------------------------ */
/* Failure safety and storage                                          */
/* ------------------------------------------------------------------ */

const V2_RECORD = (userFoodData, revision = 30) => ({ format: 'macro-tracker-v2-store', version: 2, revision, savedAt: '2026-09-01T00:00:00.000Z', data: { ...fresh(V1_STORE.data), userFoodData: fresh(userFoodData) } });
let n = 0;
const now = () => new Date(Date.parse('2026-09-24T12:00:00Z') + 60000 * ++n).toISOString();

test('C5 — 10: a failed write leaves the stored record and archives unchanged; retry writes the carried-forward result', async () => {
  // A synchronous adapter that refuses the write: nothing in memory changes either.
  const sync = layer(ufd([1, 2]), { failWrites: true });
  const before = sync.app.exportUserData().data;
  assert.throws(() => sync.app.restoreUserData(v2Backup(ufd([2]))), (e) => e.code === 'PERSIST_FAILED');
  assert.deepEqual(sync.app.exportUserData().data, before, 'in-memory state unchanged when the adapter refused the write');

  // The browser adapter (durable writes in the background): the stored record and the archives
  // stay as they were; the change is held in the app with a visible error until it is retried
  // (the existing §11.2 / §4.8 behaviour), and the retry writes exactly the carried-forward result.
  const archiveKey = storeArchiveKey(1, 7);
  const existingArchive = { format: STORE_ARCHIVE_FORMAT, archiveVersion: 1, archivedAt: 't', reason: 'upgrade-to-format-2', replacedByRevision: 8, original: { ...fresh(V1_STORE), revision: 7 } };
  const store = createMemorySnapshotStore(V2_RECORD(ufd([1, 2], [3])), { archives: { [archiveKey]: existingArchive } });
  const { app, adapter } = await openBrowserDataLayer({ snapshotStore: store, today: () => TODAY, now });
  const record = store.peek();
  const archives = store.peekArchives();
  store.failNextWrites(1);
  const result = app.restoreUserData(v2Backup(ufd([2])));
  assert.equal((await app.flushPersistence()).state, 'error');
  assert.deepEqual(store.peek(), record, 'stored record unchanged');
  assert.deepEqual(store.peekArchives(), archives, 'archives unchanged');
  assert.equal((await adapter.retry()).state, 'saved');
  const written = store.peek().data.userFoodData;
  assert.deepEqual(activeIds(written), [sid(2)]);
  assert.deepEqual(written.retiredServingIds, [sid(1), sid(3)]);
  assert.deepEqual(result.servingIds, { carriedForward: 1, revived: 0 });
  assert.deepEqual(store.peekArchives(), archives, 'no archive created or changed by a version 2 restore');
});

test('C5 — 11: a pending V1 record with a conflicting archive stays unchanged when the restore can’t be saved', async () => {
  const key = storeArchiveKey(1, 24);
  const other = fresh(V1_STORE);
  other.data.targets.rest.carbs += 1;
  const conflicting = { format: STORE_ARCHIVE_FORMAT, archiveVersion: 1, archivedAt: 't', reason: 'upgrade-to-format-2', replacedByRevision: 25, original: other };
  const store = createMemorySnapshotStore(V1_STORE, { archives: { [key]: conflicting } });
  const { app } = await openBrowserDataLayer({ snapshotStore: store, today: () => TODAY, now });
  app.restoreUserData(v2Backup(ufd([1])));
  const status = await app.flushPersistence();
  assert.equal(status.code, 'STORAGE_ARCHIVE_CONFLICT');
  assert.deepEqual(store.peek(), V1_STORE, 'the version 1 record, unchanged');
  assert.deepEqual(store.peekArchives(), { [key]: conflicting }, 'the existing archive, unchanged');
  assert.equal(store.writeCount(), 0);
});

test('C5 — 12: logged days are exactly the backup’s; only userFoodData is carried forward', () => {
  const { app } = layer(ufd([1, 2], [3]));
  const backup = v2Backup(ufd([2]));
  app.restoreUserData(backup);
  const data = app.exportUserData().data;
  for (const c of ['targets', 'customFoods', 'savedMeals', 'days', 'preferences']) assert.deepEqual(data[c], backup.data[c], c);
  assert.deepEqual(data.days, V1_BACKUP.data.days, 'every logged meal snapshot as in the backup');
});

test('C5 — 13: restores without any servings behave exactly as before', () => {
  const { app, writes } = layer();
  const result = app.restoreUserData(JSON.stringify(V1_BACKUP));
  assert.deepEqual(userFoodDataOf(app), EMPTY);
  assert.deepEqual(result.servingIds, { carriedForward: 0, revived: 0 });
  assert.equal(writes.length, 1, 'still one write');
  assert.deepEqual(Object.keys(result), ['restored', 'servingIds'], 'restored is kept; servingIds is added');
  assert.equal(servingIdsText(result.servingIds, 'result'), '', 'no extra wording');
  const preview = { summary: { days: 1, mealInstances: 1, savedMeals: 0, customFoods: 0 }, current: { days: 0, mealInstances: 0, savedMeals: 0, customFoods: 0 }, exportedAt: '2026-09-01T00:00:00Z', note: '' };
  assert.equal(renderRestorePreview({ ...preview, servingIds: { carriedForward: 0, revived: 0 } }), renderRestorePreview(preview), 'the preview reads exactly as before');
});

/* ------------------------------------------------------------------ */
/* Exhaustive check, determinism, preview vs restore                   */
/* ------------------------------------------------------------------ */

test('C5 — 14: every placement of four IDs keeps the invariants', () => {
  const STATES = ['absent', 'active', 'retired'];
  const ids = [1, 2, 3, 4];
  let combos = 0;
  let checkedThroughStore = 0;
  for (let mask = 0; mask < 9 ** ids.length; mask += 1) {
    let m = mask;
    const placeB = [];
    const placeC = [];
    for (const id of ids) { placeB.push([id, STATES[m % 3]]); m = Math.floor(m / 3); placeC.push([id, STATES[m % 3]]); m = Math.floor(m / 3); }
    const pick = (place, s) => place.filter(([, st]) => st === s).map(([id]) => id);
    const backup = ufd(pick(placeB, 'active'), pick(placeB, 'retired'));
    const current = ufd(pick(placeC, 'active'), pick(placeC, 'retired'));
    const out = carryForwardServingIds(backup, current);
    const L = new Set(activeIds(backup));
    const R = new Set(backup.retiredServingIds);
    const C = new Set([...activeIds(current), ...current.retiredServingIds]);
    const A2 = activeIds(out.userFoodData);
    const R2 = out.userFoodData.retiredServingIds;
    assert.deepEqual(out.userFoodData.foods, backup.foods, 'active definitions are exactly the backup’s');
    assert.equal(new Set(R2).size, R2.length, 'no duplicate retired IDs');
    for (const id of R2) assert.ok(!A2.includes(id), 'active and retired are disjoint');
    for (const id of C) assert.ok(A2.includes(id) || R2.includes(id), 'every ID reserved here stays reserved');
    for (const id of R) assert.ok(R2.includes(id), 'the backup’s retired IDs are kept');
    for (const id of R2) assert.ok(R.has(id) || C.has(id), 'nothing invented');
    assert.equal(out.carriedForward, activeIds(current).filter((id) => !L.has(id)).length);
    assert.equal(out.revived, [...L].filter((id) => current.retiredServingIds.includes(id)).length);
    combos += 1;
    if (mask % 113 === 0) { // and the result passes the store's own rules
      layer(out.userFoodData);
      checkedThroughStore += 1;
    }
  }
  assert.equal(combos, 6561);
  assert.ok(checkedThroughStore >= 50);
});

test('C5 — 15: deterministic, order-preserving, and never changes its inputs', () => {
  const backup = deepFreeze(ufd([3], [9, 7]));
  const current = deepFreeze(ufd([5, 1], [8, 3]));
  const a = carryForwardServingIds(backup, current);
  const b = carryForwardServingIds(fresh(backup), fresh(current));
  assert.equal(JSON.stringify(a), JSON.stringify(b));
  assert.deepEqual(a.userFoodData.retiredServingIds, [sid(9), sid(7), sid(1), sid(5), sid(8)], 'the backup’s order, then the kept IDs sorted');
  assert.notEqual(a.userFoodData.foods, backup.foods, 'a copy');
  assert.notEqual(a.userFoodData.foods[0], backup.foods[0]);
  assert.deepEqual(a.revived, 1);
});

test('C5 — 16: the preview counts match the restore when nothing changed in between', () => {
  const { app } = layer(ufd([1, 2], [3]));
  const backup = v2Backup(ufd([2, 3], [4]));
  const before = app.exportUserData().data;
  const preview = app.validateBackup(backup).servingIds;
  assert.deepEqual(app.exportUserData().data, before, 'previewing changed nothing');
  const result = app.restoreUserData(backup);
  assert.deepEqual(result.servingIds, preview);
  assert.deepEqual(result.servingIds, { carriedForward: 1, revived: 1 });
  assert.equal(servingIdsText(preview, 'preview'), 'Servings: 1 serving on this device isn’t in the backup and will be removed; its ID stays reserved so it’s never reused; 1 serving deleted on this device will come back from the backup.');
  assert.equal(servingIdsText(result.servingIds, 'result'), 'Servings: 1 serving removed, its ID kept reserved; 1 deleted serving brought back from the backup.');
  assert.match(renderRestorePreview({ summary: { days: 0, mealInstances: 0, savedMeals: 0, customFoods: 0 }, current: { days: 0, mealInstances: 0, savedMeals: 0, customFoods: 0 }, exportedAt: 'x', note: '', servingIds: preview }), /<p class="hint">Servings: 1 serving on this device/);
});

test('C5 — 17: if the data changes between preview and restore, the restore uses the data as it is then', () => {
  const { app } = layer(ufd([1]));
  const target = v2Backup(ufd([2]));
  const preview = app.validateBackup(target).servingIds;
  assert.deepEqual(preview, { carriedForward: 1, revived: 0 });
  app.restoreUserData(v2Backup(ufd([6, 7], [1]))); // something else changes the data meanwhile
  const result = app.restoreUserData(target);
  assert.deepEqual(result.servingIds, { carriedForward: 2, revived: 0 }, 'counted against the data at restore time');
  const after = userFoodDataOf(app);
  assert.deepEqual(activeIds(after), [sid(2)]);
  assert.deepEqual(after.retiredServingIds, [sid(1), sid(6), sid(7)]);
  layer(after); // still valid by the store’s own rules
});
