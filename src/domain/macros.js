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
 *   - a named serving is resolved to grams here (servingQuantity) before anything else
 *     sees it; everything downstream still takes grams only
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

/**
 * Where logged stands against a target, per macro. Targets are floors.
 *   remaining  target − logged (negative once past the target)
 *   reached    logged ≥ target
 *   overBy     how far past the target, ≥ 0 (0 while still short)
 *   progress   logged ÷ target, capped at 1 (a target of 0 counts as reached: 1) —
 *              for progress bars, so screens never divide macros themselves
 * Screens use this instead of negating, comparing or dividing remaining themselves.
 */
export function targetStatus(target, logged) {
  const remaining = subtractMacros(target, logged);
  const reached = meetsTarget(logged, target);
  const overBy = {};
  const progress = {};
  for (const m of MACROS) {
    overBy[m] = remaining[m] < 0 ? -remaining[m] : 0;
    progress[m] = target[m] > 0 ? Math.min(logged[m] / target[m], 1) : 1;
  }
  return { remaining, reached, overBy, progress };
}

/** Grams of protein + carbs + fat per 100 g may exceed 100 by at most this much (label rounding). */
export const NUTRITION_SUM_TOLERANCE_G = 1;

/**
 * Check per-100 g nutrition values as a user would enter them for a Food.
 * Never throws. Returns [{ field, code, message }] (empty when valid):
 *   NUTRITION_REQUIRED      a macro is missing
 *   NUTRITION_NOT_A_NUMBER  not a number, or NaN / Infinity / -Infinity
 *   NUTRITION_NEGATIVE      below 0
 *   NUTRITION_IMPOSSIBLE    protein + carbs + fat is more than 100 g per 100 g (+ tolerance)
 * Only protein, carbs and fat exist; any other key is reported as NUTRITION_UNKNOWN_FIELD.
 */
export function checkNutritionValues(nutrition) {
  if (!nutrition || typeof nutrition !== 'object' || Array.isArray(nutrition)) {
    return [{ field: 'nutrition', code: 'NUTRITION_REQUIRED', message: 'nutrition { protein, carbs, fat } per 100 g is required' }];
  }
  const problems = [];
  for (const k of Object.keys(nutrition)) {
    if (k !== 'basis' && !MACROS.includes(k)) problems.push({ field: `nutrition.${k}`, code: 'NUTRITION_UNKNOWN_FIELD', message: `nutrition only has protein, carbs and fat; got "${k}"` });
  }
  let allNumbers = true;
  for (const m of MACROS) {
    const v = nutrition[m];
    const field = `nutrition.${m}`;
    if (v === undefined || v === null || v === '') { problems.push({ field, code: 'NUTRITION_REQUIRED', message: `${m} is required` }); allNumbers = false; }
    else if (typeof v !== 'number' || !Number.isFinite(v)) { problems.push({ field, code: 'NUTRITION_NOT_A_NUMBER', message: `${m} must be a finite number` }); allNumbers = false; }
    else if (v < 0) problems.push({ field, code: 'NUTRITION_NEGATIVE', message: `${m} cannot be negative` });
  }
  if (allNumbers) {
    const total = sumMacros([pickMacros(nutrition)]);
    const grams = total.protein + total.carbs + total.fat;
    if (grams > 100 + NUTRITION_SUM_TOLERANCE_G) {
      problems.push({ field: 'nutrition', code: 'NUTRITION_IMPOSSIBLE', message: `protein + carbs + fat is ${Math.round(grams * 10) / 10} g per 100 g; it cannot be more than 100 g` });
    }
  }
  return problems;
}

/** Display rounding only. Never store rounded values as authoritative. */
export function roundMacros(x, decimals = 1) {
  const f = 10 ** decimals;
  const out = {};
  for (const m of MACROS) out[m] = Math.round(x[m] * f) / f;
  return out;
}

/* ---------------- named servings → canonical grams (V3 Slice 1 · C6) ----------------
 *
 * Grams stay canonical. A serving is an alternate way to enter an amount: its stored weight
 * in grams × a count. The result is the gram quantity that preview, logging and the meal
 * tray all receive — one number, worked out once, here.
 *
 *   exact      = serving grams × n / d                (kept as an exact fraction)
 *   canonical  = exact rounded half-up to 0.01 g      (the quantity passed on)
 *   text       = canonical as a decimal string, trailing zeros trimmed ("45", "67.5", "33.33")
 *
 * The arithmetic is done in integers (BigInt), not binary floating point, so 0.1 × 3 is
 * 0.3 and 1.005 × 1 rounds to 1.01. The serving weight is read as the decimal JavaScript
 * prints for it (the shortest text that reads back as the same number), which is the value
 * that was entered or stored. The count is an exact fraction from the domain's parser.
 */

/** A positive finite number as an exact decimal: mantissa / 10^scale. null for anything else. */
function exactDecimal(x) {
  if (!(typeof x === 'number' && Number.isFinite(x) && x > 0)) return null;
  const m = /^(\d+)(?:\.(\d+))?(?:e([+-]\d+))?$/.exec(String(x));
  if (!m) return null;
  const frac = m[2] || '';
  let scale = frac.length - Number(m[3] || 0);
  let mantissa = BigInt(m[1] + frac);
  if (scale < 0) { mantissa *= 10n ** BigInt(-scale); scale = 0; }
  return { mantissa, scale };
}

/** Decimal places in a positive finite number as written (30 → 0, 22.5 → 1, 0.125 → 3). null if not positive and finite. */
export function decimalPlaces(x) {
  const d = exactDecimal(x);
  if (!d) return null;
  let { mantissa, scale } = d;
  while (scale > 0 && mantissa % 10n === 0n) { mantissa /= 10n; scale -= 1; }
  return scale;
}

/**
 * servingQuantity(grams, { n, d }) → { quantity, text, centigrams, rounded }
 *   grams       the serving's stored weight (> 0, finite)
 *   n, d        the count as a positive BigInt fraction (from parseServingCount)
 *   quantity    canonical grams (a Number equal to Number(text)); 0 when the amount rounds to nothing
 *   text        the same value as text, for display and for the grams field / tray
 *   centigrams  the canonical value in hundredths of a gram (BigInt)
 *   rounded     true when the exact amount had more than two decimal places
 * Throws on input outside those types (callers validate first and report domain errors).
 */
export function servingQuantity(grams, count) {
  const g = exactDecimal(grams);
  if (!g) throw new Error(`serving grams must be a positive finite number, got ${grams}`);
  const { n, d } = count || {};
  if (typeof n !== 'bigint' || typeof d !== 'bigint' || n <= 0n || d <= 0n) throw new Error('count must be a positive BigInt fraction');
  const num = g.mantissa * n * 100n;            // exact centigrams = num / den
  const den = (10n ** BigInt(g.scale)) * d;
  const centigrams = (2n * num + den) / (2n * den); // half-up; every term is positive
  const whole = centigrams / 100n;
  const cents = centigrams % 100n;
  const text = cents === 0n ? String(whole) : `${whole}.${String(cents).padStart(2, '0').replace(/0$/, '')}`;
  return { quantity: Number(text), text, centigrams, rounded: num % den !== 0n };
}
