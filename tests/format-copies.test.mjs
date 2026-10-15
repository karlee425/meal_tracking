/*
 * format-copies.test.mjs — V3 Slice 1 · C4: earlier-format copies and the archive conflict.
 *   - the older-format backup: the pre-upgrade version-1 data, from the pending original or a
 *     stored migration archive; accepted by this app and by the frozen V1 app; read-only
 *   - the raw migration archive: exactly as stored; never restorable
 *   - the archive-conflict presentation, and restore over an un-archived version-1 record
 * Synthetic data only (the C1 fixture, read; isolated memory and fake IndexedDB stores).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { IDBFactory } from 'fake-indexeddb';
import { ROOT } from './helpers.mjs';
import { DomainError, olderFormatBackup, upgradeUserData, BACKUP_FORMAT } from '../src/domain/index.js';
import { storeArchiveKey, STORE_ARCHIVE_FORMAT, inspectStoreArchive, inspectOriginalRecord, isExactJson } from '../src/browser/browser-adapter.js';
import { createMemorySnapshotStore } from '../src/browser/memory-snapshot-store.js';
import { createIndexedDbSnapshotStore } from '../src/browser/indexeddb-snapshot-store.js';
import { openBrowserDataLayer, recoverStoredData, validateRecoveryBackup } from '../src/browser/app-data.js';
import { downloadBackup, downloadOlderFormatBackup, rawArchiveFile, downloadRawArchive, downloadRawArchives } from '../app/download.js';
import { formatCopiesModel, renderFormatCopiesBody, renderSettings, settingsFoodsModel, saveStatusText, createCopiesLoader } from '../app/settings.js';
import {
  conflictDialogView, persistenceView, restoreFileErrorMessage, restoreErrorMessage, RAW_ARCHIVE_RESTORE_MESSAGE, isRawMigrationArchiveText, createShell,
  archiveConflictView, archiveDownloadMessage, preUpgradeOffer, storedArchiveOffer
} from '../app/shell.js';
import { openBrowserDataLayer as openV1 } from './fixtures/v1-app/src/browser/app-data.js';
import { createMemorySnapshotStore as createV1MemoryStore } from './fixtures/v1-app/src/browser/memory-snapshot-store.js';
import { createIndexedDbSnapshotStore as createV1IdbStore } from './fixtures/v1-app/src/browser/indexeddb-snapshot-store.js';

const TODAY = '2026-09-24';
const V1_STORE = JSON.parse(fs.readFileSync(path.join(ROOT, 'tests/fixtures/v1/store-record.json'), 'utf8'));
const V1_BACKUP = JSON.parse(fs.readFileSync(path.join(ROOT, 'tests/fixtures/v1/backup.json'), 'utf8'));
const V1_KEYS = ['targets', 'customFoods', 'savedMeals', 'days', 'preferences'];
const KEY = storeArchiveKey(1, 24);
const fresh = (v) => JSON.parse(JSON.stringify(v));
let n = 0;
const now = () => new Date(Date.parse('2026-09-24T12:00:00Z') + 60000 * ++n).toISOString();
const open = (snapshotStore) => openBrowserDataLayer({ snapshotStore, today: () => TODAY, now });
const text = (html) => html.replace(/<[^>]*>/g, ' ').replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/\s+/g, ' ');
const archiveFor = (original, archivedAt = '2026-09-01T00:00:00.000Z') => ({ format: STORE_ARCHIVE_FORMAT, archiveVersion: 1, archivedAt, reason: 'upgrade-to-format-2', replacedByRevision: original.revision + 1, original });

/** A document stand-in that records every file offered: [{ name, text }]. */
function fakeDocument() {
  const files = [];
  let blob = '';
  const doc = {
    defaultView: { URL: { createObjectURL: () => 'blob:x', revokeObjectURL() {} }, Blob: function Blob(parts) { blob = parts.join(''); }, setTimeout: () => 0 },
    createElement: () => ({ click() { files.push({ name: this.download, text: blob }); }, remove() {} }),
    body: { appendChild() {} }
  };
  return { doc, files };
}

/** The frozen V1 app accepts the backup: validateBackup, then restoreUserData stores it as a version-1 record. */
async function frozenV1Accepts(backup) {
  const store = createV1MemoryStore();
  const { app } = await openV1({ snapshotStore: store, today: () => TODAY });
  const check = app.validateBackup(JSON.stringify(backup));
  assert.equal(check.valid, true, (check.errors || []).join('; '));
  app.restoreUserData(JSON.stringify(backup));
  await app.flushPersistence();
  return store.peek();
}

/* ------------------------------------------------------------------ */
/* The older-format backup                                             */
/* ------------------------------------------------------------------ */

test('C4 — pending source: before the first save, the pre-upgrade copy builds the exact format-1 backup; nothing is written', async () => {
  const store = createMemorySnapshotStore(V1_STORE);
  const { app, adapter } = await open(store);
  const copies = await adapter.listFormatCopies();
  assert.equal(copies.length, 1);
  const [c] = copies;
  assert.equal(c.kind, 'pending');
  assert.equal(c.key, null);
  assert.deepEqual(c.problems, []);
  assert.equal(c.revision, 24);
  assert.equal(c.savedAt, V1_STORE.savedAt);
  assert.deepEqual(c.original, V1_STORE);

  const backup = olderFormatBackup(c.original);
  assert.deepEqual(Object.keys(backup), ['format', 'formatVersion', 'exportedAt', 'data'], 'the exact envelope');
  assert.equal(backup.format, BACKUP_FORMAT);
  assert.equal(backup.formatVersion, 1);
  assert.equal(backup.exportedAt, V1_STORE.savedAt, 'exportedAt is when the original was saved');
  assert.deepEqual(Object.keys(backup.data), V1_KEYS, 'exactly the five version-1 collections');
  assert.equal(JSON.stringify(backup.data), JSON.stringify(V1_STORE.data), 'the original data, byte for byte');
  assert.notEqual(backup.data, c.original.data, 'a copy, not the source');

  const check = app.validateBackup(backup);
  assert.equal(check.valid, true, check.errors.join('; '));
  assert.equal(check.formatVersion, 1);
  const stored = await frozenV1Accepts(backup);
  assert.equal(stored.version, 1, 'the frozen V1 app stores it as its own version-1 record');
  assert.deepEqual(stored.data, V1_STORE.data, 'every collection restored exactly');

  assert.equal(store.writeCount(), 0, 'listing and building wrote nothing');
  assert.deepEqual(store.peek(), V1_STORE, 'still the version-1 record');
  assert.deepEqual(store.peekArchives(), {});
});

