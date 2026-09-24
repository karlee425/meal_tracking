/*
 * constants.js — canonical V2 enumerations (they mirror data/schemas/*).
 */

/** Day types. The legacy key "long" is not valid in V2; use "long_run". */
export const DAY_TYPES = Object.freeze(['lift', 'long_run', 'rest']);

/** What a Meal is (Library / Saved Meal classification). */
export const MEAL_TYPES = Object.freeze(['breakfast', 'lunch', 'snack', 'dinner', 'other']);

/**
 * Where a Meal Instance was logged. Independent of mealType: a "snack" Meal can be logged
 * into either snack slot. There is no per-slot macro allocation.
 */
export const MEAL_SLOTS = Object.freeze(['breakfast', 'lunch', 'snack_afternoon', 'dinner', 'snack_night']);

export const FOOD_STATES = Object.freeze(['raw', 'dry', 'cooked', 'roasted', 'boiled', 'baked', 'prepared', 'frozen', 'other']);
