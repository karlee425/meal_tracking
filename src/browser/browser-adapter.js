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
 * What is stored: only the five user-owned collections (targets, customFoods, savedMeals,
 * days — with their Meal Instances — and preferences), as ONE snapshot record. Core Foods,
 * Library Meals and the schemas are app data passed in as `appData` and are never stored.
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

import { DomainError } from '../domain/index.js';

export const STORE_RECORD_FORMAT = 'macro-tracker-v2-store';
export const STORE_RECORD_VERSION = 1;
export const USER_COLLECTION_NAMES = Object.freeze(['targets', 'customFoods', 'savedMeals', 'days', 'preferences']);

const copy = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));

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
  if (stored === null || stored === undefined) {
    user = {};
    for (const c of USER_COLLECTION_NAMES) {
      if (appData.seed[c] === undefined) throw new Error(`createBrowserAdapter: appData.seed.${c} is missing`);
      user[c] = copy(appData.seed[c]);
    }
  } else {
    if (stored.format !== STORE_RECORD_FORMAT || stored.version !== STORE_RECORD_VERSION || !stored.data || typeof stored.data !== 'object') {
      const e = new DomainError('STORED_DATA_UNRECOGNIZED', `stored data is not a ${STORE_RECORD_FORMAT} v${STORE_RECORD_VERSION} record; refusing to start rather than overwrite it`);
      e.readStoredRecord = () => snapshotStore.read();
      throw e;
    }
    revision = stored.revision;
    user = copy(stored.data);
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
      setStatus({ state: 'saving' });
      try {
        await snapshotStore.write(record, { expectedRevision: revision });
        revision = record.revision;
        setStatus({ state: dirty ? 'saving' : 'saved', lastSavedAt: record.savedAt, revision, error: null });
      } catch (e) {
        if (e && e.code === 'CONFLICT') {
          setStatus({ state: 'conflict', error: 'Your data was changed in another tab or window. Reload to continue; nothing was overwritten.' });
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
 * Replace the stored user data with `data` (the five user collections) as a new record,
 * whatever is stored now — including a record that failed to load. Only for an explicit
 * user choice (recoverStoredData); nothing calls it automatically. Throws DomainError
 * STORAGE_CONFLICT if storage changed underneath, STORAGE_UNAVAILABLE if it can't be written.
 */
export async function replaceStoredUserData({ snapshotStore, data, now = () => new Date().toISOString() }) {
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