test('C4 — archive source: after the first save the stored migration archive gives the same backup; the pending copy is gone', async () => {
  const store = createMemorySnapshotStore(V1_STORE);
  const { app, adapter } = await open(store);
  const fromPending = olderFormatBackup((await adapter.listFormatCopies())[0].original);
  app.createDay(TODAY, 'rest');
  await app.flushPersistence();
  const copies = await adapter.listFormatCopies();
  assert.deepEqual(copies.map((c) => [c.kind, c.key]), [['archive', KEY]], 'only the stored archive now');
  const [c] = copies;
  assert.deepEqual(c.problems, []);
  assert.equal(c.exactJson, true);
  assert.deepEqual(c.archive, store.peekArchives()[KEY], 'the archive exactly as stored');
  const fromArchive = olderFormatBackup(c.original);
  assert.deepEqual(fromArchive, fromPending, 'the same pre-upgrade data either way');
  assert.equal(app.validateBackup(fromArchive).valid, true);
  assert.deepEqual((await frozenV1Accepts(fromArchive)).data, V1_STORE.data);
  // A reopened tab (V2 record, no pending copy) still finds the archive.
  const reopened = await open(store);
  assert.deepEqual((await reopened.adapter.listFormatCopies()).map((x) => x.kind), ['archive']);
});

test('C4 — the older-format backup is never a conversion: it refuses data it can’t carry exactly', () => {
  assert.throws(() => olderFormatBackup({ data: { ...fresh(V1_STORE.data), userFoodData: { foods: [], retiredServingIds: [] } }, savedAt: 'x' }), (e) => e instanceof DomainError && e.code === 'BACKUP_INVALID', 'a version-2 collection is not dropped');
  assert.throws(() => olderFormatBackup({ data: (({ days, ...d }) => d)(fresh(V1_STORE.data)), savedAt: 'x' }), (e) => e.code === 'BACKUP_INVALID');
  const lossy = fresh(V1_STORE.data);
  lossy.preferences.appPreferences.note = undefined; // JSON would silently drop it
  assert.throws(() => olderFormatBackup({ data: lossy, savedAt: 'x' }), (e) => e.code === 'BACKUP_INVALID' && e.details.length > 0);
  assert.throws(() => olderFormatBackup(null), (e) => e.code === 'BACKUP_INVALID');
  const source = Object.freeze(fresh(V1_STORE));
  olderFormatBackup(source);
  assert.deepEqual(source, V1_STORE, 'the source is never changed');
});

test('C4 — downloads are read-only: no write, no first save, no lastBackupAt; the ordinary backup still records it', async () => {
  const store = createMemorySnapshotStore(V1_STORE);
  const { app, adapter } = await open(store);
  const { doc, files } = fakeDocument();
  const [c] = await adapter.listFormatCopies();
  const file = downloadOlderFormatBackup(doc, app, olderFormatBackup(c.original));
  assert.match(file.filename, /^macro-tracker-older-format-backup-2026-08-09\.json$/);
  assert.equal(files.length, 1);
  assert.deepEqual(JSON.parse(files[0].text), olderFormatBackup(c.original));
  await app.flushPersistence();
  assert.equal(store.writeCount(), 0, 'no write, so no upgrade either');
  assert.deepEqual(store.peek(), V1_STORE);
  assert.equal((app.getPreferences().appPreferences || {}).lastBackupAt, V1_STORE.data.preferences.appPreferences.lastBackupAt, 'lastBackupAt untouched');

  // With an archive stored: the raw archive download is read-only too.
  app.createDay(TODAY, 'rest');
  await app.flushPersistence();
  const writes = store.writeCount();
  const record = store.peek();
  const archives = store.peekArchives();
  const prefsBefore = JSON.stringify(app.getPreferences());
  const [a] = await adapter.listFormatCopies();
  downloadOlderFormatBackup(doc, app, olderFormatBackup(a.original));
  downloadRawArchive(doc, a);
  await app.flushPersistence();
  assert.equal(store.writeCount(), writes);
  assert.deepEqual(store.peek(), record);
  assert.deepEqual(store.peekArchives(), archives);
  assert.equal(JSON.stringify(app.getPreferences()), prefsBefore);

  downloadBackup(doc, app); // the ordinary current-format backup keeps its existing behaviour
  assert.ok(app.getPreferences().appPreferences.lastBackupAt, 'the ordinary backup records lastBackupAt');
});

test('C4 — an older-format backup that does not validate is not offered', async () => {
  const bad = fresh(V1_STORE);
  bad.data.savedMeals[0].ingredients[0].foodId = 'food_core_does_not_exist';
  // A V2 record whose stored archive holds pre-upgrade data the current app can't accept.
  const v2Record = { ...fresh(V1_STORE), version: 2, revision: 25, data: { ...fresh(V1_STORE.data), userFoodData: { foods: [], retiredServingIds: [] } } };
  const store = createMemorySnapshotStore(v2Record, { archives: { [KEY]: archiveFor(bad) } });
  const { app, adapter } = await open(store);
  const model = formatCopiesModel(app, { state: 'ready', copies: await adapter.listFormatCopies() });
  const [c] = model.copies;
  assert.equal(c.kind, 'archive');
  assert.deepEqual(c.problems, [], 'the archive itself is well-formed');
  assert.equal(c.older.valid, false);
  assert.equal(c.older.code, 'BACKUP_INVALID');
  const html = renderFormatCopiesBody(model);
  assert.ok(!/download-older-backup/.test(html), 'no older-format download offered');
  assert.match(text(html), /An older-format backup can’t be made from this copy\./);
  assert.match(html, /data-action="download-raw-archive"/, 'the raw archive is still offered');
  assert.equal(store.writeCount(), 0);
});

