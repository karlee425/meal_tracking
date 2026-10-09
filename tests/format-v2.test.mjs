/*
 * format-v2.test.mjs — V3 Slice 1 · C3: user-data format 2 wired through the schema, store,
 * backups, the Node file adapter and the browser adapter (in-memory snapshot store).
 * The IndexedDB side is in idb-adapter.test.mjs. Synthetic data only: the C1 V1 fixture
 * (read, never written) and hand-made servings below.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, tempRepo, cleanup } from './helpers.mjs';
import {
  DomainError, createDataLayer, createMemoryAdapter, readBackup,
  BACKUP_FORMAT, BACKUP_FORMAT_VERSION, BACKUP_USER_DATA_VERSION, USER_COLLECTIONS, USER_DATA_FORMAT_VERSION, upgradeUserData
} from '../src/domain/index.js';
import { makeSchemaValidator } from '../src/domain/schema-validator.js';
import { createFileAdapter, FILES } from '../src/node/file-adapter.js';
import {
  createBrowserAdapter, STORE_RECORD_FORMAT, STORE_RECORD_VERSION, STORE_RECORD_USER_DATA_VERSION, USER_COLLECTION_NAMES,
  STORE_ARCHIVE_FORMAT, storeArchiveKey, isStoreArchiveKey, sameStoreArchive
} from '../src/browser/browser-adapter.js';
import { createMemorySnapshotStore } from '../src/browser/memory-snapshot-store.js';
import { APP_DATA, openBrowserDataLayer, recoverStoredData } from '../src/browser/app-data.js';
import { openBrowserDataLayer as openV1, APP_DATA as V1_APP_DATA } from './fixtures/v1-app/src/browser/app-data.js';
import { replaceStoredUserData as replaceV1 } from './fixtures/v1-app/src/browser/browser-adapter.js';
import { createMemorySnapshotStore as createV1MemoryStore } from './fixtures/v1-app/src/browser/memory-snapshot-store.js';

const TODAY = '2026-09-24';
const fixture = (name) => JSON.parse(fs.readFileSync(path.join(ROOT, 'tests', 'fixtures', 'v1', name), 'utf8'));
const V1_STORE = fixture('store-record.json');
const V1_BACKUP = fixture('backup.json');
const V1_KEYS = ['targets', 'customFoods', 'savedMeals', 'days', 'preferences'];
const EMPTY = { foods: [], retiredServingIds: [] };
const fresh = (v) => JSON.parse(JSON.stringify(v));
const SEED = createFileAdapter(ROOT).load(); // read-only

function deepFreeze(v) {
  if (v && typeof v === 'object' && !Object.isFrozen(v)) { Object.freeze(v); for (const k of Object.keys(v)) deepFreeze(v[k]); }
  return v;
}

let clockN = 0;
const now = () => new Date(Date.parse('2026-09-24T12:00:00Z') + 60000 * ++clockN).toISOString();
const open = (snapshotStore, appData) => openBrowserDataLayer({ snapshotStore, today: () => TODAY, now, ...(appData ? { appData } : {}) });

/** A data layer over memory, optionally with different user collections; counts writes. */
function memoryLayer(overrides = {}) {
  const inner = createMemoryAdapter({ ...SEED, ...overrides });
  const calls = [];
  const adapter = { load: () => inner.load(), save: (c, d) => adapter.saveMany({ [c]: d }), saveMany(ch) { calls.push(Object.keys(ch).sort()); inner.saveMany(ch); }, snapshot: () => inner.snapshot() };
  let n = 0;
  const app = createDataLayer({ adapter, today: () => TODAY, clock: () => new Date(Date.parse('2026-09-24T12:00:00Z') + 60000 * ++n), newId: () => `t${++n}` });
  return { app, calls, adapter };
}

