/*
 * macros.js — THE canonical P/C/F calculator.
 *
 * This is the only place in the application (and, via migration/macro-calc.js, in the
 * migration tooling) where protein / carbs / fat arithmetic happens:
 *
 *   contribution = quantity / 100 × Food nutrition        (nutrition basis "100g", quantity in g)
 *   meal total   = sum of ingredient contributions
 *   remaining    = daily target − logged
 *
 * Meal detail, Saved Meals, logging, Today, Progress and the Macro Coach context all call
 * these functions. No other module may do P/C/F arithmetic.
 *
 * Rules:
 *   - protein, carbs and fat are the only nutrition dimensions
 *   - the Food's stored nutrition is used as-is: no raw↔cooked conversion, no yield factors
 *   - grams only; any other unit is reported, never converted
 *   - calculateMealMacros never throws: a missing Food or bad quantity is reported so the
 *     caller can show the Meal as invalid and ask for a replacement
 *   - values are returned unrounded; roundMacros is for display only
 */

export const MACROS = Object.freeze(['protein', 'carbs', 'fat']);
export const CANONICAL_UNIT = 'g';
const EPSILON = 1e-9;

export function zeroMacros() {
  return { protein: 0, carbs: 0, fat: 0 };
}

/** Why an ingredient cannot be calculated, or null when it can. */
export function checkIngredient(food, quantity, unit) {
  if (!food) return { code: 'FOOD_MISSING', message: 'Food not found' };
  if (unit !== CANONICAL_UNIT) return { code: 'UNSUPPORTED_UNIT', message: `unsupported unit "${unit}" for ${food.id} (only "g"; no silent conversion)` };
  if (!(typeof quantity === 'number' && Number.isFinite(quantity) && quantity > 0)) {
    return { code: 'INVALID_QUANTITY', message: `quantity must be > 0 for ${food.id}, got ${quantity}` };
  }
  if (!food.nutrition || food.nutrition.basis !== '100g') {
    return { code: 'UNSUPPORTED_BASIS', message: `food ${food.id} has unsupported nutrition basis` };
  }
  return null;
}

// The formula. Every P/C/F contribution in the system comes from this function.
function contribution(food, quantity) {
  const out = {};
  for (const m of MACROS) out[m] = (quantity / 100) * food.nutrition[m];
  return out;
}

/** Contribution of one ingredient. Throws on invalid input (use checkIngredient first). */
export function ingredientContribution(food, quantity, unit) {
  const problem = checkIngredient(food, quantity, unit);
  if (problem) throw new Error(food ? problem.message : 'ingredientContribution: food is required');
  return contribution(food, quantity);
}

/**
 * calculateMealMacros(meal, getFood)
 *   meal.ingredients: [{ foodId, quantity, unit }]
 *   getFood(foodId) -> Food | null
 * Never throws. Returns:
 *   {
 *     valid,                 every ingredient calculated
 *     needsReplacement,      at least one ingredient's Food no longer exists
 *     totals,                {protein, carbs, fat} when valid, otherwise null
 *     partialTotals,         sum of the calculable ingredients when invalid, otherwise null
 *     ingredients,           [{ index, foodId, foodName, quantity, unit, status, protein, carbs, fat }]
 *     problems               [{ index, foodId, quantity, unit, code, message }]
 *   }
 */
export function calculateMealMacros(meal, getFood) {
  const totals = zeroMacros();
  const ingredients = [];
  const problems = [];
  (meal.ingredients || []).forEach((ing, index) => {
    const food = getFood(ing.foodId) || null;
    const problem = checkIngredient(food, ing.quantity, ing.unit);
    if (problem) {
      problems.push({ index, foodId: ing.foodId, quantity: ing.quantity, unit: ing.unit, code: problem.code, message: problem.message });
      ingredients.push({ index, foodId: ing.foodId, foodName: food ? food.name : null, quantity: ing.quantity, unit: ing.unit, status: problem.code });
      return;
    }
    const c = contribution(food, ing.quantity);
    for (const m of MACROS) totals[m] += c[m];
    ingredients.push({ index, foodId: ing.foodId, foodName: food.name, quantity: ing.quantity, unit: ing.unit, status: 'ok', ...c });
  });
  if (!ingredients.length) problems.push({ index: null, foodId: null, code: 'NO_INGREDIENTS', message: 'meal has no ingredients' });
  const valid = problems.length === 0;
  return {
    valid,
    needsReplacement: problems.some((p) => p.code === 'FOOD_MISSING'),
    totals: valid ? totals : null,
    partialTotals: valid ? null : totals,
    ingredients,
    problems
  };
}

/**
 * Re-scale a historical snapshot ingredient to a new quantity using the snapshot's own
 * values (so an edit to a logged meal never depends on today's Food data, which may have
 * changed or been deleted).
 */
export function rescaleSnapshotIngredient(snapshotIngredient, newQuantity) {
  if (!(typeof newQuantity === 'number' && Number.isFinite(newQuantity) && newQuantity > 0)) {
    throw new Error(`quantity must be > 0, got ${newQuantity}`);
  }
  const out = { ...snapshotIngredient, quantity: newQuantity };
  for (const m of MACROS) out[m] = (newQuantity / snapshotIngredient.quantity) * snapshotIngredient[m];
  return out;
}

/** Sum a list of {protein, carbs, fat} objects. */
export function sumMacros(list) {
  const out = zeroMacros();
  for (const x of list) for (const m of MACROS) out[m] += x[m];
  return out;
}

/** a − b, per macro (e.g. remaining = target − logged). Can be negative. */
export function subtractMacros(a, b) {
  const out = {};
  for (const m of MACROS) out[m] = a[m] - b[m];
  return out;
}

/** Mean of a non-empty list of {protein, carbs, fat}; null for an empty list. */
export function averageMacros(list) {
  if (!list.length) return null;
  const total = sumMacros(list);
  const out = {};
  for (const m of MACROS) out[m] = total[m] / list.length;
  return out;
}

/** Targets are floors: per macro, is actual at or above target? */
export function meetsTarget(actual, target) {
  const out = {};
  for (const m of MACROS) out[m] = actual[m] >= target[m] - EPSILON;
  return out;
}

/** Copy only protein/carbs/fat from an object. */
export function pickMacros(x) {
  return { protein: x.protein, carbs: x.carbs, fat: x.fat };
}

/** Display rounding only. Never store rounded values as authoritative. */
export function roundMacros(x, decimals = 1) {
  const f = 10 ** decimals;
  const out = {};
  for (const m of MACROS) out[m] = Math.round(x[m] * f) / f;
  return out;
}
