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
      if (!values || typeof values !== 'object') throw new DomainError('INVALID_TARGETS', 'values {protein, carbs, fat} are required');
      for (const k of Object.keys(values)) if (!MACROS.includes(k)) throw new DomainError('INVALID_TARGETS', `targets only have protein, carbs and fat; got "${k}"`);
      const next = clone(store.get('targets'));
      next[dayType] = { ...next[dayType], ...pickMacros({ ...next[dayType], ...values }) };
      store.commit({ targets: next });
      return clone(next[dayType]);
    }
  };
  return api;
}