test('C4 — a pending copy with inspection problems is never offered, and says why', async () => {
  for (const [what, record] of [
    ['savedAt missing', (({ savedAt, ...r }) => r)(fresh(V1_STORE))],
    ['savedAt not text', { ...fresh(V1_STORE), savedAt: 20260809 }]
  ]) {
    const store = createMemorySnapshotStore(record);
    const { app, adapter } = await open(store); // the stored record still opens: savedAt isn't needed to use the data
    const [c] = await adapter.listFormatCopies();
    assert.equal(c.kind, 'pending', what);
    assert.deepEqual(c.problems, ['the original record has no savedAt'], what);
    assert.equal(c.original, null, `${what}: no source to build from`);
    const model = formatCopiesModel(app, { state: 'ready', copies: [c] });
    assert.equal(model.copies[0].older.valid, false, what);
    const html = renderFormatCopiesBody(model);
    assert.match(text(html), /Pre-upgrade copy: it isn’t in the expected form, so an older-format backup can’t be made from it\./, what);
    assert.match(html, /no savedAt/, `${what}: the problem is shown`);
    assert.ok(!/download-older-backup|download-raw-archive/.test(html), `${what}: nothing offered`);
    assert.equal(preUpgradeOffer(model).available, false, `${what}: not in the conflict dialog either`);
    // Even a copy that slipped through with an `original` is refused while it has problems.
    assert.equal(formatCopiesModel(app, { state: 'ready', copies: [{ ...c, original: record }] }).copies[0].older.valid, false);
    assert.equal(store.writeCount(), 0);
    assert.deepEqual(store.peek(), record, `${what}: the source record is unchanged`);
  }
  // Every problem the inspection API reports for an original record.
  const good = fresh(V1_STORE);
  assert.deepEqual(inspectOriginalRecord(good), [], 'a normal version-1 record has no problems');
  assert.deepEqual(inspectOriginalRecord('x'), ['the original record is not an object']);
  for (const [field, value, pattern] of [
    ['format', 'other', /format is "other"/],
    ['version', 2, /version 2, not version 1/],
    ['version', '1', /version "1", not version 1/],
    ['revision', 0, /revision 0 is not valid/],
    ['savedAt', null, /no savedAt/],
    ['data', [], /holds no data/]
  ]) {
    const problems = inspectOriginalRecord({ ...good, [field]: value });
    assert.equal(problems.length, 1, `${field}: ${JSON.stringify(problems)}`);
    assert.match(problems[0], pattern);
  }
});

test('C4 — Settings copies: an older load never replaces a newer one, and the first save triggers a fresh load', async () => {
  const gate = () => { let release; const p = new Promise((r) => { release = r; }); return { p, release }; };
  const app = { validateBackup: () => ({ valid: true, formatVersion: 1, summary: {} }) };
  const pending = { kind: 'pending', key: null, original: fresh(V1_STORE), problems: [], exactJson: true };
  const archive = { kind: 'archive', key: KEY, archive: archiveFor(fresh(V1_STORE)), original: fresh(V1_STORE), problems: [], exactJson: true };
  const answers = [];
  const seen = [];
  const loader = createCopiesLoader(app, () => { const g = gate(); answers.push(g); return g.p; }, (m) => seen.push(m.state === 'ready' ? m.copies.map((c) => c.kind).join(',') : m.state));

  // Two overlapping loads: the first answers last, with the stale pending list.
  const first = loader.load();
  const second = loader.load();
  await settle(); // both requests are now out
  answers[1].release([archive]);
  await second;
  answers[0].release([pending]);
  await first;
  assert.deepEqual(loader.current().copies.map((c) => c.kind), ['archive'], 'the older answer was ignored');

  // A pending copy is showing; the first save completes: a fresh load replaces it.
  const loader2 = createCopiesLoader(app, () => { const g = gate(); answers.push(g); return g.p; }, () => {});
  const initial = loader2.load();
  await settle();
  answers[2].release([pending]);
  await initial;
  assert.deepEqual(loader2.current().copies.map((c) => c.kind), ['pending']);
  loader2.onStatus({ state: 'saving' });
  await settle();
  assert.equal(answers.length, 3, 'nothing re-read while saving');
  loader2.onStatus({ state: 'saved' });
  await settle();
  assert.equal(answers.length, 4, 'the first save re-reads');
  assert.equal(loader2.current().state, 'loading', 'truthfully loading meanwhile');
  answers[3].release([archive]);
  await settle();
  assert.deepEqual(loader2.current().copies.map((c) => c.kind), ['archive']);
  loader2.onStatus({ state: 'saved' });
  await settle();
  assert.equal(answers.length, 4, 'later saves don’t re-read once no pending copy is shown');

  // A save that completes while a load is still in flight: that load's (stale) answer is dropped.
  const loader3 = createCopiesLoader(app, () => { const g = gate(); answers.push(g); return g.p; }, () => {});
  const inflight = loader3.load();
  loader3.onStatus({ state: 'saved' });
  await settle();
  answers[5].release([archive]);
  await settle();
  answers[4].release([pending]);
  await inflight;
  assert.deepEqual(loader3.current().copies.map((c) => c.kind), ['archive']);

  // A read failure is shown as an error, not as "none".
  const failing = createCopiesLoader(app, () => Promise.reject(new DomainError('STORAGE_UNAVAILABLE', 'disk gone')), () => {});
  await failing.load();
  assert.deepEqual(failing.current(), { state: 'error', code: 'STORAGE_UNAVAILABLE', errors: ['disk gone'] });
  // Stopped (Settings unmounted): no further updates.
  const stopped = createCopiesLoader(app, () => { const g = gate(); answers.push(g); return g.p; }, (m) => seen.push(`stopped:${m.state}`));
  const late = stopped.load();
  await settle();
  stopped.stop();
  answers[6].release([archive]);
  await late;
  assert.equal(stopped.current().state, 'loading');
  assert.deepEqual(seen.filter((x) => x.startsWith('stopped')), ['stopped:loading']);
});

