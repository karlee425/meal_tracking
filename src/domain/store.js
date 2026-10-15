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
 *   userFoodData  user-data/user-food-data.json   named servings per Food (user data format 2)
 *
 * An adapter implements:
 *   load()                  -> { schemas, coreFoods, libraryMeals, targets, customFoods, savedMeals, days, preferences, userFoodData }
 *                              always in the CURRENT user-data format (src/domain/upgrade.js): an adapter
 *                              that reads an older stored format upgrades it before handing it over
 *   save(collection, data)  persist one writable collection
 * and, optionally (all three shipped adapters do):
 *   saveMany(changes)       persist several collections as one all-or-nothing write
 *   status()                -> { state: 'saved' | 'saving' | 'error' | 'conflict', lastSavedAt, error }
 *   subscribe(listener)     -> unsubscribe; listener(status) on every status change
 *   flush()                 -> Promise, resolved once every accepted write is durable
 *   retry()                 -> Promise<status>, try a failed background write again
 *
 * A commit is all-or-nothing: every change is validated first, then written in one
 * saveMany call; in-memory state changes only after the adapter accepted the write.
 */

import { makeSchemaValidator } from './schema-validator.js';
import { DomainError, clone } from './util.js';
import { servingQuantity } from './macros.js';

const COLLECTIONS = {
  coreFoods: { schema: 'food.schema.json', list: true, writable: false },
  libraryMeals: { schema: 'meal.schema.json', list: true, writable: false },
  targets: { schema: 'targets.schema.json', list: false, writable: true },
  customFoods: { schema: 'food.schema.json', list: true, writable: true },
  savedMeals: { schema: 'meal.schema.json', list: true, writable: true },
  days: { schema: 'day.schema.json', list: true, writable: true },
  preferences: { schema: 'preferences.schema.json', list: false, writable: true },
  userFoodData: { schema: 'user-food-data.schema.json', list: false, writable: true }
};

// Serving rules the JSON schema cannot express (the validator has no `pattern`, and these
// need normalisation or comparison across records). The schema covers the rest: required
// fields, types, grams > 0, non-empty strings, ISO date-times, at least one serving.
//   - A serving ID, live or retired, is "srv_" + a lowercase UUID, as crypto.randomUUID()
//     produces it (8-4-4-4-12 lowercase hex).
//   - Labels are compared after trimming surrounding whitespace and ignoring case: a label
//     must not be blank, must not be g / gram / grams, and must be unique within its Food.
// The label is stored as given; only the comparison is normalised.
const SERVING_ID = /^srv_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const RESERVED_SERVING_LABELS = new Set(['g', 'gram', 'grams']);
const servingLabelKey = (label) => label.trim().toLowerCase();

// Logged-serving snapshots (V3 Slice 1 · C8). A logged ingredient may carry `serving`: a copy of
// the serving it was logged with — { id, label, grams, approximate, count: { numerator,
// denominator } } — taken when it was logged and never read from userFoodData again. The schema
// covers types and required fields; these rules cover the rest. The label is a historical record:
// it must not be blank, but it is not checked against today's reserved or duplicate-label rules.
// The quantity is authoritative and must be exactly what the serving and count come to, by the
// same rule that logged it (macros.servingQuantity). Nothing is ever repaired.
const gcd = (a, b) => { while (b) [a, b] = [b, a % b]; return a; };
const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/** Problems with one logged ingredient's serving snapshot (none for an ingredient without one). */
function servingSnapshotErrors(ing, where) {
  if (!isPlainObject(ing) || !('serving' in ing)) return [];
  const sv = ing.serving;
  if (!isPlainObject(sv)) return []; // the schema errors already say why
  const errs = [];
  if (typeof sv.id === 'string' && !SERVING_ID.test(sv.id)) errs.push(`${where}: serving id ${JSON.stringify(sv.id)} is not srv_<uuid>`);
  if (typeof sv.label === 'string' && sv.label.trim() === '') errs.push(`${where}: a serving label must not be blank`);
  if (ing.unit !== 'g') errs.push(`${where}: a serving can only be logged in grams (unit is ${JSON.stringify(ing.unit)})`);
  const c = sv.count;
  const n = isPlainObject(c) ? c.numerator : undefined;
  const d = isPlainObject(c) ? c.denominator : undefined;
  const whole = (x) => Number.isSafeInteger(x) && x >= 1;
  if (!whole(n) || !whole(d)) {
    if (isPlainObject(c)) errs.push(`${where}: serving count must be positive whole numbers no larger than ${Number.MAX_SAFE_INTEGER}`);
    return errs;
  }
  if (gcd(n, d) !== 1) errs.push(`${where}: serving count ${n}/${d} is not in lowest terms`);
  if (typeof sv.grams === 'number' && Number.isFinite(sv.grams) && sv.grams > 0 && typeof ing.quantity === 'number') {
    let expected = null;
    try { expected = servingQuantity(sv.grams, { n: BigInt(n), d: BigInt(d) }).quantity; } catch { expected = null; }
    if (expected !== ing.quantity) errs.push(`${where}: quantity ${ing.quantity} g is not what the serving comes to (${n}/${d} × ${sv.grams} g = ${expected} g)`);
  }
  return errs;
}

