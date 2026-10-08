# V2 data / domain layer (Prompt 2)

```
FOODS → MEALS → MEAL INSTANCE → DAY → derived Progress / Macro Coach context
```

Plain ES modules with no build step and no dependencies. `src/domain/` is browser-safe;
`src/node/file-adapter.js` connects it to the canonical JSON files in this repository.
There is no UI here. The legacy pages (`close-the-carbs.html`, `meal-bank.html`) are untouched
and do not use this layer yet.

```js
import { createDataLayer } from './src/domain/index.js';
import { createFileAdapter } from './src/node/file-adapter.js';
const app = createDataLayer({ adapter: createFileAdapter(repoRoot) });
```

In a browser (the V2 runtime target), the same data layer runs on the browser adapter:

```js
import { openBrowserDataLayer } from '../src/browser/app-data.js';
import { requestPersistentStorage } from '../src/browser/browser-adapter.js';
const { app } = await openBrowserDataLayer();   // IndexedDB "meal-tracking-v2"; every call stays synchronous
await requestPersistentStorage();                // optional: ask the browser not to evict
```

**Browser data-loading contract**

- *Source:* `src/browser/app-data.js` imports the canonical files statically as JSON modules
  (`import … with { type: 'json' }`): the six schemas, `data/foods/core-foods.json`,
  `data/meals/library-meals.json`, and the first-run seed (`data/targets.json`, `user-data/*.json`).
  No fetch, no dynamic import, no build step. Serve the repository root as the web root (so
  `src/` and `data/` resolve at their on-disk relative paths), with `.json` as `application/json`.
- *Immutable app data:* schemas, Core Foods and Library Meals come from the app on every load and
  are never stored in the browser.
- *Persisted user data:* targets, Custom Foods, Saved Meals, Days (with Meal Instances) and
  preferences — one IndexedDB record, written after each change.
- *First run:* nothing stored → user data starts from the seed; nothing is written until the first
  change, which stores the full record.
- *Later runs:* the stored record is used and the seed is ignored; it is validated against the
  current schemas before the app starts. If it fails, `DATA_INVALID` is thrown with
  `error.readStoredRecord()` for a raw download, and nothing is overwritten.
- *Recovery:* only on explicit request, `recoverStoredData({ backup })` (validated in full first) or
  `recoverStoredData({ startFresh: true })` (shipped seed) replaces an unreadable stored record.
- *Tests:* `tests/pre-ui.test.mjs` W1–W4 and `tests/foundations.test.mjs` run this path in Node (which loads the same JSON modules)
  with `memory-snapshot-store.js` standing in for IndexedDB.

Code outside `src/domain/` imports the domain only through `src/domain/index.js`.

Tests: `node --test 'tests/*.test.mjs'` (Node 22+, built-in test runner). `tests/pre-ui.test.mjs` and `tests/foundations.test.mjs` cover the pre-UI foundations. The UI contract is `V2_UI_CONTRACT.md` (repo root).

## Runtime boundary (Prompt 3)

This directory is the only V2 runtime. `runtime-boundary.json` (repo root) puts every file in
exactly one class: runtime, canonical data, migration, legacy reference, specification or tests.
`tests/runtime-boundary.test.mjs` enforces the boundary:

- every file must be classified. A new UI directory must be added to the `runtime` class, and is then scanned.
- runtime code and canonical data may not reference any legacy source or rule. The test reports `file:line identifier`.
- the runtime reads and writes only `data/` and `user-data/`, checked by recording every file access during a full scenario.
- legacy reference files must stay byte-for-byte as uploaded.

The retired pages and why they were not rewired are in `LEGACY-RUNTIME.md`.

## Ownership

| Thing | Owner | File |
|---|---|---|
| Nutrition (P/C/F per 100 g) | Food | `data/foods/core-foods.json` (read-only), `user-data/custom-foods.json` |
| Ingredients | Meal | `data/meals/library-meals.json` (read-only), `user-data/saved-meals.json` |
| What was eaten, as it was | Meal Instance (snapshot) | inside each Day in `user-data/daily-logs.json` |
| Day type + target at the time | Day (`targetSnapshot`) | `user-data/daily-logs.json` |
| Targets for new Days | Current targets | `data/targets.json` (seed-once; the migration never overwrites it) |
| Favourites, dislikes, settings | Preferences | `user-data/preferences.json` |

Meal totals, remaining macros, Progress and the Macro Coach context are always derived and never stored.

## One calculator

`src/domain/macros.js` is the only place P/C/F arithmetic happens:
`contribution = quantity / 100 × Food nutrition`, meal total = sum, remaining = daily target − logged.
Meal detail, Saved Meals, logging, Today (`getDaySummary`), Progress and the Macro Coach context all
use it, and so does the migration (`migration/macro-calc.js` re-exports it). Food state is
descriptive only: no raw↔cooked conversion and no yield factors at runtime.
`tests/architecture.test.mjs` fails if P/C/F arithmetic appears anywhere else in `src/`.

## Modules