test('C4 — -0 can’t be saved exactly as JSON: such an archive is not offered raw anywhere', async () => {
  assert.equal(isExactJson(-0), false);
  assert.equal(isExactJson(0), true);
  assert.equal(JSON.stringify(-0), '0', 'why: JSON writes -0 as 0');
  for (const lossy of [NaN, Infinity, undefined, () => 1, new Date(0), [1, , 3]]) assert.equal(isExactJson(lossy), false, String(lossy));
  const archive = archiveFor(fresh(V1_STORE));
  archive.original.data.targets.rest.fat = -0;
  const v2Record = { ...fresh(V1_STORE), version: 2, revision: 30, data: { ...fresh(V1_STORE.data), userFoodData: { foods: [], retiredServingIds: [] } } };
  const inner = createMemorySnapshotStore(v2Record);
  const store = { archives: true, read: () => inner.read(), write: (r, o) => inner.write(r, o), listArchives: async () => [KEY], readArchive: async () => archive };
  const { app, adapter } = await open(store);
  const [c] = await adapter.listFormatCopies();
  assert.equal(c.exactJson, false);
  assert.throws(() => rawArchiveFile(c), (e) => e.code === 'ARCHIVE_NOT_EXACT');
  const model = formatCopiesModel(app, { state: 'ready', copies: [c] });
  assert.match(text(renderFormatCopiesBody(model)), /can’t be saved exactly as a file/);
  assert.ok(!/download-raw-archive/.test(renderFormatCopiesBody(model)));
  assert.equal(storedArchiveOffer(model).available, false);
  assert.deepEqual(downloadRawArchives(fakeDocument().doc, [c]).results.map((r) => r.outcome), ['not-exact']);
  assert.equal(inner.writeCount(), 0);
});

/* ------------------------------------------------------------------ */
/* The raw migration archive                                           */
/* ------------------------------------------------------------------ */

test('C4 — the raw migration archive downloads exactly as stored, wrapper included, under a name that says what it is', async () => {
  const store = createMemorySnapshotStore(V1_STORE);
  const { app, adapter } = await open(store);
  app.createDay(TODAY, 'rest');
  await app.flushPersistence();
  const [c] = await adapter.listFormatCopies();
  const stored = store.peekArchives()[KEY];
  const file = rawArchiveFile(c, new Date(2026, 9, 9));
  assert.equal(file.filename, 'macro-tracker-raw-migration-archive-format-1-r24-2026-10-09.json');
  assert.equal(file.text, JSON.stringify(stored, null, 2), 'the stored object, serialised as it is');
  const parsed = JSON.parse(file.text);
  assert.deepEqual(parsed, stored);
  assert.deepEqual(Object.keys(parsed), ['format', 'archiveVersion', 'archivedAt', 'reason', 'replacedByRevision', 'original']);
  assert.deepEqual(parsed.original, V1_STORE, 'the original record, untouched');
  const { doc, files } = fakeDocument();
  assert.deepEqual(downloadRawArchives(doc, await adapter.listFormatCopies()), { found: 1, results: [{ key: KEY, outcome: 'downloaded' }] });
  assert.equal(files[0].text, file.text);
  // A pending copy is not a stored archive: there is no raw archive to download yet.
  const pending = await (await open(createMemorySnapshotStore(V1_STORE))).adapter.listFormatCopies();
  assert.throws(() => rawArchiveFile(pending[0]), (e) => e.code === 'NOT_AN_ARCHIVE');
  assert.ok(!/download-raw-archive/.test(renderFormatCopiesBody(formatCopiesModel(app, { state: 'ready', copies: pending }))));
});

test('C4 — states: no copy, a malformed archive, an archive JSON can’t carry, and a storage read failure', async () => {
  // None: first run, and a V2 record with no archive.
  for (const initial of [null, { ...fresh(V1_STORE), version: 2, data: { ...fresh(V1_STORE.data), userFoodData: { foods: [], retiredServingIds: [] } } }]) {
    const { app, adapter } = await open(createMemorySnapshotStore(initial));
    const model = formatCopiesModel(app, { state: 'ready', copies: await adapter.listFormatCopies() });
    assert.deepEqual(model.copies, []);
    assert.match(text(renderFormatCopiesBody(model)), /No earlier-format copy on this device\./);
  }
  // Malformed: wrong format, an original that isn't version 1, a key that doesn't match.
  const v2Record = { ...fresh(V1_STORE), version: 2, revision: 30, data: { ...fresh(V1_STORE.data), userFoodData: { foods: [], retiredServingIds: [] } } };
  for (const [what, archive] of [
    ['wrong format', { ...archiveFor(fresh(V1_STORE)), format: 'something-else' }],
    ['original not version 1', archiveFor({ ...fresh(V1_STORE), version: 2 })],
    ['key and original disagree', archiveFor({ ...fresh(V1_STORE), revision: 23 })],
    ['not an object', 'archive']
  ]) {
    const store = createMemorySnapshotStore(v2Record, { archives: { [KEY]: archive } });
    const { app, adapter } = await open(store);
    const [c] = await adapter.listFormatCopies();
    assert.equal(c.kind, 'archive', what);
    assert.ok(c.problems.length > 0, `${what}: problems reported`);
    assert.equal(c.original, null, what);
    assert.deepEqual(inspectStoreArchive(archive, KEY), c.problems);
    const html = renderFormatCopiesBody(formatCopiesModel(app, { state: 'ready', copies: [c] }));
    assert.match(text(html), /isn’t in the expected form/, what);
    assert.ok(!/download-older-backup/.test(html), `${what}: no older-format backup`);
    assert.match(html, /data-action="download-raw-archive"/, `${what}: still downloadable raw`);
    assert.equal(rawArchiveFile(c).text, JSON.stringify(archive, null, 2), `${what}: exactly as stored, not repaired`);
    assert.equal(store.writeCount(), 0);
  }
  // An archive JSON can't carry exactly (here a Date, as IndexedDB could hold): not offered raw.
  const exotic = { ...archiveFor(fresh(V1_STORE)), archivedAt: new Date(0) };
  assert.equal(isExactJson(exotic), false);
  const inner = createMemorySnapshotStore(v2Record);
  const oddStore = { archives: true, read: () => inner.read(), write: (r, o) => inner.write(r, o), listArchives: async () => [KEY], readArchive: async () => exotic };
  const odd = await open(oddStore);
  const [x] = await odd.adapter.listFormatCopies();
  assert.equal(x.exactJson, false);
  assert.throws(() => rawArchiveFile(x), (e) => e.code === 'ARCHIVE_NOT_EXACT');
  assert.match(text(renderFormatCopiesBody(formatCopiesModel(odd.app, { state: 'ready', copies: [x] }))), /can’t be saved exactly as a file/);
  // A read failure: rejected as STORAGE_UNAVAILABLE, shown as an error, nothing written.
  const failing = { archives: true, read: () => inner.read(), write: (r, o) => inner.write(r, o), listArchives: async () => { throw new Error('disk gone'); }, readArchive: async () => null };
  const f = await open(failing);
  const error = await f.adapter.listFormatCopies().then(() => null, (e) => e);
  assert.equal(error && error.code, 'STORAGE_UNAVAILABLE');
  await assert.rejects(f.adapter.readArchive('user-data'), (e) => e.code === 'INVALID_ARGUMENT', 'only archive keys can be read');
  const shown = text(renderFormatCopiesBody({ state: 'error', code: error.code, errors: [error.message] }));
  assert.match(shown, /Earlier-format copies couldn’t be read\. Nothing was changed\./);
  assert.match(text(renderFormatCopiesBody({ state: 'loading' })), /Checking for an earlier-format copy/);
  assert.equal(inner.writeCount(), 0);
});

