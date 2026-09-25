/*
 * coach.js — the Macro Coach's data: context plus a deterministic suggestion order.
 * No chat, no AI dependency, no nutrition scoring, no macro-fit ranking. Everything is
 * derived through the same APIs the rest of the app uses (macros come from macros.js via
 * meals/days), so there is no second copy of any rule.
 *
 * Suggestion order (getMacroCoachSuggestions), approved for V2:
 *   1. favorite  — favourite Saved Meals
 *   2. recent    — recently logged Meals (Saved or Library), newest first
 *   3. saved     — the user's other Saved Meals
 *   4. library   — Library starter Meals (app content, not personal)
 * plus, separately, top-up Foods: favourite and recently logged Foods, and — only while
 * personal history is thin — Foods the Library Meals use most (again, not personal).
 * Within a tier, order is by recency, update time or file order, then name: never by
 * how well a meal fits the remaining macros.
 */

import { DomainError, clone, assertDate, assertMealSlot, assertDayType } from './util.js';
import { sumMacros, targetStatus, zeroMacros } from './macros.js';

/** Fewer personal (tier 1–3) meals than this → insufficientHistory: true. */
export const COACH_MIN_PERSONAL_MEALS = 3;
/** How many starter Foods to offer while history is thin. */
export const COACH_STARTER_FOOD_LIMIT = 10;

