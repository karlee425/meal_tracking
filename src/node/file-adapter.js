/*
 * file-adapter.js — Node adapter: the canonical JSON files in a repository checkout.
 *
 *   import { createFileAdapter } from './src/node/file-adapter.js';
 *   import { createDataLayer } from './src/domain/index.js';
 *   const app = createDataLayer({ adapter: createFileAdapter(repoRoot) });
 *
 * Reads the canonical V2 files only. Writes only the writable collections, atomically
 * (temp file + rename), in the same format the migration seeded them with.
 * Never reads legacy files or migration/.
 */

import fs from 'node:fs';
import path from 'node:path';

export const FILES = Object.freeze({
  coreFoods: 'data/foods/core-foods.json',
  libraryMeals: 'data/meals/library-meals.json',
  targets: 'data/targets.json',
  customFoods: 'user-data/custom-foods.json',
  savedMeals: 'user-data/saved-meals.json',
  days: 'user-data/daily-logs.json',
  preferences: 'user-data/preferences.json'
});
const WRITABLE = new Set(['targets', 'customFoods', 'savedMeals', 'days', 'preferences']);
const SCHEMA_DIR = 'data/schemas';

export function createFileAdapter(root) {
  const abs = (p) => path.join(root, p);
  const readJSON = (p) => JSON.parse(fs.readFileSync(abs(p), 'utf8'));
  const adapter = {
    load() {
      const schemas = {};
      for (const f of fs.readdirSync(abs(SCHEMA_DIR)).filter((x) => x.endsWith('.schema.json')).sort()) {
        schemas[f] = readJSON(`${SCHEMA_DIR}/${f}`);
      }
      const out = { schemas };
      for (const [c, p] of Object.entries(FILES)) out[c] = readJSON(p);
      return out;
    },
    save(collection, data) {
      adapter.saveMany({ [collection]: data });
    },

    /**
     * Write several collections together. Every file is first written in full to a temp
     * file next to its target; only when all of them are written are they renamed into
     * place. If any temp write fails, the temps are removed and no canonical file changes.
     * (Renames on one filesystem do not fail in practice; this adapter is for development
     * and tests — the browser adapter writes one snapshot record per commit.)
     */
    saveMany(changes) {
      const entries = Object.entries(changes);
      for (const [c] of entries) if (!WRITABLE.has(c)) throw new Error(`file adapter: ${c} is read-only`);
      const written = [];
      try {
        for (const [c, data] of entries) {
          const target = abs(FILES[c]);
          const tmp = `${target}.tmp-${process.pid}`;
          fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n');
          written.push([tmp, target]);
        }
      } catch (e) {
        for (const [tmp] of written) fs.rmSync(tmp, { force: true });
        throw e;
      }
      for (const [tmp, target] of written) fs.renameSync(tmp, target);
    }
  };
  return adapter;
}