| Module | Operations |
|---|---|
| `foods.js` | `getFood`, `searchFoods` (names + aliases, ranked), `getRecentFoods`, `getCustomFoods`, `getFoodUsage`, `createCustomFood`, `updateCustomFood`, `deleteCustomFood` |
| `meals.js` | `getLibraryMeals`, `getSavedMeals`, `searchMeals` (same ranking as `searchFoods`; retired Library Meals excluded), `getRecentMeals`, `getMeal`, `calculateMealMacros`, `createSavedMeal`, `updateSavedMeal`, `replaceSavedMealIngredient`, `duplicateSavedMeal`, `deleteSavedMeal` |
| `days.js` | `getDay`, `listDays`, `createDay`, `updateDayType`, `previewDayTypeChange`, `applyCurrentTargetsToToday`, `getToday`, `setDayLoggingComplete`, `deleteDay`, `createMealInstance`, `logFood`, `updateMealInstance`, `deleteMealInstance`, `getDaySummary`, and the previews `previewMealInstance`, `previewLogFood`, `previewMealInstanceUpdate` |
| `targets.js` | `getCurrentTargets`, `getAllCurrentTargets`, `createTargetSnapshot`, `updateCurrentTargets` |
| `progress.js` | `getProgress({ period: 7 \| 14 \| 30, endDate })` or `({ startDate, endDate })` |
| `coach.js` | `getMacroCoachContext({ date, mealSlot, dayType? })`, `getMacroCoachSuggestions({ date, mealSlot, dayType?, limitPerTier? })` — tiers `favoriteSaved` → `recent` → `saved` → `library`, plus `topUpFoods`; tiers 1–3 are Saved Meals only (a favourited or logged Library Meal stays in the Library tier, in Library order; retired ones never appear); deterministic, no scoring, no AI |
| `preferences.js` | `getPreferences`, `updatePreferences`, `setFavoriteFood`, `setDislikedFood`, `setFavoriteMeal` |
| `backup.js` | `exportUserData`, `validateBackup`, `restoreUserData` |
| `store.js` | state + persistence; validates every write (schemas, invariants, finite numbers) before one atomic `saveMany`; `getPersistenceStatus`, `onPersistenceChange`, `flushPersistence`, `retryPersistence` |
| `macros.js` | the calculator (also `targetStatus` → `remaining`, `reached`, `overBy`, `progress`; `checkNutritionValues`) |
| `schema-validator.js` | the JSON Schema subset validator (shared with `migration/validate.js`); rejects NaN / ±Infinity |
| `foods.js` (also) | `validateCustomFood` — the same checks as create/update, as a dry run with field-level errors |

Adapters: `src/node/file-adapter.js` (Node, dev/tests), `src/domain/memory-adapter.js` (tests), `src/browser/browser-adapter.js` + `indexeddb-snapshot-store.js` (browser; `memory-snapshot-store.js` for tests), opened in a browser through `src/browser/app-data.js`.

Expected failures throw a `DomainError` with a stable `code` (e.g. `FOOD_NOT_FOUND`,
`MEAL_NEEDS_REPLACEMENT`, `DAY_TYPE_REQUIRED`, `NOTHING_LOGGED`, `PERSIST_FAILED`,
`BACKUP_UNREADABLE` / `BACKUP_INCOMPATIBLE` / `BACKUP_INVALID`; at browser start-up `STORAGE_UNAVAILABLE`,
`STORED_DATA_UNRECOGNIZED`, `DATA_INVALID`). Validation errors carry
field-level `details` where a field is identifiable. Reads never throw for data problems.

## Rules the layer enforces

- **Saved Meal edited:** future use changes; logged Meal Instances do not.
- **Meal Instance edited:** only that instance changes. An ingredient already in the snapshot is re-scaled from the snapshot's own values, so it works even if the Food was later changed or deleted.
- **Food nutrition edited:** Saved Meals recalculate (they are derived); history does not change.
- **Custom Food deleted:** Saved Meals using it keep the ingredient and become invalid (`calculateMealMacros(...).needsReplacement: true`, with `problems[].foodId` and `lastKnownName`). They show `totals: null` rather than a misleading partial total, and logging them is refused (`MEAL_NEEDS_REPLACEMENT`) until `replaceSavedMealIngredient` fixes them. A new Food never reuses an ID that anything still refers to.
- **Saved Meal deleted:** the recipe goes; logged instances stay.
- **Library Meal saved:** an independent copy with its own `meal_saved_…` ID. `metadata.copiedFromMealId` is provenance only.
- **Similar Foods:** never merged.
- **`metadata.ingredientLabels`:** recipe wording only. It is never searched or used for lookup or calculation, and labels for Foods no longer in a Saved Meal are removed on every edit.
- **Slots vs types:** `mealType` (breakfast, lunch, snack, dinner, other) describes a Meal; `mealSlot` (breakfast, lunch, snack_afternoon, dinner, snack_night) is where it was logged. `mealType` never restricts the slot, and there are no per-slot targets.
- **Day types:** `lift`, `long_run`, `rest` (the legacy `long` is rejected). Changing a Day's type re-takes its target snapshot from the current targets for the new type; logged food is untouched.
- **Current targets changed:** only Days created afterwards use them.
- **Days:** created when first needed (`createDay`, or `dayType` passed when logging to a date with no Day). Nothing invents history.
- **Day completeness:** explicit. `setDayLoggingComplete(date, true)` marks a Day done logging (needs ≥ 1 logged meal); slot coverage is information only and never decides it. No slot, including `snack_night`, is required.
- **Day type corrections:** allowed on any Day; the replaced snapshot is kept in `priorTargetSnapshots` and restored if that type is chosen again; the same type is a no-op. Only `applyCurrentTargetsToToday()` re-takes a snapshot from current targets, and only for today.
- **Numbers:** every stored number is finite; NaN / ±Infinity are refused before anything is written.
- **Previews:** screens never compute P/C/F. `previewMealInstance` / `previewLogFood` / `previewMealInstanceUpdate` / `getDaySummary` (`remaining`, `reached`, `overBy`) / the `macros` export give every number a UI needs.
- **Progress:** each date is `no_data`, `partial` (food logged, not marked done) or `complete` (marked done). No-data days are never zero. Actual-intake averages use complete days only, with a separate labelled average over logged days. Per macro, a day is `hit` (logged ≥ target; targets are floors), `missed` (complete and short) or `undetermined` (partial and short).
- **Favourites:** live only in `preferences.json`. The optional Meal `favorite` field is not written, so there is one favourites store.
