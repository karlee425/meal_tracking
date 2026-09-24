/*
 * store.js — the in-memory state of the canonical data and its persistence.
 *
 * The store is the only thing that talks to an adapter. Every write is validated against
 * the canonical JSON schemas (data/schemas/) plus a few cross-record invariants BEFORE it
 * is persisted; a rejected write changes nothing.
 *
 * Collections and where they live (see src/node/file-adapter.js):
 *   coreFoods     data/foods/core-foods.json       read-only (app-managed)
 *   libraryMeals  data/meals/library-meals.json    read-only (app-managed)
 *   targets       data/targets.json                current targets for new Days
 *   customFoods   user-data/custom-foods.json
 *   savedMeals    user-data/saved-meals.json
 *   days          user-data/daily-logs.json        Days with their Meal Instance snapshots
 *   preferences   user-data/preferences.json
 *
 * An adapter implements:
 *   load()                  -> { schemas, coreFoods, libraryMeals, targets, customFoods, savedMeals, days, preferences }
 *   save(collection, data)  persist one writable collection
 */

import { makeSchemaValidator } from './schema-validator.js';
import { DomainError, clone } from './util.js';

const COLLECTIONS = {
  coreFoods: { schema: 'food.schema.json', list: true, writable: false },
  libraryMeals: { schema: 'meal.schema.json', list: true, writable: false },
  targets: { schema: 'targets.schema.json', list: false, writable: true },
  customFoods: { schema: 'food.schema.json', list: true, writable: true },
  savedMeals: { schema: 'meal.schema.json', list: true, writable: true },
  days: { schema: 'day.schema.json', list: true, writable: true },
  preferences: { schema: 'preferences.schema.json', list: false, writable: true }
};

export const WRITABLE_COLLECTIONS = Object.keys(COLLECTIONS).filter((c) => COLLECTIONS[c].writable);

export function createStore(adapter) {
  const loaded = adapter.load();
  if (!loaded || !loaded.schemas) throw new DomainError('DATA_INVALID', 'adapter.load() must return schemas and all collections');
  const validate = makeSchemaValidator(loaded.schemas);
  const state = {};
  for (const c of Object.keys(COLLECTIONS)) {
    if (loaded[c] === undefined) throw new DomainError('DATA_INVALID', `adapter.load() is missing "${c}"`);
    state[c] = clone(loaded[c]);
  }

  function schemaErrors(collection, data) {
    const def = COLLECTIONS[collection];
    if (!def.list) return validate(data, def.schema, collection);
    if (!Array.isArray(data)) return [`${collection}: expected an array`];
    const errs = [];
    data.forEach((x, i) => errs.push(...validate(x, def.schema, `${collection}[${i}]`)));
    return errs;
  }

  // Cross-record rules the JSON schemas cannot express.
  function invariantErrors(collection, data, s) {
    const errs = [];
    const dupes = (ids, label) => {
      const seen = new Set();
      for (const id of ids) { if (seen.has(id)) errs.push(`duplicate ${label} ${id}`); seen.add(id); }
    };
    if (collection === 'customFoods' || collection === 'coreFoods') {
      dupes(data.map((f) => f.id), 'Food id');
      const other = collection === 'customFoods' ? s.coreFoods : s.customFoods;
      const otherIds = new Set(other.map((f) => f.id));
      for (const f of data) if (otherIds.has(f.id)) errs.push(`Food id ${f.id} exists as both core and custom`);
      for (const f of data) {
        if (collection === 'customFoods' && f.source !== 'custom') errs.push(`${f.id}: custom Food must have source "custom"`);
        if (collection === 'coreFoods' && f.source !== 'core') errs.push(`${f.id}: core Food must have source "core"`);
      }
    }
    if (collection === 'savedMeals' || collection === 'libraryMeals') {
      dupes(data.map((m) => m.id), 'Meal id');
      const want = collection === 'savedMeals' ? 'saved' : 'library';
      for (const m of data) if (m.source !== want) errs.push(`${m.id}: expected source "${want}"`);
      const other = new Set((collection === 'savedMeals' ? s.libraryMeals : s.savedMeals).map((m) => m.id));
      for (const m of data) if (other.has(m.id)) errs.push(`Meal id ${m.id} exists as both library and saved`);
    }
    if (collection === 'days') {
      dupes(data.map((d) => d.date), 'Day date');
      const instanceIds = [];
      for (const d of data) {
        if (d.id !== `day_${d.date}`) errs.push(`Day ${d.date} must have id day_${d.date}`);
        for (const mi of d.mealInstances) instanceIds.push(mi.id);
      }
      dupes(instanceIds, 'Meal Instance id');
    }
    return errs;
  }

  // Validate everything that was loaded; refuse to start on invalid data.
  {
    const errs = [];
    for (const c of Object.keys(COLLECTIONS)) errs.push(...schemaErrors(c, state[c]), ...invariantErrors(c, state[c], state));
    if (errs.length) throw new DomainError('DATA_INVALID', `canonical data failed validation (${errs.length} problem(s))`, errs);
  }

  return {
    /** Read access. Callers must treat the result as read-only and clone before changing it. */
    get(collection) {
      if (!(collection in COLLECTIONS)) throw new Error(`unknown collection ${collection}`);
      return state[collection];
    },

    /**
     * Validate and persist one or more collections: commit({ savedMeals: [...], customFoods: [...] }).
     * All are validated first; if any fails, nothing is saved.
     */
    commit(changes) {
      const next = { ...state, ...changes };
      const errs = [];
      for (const [c, data] of Object.entries(changes)) {
        if (!COLLECTIONS[c] || !COLLECTIONS[c].writable) throw new DomainError('READ_ONLY', `collection "${c}" is read-only`);
        errs.push(...schemaErrors(c, data), ...invariantErrors(c, data, next));
      }
      if (errs.length) throw new DomainError('VALIDATION_FAILED', `write rejected (${errs.length} problem(s)): ${errs.slice(0, 3).join('; ')}`, errs);
      for (const [c, data] of Object.entries(changes)) {
        adapter.save(c, data);
        state[c] = data;
      }
    }
  };
}