export function createCoachApi(ctx, { foods, meals, days, targets, preferences }) {
  function mealEntry(meal) {
    const calc = meals._describe(meal);
    return {
      id: meal.id,
      name: meal.name,
      source: meal.source,
      mealType: meal.mealType || null,
      valid: calc.valid,
      needsReplacement: calc.needsReplacement,
      totals: calc.totals,
      problems: calc.problems
    };
  }

  /**
   * getMacroCoachContext({ date, mealSlot, dayType? })
   * dayType is only used when no Day exists yet for that date (then the current targets
   * for that type are shown and targetSource is "current").
   */
  function getMacroCoachContext({ date, mealSlot, dayType } = {}) {
    assertDate(date);
    assertMealSlot(mealSlot);
    const summary = days.getDaySummary(date);
    let target = summary.target;
    let resolvedDayType = summary.dayType;
    let targetSource = summary.exists ? 'day_snapshot' : null;
    if (!summary.exists && dayType !== undefined) {
      assertDayType(dayType);
      resolvedDayType = dayType;
      target = targets.createTargetSnapshot(dayType);
      targetSource = 'current';
    }
    if (!summary.exists && dayType === undefined) {
      throw new DomainError('DAY_TYPE_REQUIRED', `no Day for ${date}; pass dayType to build a context`);
    }
    const remaining = summary.exists ? summary.remaining : target; // nothing logged yet on a day that does not exist

    const prefs = preferences.getPreferences();
    const disliked = new Set(prefs.dislikedFoods);
    const relevant = new Map();
    const add = (food, reason) => {
      if (!food || disliked.has(food.id)) return;
      const e = relevant.get(food.id) || { id: food.id, name: food.name, source: food.source, category: food.category, state: food.state, nutrition: clone(food.nutrition), tags: clone(food.tags || []), reasons: [] };
      if (!e.reasons.includes(reason)) e.reasons.push(reason);
      relevant.set(food.id, e);
    };
    for (const id of prefs.favoriteFoods) add(foods.getFood(id), 'favorite');
    for (const f of foods.getRecentFoods()) add(f, 'recent');

    return {
      date,
      dayType: resolvedDayType,
      mealSlot,
      targetSource,
      target,
      logged: summary.logged,
      remaining: { protein: remaining.protein, carbs: remaining.carbs, fat: remaining.fat },
      loggedSlots: summary.loggedSlots,
      unloggedSlots: summary.unloggedSlots,
      savedMeals: meals.getSavedMeals().map(mealEntry),
      recentMeals: meals.getRecentMeals().map(mealEntry),
      favoriteMealIds: clone(prefs.favoriteMeals),
      relevantFoods: [...relevant.values()],
      preferences: prefs
    };
  }

  const byName = (a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id);

  /**
   * getMacroCoachSuggestions({ date, mealSlot, dayType?, limitPerTier? })
   * Same inputs and DAY_TYPE_REQUIRED rule as getMacroCoachContext. Returns:
   * {
   *   date, dayType, mealSlot, targetSource, target, logged, remaining, reached, overBy,
   *   insufficientHistory, personalMealCount,
   *   tiers: [{ tier: 'favorite' | 'recent' | 'saved' | 'library', personalized, total,
   *             items: [{ mealId, name, source, mealType, isFavorite, totals,
   *                       after: { logged, remaining, reached, overBy } }] }],
   *   topUpFoods: { personalized: [{ food, reasons }], starter: [{ food, reasons, usedInLibraryMeals }] },
   *   excluded: { needsReplacement: [mealId] }
   * }
   * A meal appears once, in its first tier. Meals that cannot be calculated are excluded
   * (and listed). Retired Library Meals are never starters. Library starters that use a
   * disliked Food are left out; personal meals are never filtered by dislikes.
   */
  function getMacroCoachSuggestions({ date, mealSlot, dayType, limitPerTier } = {}) {
    const context = getMacroCoachContext({ date, mealSlot, dayType });
    if (limitPerTier !== undefined && !(Number.isInteger(limitPerTier) && limitPerTier > 0)) {
      throw new DomainError('INVALID_ARGUMENT', 'limitPerTier must be a positive whole number');
    }
    const target = context.target;
    const logged = context.logged || zeroMacros();
    const prefs = context.preferences;
    const favorite = new Set(prefs.favoriteMeals);
    const disliked = new Set(prefs.dislikedFoods);

    // Most recent log time per source Meal (instances newest first).
    const lastLogged = new Map();
    for (const mi of ctx.instancesNewestFirst()) if (mi.sourceMealId && !lastLogged.has(mi.sourceMealId)) lastLogged.set(mi.sourceMealId, mi.loggedAt);

    const used = new Set();
    const needsReplacement = [];
    const calcCache = new Map();
    const describe = (meal) => {
      if (!calcCache.has(meal.id)) calcCache.set(meal.id, meals._describe(meal));
      return calcCache.get(meal.id);
    };
    const usable = (meal) => {
      if (used.has(meal.id)) return false;
      const calc = describe(meal);
      if (!calc.valid) { if (!needsReplacement.includes(meal.id)) needsReplacement.push(meal.id); return false; }
      return true;
    };
    const item = (meal) => {
      const totals = describe(meal).totals;
      const loggedAfter = sumMacros([logged, totals]);
      return {
        mealId: meal.id,
        name: meal.name,
        source: meal.source,
        mealType: meal.mealType || null,
        isFavorite: favorite.has(meal.id),
        totals,
        after: { logged: loggedAfter, ...targetStatus(target, loggedAfter) }
      };
    };
    const tier = (name, personalized, list) => {
      for (const m of list) used.add(m.id);
      const items = list.map(item);
      return { tier: name, personalized, total: items.length, items: limitPerTier ? items.slice(0, limitPerTier) : items };
    };
    const newestLoggedFirst = (a, b) => {
      const ta = lastLogged.get(a.id) || '';
      const tb = lastLogged.get(b.id) || '';
      return ta < tb ? 1 : ta > tb ? -1 : byName(a, b);
    };

    const saved = meals.getSavedMeals();

    // 1. Favourite Saved Meals: most recently logged first, then name.
    const t1 = saved.filter((m) => favorite.has(m.id) && usable(m)).sort(newestLoggedFirst);
    const tierFavorite = tier('favorite', true, t1);

    // 2. Recently logged Meals (Saved or Library), newest first.
    const t2 = [];
    for (const id of lastLogged.keys()) {
      const m = ctx.findMeal(id);
      if (m && usable(m)) { t2.push(clone(m)); used.add(m.id); }
    }
    const tierRecent = tier('recent', true, t2);

    // 3. Other Saved Meals: most recently updated first, then name.
    const updated = (m) => (m.metadata && m.metadata.updatedAt) || '';
    const t3 = saved.filter((m) => usable(m)).sort((a, b) => (updated(a) < updated(b) ? 1 : updated(a) > updated(b) ? -1 : byName(a, b)));
    const tierSaved = tier('saved', true, t3);

    // 4. Library starter Meals: favourites first, then the Library's own order.
    const library = meals.getLibraryMeals()
      .filter((m) => !m.ingredients.some((i) => disliked.has(i.foodId)))
      .filter((m) => usable(m));
    const t4 = [...library.filter((m) => favorite.has(m.id)), ...library.filter((m) => !favorite.has(m.id))];
    const tierLibrary = tier('library', false, t4);

    const personalMealCount = tierFavorite.total + tierRecent.total + tierSaved.total;
    const insufficientHistory = personalMealCount < COACH_MIN_PERSONAL_MEALS;

    // Top-up Foods: personal first (favourites, then recent — already in that order and
    // without disliked Foods in the context); starter Foods only while history is thin.
    const personalFoods = context.relevantFoods.map((f) => ({ food: f, reasons: f.reasons.slice() }));
    let starter = [];
    if (insufficientHistory || personalFoods.length < COACH_MIN_PERSONAL_MEALS) {
      const listed = new Set(personalFoods.map((x) => x.food.id));
      const usage = new Map();
      for (const m of meals.getLibraryMeals()) for (const id of new Set(m.ingredients.map((i) => i.foodId))) usage.set(id, (usage.get(id) || 0) + 1);
      starter = [...usage.entries()]
        .map(([id, count]) => ({ food: foods.getFood(id), count }))
        .filter((x) => x.food && !listed.has(x.food.id) && !disliked.has(x.food.id) && !(x.food.metadata && x.food.metadata.active === false))
        .sort((a, b) => b.count - a.count || byName(a.food, b.food))
        .slice(0, COACH_STARTER_FOOD_LIMIT)
        .map((x) => ({ food: x.food, reasons: ['library_ingredient'], usedInLibraryMeals: x.count }));
    }

    return {
      date: context.date,
      dayType: context.dayType,
      mealSlot: context.mealSlot,
      targetSource: context.targetSource,
      target,
      logged: context.logged,
      ...targetStatus(target, logged),
      insufficientHistory,
      personalMealCount,
      tiers: [tierFavorite, tierRecent, tierSaved, tierLibrary],
      topUpFoods: { personalized: personalFoods, starter },
      excluded: { needsReplacement }
    };
  }

  return { getMacroCoachContext, getMacroCoachSuggestions };
}
