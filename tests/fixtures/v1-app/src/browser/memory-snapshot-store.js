/*
 * memory-snapshot-store.js — the same contract as indexeddb-snapshot-store.js, held in
 * memory. For tests and development: one instance survives any number of
 * createBrowserAdapter() calls, which is what a page reload looks like to the adapter.
 *
 *   failNextWrites(n)  make the next n writes reject (simulates a storage failure)
 *   peek()             the stored record (a copy), or null
 */

const copy = (v) => (v === undefined || v === null ? null : JSON.parse(JSON.stringify(v)));

export function createMemorySnapshotStore(initialRecord = null) {
  let record = copy(initialRecord);
  let failures = 0;
  let writes = 0;
  return {
    async read() { return copy(record); },
    async write(next, { expectedRevision }) {
      if (failures > 0) { failures -= 1; throw new Error('simulated storage failure'); }
      const current = record ? record.revision : 0;
      if (current !== expectedRevision) throw Object.assign(new Error(`stored revision is ${current}, expected ${expectedRevision}`), { code: 'CONFLICT' });
      record = copy(next);
      writes += 1;
    },
    failNextWrites(n = 1) { failures = n; },
    peek: () => copy(record),
    writeCount: () => writes
  };
}
