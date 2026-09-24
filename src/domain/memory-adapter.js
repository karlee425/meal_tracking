/*
 * memory-adapter.js — an adapter that keeps everything in memory.
 * Browser-safe. Useful for tests and for a page that loads the canonical JSON itself.
 *
 *   const adapter = createMemoryAdapter({ schemas, coreFoods, libraryMeals, targets,
 *                                         customFoods, savedMeals, days, preferences });
 *   adapter.snapshot()  -> deep copy of the current collections (what would be on disk)
 */

import { clone } from './util.js';

export function createMemoryAdapter(initial) {
  const data = clone(initial);
  return {
    load: () => clone(data),
    save(collection, value) { data[collection] = clone(value); },
    snapshot: () => clone(data)
  };
}
