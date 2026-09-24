/*
 * meals.js — Meals own ingredients (Food ID + quantity + unit). P/C/F is always derived.
 *
 * Library Meals (data/meals/library-meals.json) are app-managed and read-only.
 * Saved Meals (user-data/saved-meals.json) are user-managed living recipes.
 * Saving a Library Meal makes an independent copy with its own ID; the copy records
 * where it came from (metadata.copiedFromMealId) for provenance only and never reads
 * from the Library Meal again.
 *
 * metadata.ingredientLabels is recipe wording only ("red onion" for Food "Onion"). It is
 * never used to find a Food or to calculate anything, and labels for Foods no longer in
 * the recipe are removed whenever a Saved Meal changes.
 *
 * Favourites live in user-data/preferences.json (favoriteMeals). The optional Meal
 * "favorite" field is not written by this layer, so there is one favourites store.
 */

import { DomainError, clone, assertMealType } from './util.js';
import { calculateMealMacros as calculate } from './macros.js';

const LIBRARY_ONLY_METADATA = ['legacyId', 'retired', 'isNew'];

export function createMealsApi(ctx) {
  const { store } = ctx;

  const findMeal = (id) => store.get('savedMeals').find((m) => m.id === id) || store.get('libraryMeals').find((m) => m.id === id) || null;

  function savedMealOrThrow(id) {
    if (store.get('libraryMeals').some((m) => m.id === id)) throw new DomainError('LIBRARY_MEAL_READ_ONLY', `${id} is a Library Meal; save a copy to edit it`);
    const m = store.get('savedMeals').find((x) => x.id === id);
    if (!m) throw new DomainError('MEAL_NOT_FOUND', `no Saved Meal ${id}`);
    return m;
  }

  /** Validate an ingredient list for a Saved Meal: every Food must exist, grams, quantity > 0. */
  function checkIngredients(ingredients) {
    if (!Array.isArray(ingredients) || !ingredients.length) throw new DomainError('INVALID_MEAL', 'a Meal needs at least one ingredient');
    return ingredients.map((ing, i) => {
      if (!ing || typeof ing.foodId !== 'string') throw new DomainError('INVALID_MEAL', `ingredient ${i}: foodId is required`);
      if (!ctx.lookupFood(ing.foodId)) throw new DomainError('FOOD_NOT_FOUND', `ingredient ${i}: no Food ${ing.foodId}`);
      const unit = ing.unit === undefined ? 'g' : ing.unit;
      if (unit !== 'g') throw new DomainError('UNSUPPORTED_UNIT', `ingredient ${i}: only grams are supported (no silent conversion)`);
      if (!(typeof ing.quantity === 'number' && Number.isFinite(ing.quantity) && ing.quantity > 0)) throw new DomainError('INVALID_QUANTITY', `ingredient ${i}: quantity must be > 0`);
      return { foodId: ing.foodId, quantity: ing.quantity, unit };
    });
  }

  /** Keep labels / unresolved-Food notes only for Foods that are still in the recipe. */
  function tidyMetadata(metadata, ingredients) {
    const present = new Set(ingredients.map((i) => i.foodId));
    const out = { ...metadata };
    for (const key of ['ingredientLabels', 'unresolvedFoods']) {
      if (!out[key]) continue;
      const kept = Object.fromEntries(Object.entries(out[key]).filter(([foodId]) => present.has(foodId)));
      if (Object.keys(kept).length) out[key] = kept;
      else delete out[key];
    }
    return out;
  }

  function newSavedMealId() {
    const taken = new Set([...store.get('savedMeals'), ...store.get('libraryMeals')].map((m) => m.id));
    let id;
    do { id = `meal_saved_${ctx.newId()}`; } while (taken.has(id));
    return id;
  }

  function describe(meal) {
    const calc = calculate(meal, ctx.lookupFood);
    const unresolved = (meal.metadata && meal.metadata.unresolvedFoods) || {};
    const labels = (meal.metadata && meal.metadata.ingredientLabels) || {};
    const problems = calc.problems.map((p) => ({
      ...p,
      // what to show the user when asking for a replacement
      lastKnownName: p.foodId ? (unresolved[p.foodId] ? unresolved[p.foodId].name : labels[p.foodId] || null) : null
    }));
    return { mealId: meal.id, ...calc, problems };
  }

  const api = {
    /** Library Meals; retired ones are hidden unless includeRetired. Copies. */
    getLibraryMeals({ includeRetired = false } = {}) {
      return clone(store.get('libraryMeals').filter((m) => includeRetired || !(m.metadata && m.metadata.retired)));
    },

    getSavedMeals() {
      return clone(store.get('savedMeals'));
    },

    /** A Library or Saved Meal by ID, or null. */
    getMeal(id) {
      const m = findMeal(id);
      return m ? clone(m) : null;
    },

    /**
     * P/C/F for a Meal (object or ID) from its ingredients and the current Foods.
     * Never throws for data problems: returns { valid, needsReplacement, totals, problems … }.
     * An invalid Meal has totals: null — partial numbers are never presented as a Meal's total.
     */
    calculateMealMacros(mealOrId) {
      const meal = typeof mealOrId === 'string' ? findMeal(mealOrId) : mealOrId;
      if (!meal) throw new DomainError('MEAL_NOT_FOUND', `no Meal ${mealOrId}`);
      return describe(meal);
    },

    /** Meals from the most recent Meal Instances that still exist, newest first. */
    getRecentMeals({ limit = 10 } = {}) {
      const out = [];
      const seen = new Set();
      for (const mi of ctx.instancesNewestFirst()) {
        if (!mi.sourceMealId || seen.has(mi.sourceMealId)) continue;
        seen.add(mi.sourceMealId);
        const m = findMeal(mi.sourceMealId);
        if (m) out.push(clone(m));
        if (out.length >= limit) break;
      }
      return out;
    },

    /**
     * Create a Saved Meal, either as a copy ({ fromMealId, name? }) or from scratch
     * ({ name, mealType, ingredients, metadata? }). Always a new, independent ID.
     */
    createSavedMeal(input = {}) {
      const now = ctx.now();
      let meal;
      if (input.fromMealId) {
        const src = findMeal(input.fromMealId);
        if (!src) throw new DomainError('MEAL_NOT_FOUND', `no Meal ${input.fromMealId}`);
        const calc = calculate(src, ctx.lookupFood);
        if (calc.needsReplacement) throw new DomainError('MEAL_INVALID', `${src.id} uses a Food that no longer exists; replace it before copying`, calc.problems);
        const metadata = clone(src.metadata || {});
        for (const k of LIBRARY_ONLY_METADATA) delete metadata[k];
        meal = {
          id: newSavedMealId(),
          name: input.name || src.name,
          source: 'saved',
          mealType: src.mealType || 'other',
          ingredients: clone(src.ingredients),
          metadata: { ...metadata, copiedFromMealId: src.id, createdAt: now, updatedAt: now }
        };
      } else {
        if (!input.name) throw new DomainError('INVALID_MEAL', 'name is required');
        const mealType = input.mealType || 'other';
        assertMealType(mealType);
        const ingredients = checkIngredients(input.ingredients);
        meal = {
          id: newSavedMealId(),
          name: input.name,
          source: 'saved',
          mealType,
          ingredients,
          metadata: { ...clone(input.metadata || {}), createdAt: now, updatedAt: now }
        };
      }
      meal.metadata = tidyMetadata(meal.metadata, meal.ingredients);
      store.commit({ savedMeals: [...store.get('savedMeals'), meal] });
      return clone(meal);
    },

    /**
     * Edit a Saved Meal (the living recipe). Future use changes; logged Meal Instances do
     * not. Library Meals cannot be edited. Patch: { name, mealType, ingredients, metadata }.
     * Replacing an ingredient drops its old label and any unresolved-Food note.
     */
    updateSavedMeal(id, patch = {}) {
      const current = savedMealOrThrow(id);
      if ('id' in patch && patch.id !== id) throw new DomainError('IMMUTABLE_ID', 'Meal IDs never change');
      const next = clone(current);
      if ('name' in patch) {
        if (!patch.name) throw new DomainError('INVALID_MEAL', 'name cannot be empty');
        next.name = patch.name;
      }
      if ('mealType' in patch) { assertMealType(patch.mealType); next.mealType = patch.mealType; }
      if ('ingredients' in patch) next.ingredients = checkIngredients(patch.ingredients);
      if (patch.metadata) {
        const protectedKeys = ['createdAt', 'copiedFromMealId', 'unresolvedFoods'];
        const incoming = clone(patch.metadata);
        for (const k of protectedKeys) delete incoming[k];
        next.metadata = { ...next.metadata, ...incoming };
      }
      next.metadata = tidyMetadata({ ...next.metadata, updatedAt: ctx.now() }, next.ingredients);
      store.commit({ savedMeals: store.get('savedMeals').map((m) => (m.id === id ? next : m)) });
      return clone(next);
    },

    /**
     * Replace one Food in a Saved Meal — the fix for a Meal made invalid by a deleted
     * Custom Food. Keeps the quantity unless a new one is given.
     */
    replaceSavedMealIngredient(id, oldFoodId, newFoodId, { quantity } = {}) {
      const current = savedMealOrThrow(id);
      if (!current.ingredients.some((i) => i.foodId === oldFoodId)) throw new DomainError('INGREDIENT_NOT_FOUND', `${id} does not use ${oldFoodId}`);
      const ingredients = current.ingredients.map((i) => (i.foodId === oldFoodId
        ? { foodId: newFoodId, quantity: quantity === undefined ? i.quantity : quantity, unit: i.unit }
        : i));
      return api.updateSavedMeal(id, { ingredients });
    },

    /** Copy a Saved Meal under a new ID. */
    duplicateSavedMeal(id, { name } = {}) {
      const src = savedMealOrThrow(id);
      return api.createSavedMeal({ fromMealId: src.id, name: name || `${src.name} (copy)` });
    },

    /** Remove a Saved Meal. Logged Meal Instances keep their snapshots. */
    deleteSavedMeal(id) {
      savedMealOrThrow(id);
      const prefs = clone(store.get('preferences'));
      prefs.favoriteMeals = prefs.favoriteMeals.filter((x) => x !== id);
      store.commit({ savedMeals: store.get('savedMeals').filter((m) => m.id !== id), preferences: prefs });
      return { deletedMealId: id };
    },

    /** Internal: raw meal lookup for other modules. */
    _findMeal: findMeal,
    _describe: describe
  };
  return api;
}
