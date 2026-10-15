/*
 * idb-adapter.test.mjs — V3 Slice 1 · C3: the real IndexedDB snapshot store and browser
 * adapter against fake-indexeddb (a fresh, isolated IDBFactory per test; never a real
 * browser database). Shows: start-up never writes; the first save after an upgrade puts the
 * V2 record and the archive in ONE transaction; conflicts and failed requests abort it
 * completely; the frozen V1 app refuses V2 data without writing.
 *
 * What this cannot show: native browser atomicity, durability across a crash, quota or
 * Safari behaviour. Those need the real-browser rehearsal.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { IDBFactory } from 'fake-indexeddb';
import { ROOT } from './helpers.mjs';
import { createIndexedDbSnapshotStore, DEFAULT_DB_NAME } from '../src/browser/indexeddb-snapshot-store.js';
import { STORE_ARCHIVE_FORMAT, storeArchiveKey } from '../src/browser/browser-adapter.js';
import { openBrowserDataLayer } from '../src/browser/app-data.js';
import { createIndexedDbSnapshotStore as createV1Store } from './fixtures/v1-app/src/browser/indexeddb-snapshot-store.js';
import { openBrowserDataLayer as openV1 } from './fixtures/v1-app/src/browser/app-data.js';

const DB = 'meal-tracking-c3-test';
const TODAY = '2026-09-24';
const V1_STORE = JSON.parse(fs.readFileSync(path.join(ROOT, 'tests/fixtures/v1/store-record.json'), 'utf8'));
const KEY = storeArchiveKey(1, 24);
let n = 0;
const now = () => new Date(Date.parse('2026-09-24T12:00:00Z') + 60000 * ++n).toISOString();

/** Every key and value in the test database, read with a separate connection. */
async function dump(factory) {
  const db = await new Promise((resolve, reject) => {
    const req = factory.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore('snapshots');
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  const out = await new Promise((resolve, reject) => {
    const tx = db.transaction('snapshots', 'readonly');
    const os = tx.objectStore('snapshots');
    const keys = os.getAllKeys();
    const values = os.getAll();
    tx.oncomplete = () => resolve(Object.fromEntries(keys.result.map((k, i) => [k, values.result[i]])));
    tx.onerror = () => reject(tx.error);
  });
  db.close();
  return out;
}

async function rawPut(factory, key, value) {
  const db = await new Promise((resolve, reject) => {
    const req = factory.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore('snapshots');
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  await new Promise((resolve, reject) => {
    const tx = db.transaction('snapshots', 'readwrite');
    tx.objectStore('snapshots').put(value, key);
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
  db.close();
}

/** A database holding the C1 V1 record, written by the frozen V1 store itself. */
async function v1Database() {
  const factory = new IDBFactory();
  await createV1Store({ dbName: DB, indexedDB: factory }).write(V1_STORE, { expectedRevision: 0 });
  return factory;
}
const store = (factory) => createIndexedDbSnapshotStore({ dbName: DB, indexedDB: factory });
const open = (factory) => openBrowserDataLayer({ snapshotStore: store(factory), today: () => TODAY, now });
const archiveFor = (original, archivedAt) => ({ format: STORE_ARCHIVE_FORMAT, archiveVersion: 1, archivedAt, reason: 'upgrade-to-format-2', replacedByRevision: original.revision + 1, original });

test('IDB — the test never names the app database', () => {
  assert.notEqual(DB, DEFAULT_DB_NAME);
});

test('IDB — opening on a V1 record writes nothing', async () => {
  const factory = await v1Database();
  const before = await dump(factory);
  assert.deepEqual(before, { 'user-data': V1_STORE });
  const { app } = await open(factory);
  await app.flushPersistence();
  assert.deepEqual(await dump(factory), before, 'database unchanged');
  assert.deepEqual(app.exportUserData().data.userFoodData, { foods: [], retiredServingIds: [] });
});

test('IDB — the first save puts the V2 record and the archive together; later saves add none', async () => {
  const factory = await v1Database();
  const { app } = await open(factory);
  app.createDay(TODAY, 'rest');
  assert.equal((await app.flushPersistence()).state, 'saved');
  const after = await dump(factory);
  assert.deepEqual(Object.keys(after).sort(), ['user-data', KEY].sort());
  const record = after['user-data'];
  assert.equal(record.version, 2);
  assert.equal(record.revision, 25);
  for (const c of ['targets', 'customFoods', 'savedMeals', 'preferences']) assert.deepEqual(record.data[c], V1_STORE.data[c], c);
  for (const day of V1_STORE.data.days) assert.deepEqual(record.data.days.find((d) => d.date === day.date), day, day.date);
  assert.deepEqual(after[KEY], archiveFor(V1_STORE, record.savedAt), 'the archive holds the V1 record exactly as read');
  const s = store(factory);
  assert.deepEqual(await s.listArchives(), [KEY]);
  assert.deepEqual(await s.readArchive(KEY), after[KEY]);
  assert.deepEqual(await s.read(), record, 'read() returns the current record, never an archive');

  app.createDay('2026-09-25', 'lift');
  await app.flushPersistence();
  const later = await dump(factory);
  assert.equal(later['user-data'].revision, 26);
  assert.deepEqual(later[KEY], after[KEY], 'archive untouched');
  assert.equal(Object.keys(later).length, 2);
});

test('IDB — an identical archive is kept; a different one aborts the whole transaction', async () => {
  const same = await v1Database();
  const existing = archiveFor(V1_STORE, '2026-09-01T00:00:00.000Z');
  await rawPut(same, KEY, existing);
  const a = await open(same);
  a.app.createDay(TODAY, 'rest');
  assert.equal((await a.app.flushPersistence()).state, 'saved');
  const sameAfter = await dump(same);
  assert.equal(sameAfter['user-data'].version, 2);
  assert.deepEqual(sameAfter[KEY], existing, 'kept as it was, archivedAt included');

  const diff = await v1Database();
  const other = JSON.parse(JSON.stringify(V1_STORE));
  other.data.targets.rest.carbs += 1;
  await rawPut(diff, KEY, archiveFor(other, '2026-09-01T00:00:00.000Z'));
  const before = await dump(diff);
  const b = await open(diff);
  b.app.createDay(TODAY, 'rest');
  const status = await b.app.flushPersistence();
  assert.equal(status.state, 'conflict');
  assert.equal(status.code, 'STORAGE_ARCHIVE_CONFLICT');
  assert.deepEqual(await dump(diff), before, 'V1 record and existing archive unchanged');
  assert.equal((await b.adapter.retry()).state, 'conflict');
  assert.deepEqual(await dump(diff), before, 'retry still refuses');
});

test('IDB — a request that fails inside the transaction (DataCloneError) commits nothing', async () => {
  const factory = await v1Database();
  const before = await dump(factory);
  const s = store(factory);
  const record = { format: 'macro-tracker-v2-store', version: 2, revision: 25, savedAt: now(), data: {} };
  // The archive cannot be cloned: nothing is written, the record included.
  await assert.rejects(s.write(record, { expectedRevision: 24, archive: { key: KEY, value: { original: { bad: () => 1 } } } }));
  assert.deepEqual(await dump(factory), before);
  // The record cannot be cloned after the archive was put: the archive is rolled back too.
  await assert.rejects(s.write({ ...record, bad: () => 1 }, { expectedRevision: 24, archive: { key: KEY, value: archiveFor(V1_STORE, now()) } }));
  assert.deepEqual(await dump(factory), before);
  // A stale revision is refused before the archive is looked at.
  await assert.rejects(s.write(record, { expectedRevision: 23, archive: { key: KEY, value: archiveFor(V1_STORE, now()) } }), (e) => e.code === 'CONFLICT');
  assert.deepEqual(await dump(factory), before);
  await assert.rejects(s.write(record, { expectedRevision: 24, archive: { key: 'user-data', value: {} } }));
  assert.deepEqual(await dump(factory), before, 'an archive can never be written over the current record');
});

test('IDB — two tabs on the same V1 record: exactly one first save succeeds, with one archive', async () => {
  const factory = await v1Database();
  const tabA = await open(factory);
  const tabB = await open(factory);
  tabA.app.createDay(TODAY, 'rest');
  tabB.app.createDay('2026-09-25', 'lift');
  const [sa, sb] = await Promise.all([tabA.app.flushPersistence(), tabB.app.flushPersistence()]);
  assert.deepEqual([sa.state, sb.state].sort(), ['conflict', 'saved']);
  const after = await dump(factory);
  assert.equal(after['user-data'].revision, 25);
  assert.equal(Object.keys(after).length, 2, 'one record and one archive');
});

test('IDB — data and archive survive reopening the database with a new connection', async () => {
  const factory = await v1Database();
  const first = await open(factory);
  first.app.createDay(TODAY, 'rest');
  await first.app.flushPersistence();
  const { app } = await open(factory);
  assert.ok(app.getDay(TODAY));
  assert.deepEqual(await store(factory).listArchives(), [KEY]);
});

test('IDB — the frozen V1 app refuses the V2 record and writes nothing', async () => {
  const factory = await v1Database();
  const { app } = await open(factory);
  app.createDay(TODAY, 'rest');
  await app.flushPersistence();
  const before = await dump(factory);
  const error = await openV1({ snapshotStore: createV1Store({ dbName: DB, indexedDB: factory }), today: () => TODAY }).then(() => null, (e) => e);
  assert.equal(error && error.code, 'STORED_DATA_UNRECOGNIZED');
  assert.deepEqual(await dump(factory), before, 'V2 record and archive untouched by the old app');
});