/* Synthetic serving data (srv_ + a lowercase UUID). */
const sid = (n) => `srv_00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const serving = (n, label, extra = {}) => ({ id: sid(n), label, grams: 35, approximate: false, createdAt: '2026-08-01T10:00:00.000Z', updatedAt: '2026-08-01T10:00:00.000Z', ...extra });
const SERVINGS = {
  foods: [
    { foodId: 'food_custom_synthetic_test_bar', servings: [serving(1, 'bar'), serving(2, 'half bar', { grams: 17.5, approximate: true })] },
    { foodId: 'food_core_banana', servings: [serving(3, 'medium')] },
    { foodId: 'food_that_no_longer_exists', servings: [serving(4, 'scoop')] }
  ],
  retiredServingIds: [sid(9)]
};
const v2Data = (userFoodData = SERVINGS) => ({ ...fresh(V1_BACKUP.data), userFoodData: fresh(userFoodData) });
const v2Backup = (userFoodData = SERVINGS) => ({ format: BACKUP_FORMAT, formatVersion: 2, exportedAt: '2026-09-01T00:00:00.000Z', data: v2Data(userFoodData) });
const v2Record = (userFoodData = SERVINGS, revision = 30) => ({ format: STORE_RECORD_FORMAT, version: 2, revision, savedAt: '2026-09-01T00:00:00.000Z', data: v2Data(userFoodData) });

/** userFoodData variants the schema or the store rules must refuse. */
const BAD_USER_FOOD_DATA = [
  ['grams 0', { foods: [{ foodId: 'f', servings: [serving(1, 'a', { grams: 0 })] }], retiredServingIds: [] }],
  ['negative grams', { foods: [{ foodId: 'f', servings: [serving(1, 'a', { grams: -5 })] }], retiredServingIds: [] }],
  ['grams as text', { foods: [{ foodId: 'f', servings: [serving(1, 'a', { grams: '35' })] }], retiredServingIds: [] }],
  ['approximate not a boolean', { foods: [{ foodId: 'f', servings: [serving(1, 'a', { approximate: 'no' })] }], retiredServingIds: [] }],
  ['createdAt not a date-time', { foods: [{ foodId: 'f', servings: [serving(1, 'a', { createdAt: 'yesterday' })] }], retiredServingIds: [] }],
  ['updatedAt missing', { foods: [{ foodId: 'f', servings: [(({ updatedAt, ...s }) => s)(serving(1, 'a'))] }], retiredServingIds: [] }],
  ['an extra serving field', { foods: [{ foodId: 'f', servings: [serving(1, 'a', { unit: 'g' })] }], retiredServingIds: [] }],
  ['an empty label', { foods: [{ foodId: 'f', servings: [serving(1, '')] }], retiredServingIds: [] }],
  ['a record with no servings', { foods: [{ foodId: 'f', servings: [] }], retiredServingIds: [] }],
  ['an empty foodId', { foods: [{ foodId: '', servings: [serving(1, 'a')] }], retiredServingIds: [] }],
  ['an extra record field', { foods: [{ foodId: 'f', servings: [serving(1, 'a')], defaultServingId: sid(1) }], retiredServingIds: [] }],
  ['an extra top-level field', { foods: [], retiredServingIds: [], version: 2 }],
  ['two records for one Food', { foods: [{ foodId: 'f', servings: [serving(1, 'a')] }, { foodId: 'f', servings: [serving(2, 'b')] }], retiredServingIds: [] }],
  ['a serving id used twice across Foods', { foods: [{ foodId: 'f', servings: [serving(1, 'a')] }, { foodId: 'g', servings: [serving(1, 'a')] }], retiredServingIds: [] }],
  ['a serving id not srv_<uuid>', { foods: [{ foodId: 'f', servings: [{ ...serving(1, 'a'), id: 'srv_1' }] }], retiredServingIds: [] }],
  ['an upper-case uuid', { foods: [{ foodId: 'f', servings: [{ ...serving(1, 'a'), id: sid(1).toUpperCase().replace('SRV_', 'srv_').replace('0000-4000-8000', '0000-4000-800A') }] }], retiredServingIds: [] }],
  ['a retired id not srv_<uuid>', { foods: [], retiredServingIds: ['old-1'] }],
  ['a retired id listed twice', { foods: [], retiredServingIds: [sid(9), sid(9)] }],
  ['an id both live and retired', { foods: [{ foodId: 'f', servings: [serving(1, 'a')] }], retiredServingIds: [sid(1)] }],
  ['labels equal ignoring case', { foods: [{ foodId: 'f', servings: [serving(1, 'Bar'), serving(2, 'bar')] }], retiredServingIds: [] }],
  ['the label "g"', { foods: [{ foodId: 'f', servings: [serving(1, 'G')] }], retiredServingIds: [] }],
  ['the label "grams"', { foods: [{ foodId: 'f', servings: [serving(1, ' Grams ')] }], retiredServingIds: [] }],
  ['the label "gram"', { foods: [{ foodId: 'f', servings: [serving(1, 'gram')] }], retiredServingIds: [] }],
  ['a blank label (spaces only)', { foods: [{ foodId: 'f', servings: [serving(1, '   ')] }], retiredServingIds: [] }],
  ['a blank label (tab and newline)', { foods: [{ foodId: 'f', servings: [serving(1, '\t\n')] }], retiredServingIds: [] }],
  ['labels equal ignoring surrounding spaces', { foods: [{ foodId: 'f', servings: [serving(1, ' bar'), serving(2, 'BAR  ')] }], retiredServingIds: [] }],
  ['a retired id with an upper-case uuid', { foods: [], retiredServingIds: [sid(9).replace('srv_00000000', 'srv_ABCDEF00')] }],
  ['a retired id without the srv_ prefix', { foods: [], retiredServingIds: [sid(9).slice(4)] }],
  ['a live id without the srv_ prefix', { foods: [{ foodId: 'f', servings: [{ ...serving(1, 'a'), id: sid(1).slice(4) }] }], retiredServingIds: [] }],
  ['a uuid with the wrong grouping', { foods: [{ foodId: 'f', servings: [{ ...serving(1, 'a'), id: 'srv_0000000000004000800000000000000001' }] }], retiredServingIds: [] }]
];

/* ------------------------------------------------------------------ */
/* Contracts and constants                                             */
/* ------------------------------------------------------------------ */

test('C3 — format 2 is current everywhere: record and backup versions map explicitly to user-data versions', () => {
  assert.equal(STORE_RECORD_VERSION, USER_DATA_FORMAT_VERSION);
  assert.equal(BACKUP_FORMAT_VERSION, USER_DATA_FORMAT_VERSION);
  assert.equal(STORE_RECORD_VERSION, 2);
  assert.deepEqual({ ...STORE_RECORD_USER_DATA_VERSION }, { 1: 1, 2: 2 });
  assert.deepEqual({ ...BACKUP_USER_DATA_VERSION }, { 1: 1, 2: 2 });
  assert.deepEqual([...USER_COLLECTIONS], [...V1_KEYS, 'userFoodData']);
  assert.deepEqual([...USER_COLLECTION_NAMES], [...USER_COLLECTIONS]);
  assert.deepEqual(Object.keys(FILES).filter((c) => !['coreFoods', 'libraryMeals'].includes(c)), [...USER_COLLECTIONS], 'the Node adapter holds the same user collections');
  assert.deepEqual(Object.keys(APP_DATA.seed), [...USER_COLLECTIONS], 'the browser seed holds the same user collections');
  assert.equal(STORE_RECORD_FORMAT, 'macro-tracker-v2-store', 'format names are unchanged');
  assert.equal(BACKUP_FORMAT, 'macro-tracker-v2-backup');
});

test('C3 — the seed and every adapter start userFoodData empty; Node, memory and browser load identical data', async () => {
  assert.deepEqual(SEED.userFoodData, EMPTY);
  assert.deepEqual(APP_DATA.seed.userFoodData, EMPTY);
  assert.deepEqual(APP_DATA.schemas['user-food-data.schema.json'], SEED.schemas['user-food-data.schema.json']);
  const dir = tempRepo();
  try {
    const viaFile = createDataLayer({ adapter: createFileAdapter(dir), today: () => TODAY }).exportUserData().data;
    const viaMemory = memoryLayer().app.exportUserData().data;
    const { app } = await open(createMemorySnapshotStore());
    const viaBrowser = app.exportUserData().data;
    assert.deepEqual(viaFile, viaMemory);
    assert.deepEqual(viaBrowser, viaMemory);
    assert.deepEqual(Object.keys(viaFile), [...USER_COLLECTIONS]);
  } finally { cleanup(dir); }
});

/* ------------------------------------------------------------------ */
/* Schema and store rules for userFoodData                             */
/* ------------------------------------------------------------------ */

test('C3 — a well-formed userFoodData passes the schema and the store, including a record for a Food that no longer exists', () => {
  const validate = makeSchemaValidator(SEED.schemas);
  assert.deepEqual(validate(SERVINGS, 'user-food-data.schema.json', 'userFoodData'), []);
  assert.deepEqual(validate(EMPTY, 'user-food-data.schema.json', 'userFoodData'), []);
  const { app } = memoryLayer({ userFoodData: fresh(SERVINGS) }); // validated at start-up
  assert.deepEqual(app.exportUserData().data.userFoodData, SERVINGS);
  // Labels are stored as given; only the comparison trims and ignores case. Near-misses of the
  // reserved words, and any positive weight, are fine.
  const edge = { foods: [{ foodId: 'f', servings: [serving(1, ' Bar '), serving(2, 'bar bites'), serving(3, 'grams of oats', { grams: 0.1 }), serving(4, 'gs')] }], retiredServingIds: [] };
  assert.deepEqual(memoryLayer({ userFoodData: fresh(edge) }).app.exportUserData().data.userFoodData, edge);
});

test('C3 — each serving rule is enforced at the layer that can express it: the schema, or the store', () => {
  const validate = makeSchemaValidator(SEED.schemas);
  const schemaOnly = (u) => validate(u, 'user-food-data.schema.json', 'userFoodData');
  // The schema expresses types, required fields, grams > 0 and non-empty strings…
  assert.ok(schemaOnly({ foods: [{ foodId: 'f', servings: [serving(1, 'a', { grams: 0 })] }], retiredServingIds: [] }).length > 0);
  assert.ok(schemaOnly({ foods: [{ foodId: 'f', servings: [serving(1, '')] }], retiredServingIds: [] }).length > 0);
  // …but not normalisation, comparison or the ID shape (the validator has no pattern), so those
  // pass the schema and are refused by the store.
  for (const u of [
    { foods: [{ foodId: 'f', servings: [serving(1, '   ')] }], retiredServingIds: [] },
    { foods: [{ foodId: 'f', servings: [serving(1, ' Grams ')] }], retiredServingIds: [] },
    { foods: [{ foodId: 'f', servings: [serving(1, 'bar'), serving(2, ' BAR')] }], retiredServingIds: [] },
    { foods: [{ foodId: 'f', servings: [{ ...serving(1, 'a'), id: 'srv_1' }] }], retiredServingIds: [] },
    { foods: [], retiredServingIds: ['old-1'] }
  ]) {
    assert.deepEqual(schemaOnly(u), [], JSON.stringify(u));
    assert.throws(() => memoryLayer({ userFoodData: u }), (e) => e.code === 'DATA_INVALID', JSON.stringify(u));
  }
});

test('C3 — invalid userFoodData is refused at every boundary: start-up DATA_INVALID, backups BACKUP_INVALID, stored records DATA_INVALID', async () => {
  for (const [what, bad] of BAD_USER_FOOD_DATA) {
    assert.throws(() => memoryLayer({ userFoodData: fresh(bad) }), (e) => e instanceof DomainError && e.code === 'DATA_INVALID', `${what}: start-up`);
    const probe = memoryLayer();
    const before = probe.app.exportUserData().data;
    const result = probe.app.validateBackup(v2Backup(bad));
    assert.equal(result.code, 'BACKUP_INVALID', `${what}: backup`);
    assert.throws(() => probe.app.restoreUserData(v2Backup(bad)), (e) => e.code === 'BACKUP_INVALID', `${what}: restore`);
    assert.deepEqual(probe.app.exportUserData().data, before, `${what}: current data untouched`);
    assert.equal(probe.calls.length, 0, `${what}: nothing written`);
    const store = createMemorySnapshotStore(v2Record(bad));
    const error = await open(store).then(() => null, (e) => e);
    assert.equal(error && error.code, 'DATA_INVALID', `${what}: stored record`);
    assert.equal(typeof error.readStoredRecord, 'function', `${what}: raw record offered`);
    assert.equal(store.writeCount(), 0, `${what}: nothing written`);
  }
});

/* ------------------------------------------------------------------ */
/* Backups                                                             */
/* ------------------------------------------------------------------ */

test('C3 — a V1 backup is upgraded, validated and restored in one write; the next export is V2 with all five collections unchanged', () => {
  const { app, calls } = memoryLayer();
  const v = app.validateBackup(V1_BACKUP);
  assert.equal(v.valid, true, v.errors.join('; '));
  assert.equal(v.formatVersion, 1, 'reports the version it was given');
  assert.deepEqual(v.summary, { customFoods: 2, savedMeals: 3, days: 5, mealInstances: 7 });
  app.restoreUserData(JSON.stringify(V1_BACKUP));
  assert.equal(calls.length, 1, 'one atomic write');
  assert.deepEqual(calls[0], [...USER_COLLECTIONS].sort(), 'carrying every user collection, userFoodData included');
  const out = app.exportUserData();
  assert.equal(out.formatVersion, 2);
  assert.deepEqual(Object.keys(out.data), [...USER_COLLECTIONS]);
  for (const c of V1_KEYS) assert.deepEqual(out.data[c], V1_BACKUP.data[c], c);
  assert.deepEqual(out.data.userFoodData, EMPTY);
  // Every logged-meal snapshot survives, field for field.
  const snaps = (d) => d.days.flatMap((day) => day.mealInstances);
  assert.deepEqual(snaps(out.data), snaps(V1_BACKUP.data));
});

test('C3 — V2 backups round-trip exactly, servings included: export → restore → export', () => {
  const a = memoryLayer();
  a.app.restoreUserData(v2Backup());
  const first = a.app.exportUserData();
  assert.deepEqual(first.data, v2Data());
  const b = memoryLayer();
  b.app.restoreUserData(JSON.stringify(first));
  const second = b.app.exportUserData();
  assert.equal(JSON.stringify(second.data), JSON.stringify(first.data), 'byte-identical data');
  assert.equal(second.formatVersion, 2);
});

test('C3 — backup versions are mapped explicitly; unsupported versions and wrong collection sets are refused with boundary codes', () => {
  const { app, calls } = memoryLayer();
  const before = app.exportUserData().data;
  const cases = [
    ['version 3', { ...v2Backup(), formatVersion: 3 }, 'BACKUP_INCOMPATIBLE'],
    ['version 0', { ...v2Backup(), formatVersion: 0 }, 'BACKUP_INCOMPATIBLE'],
    ['version "2"', { ...v2Backup(), formatVersion: '2' }, 'BACKUP_INCOMPATIBLE'],
    ['version 1.5', { ...v2Backup(), formatVersion: 1.5 }, 'BACKUP_INCOMPATIBLE'],
    ['version missing', (({ formatVersion, ...d }) => d)(v2Backup()), 'BACKUP_INCOMPATIBLE'],
    ['a version 1 backup holding userFoodData', { ...v2Backup(), formatVersion: 1 }, 'BACKUP_INVALID'],
    ['a version 2 backup without userFoodData', { ...fresh(V1_BACKUP), formatVersion: 2 }, 'BACKUP_INVALID'],
    ['a version 2 backup with an extra collection', { ...v2Backup(), data: { ...v2Data(), extra: [] } }, 'BACKUP_INVALID'],
    ['a version 1 backup with a nested NaN', (() => { const d = fresh(V1_BACKUP); d.data.targets.lift.protein = NaN; return d; })(), 'BACKUP_INVALID'],
    ['a version 2 backup whose userFoodData is a list', { ...v2Backup(), data: { ...v2Data(), userFoodData: [] } }, 'BACKUP_INVALID']
  ];
  for (const [what, doc, code] of cases) {
    const r = app.validateBackup(doc);
    assert.equal(r.code, code, what);
    assert.ok(r.errors.every((e) => !/USER_DATA_/.test(e)), `${what}: no domain-level code leaks`);
    assert.throws(() => app.restoreUserData(doc), (e) => e instanceof DomainError && e.code === code, what);
  }
  assert.deepEqual(app.exportUserData().data, before, 'current data untouched');
  assert.equal(calls.length, 0, 'nothing written');
});

test('C3 — readBackup is pure: it never changes its input and returns the upgraded data separately', () => {
  const input = deepFreeze(fresh(V1_BACKUP));
  const read = readBackup(input);
  assert.equal(read.code, undefined);
  assert.deepEqual(read.doc, V1_BACKUP);
  assert.deepEqual(read.data, upgradeUserData(V1_BACKUP.data, 1));
  assert.equal('userFoodData' in input.data, false);
  assert.deepEqual(readBackup(JSON.stringify(V1_BACKUP)).data, read.data);
  assert.equal(readBackup('{not json').code, 'BACKUP_UNREADABLE');
});

/* ------------------------------------------------------------------ */
/* Browser adapter: reading, versions, read-only start-up               */
/* ------------------------------------------------------------------ */

test('C3 — a V1 store record opens upgraded in memory; opening writes nothing and keeps the record as it was', async () => {
  const store = createMemorySnapshotStore(V1_STORE);
  const { app, adapter } = await open(store);
  assert.equal(store.writeCount(), 0, 'no write at start-up');
  assert.deepEqual(store.peek(), V1_STORE, 'stored record unchanged');
  assert.deepEqual(store.peekArchives(), {}, 'no archive at start-up');
  const data = app.exportUserData().data;
  for (const c of V1_KEYS) assert.deepEqual(data[c], V1_STORE.data[c], c);
  assert.deepEqual(data.userFoodData, EMPTY);
  assert.equal(adapter.status().revision, 24);
  assert.equal(adapter.status().state, 'saved');
  await app.flushPersistence();
  assert.equal(store.writeCount(), 0, 'still nothing after a flush');
});

test('C3 — first run and V2 records also open without writing', async () => {
  for (const initial of [null, v2Record()]) {
    const store = createMemorySnapshotStore(initial);
    const { app } = await open(store);
    await app.flushPersistence();
    assert.equal(store.writeCount(), 0);
    assert.deepEqual(store.peek(), initial);
  }
});

test('C3 — store record versions are mapped explicitly; bad wrappers and bad data are refused with boundary codes and nothing is written', async () => {
  const base = fresh(V1_STORE);
  const cases = [
    ['version 3', { ...base, version: 3 }, 'STORED_DATA_UNRECOGNIZED'],
    ['version 0', { ...base, version: 0 }, 'STORED_DATA_UNRECOGNIZED'],
    ['version "1"', { ...base, version: '1' }, 'STORED_DATA_UNRECOGNIZED'],
    ['version 1.5', { ...base, version: 1.5 }, 'STORED_DATA_UNRECOGNIZED'],
    ['version missing', (({ version, ...r }) => r)(base), 'STORED_DATA_UNRECOGNIZED'],
    ['revision missing', (({ revision, ...r }) => r)(base), 'STORED_DATA_UNRECOGNIZED'],
    ['revision as text', { ...base, revision: '24' }, 'STORED_DATA_UNRECOGNIZED'],
    ['revision 0', { ...base, revision: 0 }, 'STORED_DATA_UNRECOGNIZED'],
    ['data as a list', { ...base, data: [] }, 'STORED_DATA_UNRECOGNIZED'],
    ['another format', { ...base, format: 'macro-tracker-store-archive' }, 'STORED_DATA_UNRECOGNIZED'],
    ['a version 1 record holding userFoodData', { ...base, data: { ...base.data, userFoodData: EMPTY } }, 'DATA_INVALID'],
    ['a version 2 record without userFoodData', { ...base, version: 2 }, 'DATA_INVALID'],
    ['a version 1 record missing a collection', { ...base, data: (({ preferences, ...d }) => d)(base.data) }, 'DATA_INVALID'],
    ['a version 1 record with a nested Infinity', (() => { const r = fresh(base); r.data.customFoods[0].nutrition.carbs = 1e400; return r; })(), 'DATA_INVALID'],
    ['a version 1 record that breaks a schema', (() => { const r = fresh(base); r.data.days[0].dayType = 'long'; return r; })(), 'DATA_INVALID']
  ];
  for (const [what, record, code] of cases) {
    const store = createMemorySnapshotStore(record);
    const error = await open(store).then(() => null, (e) => e);
    assert.equal(error && error.code, code, what);
    assert.ok(!/^USER_DATA_/.test(error.code), `${what}: no domain-level code leaks`);
    assert.equal(typeof error.readStoredRecord, 'function', `${what}: the raw record stays downloadable`);
    assert.deepEqual(await error.readStoredRecord(), store.peek(), `${what}: raw record as stored`);
    assert.equal(store.writeCount(), 0, `${what}: nothing written`);
    assert.deepEqual(store.peekArchives(), {}, `${what}: no archive`);
  }
});

/* ------------------------------------------------------------------ */
/* Browser adapter: the first write and its archive                     */
/* ------------------------------------------------------------------ */

const expectedArchive = (record, savedAt) => ({
  format: STORE_ARCHIVE_FORMAT, archiveVersion: 1, archivedAt: savedAt, reason: 'upgrade-to-format-2', replacedByRevision: record.revision + 1, original: record
});

test('C3 — the first save after an upgrade writes the V2 record and the archive together; later saves add no archive', async () => {
  const store = createMemorySnapshotStore(V1_STORE);
  const { app } = await open(store);
  app.createDay(TODAY, 'rest');
  assert.equal((await app.flushPersistence()).state, 'saved');
  assert.equal(store.writeCount(), 1, 'one write');
  const record = store.peek();
  assert.equal(record.format, STORE_RECORD_FORMAT);
  assert.equal(record.version, 2);
  assert.equal(record.revision, 25);
  assert.deepEqual(Object.keys(record.data), [...USER_COLLECTIONS]);
  for (const c of ['targets', 'customFoods', 'savedMeals', 'preferences']) assert.deepEqual(record.data[c], V1_STORE.data[c], c);
  for (const day of V1_STORE.data.days) assert.deepEqual(record.data.days.find((d) => d.date === day.date), day, `day ${day.date} and its snapshots unchanged`);
  assert.deepEqual(record.data.userFoodData, EMPTY);
  const key = storeArchiveKey(1, 24);
  assert.equal(key, 'user-data:format-1@r24');
  assert.deepEqual(store.peekArchives(), { [key]: expectedArchive(V1_STORE, record.savedAt) });
  assert.deepEqual(await store.listArchives(), [key]);

  app.createDay('2026-09-25', 'lift');
  await app.flushPersistence();
  assert.equal(store.peek().revision, 26);
  assert.deepEqual(Object.keys(store.peekArchives()), [key], 'no second archive');

  const reopened = await open(store);
  reopened.app.createDay('2026-09-26', 'lift');
  await reopened.app.flushPersistence();
  assert.equal(store.peek().revision, 27);
  assert.deepEqual(Object.keys(store.peekArchives()), [key], 'a V2 record never archives');
});

test('C3 — an identical archive already under the key is kept as it is; only the record is written', async () => {
  const key = storeArchiveKey(1, 24);
  const existing = expectedArchive(V1_STORE, '2026-09-01T00:00:00.000Z');
  const store = createMemorySnapshotStore(V1_STORE, { archives: { [key]: existing } });
  const { app } = await open(store);
  app.createDay(TODAY, 'rest');
  assert.equal((await app.flushPersistence()).state, 'saved');
  assert.equal(store.peek().version, 2);
  assert.deepEqual(store.peekArchives(), { [key]: existing }, 'the existing archive, archivedAt included, is untouched');
  assert.equal(sameStoreArchive(existing, expectedArchive(V1_STORE, 'any time')), true);
});

test('C3 — a different archive under the key blocks saving: STORAGE_ARCHIVE_CONFLICT, nothing written, retry still refuses', async () => {
  const key = storeArchiveKey(1, 24);
  const other = fresh(V1_STORE);
  other.data.preferences.favoriteFoods = [];
  const different = expectedArchive(other, '2026-09-01T00:00:00.000Z');
  const store = createMemorySnapshotStore(V1_STORE, { archives: { [key]: different } });
  const { app, adapter } = await open(store);
  app.createDay(TODAY, 'rest');
  const status = await app.flushPersistence();
  assert.equal(status.state, 'conflict', 'blocking');
  assert.equal(status.code, 'STORAGE_ARCHIVE_CONFLICT');
  assert.match(status.error, /Download a backup/);
  assert.deepEqual(store.peek(), V1_STORE, 'the V1 record is unchanged');
  assert.deepEqual(store.peekArchives(), { [key]: different }, 'the existing archive is unchanged');
  assert.equal(store.writeCount(), 0);
  assert.equal((await adapter.retry()).state, 'conflict', 'a manual retry still refuses');
  app.createDay('2026-09-25', 'lift');
  await app.flushPersistence();
  assert.equal(store.writeCount(), 0, 'no automatic retry');
  assert.deepEqual(store.peek(), V1_STORE);
  // Archives that differ only in other ways are different too.
  for (const change of [{ reason: 'other' }, { replacedByRevision: 99 }, { archiveVersion: 2 }, { format: 'x' }]) {
    assert.equal(sameStoreArchive({ ...expectedArchive(V1_STORE, 't'), ...change }, expectedArchive(V1_STORE, 't')), false, JSON.stringify(change));
  }
});

test('C3 — a failed first write leaves the V1 record and archives unchanged; retry writes both', async () => {
  const store = createMemorySnapshotStore(V1_STORE);
  const { app, adapter } = await open(store);
  store.failNextWrites(1);
  app.createDay(TODAY, 'rest');
  assert.equal((await app.flushPersistence()).state, 'error');
  assert.deepEqual(store.peek(), V1_STORE);
  assert.deepEqual(store.peekArchives(), {});
  assert.equal((await adapter.retry()).state, 'saved');
  assert.equal(store.peek().version, 2);
  assert.deepEqual(store.peekArchives(), { [storeArchiveKey(1, 24)]: expectedArchive(V1_STORE, store.peek().savedAt) });
});

test('C3 — a stale revision refuses the first write before any archive is considered', async () => {
  const store = createMemorySnapshotStore(V1_STORE);
  const tabA = await open(store);
  const tabB = await open(store);
  tabA.app.createDay(TODAY, 'rest');
  assert.equal((await tabA.app.flushPersistence()).state, 'saved');
  tabB.app.createDay('2026-09-25', 'lift');
  assert.equal((await tabB.app.flushPersistence()).state, 'conflict');
  assert.equal(tabB.adapter.status().code, undefined, 'an ordinary revision conflict, not an archive conflict');
  assert.equal(store.writeCount(), 1);
  assert.equal(store.peek().revision, 25);
  assert.equal(Object.keys(store.peekArchives()).length, 1, 'one archive, from tab A');
});

test('C3 — storage that cannot keep the archive is not used for the upgrade write', async () => {
  const inner = createMemorySnapshotStore(V1_STORE);
  const plain = { read: () => inner.read(), write: (r, o) => inner.write(r, o) }; // no archive support declared
  const adapter = await createBrowserAdapter({ appData: APP_DATA, snapshotStore: plain, now });
  const app = createDataLayer({ adapter, today: () => TODAY });
  app.createDay(TODAY, 'rest');
  const status = await app.flushPersistence();
  assert.equal(status.state, 'error');
  assert.deepEqual(inner.peek(), V1_STORE);
  assert.equal(inner.writeCount(), 0);
});

test('C3 — archive equivalence: everything but archivedAt must match; anything else is a conflict', () => {
  const base = expectedArchive(V1_STORE, '2026-09-01T00:00:00.000Z');
  assert.equal(sameStoreArchive(base, { ...base, archivedAt: '2030-01-01T00:00:00.000Z' }), true, 'only archivedAt differs');
  const reordered = { ...fresh(base), original: Object.fromEntries(Object.entries(fresh(V1_STORE)).reverse()) };
  assert.equal(sameStoreArchive(base, reordered), true, 'key order is not a difference');
  const nested = fresh(base);
  nested.original.data.days[0].mealInstances[0].mealName += ' (edited)';
  assert.equal(sameStoreArchive(base, nested), false, 'a nested change in the original record');
  assert.equal(sameStoreArchive({ ...base, note: 'extra' }, base), false, 'an extra field on the existing archive');
  assert.equal(sameStoreArchive(base, { ...base, note: 'extra' }), false, 'an extra field on the new archive');
  assert.equal(sameStoreArchive((({ reason, ...a }) => a)(base), base), false, 'a missing field');
  for (const bad of [null, [], 'x', 1]) assert.equal(sameStoreArchive(bad, base), false);
});

test('C3 — compatibility basis for the revision rule: the frozen V1 app only ever writes whole-number revisions of 1 or more', async () => {
  const seen = [];
  // First run, then two saves, through the frozen V1 browser data layer.
  const store = createV1MemoryStore();
  const { app } = await openV1({ snapshotStore: store, today: () => TODAY });
  app.createDay(TODAY, 'rest');
  await app.flushPersistence();
  seen.push(store.peek().revision);
  app.createDay('2026-09-25', 'lift');
  await app.flushPersistence();
  seen.push(store.peek().revision);
  // Its explicit replacement, over nothing, over a revision, and over a record without one.
  for (const initial of [null, { ...fresh(V1_STORE), revision: 7 }, (({ revision, ...r }) => r)(fresh(V1_STORE))]) {
    const s = createV1MemoryStore(initial);
    await replaceV1({ snapshotStore: s, data: fresh(V1_APP_DATA.seed) });
    seen.push(s.peek().revision);
  }
  assert.deepEqual(seen, [1, 2, 1, 8, 1], 'first write 1, then +1; replacement = stored + 1, or 1 when there is none');
  assert.ok(seen.every((r) => Number.isInteger(r) && r >= 1));
  // So a V1 record this app refuses for its revision did not come from the V1 app.
  for (const revision of [0, -1, 1.5, '24', null]) {
    assert.equal(await open(createMemorySnapshotStore({ ...fresh(V1_STORE), revision })).then(() => null, (e) => e.code), 'STORED_DATA_UNRECOGNIZED', String(revision));
  }
});

test('C3 — archive keys are explicit and only archive keys can be read as archives', async () => {
  assert.equal(isStoreArchiveKey('user-data:format-1@r24'), true);
  for (const k of ['user-data', 'user-data:format-1', 'user-data:format-0@r1', 'user-data:format-1@r0', 'user-data:format-1@r', 'x']) assert.equal(isStoreArchiveKey(k), false, k);
  const store = createMemorySnapshotStore(V1_STORE);
  await assert.rejects(store.readArchive('user-data'));
  await assert.rejects(store.write(v2Record(EMPTY, 25), { expectedRevision: 24, archive: { key: 'user-data', value: {} } }));
  assert.equal(store.writeCount(), 0);
});

/* ------------------------------------------------------------------ */
/* Recovery (unreadable stored data — Q6: no archive, unchanged safety)  */
/* ------------------------------------------------------------------ */

test('C3 — recovery stores a V1 backup upgraded to V2 (one write, no archive); Start over stores the V2 seed', async () => {
  const odd = { format: 'another-app', version: 3, data: {} };
  const store = createMemorySnapshotStore(odd);
  const { app } = await recoverStoredData({ snapshotStore: store, backup: JSON.stringify(V1_BACKUP), today: () => TODAY, now });
  assert.equal(store.writeCount(), 1);
  const record = store.peek();
  assert.equal(record.version, 2);
  for (const c of V1_KEYS) assert.deepEqual(record.data[c], V1_BACKUP.data[c], c);
  assert.deepEqual(record.data.userFoodData, EMPTY);
  assert.deepEqual(store.peekArchives(), {}, 'recovery never creates or touches archives');
  assert.deepEqual(app.exportUserData().data, record.data);

  const fresh2 = createMemorySnapshotStore(odd);
  await recoverStoredData({ snapshotStore: fresh2, startFresh: true, today: () => TODAY, now });
  assert.equal(fresh2.peek().version, 2);
  assert.deepEqual(fresh2.peek().data, fresh(APP_DATA.seed));
  const invalid = createMemorySnapshotStore(odd);
  await assert.rejects(recoverStoredData({ snapshotStore: invalid, backup: { ...v2Backup(), formatVersion: 3 } }), (e) => e.code === 'BACKUP_INCOMPATIBLE');
  assert.equal(invalid.writeCount(), 0);
});

/* ------------------------------------------------------------------ */
/* Node file adapter                                                   */
/* ------------------------------------------------------------------ */

test('C3 — the Node file adapter reads and writes userFoodData; it never guesses an older format from a missing file', () => {
  const dir = tempRepo();
  try {
    const app = createDataLayer({ adapter: createFileAdapter(dir), today: () => TODAY });
    app.restoreUserData(v2Backup());
    const onDisk = JSON.parse(fs.readFileSync(path.join(dir, 'user-data/user-food-data.json'), 'utf8'));
    assert.deepEqual(onDisk, SERVINGS);
    const reopened = createDataLayer({ adapter: createFileAdapter(dir), today: () => TODAY });
    assert.deepEqual(reopened.exportUserData().data, v2Data());
    fs.rmSync(path.join(dir, 'user-data/user-food-data.json'));
    const before = fs.readdirSync(path.join(dir, 'user-data')).map((f) => [f, fs.readFileSync(path.join(dir, 'user-data', f), 'utf8')]);
    assert.throws(() => createDataLayer({ adapter: createFileAdapter(dir) }), (e) => e instanceof DomainError && e.code === 'DATA_INVALID'
      && /not in the current user-data format/.test(e.message) && e.details.includes('missing user-data/user-food-data.json'));
    assert.equal(fs.existsSync(path.join(dir, 'user-data/user-food-data.json')), false, 'not recreated');
    const after = fs.readdirSync(path.join(dir, 'user-data')).map((f) => [f, fs.readFileSync(path.join(dir, 'user-data', f), 'utf8')]);
    assert.deepEqual(after, before, 'every other file untouched');
  } finally { cleanup(dir); }
});
