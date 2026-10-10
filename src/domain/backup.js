/*
 * backup.js — manual backup and restore of the user's own data.
 *
 * A backup holds exactly the user-owned, persisted collections — the same ones every
 * adapter writes — and nothing derived:
 *
 *   {
 *     "format": "macro-tracker-v2-backup",
 *     "formatVersion": 2,
 *     "exportedAt": "2026-09-25T20:00:00.000Z",
 *     "data": {
 *       "targets":     current targets (lift / long_run / rest),
 *       "customFoods": Custom Foods,
 *       "savedMeals":  Saved Meals (ingredients only; totals are always derived),
 *       "days":        Days, each with its target snapshot, completeness and its
 *                      Meal Instances (the historical snapshots — the record itself),
 *       "preferences": favourites, dislikes and settings,
 *       "userFoodData": named servings per Food and retired serving IDs (format 2)
 *     }
 *   }
 *
 * Versions: a backup's formatVersion names its user-data format (src/domain/upgrade.js),
 * through the explicit map BACKUP_USER_DATA_VERSION. Exports are always the current version.
 * A version 1 backup (the five collections, no userFoodData) is upgraded in memory before it
 * is validated or restored; a newer or unknown version is refused (BACKUP_INCOMPATIBLE).
 * The domain upgrade's own errors never leave this module: USER_DATA_VERSION_UNSUPPORTED
 * becomes BACKUP_INCOMPATIBLE and USER_DATA_INVALID becomes BACKUP_INVALID.
 *
 * Core Foods and Library Meals are app data shipped with the app, so they are not in a
 * backup; a backup's references to them are checked against the running app's copy.
 *
 * Restore is all-or-nothing: parse → check format/version → upgrade an older version →
 * validate every record against the schemas and cross-record invariants → check references
 * → one atomic write. If any step fails nothing is changed.
 */

import { DomainError, clone } from './util.js';
import { USER_DATA_FORMAT_VERSION, USER_DATA_COLLECTIONS, upgradeUserData } from './upgrade.js';
import { carryForwardServingIds } from './serving-ids.js';

/** The format name stays "v2": it names the app generation, not the format version. */
export const BACKUP_FORMAT = 'macro-tracker-v2-backup';
export const BACKUP_FORMAT_VERSION = USER_DATA_FORMAT_VERSION;

/** Backup formatVersion → the user-data format version its `data` is in. Explicit, never inferred. */
export const BACKUP_USER_DATA_VERSION = Object.freeze({ 1: 1, 2: 2 });

/** The user-owned persisted collections of the current format, in backup order. */
export const USER_COLLECTIONS = USER_DATA_COLLECTIONS[USER_DATA_FORMAT_VERSION];

/**
 * Parse and shape-check a backup (object or JSON text), upgrading an older version in memory.
 * Pure: never changes its input. Returns { doc, data } — `data` in the current format — or
 * { code, errors } with code BACKUP_UNREADABLE | BACKUP_INCOMPATIBLE | BACKUP_INVALID.
 * Record-level validation (schemas, invariants, references) is validateBackup's job.
 */
