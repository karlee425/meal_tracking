/*
 * util.js — small shared helpers: errors, ids, dates, cloning.
 */

import { DAY_TYPES, MEAL_SLOTS, MEAL_TYPES } from './constants.js';

/** Every expected failure of a domain operation is a DomainError with a stable code. */
export class DomainError extends Error {
  constructor(code, message, details) {
    super(message);
    this.name = 'DomainError';
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

/** Identity-derived ID fragment; the same rule the migration used for Food IDs. */
export function slug(name) {
  return String(name).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
}

/** base, base_2, base_3 … — the first candidate not in `taken`. */
export function uniqueId(base, taken) {
  if (!taken.has(base)) return base;
  let n = 2;
  while (taken.has(`${base}_${n}`)) n++;
  return `${base}_${n}`;
}

export const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));

export function assertDate(date) {
  if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new DomainError('INVALID_DATE', `date must be YYYY-MM-DD, got ${JSON.stringify(date)}`);
  const d = new Date(`${date}T00:00:00Z`);
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== date) throw new DomainError('INVALID_DATE', `not a real date: ${date}`);
}

export function assertDayType(dayType) {
  if (!DAY_TYPES.includes(dayType)) {
    throw new DomainError('INVALID_DAY_TYPE', `dayType must be one of ${DAY_TYPES.join(', ')}, got ${JSON.stringify(dayType)}`);
  }
}

export function assertMealSlot(mealSlot) {
  if (!MEAL_SLOTS.includes(mealSlot)) {
    throw new DomainError('INVALID_MEAL_SLOT', `mealSlot must be one of ${MEAL_SLOTS.join(', ')}, got ${JSON.stringify(mealSlot)}`);
  }
}

export function assertMealType(mealType) {
  if (!MEAL_TYPES.includes(mealType)) {
    throw new DomainError('INVALID_MEAL_TYPE', `mealType must be one of ${MEAL_TYPES.join(', ')}, got ${JSON.stringify(mealType)}`);
  }
}

/** YYYY-MM-DD ± n days (UTC calendar arithmetic, no time zones involved). */
export function addDays(date, n) {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** Inclusive list of dates from start to end. */
export function dateRange(startDate, endDate) {
  assertDate(startDate);
  assertDate(endDate);
  if (startDate > endDate) throw new DomainError('INVALID_PERIOD', `startDate ${startDate} is after endDate ${endDate}`);
  const out = [];
  for (let d = startDate; d <= endDate; d = addDays(d, 1)) out.push(d);
  return out;
}
