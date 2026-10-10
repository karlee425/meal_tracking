/*
 * serving-ids.js — reserved serving IDs across a restore (V3 Slice 1 · C5).
 *
 * A serving ID, once used on this device, is never reused for anything else. A restore replaces
 * userFoodData with the backup's, so the IDs this device had reserved would otherwise be lost.
 * carryForwardServingIds keeps them:
 *
 *   backup:  L = active serving IDs, R = retired IDs
 *   device:  Lc = active, Rc = retired, C = Lc ∪ Rc (every ID reserved here before the restore)
 *
 *   active   L′ = L                 the backup's serving definitions, exactly as they are
 *   retired  R′ = (R ∪ C) \ L        R in its own order, then the newly kept IDs sorted
 *
 *   carriedForward = |Lc \ L|   servings active here and not in the backup: retired, ID kept
 *   revived        = |L ∩ Rc|   servings retired here but active in the backup: they come back
 *                                with the backup's definition (same ID, same serving)
 *
 * Pure and deterministic: inputs are never changed; the backup's foods are copied unchanged.
 * Both inputs must already be valid (validateBackup / the store); anything inconsistent here is
 * refused, never repaired: DomainError BACKUP_INVALID for the backup, DATA_INVALID for the device.
 *
 * Not covered (documented limitations): recovery from unreadable stored data and Start over —
 * there is no readable device state to carry forward from. Logged-meal serving IDs are not part
 * of C yet because no logged meal can hold a serving; the slice that adds serving-aware logging
 * must add them here (and to backup validation) before it ships.
 */

import { DomainError, clone } from './util.js';

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/** The active and retired IDs of a userFoodData, checked for shape, duplicates and overlap. */
function servingIds(userFoodData, code, what) {
  const fail = (why) => { throw new DomainError(code, `${what} serving IDs can't be carried forward: ${why}`, [why]); };
  if (!isPlainObject(userFoodData) || !Array.isArray(userFoodData.foods) || !Array.isArray(userFoodData.retiredServingIds)) fail('userFoodData is not in the expected form');
  const active = [];
  for (const record of userFoodData.foods) {
    if (!isPlainObject(record) || !Array.isArray(record.servings)) fail('a serving record is not in the expected form');
    for (const s of record.servings) {
      if (!isPlainObject(s) || typeof s.id !== 'string') fail('a serving has no ID');
      active.push(s.id);
    }
  }
  const retired = userFoodData.retiredServingIds;
  if (!retired.every((id) => typeof id === 'string')) fail('a retired serving ID is not text');
  const activeSet = new Set(active);
  const retiredSet = new Set(retired);
  if (activeSet.size !== active.length) fail('a serving ID is used more than once');
  if (retiredSet.size !== retired.length) fail('a retired serving ID is listed more than once');
  for (const id of activeSet) if (retiredSet.has(id)) fail(`serving ID ${id} is both active and retired`);
  return { activeSet, retired, retiredSet };
}

/**
 * The userFoodData a restore writes, and what it did to reserved IDs.
 * Returns { userFoodData, carriedForward, revived } — the two counts as numbers.
 */
export function carryForwardServingIds(backupUserFoodData, currentUserFoodData) {
  const backup = servingIds(backupUserFoodData, 'BACKUP_INVALID', 'the backup’s');
  const device = servingIds(currentUserFoodData, 'DATA_INVALID', 'this device’s');
  const L = backup.activeSet;
  const kept = backup.retired.filter((id) => !L.has(id));
  const keptSet = new Set(kept);
  const added = [...new Set([...device.activeSet, ...device.retired])].filter((id) => !L.has(id) && !keptSet.has(id)).sort();
  let carriedForward = 0;
  for (const id of device.activeSet) if (!L.has(id)) carriedForward += 1;
  let revived = 0;
  for (const id of L) if (device.retiredSet.has(id)) revived += 1;
  return {
    userFoodData: { foods: clone(backupUserFoodData.foods), retiredServingIds: [...kept, ...added] },
    carriedForward,
    revived
  };
}