test('C4 — Settings shows the copies inside "Data on this device", never as a section of its own', async () => {
  const store = createMemorySnapshotStore(V1_STORE);
  const { app, adapter } = await open(store);
  const model = formatCopiesModel(app, { state: 'ready', copies: await adapter.listFormatCopies() });
  const html = renderSettings({ targets: app.getAllCurrentTargets(), status: app.getPersistenceStatus(), lastBackupAt: null, restore: null, foods: settingsFoodsModel(app), formatCopies: model });
  const data = html.slice(html.indexOf('id="data-title"'), html.indexOf('id="about-title"'));
  assert.match(data, /Earlier-format copies/);
  assert.match(text(data), /Pre-upgrade copy: .+ It hasn’t been stored as a migration archive yet\./);
  assert.match(data, /data-action="download-older-backup" data-copy="0">Download older-format backup/);
  assert.ok(!/download-raw-archive/.test(data), 'no raw archive claimed before one exists');
  assert.equal((html.match(/class="settings-section"/g) || []).length, 6, 'still six sections');
  assert.ok(!/Earlier-format copies/.test(renderSettings({ targets: app.getAllCurrentTargets(), status: app.getPersistenceStatus(), lastBackupAt: null, restore: null, foods: settingsFoodsModel(app) })), 'nothing when the copies service is absent');
});

/* ------------------------------------------------------------------ */
/* A raw archive is never a backup                                     */
/* ------------------------------------------------------------------ */

test('C4 — a raw migration archive fails backup validation everywhere, is named as such, and never restores', async () => {
  const store = createMemorySnapshotStore(V1_STORE);
  const { app } = await open(store);
  app.createDay(TODAY, 'rest');
  await app.flushPersistence();
  const raw = JSON.stringify(store.peekArchives()[KEY], null, 2);
  const writes = store.writeCount();
  const before = store.peek();
  const check = app.validateBackup(raw);
  assert.equal(check.valid, false);
  assert.equal(check.code, 'BACKUP_INCOMPATIBLE');
  assert.throws(() => app.restoreUserData(raw), (e) => e.code === 'BACKUP_INCOMPATIBLE');
  assert.equal(validateRecoveryBackup(raw).code, 'BACKUP_INCOMPATIBLE');
  await app.flushPersistence();
  assert.equal(store.writeCount(), writes, 'no restore write');
  assert.deepEqual(store.peek(), before);
  const recovering = createMemorySnapshotStore({ format: 'another-app', version: 3, data: {} });
  await assert.rejects(recoverStoredData({ snapshotStore: recovering, backup: raw }), (e) => e.code === 'BACKUP_INCOMPATIBLE');
  assert.equal(recovering.writeCount(), 0);
  // The message names it; other incompatible files keep the general message.
  assert.equal(isRawMigrationArchiveText(raw), true);
  assert.equal(restoreFileErrorMessage('BACKUP_INCOMPATIBLE', raw), RAW_ARCHIVE_RESTORE_MESSAGE);
  assert.match(RAW_ARCHIVE_RESTORE_MESSAGE, /raw migration archive, not a backup/);
  assert.equal(restoreFileErrorMessage('BACKUP_INCOMPATIBLE', JSON.stringify({ format: 'other-app' })), restoreErrorMessage('BACKUP_INCOMPATIBLE'));
  assert.equal(restoreFileErrorMessage('BACKUP_UNREADABLE', '{bad'), restoreErrorMessage('BACKUP_UNREADABLE'));
  // No code path hands an archive to restore: restore only ever takes the chosen file's text.
  for (const f of ['app/settings.js', 'app/shell.js', 'app/main.js', 'app/download.js']) {
    const src = fs.readFileSync(path.join(ROOT, f), 'utf8');
    for (const m of src.matchAll(/restoreUserData\(([^)]*)\)/g)) assert.equal(m[1], 'text', `${f}: restoreUserData(${m[1]})`);
    assert.ok(!/archive[^\n]*restoreUserData|restoreUserData[^\n]*archive/i.test(src), f);
  }
});

/* ------------------------------------------------------------------ */
/* The archive conflict                                                */
/* ------------------------------------------------------------------ */

