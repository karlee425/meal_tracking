/*
 * targets.js — current targets (data/targets.json) vs historical Day target snapshots.
 *
 * Current targets are configuration for new Days only. A Day copies them into its own
 * targetSnapshot when it is created (or when its day type is changed). Changing current
 * targets never rewrites an existing Day.
 *
 * Targets are daily only. There are no per-slot allocations: remaining = daily target − logged.
 */

import { DomainError, clone, assertDayType } from './util.js';
import { MACROS, pickMacros } from './macros.js';

/**
 * Problems with target values ([] when they can be saved): only protein / carbs / fat, each a
 * finite number ≥ 0. One rule set for validateTargets (a dry run) and updateCurrentTargets.
 */
function targetProblems(values) {
  if (!values || typeof values !== 'object' || Array.isArray(values)) {
    return [{ field: null, code: 'TARGETS_REQUIRED', message: 'values {protein, carbs, fat} are required' }];
  }
  const problems = [];
  for (const k of Object.keys(values)) {
    if (!MACROS.includes(k)) problems.push({ field: k, code: 'TARGET_UNKNOWN_FIELD', message: `targets only have protein, carbs and fat; got "${k}"` });
  }
  for (const [k, v] of Object.entries(values)) {
    if (MACROS.includes(k) && !(typeof v === 'number' && Number.isFinite(v) && v >= 0)) {
      problems.push({ field: k, code: 'TARGET_NOT_A_VALID_NUMBER', message: `${k} must be a finite number ≥ 0` });
    }
  }
  return problems;
}

export function createTargetsApi(ctx) {
  const { store } = ctx;

  const api = {
    /** Current targets for a day type (lift | long_run | rest). */
    getCurrentTargets(dayType) {
      assertDayType(dayType);
      return clone(store.get('targets')[dayType]);
    },

    /** All current targets. */
    getAllCurrentTargets() {
      return clone(store.get('targets'));
    },

    /**
     * Check target values without saving anything — the same rules updateCurrentTargets
     * enforces, so a form can explain problems before asking the user to confirm.
     * Returns { valid, errors: [{ field, code, message }] }.
     */
    validateTargets(values) {
      const errors = targetProblems(values);
      return { valid: errors.length === 0, errors };
    },

    /** A copy of the current targets, for storing on a new Day. */
    createTargetSnapshot(dayType) {
      return pickMacros(api.getCurrentTargets(dayType));
    },

    /**
     * Change current targets for one day type. Affects Days created afterwards only.
     * Only done on an explicit request — nothing in the data layer calls this on its own.
     */
    updateCurrentTargets(dayType, values) {
      assertDayType(dayType);
      const problems = targetProblems(values);
      if (problems.length) throw new DomainError('INVALID_TARGETS', `targets not changed: ${problems.map((p) => p.message).join('; ')}`, problems);
      const next = clone(store.get('targets'));
      next[dayType] = { ...next[dayType], ...pickMacros({ ...next[dayType], ...values }) };
      store.commit({ targets: next });
      return clone(next[dayType]);
    }
  };
  return api;
}
