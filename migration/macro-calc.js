'use strict';
/*
 * macro-calc.js — the migration's view of the canonical P/C/F calculator.
 *
 * There is ONE formula, and it lives in src/domain/macros.js (the runtime calculator):
 *   contribution = quantity / 100 × food nutrition   (nutrition basis "100g", quantity in g)
 * This file contains no macro arithmetic of its own. It re-exports the runtime functions
 * and adds the one behaviour the migration needs that the runtime deliberately does not
 * have: it throws when a meal cannot be calculated (a missing Food, a non-gram unit, a
 * bad quantity), because a migration must stop on bad data, while the app must show the
 * meal as invalid instead of crashing.
 */

const runtime = require('../src/domain/macros.js');

/**
 * Strict form of the runtime calculateMealMacros: same numbers, but throws on the first
 * problem. Returns { totals, ingredients } as the Prompt 1 version did.
 */
function calculateMealMacros(meal, getFood) {
  const r = runtime.calculateMealMacros(meal, (id) => getFood(id) || null);
  if (!r.valid) {
    const p = r.problems[0];
    if (p.code === 'FOOD_MISSING') throw new Error(`meal ${meal.id}: unresolved foodId ${p.foodId}`);
    throw new Error(p.message);
  }
  return {
    totals: r.totals,
    ingredients: r.ingredients.map((i) => ({ foodId: i.foodId, quantity: i.quantity, unit: i.unit, protein: i.protein, carbs: i.carbs, fat: i.fat }))
  };
}

// Rounding a single number to 0.1 for the migration report's legacy comparison (display only).
const round1 = (n) => Math.round(n * 10) / 10;

module.exports = {
  MACROS: runtime.MACROS,
  ingredientContribution: runtime.ingredientContribution,
  calculateMealMacros,
  round1
};
