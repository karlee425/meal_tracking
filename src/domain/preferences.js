/*
 * preferences.js — the one preference store: user-data/preferences.json.
 */

import { DomainError, clone } from './util.js';

const OBJECT_KEYS = ['mealPreferences', 'coachingPreferences', 'appPreferences'];
const LIST_KEYS = ['favoriteFoods', 'favoriteMeals', 'dislikedFoods'];

export function createPreferencesApi(ctx) {
  const { store } = ctx;

  function setMembership(listKey, id, on, exists) {
    if (on && !exists(id)) throw new DomainError('NOT_FOUND', `${id} does not exist`);
    const prefs = clone(store.get('preferences'));
    const list = prefs[listKey].filter((x) => x !== id);
    if (on) list.push(id);
    prefs[listKey] = list;
    store.commit({ preferences: prefs });
    return clone(prefs);
  }

  const api = {
    getPreferences() {
      return clone(store.get('preferences'));
    },

    /**
     * Update preferences. Lists are replaced; the three settings objects are merged one
     * level deep ({ appPreferences: { x: 1 } } keeps other appPreferences keys).
     */
    updatePreferences(patch = {}) {
      const prefs = clone(store.get('preferences'));
      for (const [k, v] of Object.entries(patch)) {
        if (LIST_KEYS.includes(k)) prefs[k] = clone(v);
        else if (OBJECT_KEYS.includes(k)) prefs[k] = { ...prefs[k], ...clone(v) };
        else throw new DomainError('INVALID_PREFERENCES', `unknown preference "${k}"`);
      }
      store.commit({ preferences: prefs });
      return clone(prefs);
    },

    setFavoriteFood(foodId, on = true) { return setMembership('favoriteFoods', foodId, on, (id) => !!ctx.lookupFood(id)); },
    setDislikedFood(foodId, on = true) { return setMembership('dislikedFoods', foodId, on, (id) => !!ctx.lookupFood(id)); },
    setFavoriteMeal(mealId, on = true) { return setMembership('favoriteMeals', mealId, on, (id) => !!ctx.findMeal(id)); }
  };
  return api;
}
