/*
 * backup.js — manual backup and restore of the user's own data.
 *
 * A backup holds exactly the user-owned, persisted collections — the same ones every
 * adapter writes — and nothing derived:
 *
 *   {
 *     "format": "macro-tracker-v2-backup",
 *     "formatVersion": 1,
 *     "exportedAt": "2026-09-25T20:00:00.000Z",
 *     "data": {
 *       "targets":     current targets (lift / long_run / rest),
 *       "customFoods": Custom Foods,
 *       "savedMeals":  Saved Meals (ingredients only; totals are always derived),
 *       "days":        Days, each with its target snapshot, completeness and its
 *                      Meal Instances (the historical snapshots — the record itself),
 *       "preferences": favourites, dislikes and settings
 *     }
 *   }
 *
 * Core Foods and Library Meals are app data shipped with the app, so they are not in a
 * backup; a backup's references to them are checked against the running app's copy.
 *
 * Restore is all-or-nothing: parse → check format/version → validate every record against
 * the schemas and cross-record invariants → check references → one atomic write. If any
 * step fails nothing is changed.
 */

import { DomainError, clone } from './util.js';

export const BACKUP_FORMAT = 'macro-tracker-v2-backup';
export const BACKUP_FORMAT_VERSION = 1;

/** The user-owned persisted collections, in backup order. */
export const USER_COLLECTIONS = Object.freeze(['targets', 'customFoods', 'savedMeals', 'days', 'preferences']);

export function createBackupApi(ctx) {
  const { store } = ctx;

  /** Parse and shape-check a backup. Returns { doc } or { code, errors }. */
  function readBackup(input) {
    let doc = input;
    if (typeof input === 'string') {
      try { doc = JSON.parse(input); } catch (e) { return { code: 'BACKUP_UNREADABLE', errors: [`not valid JSON: ${e.message}`] }; }
    }
    if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return { code: 'BACKUP_UNREADABLE', errors: ['a backup is a JSON object'] };
    if (doc.format !== BACKUP_FORMAT) return { code: 'BACKUP_INCOMPATIBLE', errors: [`not a V2 backup (format is ${JSON.stringify(doc.format)})`] };
    if (!Number.isInteger(doc.formatVersion) || doc.formatVersion < 1) return { code: 'BACKUP_INCOMPATIBLE', errors: [`formatVersion ${JSON.stringify(doc.formatVersion)} is not valid`] };
    if (doc.formatVersion > BACKUP_FORMAT_VERSION) {
      return { code: 'BACKUP_INCOMPATIBLE', errors: [`this backup is format version ${doc.formatVersion}; this app reads version ${BACKUP_FORMAT_VERSION}`] };
    }
    const errors = [];
    for (const k of Object.keys(doc)) if (!['format', 'formatVersion', 'exportedAt', 'data'].includes(k)) errors.push(`unexpected top-level field "${k}"`);
    const data = doc.data;
    if (!data || typeof data !== 'object' || Array.isArray(data)) errors.push('data is missing');
    else {
      for (const c of USER_COLLECTIONS) if (!(c in data)) errors.push(`data.${c} is missing`);
      for (const k of Object.keys(data)) if (!USER_COLLECTIONS.includes(k)) errors.push(`data.${k} is not part of a V2 backup`);
    }
    if (errors.length) return { code: 'BACKUP_INVALID', errors };
    return { doc };
  }

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
     * Returns { valid, code, errors, formatVersion, summary }. code is null when valid, else
     * BACKUP_UNREADABLE | BACKUP_INCOMPATIBLE | BACKUP_INVALID.
     */
    validateBackup(input) {
      const read = readBackup(input);
      if (read.code) return { valid: false, code: read.code, errors: read.errors, formatVersion: null, summary: null };
      const data = read.doc.data;
      let errors;
      try {
        errors = store.check(clone(data));
      } catch (e) {
        errors = [e.message];
      }
      if (!errors.length) errors = referenceErrors(data);
      return {
        valid: errors.length === 0,
        code: errors.length ? 'BACKUP_INVALID' : null,
        errors,
        formatVersion: read.doc.formatVersion,
        summary: errors.length ? null : summaryOf(data)
      };
    },

    /**
     * Replace ALL of the user's data with a backup. Validated in full first; on any problem
     * a DomainError (code as validateBackup) is thrown and nothing changes. The replacement
     * is one atomic write of every user collection. Returns { restored: summary }.
     */
    restoreUserData(input) {
      const result = api.validateBackup(input);
      if (!result.valid) throw new DomainError(result.code, `backup not restored: ${result.errors.slice(0, 3).join('; ')}`, result.errors);
      const read = readBackup(input);
      const changes = {};
      for (const c of USER_COLLECTIONS) changes[c] = clone(read.doc.data[c]);
      store.commit(changes);
      return { restored: result.summary };
    }
  };
  return api;
}