export function readBackup(input) {
  let doc = input;
  if (typeof input === 'string') {
    try { doc = JSON.parse(input); } catch (e) { return { code: 'BACKUP_UNREADABLE', errors: [`not valid JSON: ${e.message}`] }; }
  }
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return { code: 'BACKUP_UNREADABLE', errors: ['a backup is a JSON object'] };
  if (doc.format !== BACKUP_FORMAT) return { code: 'BACKUP_INCOMPATIBLE', errors: [`not a V2 backup (format is ${JSON.stringify(doc.format)})`] };
  if (!Number.isInteger(doc.formatVersion) || doc.formatVersion < 1) return { code: 'BACKUP_INCOMPATIBLE', errors: [`formatVersion ${JSON.stringify(doc.formatVersion)} is not valid`] };
  if (doc.formatVersion > BACKUP_FORMAT_VERSION) {
    return { code: 'BACKUP_INCOMPATIBLE', errors: [`this backup is format version ${doc.formatVersion}; this app reads versions 1 to ${BACKUP_FORMAT_VERSION}`] };
  }
  const fromVersion = BACKUP_USER_DATA_VERSION[doc.formatVersion];
  if (fromVersion === undefined) return { code: 'BACKUP_INCOMPATIBLE', errors: [`formatVersion ${doc.formatVersion} is not supported`] };
  const expected = USER_DATA_COLLECTIONS[fromVersion];
  const errors = [];
  for (const k of Object.keys(doc)) if (!['format', 'formatVersion', 'exportedAt', 'data'].includes(k)) errors.push(`unexpected top-level field "${k}"`);
  const data = doc.data;
  if (!data || typeof data !== 'object' || Array.isArray(data)) errors.push('data is missing');
  else {
    for (const c of expected) if (!(c in data)) errors.push(`data.${c} is missing`);
    for (const k of Object.keys(data)) if (!expected.includes(k)) errors.push(`data.${k} is not part of a format version ${doc.formatVersion} backup`);
  }
  if (errors.length) return { code: 'BACKUP_INVALID', errors };
  try {
    return { doc, data: upgradeUserData(data, fromVersion) };
  } catch (e) {
    if (e instanceof DomainError && e.code === 'USER_DATA_VERSION_UNSUPPORTED') return { code: 'BACKUP_INCOMPATIBLE', errors: [e.message] };
    if (e instanceof DomainError && e.code === 'USER_DATA_INVALID') return { code: 'BACKUP_INVALID', errors: e.details && e.details.length ? e.details : [e.message] };
    throw e;
  }
}

/**
 * The older-format backup of a pre-upgrade snapshot (V3 Slice 1 · C4): the version-1 data the
 * app held immediately before it upgraded it, as a format-1 backup the earlier app can restore.
 *   { format: BACKUP_FORMAT, formatVersion: 1, exportedAt: original.savedAt, data }
 * `original` is a version-1 record's { data, savedAt } (the caller checks the record wrapper).
 * The data must already be exactly the five version-1 collections in plain JSON values; it is
 * then copied unchanged — never converted, never trimmed, and current data is never used.
 * Pure: nothing is read or written. Throws DomainError BACKUP_INVALID (details: the problems)
 * if the data could not be carried exactly. The caller still runs validateBackup on the result
 * (schemas, store rules and references) before offering it.
 */
export function olderFormatBackup(original) {
  if (!original || typeof original !== 'object') throw new DomainError('BACKUP_INVALID', 'no original record to build an older-format backup from');
  try {
    upgradeUserData(original.data, 1); // shape check only: exactly the version-1 collections, JSON values only
  } catch (e) {
    if (e instanceof DomainError && e.code.startsWith('USER_DATA_')) throw new DomainError('BACKUP_INVALID', `the original data can't be carried exactly: ${e.message}`, e.details || [e.message]);
    throw e;
  }
  return { format: BACKUP_FORMAT, formatVersion: 1, exportedAt: original.savedAt, data: clone(original.data) };
}

