/*
 * indexeddb-snapshot-store.js — the durable browser store behind browser-adapter.js.
 *
 * One IndexedDB database (default "meal-tracking-v2"), one object store, one record under
 * one key. Each write is a single readwrite transaction that checks the stored revision
 * and puts the new record: it either fully happens or does not happen at all.
 *
 * The database name is V2's own. The retired pages' browser storage and hosted records are
 * never opened, read or written.
 *
 * This is the only runtime file allowed to touch browser storage APIs
 * (tests/runtime-boundary.test.mjs).
 */

import { DomainError } from '../domain/index.js';

export const DEFAULT_DB_NAME = 'meal-tracking-v2';
const STORE = 'snapshots';
const KEY = 'user-data';

const conflict = (message) => Object.assign(new Error(message), { code: 'CONFLICT' });
/** Browser storage cannot be used at all (missing, disabled, private mode, blocked). */
const unavailable = (why) => new DomainError('STORAGE_UNAVAILABLE', `browser storage is not available: ${why}`);

export function createIndexedDbSnapshotStore({ dbName = DEFAULT_DB_NAME, indexedDB = globalThis.indexedDB } = {}) {
  if (!indexedDB) throw unavailable('IndexedDB is missing in this environment');
  let dbPromise = null;

  function open() {
    if (!dbPromise) {
      dbPromise = new Promise((resolve, reject) => {
        let req;
        try { req = indexedDB.open(dbName, 1); } catch (e) { reject(unavailable(e.message)); return; }
        req.onupgradeneeded = () => { if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE); };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(unavailable(req.error ? req.error.message : 'the database could not be opened'));
        req.onblocked = () => reject(unavailable('the database is blocked by another open version of the app'));
      });
    }
    return dbPromise;
  }

  return {
    dbName,

    async read() {
      const db = await open();
      return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE, 'readonly');
        const req = tx.objectStore(STORE).get(KEY);
        req.onsuccess = () => resolve(req.result === undefined ? null : req.result);
        req.onerror = () => reject(unavailable(req.error ? req.error.message : 'the stored data could not be read'));
      });
    },

    /** Put `record` only if the stored revision equals expectedRevision (0 = nothing stored yet). */
    async write(record, { expectedRevision }) {
      const db = await open();
      return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE, 'readwrite');
        const os = tx.objectStore(STORE);
        let refused = null;
        const get = os.get(KEY);
        get.onsuccess = () => {
          const current = get.result ? get.result.revision : 0;
          if (current !== expectedRevision) {
            refused = conflict(`stored revision is ${current}, expected ${expectedRevision}`);
            tx.abort();
            return;
          }
          os.put(record, KEY);
        };
        tx.oncomplete = () => resolve();
        tx.onabort = () => reject(refused || tx.error || new Error('write aborted'));
        tx.onerror = () => { /* reported through onabort */ };
      });
    }
  };
}
