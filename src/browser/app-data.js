/*
 * app-data.js — how the browser app gets the canonical data, and the one call that opens
 * the data layer in a browser.
 *
 *   import { openBrowserDataLayer } from '../src/browser/app-data.js';
 *   const { app, adapter } = await openBrowserDataLayer();   // IndexedDB by default
 *
 * Where the data comes from: the canonical JSON files in this repository, imported
 * STATICALLY as JSON modules (`import … with { type: 'json' }`). No fetch, no dynamic
 * import, no build step: the browser (Chrome 123+, Safari 17.2+, Firefox 138+) and Node 22
 * both load these natively. The site must serve the repository root, so src/ and data/ are
 * reachable at the same relative paths as on disk, with JSON served as application/json.
 *
 * What is immutable app data vs persisted user data:
 *   schemas, coreFoods, libraryMeals   shipped with the app on every load; never stored in
 *                                      the browser; a new app version brings new values
 *   seed.targets, seed.customFoods,    FIRST-RUN contents only (data/targets.json and
 *   seed.savedMeals, seed.days,        user-data/*.json as committed). After the first
 *   seed.preferences                   save, the browser's stored record is the user's data
 *                                      and the seed is never read again.
 *
 * This list mirrors src/node/file-adapter.js FILES; tests/pre-ui.test.mjs checks that the
 * two load identical data and that every schema in data/schemas/ is imported here.
 */

import daySchema from '../../data/schemas/day.schema.json' with { type: 'json' };
import foodSchema from '../../data/schemas/food.schema.json' with { type: 'json' };
import mealInstanceSchema from '../../data/schemas/meal-instance.schema.json' with { type: 'json' };
import mealSchema from '../../data/schemas/meal.schema.json' with { type: 'json' };
import preferencesSchema from '../../data/schemas/preferences.schema.json' with { type: 'json' };
import targetsSchema from '../../data/schemas/targets.schema.json' with { type: 'json' };
import coreFoods from '../../data/foods/core-foods.json' with { type: 'json' };
import libraryMeals from '../../data/meals/library-meals.json' with { type: 'json' };
import seedTargets from '../../data/targets.json' with { type: 'json' };
import seedCustomFoods from '../../user-data/custom-foods.json' with { type: 'json' };
import seedSavedMeals from '../../user-data/saved-meals.json' with { type: 'json' };
import seedDays from '../../user-data/daily-logs.json' with { type: 'json' };
import seedPreferences from '../../user-data/preferences.json' with { type: 'json' };

import { createDataLayer, createMemoryAdapter, DomainError } from '../domain/index.js';
import { createBrowserAdapter, replaceStoredUserData } from './browser-adapter.js';
import { createIndexedDbSnapshotStore } from './indexeddb-snapshot-store.js';

/** The canonical data a browser app starts from. Treat as read-only; the adapter copies it. */
export const APP_DATA = Object.freeze({
  schemas: Object.freeze({
    'day.schema.json': daySchema,
    'food.schema.json': foodSchema,
    'meal-instance.schema.json': mealInstanceSchema,
    'meal.schema.json': mealSchema,
    'preferences.schema.json': preferencesSchema,
    'targets.schema.json': targetsSchema
  }),
  coreFoods,
  libraryMeals,
  seed: Object.freeze({
    targets: seedTargets,
    customFoods: seedCustomFoods,
    savedMeals: seedSavedMeals,
    days: seedDays,
    preferences: seedPreferences
  })
});

/**
 * Open the V2 data layer in a browser.
 *   snapshotStore  where user data is stored (default: IndexedDB "meal-tracking-v2")
 *   appData        canonical data (default: APP_DATA) — tests may pass their own
 *   clock, today, newId, now   passed through (tests)
 * First run (nothing stored): user data starts from appData.seed; the first change
 * writes the full record. Later runs: the stored record is used and the seed is ignored.
 * If the stored data fails validation, the DomainError DATA_INVALID is rethrown with
 * error.readStoredRecord() attached, so the app can offer the raw record as a download
 * instead of losing it. Nothing is overwritten in that case.
 */
export async function openBrowserDataLayer({ snapshotStore, appData = APP_DATA, clock, today, newId, now } = {}) {
  const adapter = await createBrowserAdapter({ appData, snapshotStore: snapshotStore || createIndexedDbSnapshotStore(), ...(now ? { now } : {}) });
  try {
    const app = createDataLayer({ adapter, ...(clock ? { clock } : {}), ...(today ? { today } : {}), ...(newId ? { newId } : {}) });
    return { app, adapter };
  } catch (e) {
    if (e && e.code === 'DATA_INVALID') e.readStoredRecord = () => adapter.readStoredRecord();
    throw e;
  }
}

/**
 * Explicit recovery when stored data can't be opened (DATA_INVALID or
 * STORED_DATA_UNRECOGNIZED). Exactly one of:
 *   backup       a backup document (object or JSON text): validated in full against the
 *                shipped app data first — on any problem a DomainError (BACKUP_UNREADABLE |
 *                BACKUP_INCOMPATIBLE | BACKUP_INVALID) is thrown and storage is untouched
 *   startFresh   true: the shipped first-run seed
 * Then the stored record is replaced (one write) and the app is opened normally.
 * Never called automatically: stored data is only replaced on this explicit request.
 * Returns { app, adapter } like openBrowserDataLayer.
 */
/**
 * Check a backup for recoverStoredData without writing anything, when the stored data can't
 * be opened (so there is no running data layer to ask). Validated against the shipped app
 * data with a throwaway in-memory data layer; returns validateBackup's result
 * ({ valid, code, errors, formatVersion, summary }), so a screen can preview it and ask
 * before anything is replaced.
 */
export function validateRecoveryBackup(backup, { appData = APP_DATA } = {}) {
  const probe = createDataLayer({ adapter: createMemoryAdapter({ schemas: appData.schemas, coreFoods: appData.coreFoods, libraryMeals: appData.libraryMeals, ...appData.seed }) });
  return probe.validateBackup(backup);
}

export async function recoverStoredData({ snapshotStore, appData = APP_DATA, backup, startFresh = false, clock, today, newId, now } = {}) {
  if ((backup === undefined) === (startFresh !== true)) throw new DomainError('INVALID_ARGUMENT', 'pass exactly one of: backup, or startFresh: true');
  const store = snapshotStore || createIndexedDbSnapshotStore();
  let data;
  if (backup !== undefined) {
    const result = validateRecoveryBackup(backup, { appData }); // validated in full before any write
    if (!result.valid) throw new DomainError(result.code, `backup not restored: ${result.errors.slice(0, 3).join('; ')}`, result.errors);
    data = (typeof backup === 'string' ? JSON.parse(backup) : backup).data;
  } else {
    data = appData.seed;
  }
  await replaceStoredUserData({ snapshotStore: store, data, ...(now ? { now } : {}) });
  return openBrowserDataLayer({ snapshotStore: store, appData, clock, today, newId, now });
}
