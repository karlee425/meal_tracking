/*
 * index.js — the canonical V2 data/domain layer.
 *
 *   FOODS → MEALS → MEAL INSTANCE → DAY → derived Progress / Macro Coach context
 *
 *   import { createDataLayer } from './domain/index.js';
 *   const app = createDataLayer({ adapter });          // adapter: file (Node) or memory
 *
 * Options:
 *   adapter   required; see store.js for the interface
 *   clock     () => Date          (default: real time)   — injectable for tests
 *   newId     () => string        (default: crypto.randomUUID) — injectable for tests
 *
 * No UI, no network, no AI dependency. Browser-safe (the Node file adapter lives in src/node/).
 */

import { createStore } from './store.js';
import { createFoodsApi } from './foods.js';
import { createMealsApi } from './meals.js';
import { createTargetsApi } from './targets.js';
import { createDaysApi } from './days.js';
import { createProgressApi } from './progress.js';
import { createCoachApi } from './coach.js';
import { createPreferencesApi } from './preferences.js';
import * as constants from './constants.js';

export { DomainError } from './util.js';
export { createMemoryAdapter } from './memory-adapter.js';
export * as macros from './macros.js';
export { constants };

export function createDataLayer({ adapter, clock = () => new Date(), newId } = {}) {
  if (!adapter) throw new Error('createDataLayer: adapter is required');
  const store = createStore(adapter);
  const makeId = newId || (() => globalThis.crypto.randomUUID());

  // Food lookup by ID, cached per version of the two Food collections.
  let cacheKey = null;
  let cache = null;
  function lookupFood(id) {
    const core = store.get('coreFoods');
    const custom = store.get('customFoods');
    if (!cache || cacheKey[0] !== core || cacheKey[1] !== custom) {
      cache = new Map([...core, ...custom].map((f) => [f.id, f]));
      cacheKey = [core, custom];
    }
    return cache.get(id) || null;
  }

  function instancesNewestFirst() {
    const all = store.get('days').flatMap((d) => d.mealInstances);
    return all.slice().sort((a, b) => (a.loggedAt < b.loggedAt ? 1 : a.loggedAt > b.loggedAt ? -1 : 0));
  }

  const ctx = {
    store,
    now: () => clock().toISOString(),
    newId: makeId,
    lookupFood,
    instancesNewestFirst,
    findMeal: null
  };

  const foods = createFoodsApi(ctx);
  const meals = createMealsApi(ctx);
  ctx.findMeal = meals._findMeal;
  const targets = createTargetsApi(ctx);
  const days = createDaysApi(ctx, { meals, targets });
  const progress = createProgressApi(ctx, { days });
  const preferences = createPreferencesApi(ctx);
  const coach = createCoachApi(ctx, { foods, meals, days, targets, preferences });

  const publicOf = (api) => Object.fromEntries(Object.entries(api).filter(([k]) => !k.startsWith('_')));

  return Object.freeze({
    ...publicOf(foods),
    ...publicOf(meals),
    ...publicOf(targets),
    ...publicOf(days),
    ...publicOf(progress),
    ...publicOf(preferences),
    ...publicOf(coach),
    constants
  });
}