const ARCHIVE_CONFLICT = { state: 'conflict', code: 'STORAGE_ARCHIVE_CONFLICT', error: 'x' };
const REVISION_CONFLICT = { state: 'conflict', error: 'x' };

test('C4 — only an archive conflict gets the "saving is paused" dialog; ordinary conflicts are unchanged', () => {
  const archive = conflictDialogView('', ARCHIVE_CONFLICT);
  assert.match(text(archive), /Saving is paused to protect your earlier data\. The original pre-upgrade copy differs from the copy now stored on this device\. Nothing has been overwritten, and your changes in this tab are not being saved\./);
  assert.match(text(archive), /Downloading them doesn’t resolve the conflict, and reloading will not resolve it either\./);
  assert.match(archive, /data-shell-action="download-conflict">Download the tab’s current data<\/button>/);
  assert.match(archive, /data-shell-action="download-preupgrade" disabled[^>]*>Download the pre-upgrade copy \(older-format backup\)<\/button>/, 'disabled until the copies are checked');
  assert.match(archive, /data-shell-action="download-archive" disabled[^>]*>Download the stored migration archive<\/button>/);
  assert.match(text(archive), /Checking for the pre-upgrade copy/);
  assert.ok(!/data-shell-action="reload"/.test(archive), 'Reload is not offered as the fix');
  assert.ok(!/stored migration archive[^<]*\(older-format backup\)|Download the stored migration archive[^<]*backup/.test(archive), 'the raw archive is never called a backup');
  assert.equal(persistenceView(ARCHIVE_CONFLICT).text, 'Saving paused');
  assert.equal(saveStatusText(ARCHIVE_CONFLICT), 'Saving is paused to protect your earlier data. Reloading won’t resolve this.');

  for (const ordinary of [REVISION_CONFLICT, null]) {
    const html = conflictDialogView('', ordinary);
    assert.equal(html, conflictDialogView(), 'the existing dialog, unchanged');
    assert.match(html, /data-shell-action="download-conflict">Download this tab’s data<\/button><button type="button" class="button primary" data-shell-action="reload">Reload/);
    assert.ok(!/download-archive|download-preupgrade|Saving is paused/.test(html));
  }
  assert.equal(persistenceView(REVISION_CONFLICT).text, 'Changed elsewhere');
  assert.equal(saveStatusText(REVISION_CONFLICT), 'Changed in another tab or window. Reload to continue.');
});

/** The shell with fakes (as conflict-dialog.test.mjs), plus click delivery and services. */
function shellHarness(services) {
  const listeners = [];
  const dialog = { open: false, innerHTML: '', matches: (s) => s === '[data-conflict]', showModal() { this.open = true; }, close() { this.open = false; } };
  const root = { innerHTML: '', querySelector: (s) => (s === '[data-conflict]' ? dialog : null), contains: () => true, addEventListener(type, fn) { listeners.push({ type, fn }); } };
  const doc = { title: '', visibilityState: 'visible', addEventListener() {} };
  const win = { location: { hash: '#/today', href: 'http://app/#/today' }, history: { replaceState() {}, pushState() {} }, addEventListener() {}, setTimeout: () => 0, clearTimeout() {} };
  const shell = createShell({ root, win, doc, services });
  shell.start();
  return { shell, dialog, click: (action) => { const el = { dataset: { shellAction: action } }; for (const l of listeners) if (l.type === 'click') l.fn({ target: { closest: () => el } }); } };
}
const settle = async () => { for (let i = 0; i < 5; i += 1) await new Promise((r) => setImmediate(r)); };

/** A real data layer in an archive conflict (memory store), and services wired as main.js wires them. */
async function archiveConflictSetup({ archive, doc } = {}) {
  const other = fresh(V1_STORE);
  other.data.targets.rest.carbs += 1;
  const store = createMemorySnapshotStore(V1_STORE, { archives: { [KEY]: archive || archiveFor(other) } });
  const { app, adapter } = await open(store);
  app.createDay(TODAY, 'rest');
  assert.equal((await app.flushPersistence()).code, 'STORAGE_ARCHIVE_CONFLICT');
  const d = doc || fakeDocument();
  const services = {
    earlierCopies: async (a) => formatCopiesModel(a, { state: 'ready', copies: await adapter.listFormatCopies() }),
    downloadBackup: (a) => downloadBackup(d.doc, a),
    downloadOlderFormatBackup: (a, backup) => downloadOlderFormatBackup(d.doc, a, backup),
    downloadRawArchives: (copies) => downloadRawArchives(d.doc, copies)
  };
  return { store, app, adapter, services, files: d.files, record: store.peek(), archives: store.peekArchives() };
}

test('C4 — archive conflict: three separate downloads, each with its own result; nothing written, nothing retried', async () => {
  const s = await archiveConflictSetup();
  const h = shellHarness(s.services);
  h.shell.setDataLayer(s.app);
  assert.equal(h.dialog.open, true);
  await settle();
  assert.match(h.dialog.innerHTML, /data-shell-action="download-preupgrade" aria-describedby/, 'the pre-upgrade copy is offered (enabled)');
  assert.match(h.dialog.innerHTML, /data-shell-action="download-archive" aria-describedby/, 'the stored archive is offered (enabled)');

  h.click('download-conflict');
  assert.match(h.dialog.innerHTML, /This tab’s current data was downloaded\. Saving is still paused\./);
  h.click('download-preupgrade');
  assert.match(h.dialog.innerHTML, /Pre-upgrade copy \(older-format backup\) downloaded\. Saving is still paused\./);
  h.click('download-archive');
  assert.match(h.dialog.innerHTML, /Stored migration archive downloaded\. Saving is still paused\./);
  assert.match(h.dialog.innerHTML, /This tab’s current data was downloaded/, 'each action keeps its own result');

  const [current, preUpgrade, raw] = s.files.map((f) => JSON.parse(f.text));
  assert.equal(current.formatVersion, 2, 'the tab’s current data');
  assert.ok(current.data.days.some((d) => d.date === TODAY), 'including the change that wasn’t saved');
  assert.equal(preUpgrade.formatVersion, 1, 'the pre-upgrade copy is the older-format backup');
  assert.deepEqual(preUpgrade.data, V1_STORE.data, 'built from this tab’s pre-upgrade original, not the differing archive');
  assert.deepEqual(raw, s.archives[KEY], 'the stored migration archive, exactly as stored');
  assert.match(s.files[2].name, /raw-migration-archive/);

  await s.app.flushPersistence();
  await s.adapter.retry();
  assert.equal(s.store.writeCount(), 0, 'no write and no retry');
  assert.deepEqual(s.store.peek(), s.record);
  assert.deepEqual(s.store.peekArchives(), s.archives);
  assert.equal(h.dialog.open, true, 'the conflict stands');
});

