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

/**
 * Deep copy through JSON. A NaN / Infinity / -Infinity anywhere is refused rather than
 * silently turned into null (which is what JSON would do), so no input can smuggle a
 * non-finite number past validation by being copied first.
 */
function finiteOnly(key, value) {
  if (typeof value === 'number' && !Number.isFinite(value)) {
    throw new DomainError('VALIDATION_FAILED', `${value} is not a finite number${key ? ` (at "${key}")` : ''}`);
  }
  return value;
}
export const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v, finiteOnly)));

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

/**
 * The calendar date of a moment in the device's own time zone, as YYYY-MM-DD.
 * Built from local date components on purpose: toISOString() is a UTC conversion and
 * rolls "today" forward in the evening west of Greenwich.
 */
export function localDate(d) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/**
 * Search normalisation and ranking, shared by searchFoods and searchMeals so both rank the
 * same way: lower-case, accents removed, punctuation → spaces.
 */
export const normText = (s) => String(s).toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
  .replace(/[^a-z0-9%]+/g, ' ').trim();

/**
 * How well a normalised query matches a text: exact 100 > starts with 80 > every query word
 * starts a word in the text 60 > substring 40 > no match 0.
 */
export function textMatchScore(q, text) {
  const t = normText(text);
  if (!q) return 0;
  if (t === q) return 100;
  if (t.startsWith(q)) return 80;
  const words = q.split(' ');
  if (words.every((w) => t.split(' ').some((tw) => tw.startsWith(w)))) return 60;
  if (t.includes(q)) return 40;
  return 0;
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