export function createBackupApi(ctx) {
  const { store } = ctx;

  /** References the schemas cannot express, checked against the backup + the app's own data. */
  function referenceErrors(data) {
    const errors = [];
    const foodIds = new Set([...store.get('coreFoods').map((f) => f.id), ...data.customFoods.map((f) => f.id)]);
    const mealIds = new Set([...store.get('libraryMeals').map((m) => m.id), ...data.savedMeals.map((m) => m.id)]);
    for (const m of data.savedMeals) {
      const unresolved = (m.metadata && m.metadata.unresolvedFoods) || {};
      m.ingredients.forEach((ing, i) => {
        // A Saved Meal may legitimately point at a deleted Custom Food, but only when it is
        // recorded as needing a replacement; anything else is a broken reference.
        if (!foodIds.has(ing.foodId) && !(ing.foodId in unresolved)) errors.push(`savedMeals ${m.id} ingredient ${i}: Food ${ing.foodId} does not exist`);
      });
    }
    for (const key of ['favoriteFoods', 'dislikedFoods']) {
      for (const id of data.preferences[key]) if (!foodIds.has(id)) errors.push(`preferences.${key}: Food ${id} does not exist`);
    }
    for (const id of data.preferences.favoriteMeals) if (!mealIds.has(id)) errors.push(`preferences.favoriteMeals: Meal ${id} does not exist`);
    // Meal Instances are historical snapshots: they may name Foods and Meals that have since
    // been deleted, so their references are deliberately not checked.
    return errors;
  }

  function summaryOf(data) {
    return {
      customFoods: data.customFoods.length,
      savedMeals: data.savedMeals.length,
      days: data.days.length,
      mealInstances: data.days.reduce((n, d) => n + d.mealInstances.length, 0)
    };
  }

  const api = {
    /** The user's data as a backup document (a plain object; serialise with JSON.stringify). */
    exportUserData() {
      const data = {};
      for (const c of USER_COLLECTIONS) data[c] = clone(store.get(c));
      return { format: BACKUP_FORMAT, formatVersion: BACKUP_FORMAT_VERSION, exportedAt: ctx.now(), data };
    },

    /**
     * Check a backup (object or JSON text) without restoring it.
     * Returns { valid, code, errors, formatVersion, summary, servingIds }. code is null when
     * valid, else BACKUP_UNREADABLE | BACKUP_INCOMPATIBLE | BACKUP_INVALID. servingIds is what a
     * restore would do to reserved serving IDs now ({ carriedForward, revived }, counts;
     * serving-ids.js), computed only for a valid backup and against the current data; null
     * otherwise. Nothing is written or changed.
     */
    validateBackup(input) {
      const read = readBackup(input);
      if (read.code) return { valid: false, code: read.code, errors: read.errors, formatVersion: null, summary: null };
      const data = read.data;
      let errors;
      try {
        errors = store.check(clone(data));
      } catch (e) {
        errors = [e.message];
      }
      if (!errors.length) errors = referenceErrors(data);
      let servingIds = null;
      if (!errors.length) {
        // Only for a valid backup: the carry-forward is never computed from rejected data.
        const carried = carryForwardServingIds(data.userFoodData, store.get('userFoodData'));
        servingIds = { carriedForward: carried.carriedForward, revived: carried.revived };
      }
      return {
        valid: errors.length === 0,
        code: errors.length ? 'BACKUP_INVALID' : null,
        errors,
        formatVersion: read.doc.formatVersion,
        summary: errors.length ? null : summaryOf(data),
        servingIds
      };
    },

    /**
     * Replace ALL of the user's data with a backup. Validated in full first; on any problem
     * a DomainError (code as validateBackup) is thrown and nothing changes. Serving IDs this
     * device had reserved are carried forward (serving-ids.js), against the data as it is at
     * this moment. The replacement is one atomic write of every user collection, validated
     * again by the store. Returns { restored: summary, servingIds: { carriedForward, revived } }.
     */
    restoreUserData(input) {
      const result = api.validateBackup(input);
      if (!result.valid) throw new DomainError(result.code, `backup not restored: ${result.errors.slice(0, 3).join('; ')}`, result.errors);
      const read = readBackup(input);
      const changes = {};
      for (const c of USER_COLLECTIONS) changes[c] = clone(read.data[c]);
      const carried = carryForwardServingIds(read.data.userFoodData, store.get('userFoodData'));
      changes.userFoodData = carried.userFoodData;
      store.commit(changes);
      return { restored: result.summary, servingIds: { carriedForward: carried.carriedForward, revived: carried.revived } };
    }
  };
  return api;
}