test('C4 — archive conflict: unavailable sources are explained and the other downloads stay usable', async () => {
  // No valid pre-upgrade copy (here: the pending copy has an inspection problem).
  const pendingBad = { state: 'ready', copies: [{ kind: 'pending', key: null, original: null, problems: ['the original record has no savedAt'], older: { valid: false, code: null, errors: ['the original record has no savedAt'] } }] };
  const pre = preUpgradeOffer(pendingBad);
  assert.equal(pre.available, false);
  assert.match(pre.hint, /An older-format backup can’t be made from the pre-upgrade copy\./);
  assert.match(pre.details, /no savedAt/);
  assert.equal(storedArchiveOffer(pendingBad).available, false);
  assert.match(storedArchiveOffer(pendingBad).hint, /No stored migration archive on this device\./);
  const html = archiveConflictView({ copies: pendingBad });
  assert.match(html, /data-shell-action="download-preupgrade" disabled/);
  assert.match(html, /data-shell-action="download-archive" disabled/);
  assert.match(html, /data-shell-action="download-conflict">/, 'the current data is always offered');
  // The differing archive is never offered as "the pre-upgrade copy" in place of this tab's.
  const withArchive = { state: 'ready', copies: [pendingBad.copies[0], { kind: 'archive', key: KEY, original: {}, problems: [], exactJson: true, older: { valid: true, backup: {} } }] };
  assert.equal(preUpgradeOffer(withArchive).available, false);
  assert.equal(storedArchiveOffer(withArchive).available, true);
  // An archive JSON can't carry exactly.
  const notExact = { state: 'ready', copies: [{ kind: 'archive', key: KEY, original: null, problems: [], exactJson: false, older: { valid: false } }] };
  assert.match(storedArchiveOffer(notExact).hint, /can’t be saved exactly as a file/);
  // A read failure.
  const readError = { state: 'error', code: 'STORAGE_UNAVAILABLE', errors: ['disk gone'] };
  assert.match(preUpgradeOffer(readError).hint, /couldn’t be read/);
  assert.match(storedArchiveOffer(readError).hint, /couldn’t be read/);

  // Through the shell: a read failure is reported as a read failure, and the current data still downloads.
  const s = await archiveConflictSetup();
  const h = shellHarness({ ...s.services, earlierCopies: async () => { throw new DomainError('STORAGE_UNAVAILABLE', 'disk gone'); } });
  h.shell.setDataLayer(s.app);
  await settle();
  h.click('download-archive');
  assert.match(h.dialog.innerHTML, /The stored migration archive couldn’t be read, so nothing was downloaded\./);
  h.click('download-preupgrade');
  assert.match(h.dialog.innerHTML, /The earlier copies couldn’t be read, so the pre-upgrade copy can’t be offered\./);
  h.click('download-conflict');
  assert.match(h.dialog.innerHTML, /This tab’s current data was downloaded\./);
  assert.equal(s.store.writeCount(), 0);
});

test('C4 — archive conflict: a refused download is reported as a download problem, never as a read failure', async () => {
  const refusing = fakeDocument();
  refusing.doc.defaultView.URL.createObjectURL = () => { throw new Error('blocked'); };
  const s = await archiveConflictSetup({ doc: refusing });
  const h = shellHarness(s.services);
  h.shell.setDataLayer(s.app);
  await settle();
  h.click('download-archive');
  assert.match(h.dialog.innerHTML, /The stored migration archive couldn’t be downloaded: the browser didn’t start the download\./);
  assert.ok(!/couldn’t be read/.test(h.dialog.innerHTML));
  h.click('download-preupgrade');
  assert.match(h.dialog.innerHTML, /The pre-upgrade copy couldn’t be downloaded\. Nothing was changed\./);
  h.click('download-conflict');
  assert.match(h.dialog.innerHTML, /This tab’s current data couldn’t be downloaded\. Nothing was changed\./);
  assert.equal(refusing.files.length, 0);
  assert.equal(s.store.writeCount(), 0);
  assert.deepEqual(s.store.peekArchives(), s.archives);
});

test('C4 — several archives: each gets its own outcome, and a partial result is reported as partial', () => {
  const ok = { kind: 'archive', key: 'user-data:format-1@r3', archive: { a: 1 }, exactJson: true };
  const second = { kind: 'archive', key: 'user-data:format-1@r7', archive: { b: 2 }, exactJson: true };
  const lossy = { kind: 'archive', key: 'user-data:format-1@r9', archive: { c: -0 }, exactJson: false };
  // The browser refuses the second download only.
  const d = fakeDocument();
  let calls = 0;
  d.doc.defaultView.URL.createObjectURL = () => { calls += 1; if (calls === 2) throw new Error('blocked'); return 'blob:x'; };
  const result = downloadRawArchives(d.doc, [ok, second, lossy, { kind: 'pending' }]);
  assert.deepEqual(result.results.map((r) => [r.key, r.outcome]), [[ok.key, 'downloaded'], [second.key, 'refused'], [lossy.key, 'not-exact']]);
  assert.equal(result.found, 3);
  assert.equal(d.files.length, 1);
  assert.equal(archiveDownloadMessage(result), 'Stored migration archives: 1 of 3 downloaded; 1 couldn’t be downloaded (the browser didn’t start the download); 1 can’t be saved exactly as a file, so it wasn’t offered. Nothing was changed.');
  assert.equal(archiveDownloadMessage({ found: 2, results: [{ outcome: 'downloaded' }, { outcome: 'downloaded' }] }), 'All 2 stored migration archives downloaded. Saving is still paused.');
  assert.equal(archiveDownloadMessage({ found: 0, results: [] }), 'There’s no stored migration archive on this device. Nothing was changed.');
  assert.match(archiveDownloadMessage({ found: 1, results: [{ outcome: 'not-exact' }] }), /can’t be saved exactly as a file, so it wasn’t downloaded/);
});

