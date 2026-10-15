/*
 * indexeddb-snapshot-store.js — the durable browser store behind browser-adapter.js.
 *
 * One IndexedDB database (default "meal-tracking-v2"), one object store, the current record
 * under one key ("user-data"). Each write is a single readwrite transaction that checks the
 * stored revision and puts the new record: it either fully happens or does not happen at all.
 *
 * Archives: a write may carry { archive: { key, value } } (the first save after a format
 * upgrade). In the SAME transaction, after the revision check: no archive under that key →
 * the archive and the record are both put; an identical archive (sameStoreArchive) → only the
 * record is put; a different one → the transaction is aborted with STORAGE_ARCHIVE_CONFLICT.
 * Any failure aborts the whole transaction, so the current record and every archive are left
 * exactly as they were. Archives are never overwritten or deleted here.
 *
 * The database name is V2's own. The retired pages' browser storage and hosted records are
 * never opened, read or written.
 *
 * This is the only runtime file allowed to touch browser storage APIs
 * (tests/runtime-boundary.test.mjs).
 */

import { DomainError } from '../domain/index.js';
import { isStoreArchiveKey, sameStoreArchive } from './browser-adapter.js';

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
    /** This store keeps an archive in the same transaction as the record (browser-adapter checks). */
    archives: true,

    async read() {
      const db = await open();
      return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE, 'readonly');
        const req = tx.objectStore(STORE).get(KEY);
        req.onsuccess = () => resolve(req.result === undefined ? null : req.result);
        req.onerror = () => reject(unavailable(req.error ? req.error.message : 'the stored data could not be read'));
      });
    },

    /**
     * Put `record` only if the stored revision equals expectedRevision (0 = nothing stored yet),
     * plus `archive` ({ key, value }) when given — all in one transaction.
     */
    async write(record, { expectedRevision, archive } = {}) {
      if (archive !== undefined && (!archive || !isStoreArchiveKey(archive.key))) throw new Error('write: archive needs an archive key');
      const db = await open();
      return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE, 'readwrite');
        const os = tx.objectStore(STORE);
        let refused = null;
        const fail = (e) => { refused = refused || e; try { tx.abort(); } catch { /* already finishing */ } };
        const get = os.get(KEY);
        get.onsuccess = () => {
          try {
            const current = get.result ? get.result.revision : 0;
            if (current !== expectedRevision) {
              fail(conflict(`stored revision is ${current}, expected ${expectedRevision}`));
              return;
            }
            if (!archive) { os.put(record, KEY); return; }
            const existing = os.get(archive.key);
            existing.onsuccess = () => {
              try {
                if (existing.result === undefined) os.put(archive.value, archive.key);
                else if (!sameStoreArchive(existing.result, archive.value)) {
                  fail(new DomainError('STORAGE_ARCHIVE_CONFLICT', `a different archive is already stored under ${archive.key}; nothing was written`));
                  return;
                }
                os.put(record, KEY);
              } catch (e) { fail(e); }
            };
          } catch (e) { fail(e); }
        };
        tx.oncomplete = () => resolve();
        tx.onabort = () => reject(refused || tx.error || new Error('write aborted'));
        tx.onerror = () => { /* reported through onabort */ };
      });
    },

    /** Keys of the archives kept by earlier upgrades (read-only). */
    async listArchives() {
      const db = await open();
      return new Promise((resolve, reject) => {
        const req = db.transaction(STORE, 'readonly').objectStore(STORE).getAllKeys();
        req.onsuccess = () => resolve(req.result.filter(isStoreArchiveKey).sort());
        req.onerror = () => reject(unavailable(req.error ? req.error.message : 'the stored data could not be read'));
      });
    },

    /** One archive exactly as stored, or null (read-only; only archive keys). */
    async readArchive(key) {
      if (!isStoreArchiveKey(key)) throw new Error('readArchive: not an archive key');
      const db = await open();
      return new Promise((resolve, reject) => {
        const req = db.transaction(STORE, 'readonly').objectStore(STORE).get(key);
        req.onsuccess = () => resolve(req.result === undefined ? null : req.result);
        req.onerror = () => reject(unavailable(req.error ? req.error.message : 'the stored data could not be read'));
      });
    }
  };
}
