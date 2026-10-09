/*
 * browser-adapter.js — browser persistence for the V2 data layer.
 *
 *   import { createBrowserAdapter } from './browser/browser-adapter.js';
 *   import { createIndexedDbSnapshotStore } from './browser/indexeddb-snapshot-store.js';
 *   import { createDataLayer } from './domain/index.js';
 *
 *   const adapter = await createBrowserAdapter({ appData, snapshotStore: createIndexedDbSnapshotStore() });
 *   const app = createDataLayer({ adapter });      // same synchronous API as with the file adapter
 *
 * How it keeps the domain synchronous: everything is read BEFORE the app starts (the
 * factory is async); after that load() returns the preloaded data, and every commit
 * updates the in-memory copy at once and queues a durable write in the background.
 *
 * What is stored: only the user-owned collections (targets, customFoods, savedMeals, days —
 * with their Meal Instances — preferences and userFoodData), as ONE snapshot record. Core
 * Foods, Library Meals and the schemas are app data passed in as `appData` and are never stored.
 *
 * Format versions: a record's `version` names the user-data format of its `data`, through the
 * explicit map STORE_RECORD_USER_DATA_VERSION (src/domain/upgrade.js owns the formats). New
 * records are always the current version. An older record (version 1: five collections) is
 * upgraded IN MEMORY when it is read; opening the app never writes. The first save after an
 * upgrade is one storage transaction that writes the new record AND keeps the old record,
 * exactly as it was read, as an archive under its own key (storeArchiveKey). If a different
 * archive already sits under that key the save is refused (STORAGE_ARCHIVE_CONFLICT, a
 * blocking 'conflict' status) and nothing is written. Archives are never read back as user
 * data, never overwritten and never deleted here.
 *
 * Atomicity: a commit that touches several collections is written as one record in one
 * storage transaction, so storage never holds a half-applied mutation.
 *
 * Stale writers: every record carries a revision. A write states the revision it was
 * based on; if storage holds a different one (another tab or device wrote since), the
 * write is refused and the status becomes 'conflict' — nothing is overwritten.
 *
 * Visibility: status() / subscribe() report 'saved' | 'saving' | 'error' | 'conflict' with
 * the last successful save time, so a failing save can never be silent.
 *
 * The snapshot store is pluggable ({ read, write }); see indexeddb-snapshot-store.js and
 * memory-snapshot-store.js. Nothing here reads or writes the retired pages' storage.
 */

import { DomainError, USER_DATA_FORMAT_VERSION, USER_DATA_COLLECTIONS, upgradeUserData } from '../domain/index.js';

/** The format name stays "v2": it names the app generation, not the format version. */
export const STORE_RECORD_FORMAT = 'macro-tracker-v2-store';
export const STORE_RECORD_VERSION = USER_DATA_FORMAT_VERSION;
/** Stored record `version` → the user-data format version of its `data`. Explicit, never inferred. */
export const STORE_RECORD_USER_DATA_VERSION = Object.freeze({ 1: 1, 2: 2 });
export const USER_COLLECTION_NAMES = USER_DATA_COLLECTIONS[USER_DATA_FORMAT_VERSION];

/** The old-format copy kept by the first save after an upgrade. */
export const STORE_ARCHIVE_FORMAT = 'macro-tracker-store-archive';
export const STORE_ARCHIVE_VERSION = 1;
export const STORE_ARCHIVE_KEY_PREFIX = 'user-data:format-';
/** e.g. "user-data:format-1@r24": the version-1 record at revision 24. */
export const storeArchiveKey = (recordVersion, revision) => `${STORE_ARCHIVE_KEY_PREFIX}${recordVersion}@r${revision}`;
export const isStoreArchiveKey = (key) => typeof key === 'string' && /^user-data:format-[1-9][0-9]*@r[1-9][0-9]*$/.test(key);

const copy = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));