test('C4 — an ordinary revision conflict still shows the existing dialog and never reads the earlier copies', async () => {
  let reads = 0;
  const h = shellHarness({ earlierCopies: async () => { reads += 1; return { state: 'ready', copies: [] }; }, downloadBackup: () => {} });
  let listener = null;
  h.shell.setDataLayer({ getPersistenceStatus: () => ({ state: 'saved', lastSavedAt: 'x' }), onPersistenceChange: (fn) => { listener = fn; return () => {}; }, flushPersistence: () => Promise.resolve() });
  listener(REVISION_CONFLICT);
  await settle();
  assert.equal(h.dialog.innerHTML, conflictDialogView());
  h.click('download-conflict');
  assert.match(h.dialog.innerHTML, /Backup downloaded\./);
  assert.match(h.dialog.innerHTML, /data-shell-action="reload"/);
  assert.equal(reads, 0);
});

/* ------------------------------------------------------------------ */
/* Restore over an un-archived version-1 record                        */
/* ------------------------------------------------------------------ */

const otherV1Backup = () => { const b = fresh(V1_BACKUP); b.data.targets.rest.carbs = 160; return b; };

test('C4 — restoring a V1 backup over an un-archived V1 record writes the V2 record and the stored original together', async () => {
  const store = createMemorySnapshotStore(V1_STORE);
  const { app } = await open(store);
  app.restoreUserData(JSON.stringify(otherV1Backup()));
  assert.equal((await app.flushPersistence()).state, 'saved');
  assert.equal(store.writeCount(), 1, 'one write');
  const record = store.peek();
  assert.equal(record.version, 2);
  assert.deepEqual(record.data, upgradeUserData(otherV1Backup().data, 1), 'the restored backup, upgraded');
  assert.deepEqual(store.peekArchives()[KEY].original, V1_STORE, 'the archive keeps what was stored, not the backup');

  // The same through fake IndexedDB: one transaction holds both.
  const factory = new IDBFactory();
  await createV1IdbStore({ dbName: 'c4-test', indexedDB: factory }).write(V1_STORE, { expectedRevision: 0 });
  const idb = createIndexedDbSnapshotStore({ dbName: 'c4-test', indexedDB: factory });
  const opened = await openBrowserDataLayer({ snapshotStore: idb, today: () => TODAY, now });
  opened.app.restoreUserData(JSON.stringify(otherV1Backup()));
  assert.equal((await opened.app.flushPersistence()).state, 'saved');
  assert.equal((await idb.read()).version, 2);
  assert.deepEqual((await idb.readArchive(KEY)).original, V1_STORE);
});

test('C4 — a failed validation or a failed transaction during that restore leaves the record and the archives unchanged', async () => {
  // Validation failure: nothing reaches storage.
  const store = createMemorySnapshotStore(V1_STORE);
  const { app, adapter } = await open(store);
  const broken = otherV1Backup();
  broken.data.days[0].dayType = 'long';
  assert.throws(() => app.restoreUserData(JSON.stringify(broken)), (e) => e.code === 'BACKUP_INVALID');
  await app.flushPersistence();
  assert.equal(store.writeCount(), 0);
  assert.deepEqual(store.peek(), V1_STORE);
  assert.deepEqual(store.peekArchives(), {});

  // Write failure: the record stays version 1, no archive; a retry then writes both together.
  store.failNextWrites(1);
  app.restoreUserData(JSON.stringify(otherV1Backup()));
  assert.equal((await app.flushPersistence()).state, 'error');
  assert.deepEqual(store.peek(), V1_STORE);
  assert.deepEqual(store.peekArchives(), {});
  assert.equal((await adapter.retry()).state, 'saved');
  assert.equal(store.peek().version, 2);
  assert.deepEqual(store.peekArchives()[KEY].original, V1_STORE);

  // A different archive already stored: the transaction aborts; both stay exactly as they were.
  const factory = new IDBFactory();
  await createV1IdbStore({ dbName: 'c4-test', indexedDB: factory }).write(V1_STORE, { expectedRevision: 0 });
  const other = fresh(V1_STORE);
  other.data.targets.lift.carbs += 1;
  const idb = createIndexedDbSnapshotStore({ dbName: 'c4-test', indexedDB: factory });
  const seeded = await openBrowserDataLayer({ snapshotStore: createIndexedDbSnapshotStore({ dbName: 'c4-test', indexedDB: factory }), today: () => TODAY, now });
  // Put the different archive in place first, through a raw IndexedDB transaction.
  await new Promise((resolve, reject) => {
    const req = factory.open('c4-test', 1);
    req.onsuccess = () => {
      const tx = req.result.transaction('snapshots', 'readwrite');
      tx.objectStore('snapshots').put(archiveFor(other), KEY);
      tx.oncomplete = () => { req.result.close(); resolve(); };
      tx.onerror = () => reject(tx.error);
    };
    req.onerror = () => reject(req.error);
  });
  const recordBefore = await idb.read();
  const archiveBefore = await idb.readArchive(KEY);
  seeded.app.restoreUserData(JSON.stringify(otherV1Backup()));
  const status = await seeded.app.flushPersistence();
  assert.equal(status.code, 'STORAGE_ARCHIVE_CONFLICT');
  assert.deepEqual(await idb.read(), recordBefore, 'still the version-1 record');
  assert.deepEqual(await idb.readArchive(KEY), archiveBefore, 'the existing archive, untouched');
  assert.deepEqual(await idb.listArchives(), [KEY]);
});
