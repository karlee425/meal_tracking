'use strict';
/*
 * macro-calc.js — the one P/C/F formula used by the migration tooling.
 *
 * Implements schema.md "Macro calculation":
 *   contribution = quantity / 100 × food nutrition   (nutrition basis "100g", quantity in g)
 *   meal total   = sum of ingredient contributions
 *
 * Only protein, carbs and fat exist. There is no other nutrition dimension.
 *
 * Scope: this module is migration tooling (migrate.js and validate.js both use it,
 * so the migration has exactly one formula). It is not the V2 runtime utility —
 * Prompt 2 owns that. When Prompt 2 adds the runtime calculator, the migration
 * should import it instead of keeping this copy, so there is still only one.
 *
 * Rules enforced here rather than trusted to callers:
 *   - unit must be "g" (canonical unit); anything else throws — no silent conversion
 *   - nutrition basis must be "100g"
 *   - quantity must be a finite number > 0
 *   - a missing Food throws — never substituted
 * Values are returned unrounded. Round only for display or comparison.
 */

const MACROS = ['protein', 'carbs', 'fat'];

function ingredientContribution(food, quantity, unit) {
  if (!food) throw new Error('ingredientContribution: food is required');
  if (unit !== 'g') throw new Error(`unsupported unit "${unit}" for ${food.id} (only "g"; no silent conversion)`);
  if (!(typeof quantity === 'number' && Number.isFinite(quantity) && quantity > 0)) {
    throw new Error(`quantity must be > 0 for ${food.id}, got ${quantity}`);
  }
  if (!food.nutrition || food.nutrition.basis !== '100g') {
    throw new Error(`food ${food.id} has unsupported nutrition basis`);
  }
  const out = {};
  for (const m of MACROS) out[m] = (quantity / 100) * food.nutrition[m];
  return out;
}

/**
 * calculateMealMacros(meal, getFood)
 *   meal.ingredients: [{ foodId, quantity, unit }]
 *   getFood(foodId) -> Food | undefined
 * Returns { totals: {protein, carbs, fat}, ingredients: [{foodId, quantity, unit, protein, carbs, fat}] }
 * Throws if any foodId does not resolve.
 */
function calculateMealMacros(meal, getFood) {
  const totals = { protein: 0, carbs: 0, fat: 0 };
  const ingredients = meal.ingredients.map((ing) => {
    const food = getFood(ing.foodId);
    if (!food) throw new Error(`meal ${meal.id}: unresolved foodId ${ing.foodId}`);
    const c = ingredientContribution(food, ing.quantity, ing.unit);
    for (const m of MACROS) totals[m] += c[m];
    return { foodId: ing.foodId, quantity: ing.quantity, unit: ing.unit, ...c };
  });
  return { totals, ingredients };
}

const round1 = (n) => Math.round(n * 10) / 10;

module.exports = { MACROS, ingredientContribution, calculateMealMacros, round1 };
