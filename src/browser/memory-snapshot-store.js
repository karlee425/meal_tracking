/*
 * memory-snapshot-store.js — the same contract as indexeddb-snapshot-store.js, held in
 * memory. For tests and development: one instance survives any number of
 * createBrowserAdapter() calls, which is what a page reload looks like to the adapter.
 *
 * Archives follow the IndexedDB store exactly: a write's { archive: { key, value } } is
 * checked after the revision — absent → both are kept, identical → only the record is
 * written, different → STORAGE_ARCHIVE_CONFLICT and nothing changes.
 *
 *   createMemorySnapshotStore(record?, { archives?: { key: value } })
 *   failNextWrites(n)  make the next n writes reject (simulates a storage failure)
 *   peek()             the stored record (a copy), or null
 *   peekArchives()     every archive (a copy), as { key: value }
 */

import { DomainError } from '../domain/index.js';
import { isStoreArchiveKey, sameStoreArchive } from './browser-adapter.js';

const copy = (v) => (v === undefined || v === null ? null : JSON.parse(JSON.stringify(v)));

export function createMemorySnapshotStore(initialRecord = null, { archives: initialArchives = {} } = {}) {
  let record = copy(initialRecord);
  const archives = new Map(Object.entries(copy(initialArchives) || {}));
  let failures = 0;
  let writes = 0;
  return {
    archives: true,
    async read() { return copy(record); },
    async write(next, { expectedRevision, archive } = {}) {
      if (archive !== undefined && (!archive || !isStoreArchiveKey(archive.key))) throw new Error('write: archive needs an archive key');
      if (failures > 0) { failures -= 1; throw new Error('simulated storage failure'); }
      const current = record ? record.revision : 0;
      if (current !== expectedRevision) throw Object.assign(new Error(`stored revision is ${current}, expected ${expectedRevision}`), { code: 'CONFLICT' });
      // Copy everything first, so a value that cannot be stored changes nothing.
      const nextRecord = copy(next);
      let nextArchive = null;
      if (archive) {
        const existing = archives.get(archive.key);
        if (existing === undefined) nextArchive = copy(archive.value);
        else if (!sameStoreArchive(existing, archive.value)) {
          throw new DomainError('STORAGE_ARCHIVE_CONFLICT', `a different archive is already stored under ${archive.key}; nothing was written`);
        }
      }
      if (nextArchive) archives.set(archive.key, nextArchive);
      record = nextRecord;
      writes += 1;
    },
    async listArchives() { return [...archives.keys()].filter(isStoreArchiveKey).sort(); },
    async readArchive(key) {
      if (!isStoreArchiveKey(key)) throw new Error('readArchive: not an archive key');
      return archives.has(key) ? copy(archives.get(key)) : null;
    },
    failNextWrites(n = 1) { failures = n; },
    peek: () => copy(record),
    peekArchives: () => Object.fromEntries([...archives].map(([k, v]) => [k, copy(v)])),
    writeCount: () => writes
  };
}
