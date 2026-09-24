/*
 * coach.js — context for a future Macro Coach. Data only: no recommendations, no chat,
 * no AI dependency. Everything is derived through the same APIs the rest of the app uses
 * (macros come from macros.js via meals/days), so there is no second copy of any rule.
 */

import { DomainError, clone, assertDate, assertMealSlot, assertDayType } from './util.js';

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

  return { getMacroCoachContext };
}
