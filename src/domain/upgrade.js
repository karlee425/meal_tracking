/*
 * upgrade.js — the user-data format version and the upgrade chain (V3 Slice 1 · C2).
 *
 * "User data" is the set of user-owned collections a backup or the browser's stored record
 * carries:
 *   version 1  targets, customFoods, savedMeals, days, preferences   (the app as merged at 936753b)
 *   version 2  version 1 + userFoodData { foods: [], retiredServingIds: [] }
 *
 * upgradeUserData(data, fromVersion) returns a NEW object in the current format:
 *   - pure: no clock, no IDs, no randomness, no I/O; the input is never changed
 *   - deterministic: equal input gives equal output; top-level collections always come out in
 *     the order listed above, everything inside them keeps its own order
 *   - 1 → 2 copies the five collections exactly (every logged-meal snapshot, target and
 *     preference unchanged) and adds the empty userFoodData
 *   - a version-2 input is checked and copied unchanged, so calling it again is harmless
 *
 * Checks here are STRUCTURAL: a supported version, exactly the right collections, the right
 * container types, and JSON-only values (no NaN / Infinity, undefined, functions, class
 * instances or sparse arrays). Record-level rules stay with the JSON schemas and the store,
 * which validate the result before anything is used or written.
 *
 * Failures throw DomainError USER_DATA_VERSION_UNSUPPORTED or USER_DATA_INVALID (details: the
 * problems found, at most 20). The data carries no version of its own: the version comes from
 * the caller's envelope (store record or backup), and any extra top-level field — a version
 * field included — is rejected. Nothing calls this yet: the store, backups and browser adapter are wired to
 * it in a later step.
 */

import { DomainError, clone } from './util.js';

export const USER_DATA_FORMAT_VERSION = 2;

/** The collections each format version holds, in output order. */
export const USER_DATA_COLLECTIONS = Object.freeze({
  1: Object.freeze(['targets', 'customFoods', 'savedMeals', 'days', 'preferences']),
  2: Object.freeze(['targets', 'customFoods', 'savedMeals', 'days', 'preferences', 'userFoodData'])
});

const CONTAINER_KIND = Object.freeze({
  targets: 'object', customFoods: 'array', savedMeals: 'array', days: 'array', preferences: 'object', userFoodData: 'object'
});
const USER_FOOD_DATA_FIELDS = Object.freeze(['foods', 'retiredServingIds']);
const MAX_REPORTED = 20;

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)
  && (Object.getPrototypeOf(v) === Object.prototype || Object.getPrototypeOf(v) === null);

/** Values JSON can carry unchanged: string, finite number, boolean, null, dense array, plain object. */
function jsonProblems(value, where, out) {
  if (out.length >= MAX_REPORTED) return out;
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return out;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) out.push(`${where}: ${value} is not a finite number`);
    return out;
  }
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i += 1) {
      if (!(i in value)) out.push(`${where}[${i}]: missing array entry`);
      else jsonProblems(value[i], `${where}[${i}]`, out);
    }
    return out;
  }
  if (isPlainObject(value)) {
    for (const [k, v] of Object.entries(value)) jsonProblems(v, `${where}.${k}`, out);
    return out;
  }
  out.push(`${where}: ${value === undefined ? 'undefined' : typeof value === 'object' ? 'a non-plain object' : `a ${typeof value}`} is not a JSON value`);
  return out;
}

function structureProblems(data, version) {
  if (!isPlainObject(data)) return ['user data must be a plain object'];
  const expected = USER_DATA_COLLECTIONS[version];
  const problems = [];
  for (const k of Object.keys(data)) if (!expected.includes(k)) problems.push(`unexpected collection "${k}" for format version ${version}`);
  for (const c of expected) {
    if (!Object.hasOwn(data, c)) { problems.push(`missing collection "${c}"`); continue; }
    const ok = CONTAINER_KIND[c] === 'array' ? Array.isArray(data[c]) : isPlainObject(data[c]);
    if (!ok) problems.push(`"${c}" must be ${CONTAINER_KIND[c] === 'array' ? 'an array' : 'a plain object'}`);
  }
  if (Object.hasOwn(data, 'userFoodData') && isPlainObject(data.userFoodData)) {
    const u = data.userFoodData;
    for (const k of Object.keys(u)) if (!USER_FOOD_DATA_FIELDS.includes(k)) problems.push(`unexpected userFoodData field "${k}"`);
    for (const k of USER_FOOD_DATA_FIELDS) if (!Array.isArray(u[k])) problems.push(`userFoodData.${k} must be an array`);
  }
  // Bounded: at most MAX_REPORTED problems are reported, however malformed the input is.
  return jsonProblems(data, 'data', problems).slice(0, MAX_REPORTED);
}

/** The collections of `version`, deep-copied, in canonical order. */
const orderedCopy = (data, version) => Object.fromEntries(USER_DATA_COLLECTIONS[version].map((c) => [c, clone(data[c])]));

/** One step per version: STEPS[n] turns version n into version n + 1. */
const STEPS = Object.freeze({
  1: (v1) => ({ ...v1, userFoodData: { foods: [], retiredServingIds: [] } })
});

const describeVersion = (v) => (typeof v === 'string' ? JSON.stringify(v) : String(v));

/**
 * Upgrade user data from `fromVersion` to USER_DATA_FORMAT_VERSION. Returns a new object;
 * throws DomainError USER_DATA_VERSION_UNSUPPORTED or USER_DATA_INVALID and changes nothing.
 */
export function upgradeUserData(data, fromVersion) {
  if (!Number.isInteger(fromVersion) || fromVersion < 1 || fromVersion > USER_DATA_FORMAT_VERSION) {
    throw new DomainError('USER_DATA_VERSION_UNSUPPORTED', `user data format version ${describeVersion(fromVersion)} is not supported; this app reads versions 1 to ${USER_DATA_FORMAT_VERSION}`);
  }
  const problems = structureProblems(data, fromVersion);
  if (problems.length) {
    throw new DomainError('USER_DATA_INVALID', `user data (format version ${fromVersion}) is not valid: ${problems.slice(0, 3).join('; ')}`, problems);
  }
  let current = orderedCopy(data, fromVersion);
  for (let version = fromVersion; version < USER_DATA_FORMAT_VERSION; version += 1) current = STEPS[version](current);
  const after = structureProblems(current, USER_DATA_FORMAT_VERSION);
  if (after.length) throw new DomainError('USER_DATA_INVALID', `upgraded user data is not valid: ${after.slice(0, 3).join('; ')}`, after);
  return current;
}
