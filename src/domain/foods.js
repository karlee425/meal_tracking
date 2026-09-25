/*
 * foods.js — Foods own nutrition.
 *
 * Core Foods (data/foods/core-foods.json) are app-managed and read-only here.
 * Custom Foods (user-data/custom-foods.json) are user-managed.
 * There is one Food collection per source; nothing is copied into a second Food database,
 * and similar Foods are never merged.
 */

import { DomainError, clone, slug, uniqueId } from './util.js';
import { FOOD_STATES } from './constants.js';
import { MACROS, checkNutritionValues } from './macros.js';

const norm = (s) => String(s).toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
  .replace(/[^a-z0-9%]+/g, ' ').trim();

export function createFoodsApi(ctx) {
  const { store } = ctx;

  /** Every Food ID that anything refers to — never reuse one for a new Food. */
  function referencedFoodIds() {
    const ids = new Set();
    for (const f of store.get('coreFoods')) ids.add(f.id);
    for (const f of store.get('customFoods')) ids.add(f.id);
    for (const m of [...store.get('savedMeals'), ...store.get('libraryMeals')]) for (const i of m.ingredients) ids.add(i.foodId);
    for (const d of store.get('days')) for (const mi of d.mealInstances) for (const i of mi.ingredients) ids.add(i.foodId);
    return ids;
  }

  /**
   * Every problem with a Custom Food as it would be stored. Never throws.
   * errors:   [{ field, code, message }]  — any error blocks the write
   * warnings: [{ code, message, foodIds }] — informational only (e.g. a Food with the same name exists)
   */
  function customFoodProblems(candidate, selfId = null) {
    const errors = [];
    const warnings = [];
    const name = typeof candidate.name === 'string' ? candidate.name.trim() : '';
    if (!name) errors.push({ field: 'name', code: 'NAME_REQUIRED', message: 'name is required' });
    else if (!slug(name)) errors.push({ field: 'name', code: 'NAME_REQUIRED', message: 'name must contain a letter or digit' });
    if (typeof candidate.category !== 'string' || !candidate.category.trim()) errors.push({ field: 'category', code: 'CATEGORY_REQUIRED', message: 'category is required' });
    if (!FOOD_STATES.includes(candidate.state)) errors.push({ field: 'state', code: 'STATE_INVALID', message: `state must be one of ${FOOD_STATES.join(', ')}` });
    if (candidate.nutrition && candidate.nutrition.basis !== undefined && candidate.nutrition.basis !== '100g') {
      errors.push({ field: 'nutrition.basis', code: 'NUTRITION_BASIS', message: 'nutrition basis must be "100g"' });
    }
    errors.push(...checkNutritionValues(candidate.nutrition));
    if (name) {
      const key = norm(name);
      const same = [...store.get('coreFoods'), ...store.get('customFoods')].filter((f) => f.id !== selfId && norm(f.name) === key).map((f) => f.id);
      if (same.length) warnings.push({ code: 'DUPLICATE_NAME', message: `a Food named "${name}" already exists`, foodIds: same });
    }
    return { errors, warnings };
  }

  function throwIfInvalid({ errors }) {
    if (errors.length) throw new DomainError('INVALID_FOOD', errors.map((e) => e.message).join('; '), errors);
  }

  function customFoodOrThrow(id) {
    if (store.get('coreFoods').some((f) => f.id === id)) throw new DomainError('CORE_FOOD_READ_ONLY', `${id} is a Core Food and cannot be changed here`);
    const f = store.get('customFoods').find((x) => x.id === id);
    if (!f) throw new DomainError('FOOD_NOT_FOUND', `no Custom Food ${id}`);
    return f;
  }

  const api = {
    /**
     * Check Custom Food input without saving anything — the same rules createCustomFood and
     * updateCustomFood enforce. For an edit, pass { id } and the patch; it is checked as merged.
     * Returns { valid, errors: [{ field, code, message }], warnings: [{ code, message, foodIds }] }.
     */
    validateCustomFood(input = {}, { id } = {}) {
      let candidate = input;
      if (id !== undefined) {
        const current = customFoodOrThrow(id);
        candidate = { ...clone(current), ...clone(input), nutrition: { ...current.nutrition, ...(input.nutrition || {}) } };
      }
      const { errors, warnings } = customFoodProblems(candidate || {}, id === undefined ? null : id);
      return { valid: errors.length === 0, errors, warnings };
    },

    /** A Food by ID (core or custom), or null. Returns a copy. */
    getFood(id) {
      const f = ctx.lookupFood(id);
      return f ? clone(f) : null;
    },

    /**
     * Search names and aliases of core and custom Foods.
     * Returns [{ food, matchedOn: 'name'|'alias', matchedText, score }], best first.
     * Ranking: exact > starts with > every word present > substring. Inactive Foods are
     * excluded unless includeInactive. Meal ingredient labels are never searched.
     */
    searchFoods(query, { limit = 25, includeInactive = false } = {}) {
      const q = norm(query || '');
      if (!q) return [];
      const words = q.split(' ');
      const results = [];
      for (const food of [...store.get('customFoods'), ...store.get('coreFoods')]) {
        if (!includeInactive && food.metadata && food.metadata.active === false) continue;
        let best = null;
        const candidates = [['name', food.name], ...(food.aliases || []).map((a) => ['alias', a])];
        for (const [kind, text] of candidates) {
          const t = norm(text);
          let score = 0;
          if (t === q) score = 100;
          else if (t.startsWith(q)) score = 80;
          else if (words.every((w) => t.split(' ').some((tw) => tw.startsWith(w)))) score = 60;
          else if (t.includes(q)) score = 40;
          if (!score) continue;
          if (kind === 'alias') score -= 5; // prefer a name match over an alias match of equal strength
          if (!best || score > best.score) best = { matchedOn: kind, matchedText: text, score };
        }
        if (best) results.push({ food, ...best });
      }
      results.sort((a, b) => b.score - a.score || a.food.name.localeCompare(b.food.name) || a.food.id.localeCompare(b.food.id));
      return results.slice(0, limit).map((r) => ({ ...r, food: clone(r.food) }));
    },

    /** Foods from the most recent Meal Instances, newest first. Deleted Foods are skipped. */
    getRecentFoods({ limit = 20 } = {}) {
      const out = [];
      const seen = new Set();
      for (const mi of ctx.instancesNewestFirst()) {
        for (const ing of mi.ingredients) {
          if (seen.has(ing.foodId)) continue;
          seen.add(ing.foodId);
          const f = ctx.lookupFood(ing.foodId);
          if (f) out.push(clone(f));
          if (out.length >= limit) return out;
        }
      }
      return out;
    },

    /**
     * Create a Custom Food. The ID comes from the name (food_custom_<name>) and never
     * reuses an ID that anything still refers to — so a deleted Food's references can
     * never silently start pointing at a new Food.
     */
    createCustomFood(input = {}) {
      const { category, state, nutrition, brand = null, tags = [], aliases, measurement, metadata = {} } = input;
      throwIfInvalid(customFoodProblems(input));
      const name = input.name.trim();
      const base = `food_custom_${slug(name)}`;
      const id = uniqueId(base, referencedFoodIds());
      const now = ctx.now();
      const food = {
        id,
        name,
        source: 'custom',
        category: category.trim(),
        brand,
        state,
        nutrition: { basis: '100g', protein: nutrition.protein, carbs: nutrition.carbs, fat: nutrition.fat },
        measurement: measurement ? clone(measurement) : { canonicalUnit: 'g', servingSize: 100, servingUnit: 'g' },
        tags: clone(tags),
        aliases: aliases ? clone(aliases) : [name.toLowerCase()],
        metadata: { ...clone(metadata), editable: true, active: true, createdAt: now, updatedAt: now }
      };
      store.commit({ customFoods: [...store.get('customFoods'), food] });
      return clone(food);
    },

    /**
     * Update a Custom Food. The ID never changes. Saved Meals using it recalculate
     * automatically (their macros are derived); logged Meal Instances do not change.
     */
    updateCustomFood(id, patch = {}) {
      const current = customFoodOrThrow(id);
      if ('id' in patch && patch.id !== id) throw new DomainError('IMMUTABLE_ID', 'Food IDs never change');
      if ('source' in patch && patch.source !== 'custom') throw new DomainError('INVALID_FOOD', 'source cannot change');
      const next = clone(current);
      for (const k of ['name', 'category', 'brand', 'state', 'tags', 'aliases', 'measurement']) if (k in patch) next[k] = clone(patch[k]);
      if (patch.nutrition) {
        for (const k of Object.keys(patch.nutrition)) if (k !== 'basis' && !MACROS.includes(k)) next.nutrition[k] = patch.nutrition[k]; // reported below
        for (const m of MACROS) if (m in patch.nutrition) next.nutrition[m] = patch.nutrition[m];
      }
      throwIfInvalid(customFoodProblems(next, id));
      next.name = next.name.trim();
      next.category = next.category.trim();
      if (patch.metadata) next.metadata = { ...next.metadata, ...clone(patch.metadata), editable: true };
      next.metadata.updatedAt = ctx.now();
      store.commit({ customFoods: store.get('customFoods').map((f) => (f.id === id ? next : f)) });
      return clone(next);
    },

    /**
     * Delete a Custom Food.
     *  - Saved Meals that use it become invalid (needsReplacement) and remember the deleted
     *    Food's name so the user can pick a replacement. Nothing is substituted or removed.
     *  - Logged Meal Instances are untouched (they carry their own snapshot).
     *  - The ID is retired from favorites / dislikes.
     * Returns { deletedFoodId, affectedSavedMealIds }.
     */
    deleteCustomFood(id) {
      const food = customFoodOrThrow(id);
      const now = ctx.now();
      const affected = [];
      const savedMeals = store.get('savedMeals').map((m) => {
        if (!m.ingredients.some((i) => i.foodId === id)) return m;
        affected.push(m.id);
        const next = clone(m);
        next.metadata = next.metadata || {};
        next.metadata.unresolvedFoods = { ...(next.metadata.unresolvedFoods || {}), [id]: { name: food.name, deletedAt: now } };
        return next;
      });
      const prefs = clone(store.get('preferences'));
      prefs.favoriteFoods = prefs.favoriteFoods.filter((x) => x !== id);
      prefs.dislikedFoods = prefs.dislikedFoods.filter((x) => x !== id);
      store.commit({
        customFoods: store.get('customFoods').filter((f) => f.id !== id),
        savedMeals,
        preferences: prefs
      });
      return { deletedFoodId: id, affectedSavedMealIds: affected };
    }
  };
  return api;
}