/**
 * The reserved-serving-ID rule across collections (C8). With
 *   L = live serving IDs, R = retired serving IDs, H = serving IDs in logged-meal snapshots:
 *   - H ⊆ L ∪ R: a serving ID a logged meal refers to stays reserved, live or retired
 *   - one ID, one Food: every logged reference to an ID is for the same Food
 *   - a referenced ID that is live belongs to that same Food's serving record
 * (L ∩ R = ∅ is checked with userFoodData.) Checked whenever days or userFoodData change, and
 * on load. Malformed input is left to the schema and per-collection checks.
 */
function servingHistoryErrors(days, userFoodData) {
  if (!Array.isArray(days) || !isPlainObject(userFoodData) || !Array.isArray(userFoodData.foods) || !Array.isArray(userFoodData.retiredServingIds)) return [];
  const live = new Map();
  for (const r of userFoodData.foods) {
    if (!isPlainObject(r) || !Array.isArray(r.servings)) return [];
    for (const sv of r.servings) if (isPlainObject(sv)) live.set(sv.id, r.foodId);
  }
  const retired = new Set(userFoodData.retiredServingIds);
  const history = new Map();
  const errs = [];
  for (const d of days) {
    if (!isPlainObject(d) || !Array.isArray(d.mealInstances)) continue;
    for (const mi of d.mealInstances) {
      if (!isPlainObject(mi) || !Array.isArray(mi.ingredients)) continue;
      for (const ing of mi.ingredients) {
        if (!isPlainObject(ing) || !isPlainObject(ing.serving) || typeof ing.serving.id !== 'string') continue;
        const id = ing.serving.id;
        if (!history.has(id)) history.set(id, ing.foodId);
        else if (history.get(id) !== ing.foodId) errs.push(`logged meals refer to serving id ${id} for more than one Food (${history.get(id)}, ${ing.foodId})`);
      }
    }
  }
  for (const [id, foodId] of history) {
    if (live.has(id)) {
      if (live.get(id) !== foodId) errs.push(`serving id ${id} is logged for ${foodId} but is a live serving of ${live.get(id)}`);
    } else if (!retired.has(id)) {
      errs.push(`logged meals refer to serving id ${id}, which is neither a live nor a retired serving`);
    }
  }
  return errs;
}

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
        if (d.loggingComplete === true && !d.mealInstances.length) errs.push(`Day ${d.date} is marked done logging but has nothing logged`);
        if (d.priorTargetSnapshots && d.dayType in d.priorTargetSnapshots) errs.push(`Day ${d.date}: priorTargetSnapshots must not hold its current day type (${d.dayType})`);
        for (const mi of d.mealInstances) {
          instanceIds.push(mi.id);
          if (Array.isArray(mi.ingredients)) mi.ingredients.forEach((ing, k) => errs.push(...servingSnapshotErrors(ing, `Day ${d.date} ${mi.id} ingredient ${k}`)));
        }
      }
      dupes(instanceIds, 'Meal Instance id');
    }
    if (collection === 'userFoodData') {
      // Structure and types are the schema's job; these are the cross-record rules.
      // A record for a Food that does not exist is allowed (and ignored), so a later
      // change to Core Foods can never stop the app from starting.
      const wellFormed = data && Array.isArray(data.foods) && Array.isArray(data.retiredServingIds)
        && data.retiredServingIds.every((id) => typeof id === 'string')
        && data.foods.every((r) => r && Array.isArray(r.servings) && r.servings.every((sv) => sv && typeof sv.id === 'string' && typeof sv.label === 'string'));
      if (!wellFormed) return errs; // the schema errors already say why
      dupes(data.foods.map((r) => r.foodId), 'serving record for Food');
      const live = [];
      for (const r of data.foods) {
        const labels = new Set();
        for (const sv of r.servings) {
          live.push(sv.id);
          const label = servingLabelKey(sv.label);
          if (label === '') errs.push(`${r.foodId}: a serving label must not be blank`);
          else if (RESERVED_SERVING_LABELS.has(label)) errs.push(`${r.foodId}: serving label "${sv.label}" is reserved for grams`);
          if (label !== '' && labels.has(label)) errs.push(`${r.foodId}: duplicate serving label "${sv.label}" (labels are compared ignoring case and surrounding spaces)`);
          labels.add(label);
        }
      }
      for (const id of [...live, ...data.retiredServingIds]) if (!SERVING_ID.test(id)) errs.push(`serving id ${JSON.stringify(id)} is not srv_<uuid>`);
      dupes(live, 'serving id');
      dupes(data.retiredServingIds, 'retired serving id');
      const retired = new Set(data.retiredServingIds);
      for (const id of new Set(live)) if (retired.has(id)) errs.push(`serving id ${id} is both live and retired`);
    }
    return errs;
  }

  // Any NaN / Infinity / -Infinity anywhere in a record, including free-form metadata the
  // schemas do not type. JSON would write it as null, silently changing the data.
  function nonFiniteErrors(value, where, errs) {
    if (typeof value === 'number') { if (!Number.isFinite(value)) errs.push(`${where}: ${value} is not a finite number`); return errs; }
    if (Array.isArray(value)) value.forEach((v, i) => nonFiniteErrors(v, `${where}[${i}]`, errs));
    else if (value && typeof value === 'object') for (const [k, v] of Object.entries(value)) nonFiniteErrors(v, `${where}.${k}`, errs);
    return errs;
  }

  /** Every problem with a proposed set of changes, validated against the state they produce. */
  function validateChanges(changes) {
    const next = { ...state, ...changes };
    const errs = [];
    for (const [c, data] of Object.entries(changes)) {
      if (!COLLECTIONS[c] || !COLLECTIONS[c].writable) throw new DomainError('READ_ONLY', `collection "${c}" is read-only`);
      errs.push(...nonFiniteErrors(data, c, []), ...schemaErrors(c, data), ...invariantErrors(c, data, next));
    }
    // One rule spans days and userFoodData: checked against the state the changes produce.
    if ('days' in changes || 'userFoodData' in changes) errs.push(...servingHistoryErrors(next.days, next.userFoodData));
    return errs;
  }

  // Validate everything that was loaded; refuse to start on invalid data.
  {
    const errs = [];
    for (const c of Object.keys(COLLECTIONS)) errs.push(...schemaErrors(c, state[c]), ...invariantErrors(c, state[c], state));
    errs.push(...servingHistoryErrors(state.days, state.userFoodData));
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
      const errs = validateChanges(changes);
      if (errs.length) throw new DomainError('VALIDATION_FAILED', `write rejected (${errs.length} problem(s)): ${errs.slice(0, 3).join('; ')}`, errs);
      const copy = clone(changes);
      try {
        if (typeof adapter.saveMany === 'function') adapter.saveMany(copy);
        else if (Object.keys(copy).length === 1) { const [c] = Object.keys(copy); adapter.save(c, copy[c]); }
        else throw new Error('this adapter cannot write several collections at once (saveMany is missing)');
      } catch (e) {
        // Nothing in memory has changed, and a saveMany adapter has written nothing.
        throw new DomainError('PERSIST_FAILED', `write not saved: ${e.message}`);
      }
      Object.assign(state, copy);
    },

    /** Dry run of commit: the problems a set of changes would be rejected for (never writes). */
    check(changes) {
      return validateChanges(changes);
    },

    /** Persistence status passed through from the adapter; adapters without one are synchronous. */
    status() {
      return typeof adapter.status === 'function' ? adapter.status() : { state: 'saved', lastSavedAt: null, error: null };
    },
    subscribe(listener) {
      return typeof adapter.subscribe === 'function' ? adapter.subscribe(listener) : () => {};
    },
    flush() {
      return typeof adapter.flush === 'function' ? adapter.flush() : Promise.resolve();
    },
    /** Try a failed background save again; resolves with the resulting status. */
    retry() {
      return typeof adapter.retry === 'function' ? adapter.retry() : Promise.resolve(this.status());
    }
  };
}