/** JSON with object keys sorted, so two equal values always compare equal as text. */
function canonical(v) {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (v && typeof v === 'object') return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`;
  return JSON.stringify(v);
}

/**
 * Is `existing` (already stored under an archive key) the same copy as `candidate`? Every
 * field must match — format, archiveVersion, reason, replacedByRevision and the original
 * record, and no field may be missing or extra — except archivedAt (when it was written),
 * which alone is ignored. Anything else is a different archive, which blocks the save.
 * Used by both snapshot stores inside their write.
 */
export function sameStoreArchive(existing, candidate) {
  const plain = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
  if (!plain(existing) || !plain(candidate)) return false;
  const { archivedAt: _a, ...a } = existing;
  const { archivedAt: _b, ...b } = candidate;
  return canonical(a) === canonical(b);
}

const ARCHIVE_CONFLICT_MESSAGE = 'A saved copy of your older data does not match the data being upgraded, so nothing was saved and nothing was overwritten. Download a backup and stop using the app until this is resolved.';

/**
 * createBrowserAdapter({ appData, snapshotStore, now? }) -> Promise<adapter>
 *   appData: { schemas, coreFoods, libraryMeals, seed: { targets, customFoods, savedMeals, days, preferences } }
 *            (seed = the first-run contents, i.e. data/targets.json and user-data/*.json)
 *   snapshotStore: { read(): Promise<record|null>, write(record, { expectedRevision }): Promise<void> }
 */
export async function createBrowserAdapter({ appData, snapshotStore, now = () => new Date().toISOString() } = {}) {
  if (!appData || !appData.schemas || !appData.coreFoods || !appData.libraryMeals || !appData.seed) {
    throw new Error('createBrowserAdapter: appData { schemas, coreFoods, libraryMeals, seed } is required');
  }
  if (!snapshotStore || typeof snapshotStore.read !== 'function' || typeof snapshotStore.write !== 'function') {
    throw new Error('createBrowserAdapter: snapshotStore { read, write } is required');
  }

  let stored;
  try {
    stored = await snapshotStore.read();
  } catch (e) {
    throw e instanceof DomainError ? e : new DomainError('STORAGE_UNAVAILABLE', `browser storage could not be read: ${e && e.message}`);
  }
  let revision = 0;
  let user;
  let pendingArchive = null; // { original } while an upgraded older record has not been saved yet
  const unrecognized = (why) => {
    const e = new DomainError('STORED_DATA_UNRECOGNIZED', `stored data is not a ${STORE_RECORD_FORMAT} record this app can read (${why}); refusing to start rather than overwrite it`);
    e.readStoredRecord = () => snapshotStore.read();
    return e;
  };
  if (stored === null || stored === undefined) {
    user = {};
    for (const c of USER_COLLECTION_NAMES) {
      if (appData.seed[c] === undefined) throw new Error(`createBrowserAdapter: appData.seed.${c} is missing`);
      user[c] = copy(appData.seed[c]);
    }
  } else {
    // The wrapper first: format, an explicitly mapped version, a revision, and data.
    if (typeof stored !== 'object' || Array.isArray(stored) || stored.format !== STORE_RECORD_FORMAT) throw unrecognized(`format is ${JSON.stringify(stored && stored.format)}`);
    if (!Number.isInteger(stored.version) || STORE_RECORD_USER_DATA_VERSION[stored.version] === undefined) {
      throw unrecognized(`version ${JSON.stringify(stored.version)}; this app reads versions 1 to ${STORE_RECORD_VERSION}`);
    }
    // Every record the V1 app (936753b) or this app writes has a whole-number revision of 1 or
    // more: the first write is 1, each later write adds 1, and a replacement is the stored
    // revision + 1 (or 1). Anything else did not come from either app, so it is refused before
    // it could be used as an archive key or a revision check (tests/format-v2.test.mjs).
    if (!Number.isInteger(stored.revision) || stored.revision < 1) throw unrecognized(`revision ${JSON.stringify(stored.revision)} is not valid`);
    if (!stored.data || typeof stored.data !== 'object' || Array.isArray(stored.data)) throw unrecognized('it holds no data');
    // Then the data, upgraded in memory to the current format. Nothing is written here.
    try {
      user = upgradeUserData(stored.data, STORE_RECORD_USER_DATA_VERSION[stored.version]);
    } catch (e) {
      if (e instanceof DomainError && e.code === 'USER_DATA_INVALID') {
        const invalid = new DomainError('DATA_INVALID', `stored data (format version ${stored.version}) failed validation: ${e.message}`, e.details);
        invalid.readStoredRecord = () => snapshotStore.read();
        throw invalid;
      }
      if (e instanceof DomainError && e.code === 'USER_DATA_VERSION_UNSUPPORTED') throw unrecognized(e.message);
      throw e;
    }
    revision = stored.revision;
    if (stored.version !== STORE_RECORD_VERSION) pendingArchive = { original: copy(stored) };
  }

  let status = { state: 'saved', lastSavedAt: stored ? stored.savedAt : null, revision, error: null };
  const listeners = new Set();
  const setStatus = (patch) => {
    status = { ...status, ...patch };
    for (const l of listeners) { try { l({ ...status }); } catch { /* a listener must not break saving */ } }
  };

  let dirty = false;
  let writing = null;

  async function writeLoop() {
    while (dirty && status.state !== 'conflict') {
      dirty = false;
      const record = { format: STORE_RECORD_FORMAT, version: STORE_RECORD_VERSION, revision: revision + 1, savedAt: now(), data: copy(user) };
      const options = { expectedRevision: revision };
      if (pendingArchive) {
        const { original } = pendingArchive;
        options.archive = {
          key: storeArchiveKey(original.version, original.revision),
          value: {
            format: STORE_ARCHIVE_FORMAT,
            archiveVersion: STORE_ARCHIVE_VERSION,
            archivedAt: record.savedAt,
            reason: `upgrade-to-format-${STORE_RECORD_VERSION}`,
            replacedByRevision: record.revision,
            original: copy(original)
          }
        };
      }
      setStatus({ state: 'saving' });
      try {
        // A store that cannot keep the archive in the same transaction must not take the write.
        if (options.archive && snapshotStore.archives !== true) throw new Error('this storage cannot keep a copy of the older data, so nothing was saved');
        await snapshotStore.write(record, options);
        revision = record.revision;
        pendingArchive = null;
        setStatus({ state: dirty ? 'saving' : 'saved', lastSavedAt: record.savedAt, revision, error: null });
      } catch (e) {
        if (e && e.code === 'CONFLICT') {
          setStatus({ state: 'conflict', error: 'Your data was changed in another tab or window. Reload to continue; nothing was overwritten.' });
          return;
        }
        if (e && e.code === 'STORAGE_ARCHIVE_CONFLICT') {
          // Blocking: never overwrite either record, never retry automatically (retry() refuses).
          dirty = true;
          setStatus({ state: 'conflict', code: 'STORAGE_ARCHIVE_CONFLICT', error: ARCHIVE_CONFLICT_MESSAGE });
          return;
        }
        dirty = true; // keep it pending; the next save or retry() tries again
        setStatus({ state: 'error', error: (e && e.message) || String(e) });
        return;
      }
    }
  }

  function schedule() {
    if (!writing) writing = writeLoop().finally(() => { writing = null; });
    return writing;
  }

  const adapter = {
    load() {
      return { schemas: copy(appData.schemas), coreFoods: copy(appData.coreFoods), libraryMeals: copy(appData.libraryMeals), ...copy(user) };
    },

    /** Called by the store only after the whole change set has been validated. */
    saveMany(changes) {
      for (const c of Object.keys(changes)) if (!USER_COLLECTION_NAMES.includes(c)) throw new Error(`browser adapter: ${c} is read-only`);
      Object.assign(user, copy(changes));
      dirty = true;
      schedule();
    },

    save(collection, data) {
      adapter.saveMany({ [collection]: data });
    },

    status: () => ({ ...status }),

    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    /** Resolves (with the status) once every accepted change has been written, or has failed. */
    async flush() {
      while (writing) await writing;
      return { ...status };
    },

    /** Try a failed write again (not after a conflict — that needs a reload). */
    retry() {
      if (status.state === 'error') { dirty = true; schedule(); }
      return adapter.flush();
    },

    /** The stored record exactly as it is, for a raw download if the data ever fails to load. */
    readStoredRecord: () => snapshotStore.read()
  };
  return adapter;
}

/**
 * Replace the stored user data with `data` (the user collections, current format) as a new record,
 * whatever is stored now — including a record that failed to load. Only for an explicit
 * user choice (recoverStoredData); nothing calls it automatically. Throws DomainError
 * STORAGE_CONFLICT if storage changed underneath, STORAGE_UNAVAILABLE if it can't be written.
 */
export async function replaceStoredUserData({ snapshotStore, data, now = () => new Date().toISOString() }) {
  try {
    upgradeUserData(data, STORE_RECORD_VERSION); // the replacement must already be in the current format
  } catch (e) {
    if (e instanceof DomainError && e.code.startsWith('USER_DATA_')) throw new DomainError('DATA_INVALID', `replacement data is not valid: ${e.message}`, e.details);
    throw e;
  }
  let current;
  try { current = await snapshotStore.read(); } catch (e) {
    throw e instanceof DomainError ? e : new DomainError('STORAGE_UNAVAILABLE', `browser storage could not be read: ${e && e.message}`);
  }
  const expectedRevision = current ? current.revision : 0;
  const revision = current && Number.isInteger(current.revision) ? current.revision + 1 : 1;
  const record = { format: STORE_RECORD_FORMAT, version: STORE_RECORD_VERSION, revision, savedAt: now(), data: copy(data) };
  try {
    await snapshotStore.write(record, { expectedRevision });
  } catch (e) {
    if (e && e.code === 'CONFLICT') throw new DomainError('STORAGE_CONFLICT', 'stored data changed while it was being replaced; nothing was written');
    throw e instanceof DomainError ? e : new DomainError('STORAGE_UNAVAILABLE', `browser storage could not be written: ${e && e.message}`);
  }
  return { revision };
}

/**
 * Ask the browser to keep this site's storage (reduces eviction, e.g. iOS clearing script
 * storage after a week without visits). Returns true when granted. Safe to call anywhere.
 */
export async function requestPersistentStorage(nav = globalThis.navigator) {
  try {
    if (nav && nav.storage && typeof nav.storage.persist === 'function') return await nav.storage.persist();
  } catch { /* not available */ }
  return false;
}
