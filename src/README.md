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

Tests: `node --test 'tests/*.test.mjs'` (Node 22+, built-in test runner).

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
| `foods.js` | `getFood`, `searchFoods` (names + aliases, ranked), `getRecentFoods`, `createCustomFood`, `updateCustomFood`, `deleteCustomFood` |
| `meals.js` | `getLibraryMeals`, `getSavedMeals`, `getRecentMeals`, `getMeal`, `calculateMealMacros`, `createSavedMeal`, `updateSavedMeal`, `replaceSavedMealIngredient`, `duplicateSavedMeal`, `deleteSavedMeal` |
| `days.js` | `getDay`, `listDays`, `createDay`, `updateDayType`, `deleteDay`, `createMealInstance`, `logFood`, `updateMealInstance`, `deleteMealInstance`, `getDaySummary` |
| `targets.js` | `getCurrentTargets`, `getAllCurrentTargets`, `createTargetSnapshot`, `updateCurrentTargets` |
| `progress.js` | `getProgress({ period: 7 \| 14 \| 30, endDate })` or `({ startDate, endDate })` |
| `coach.js` | `getMacroCoachContext({ date, mealSlot, dayType? })` — data only, no AI |
| `preferences.js` | `getPreferences`, `updatePreferences`, `setFavoriteFood`, `setDislikedFood`, `setFavoriteMeal` |
| `store.js` | state + persistence; validates every write against `data/schemas/` before saving |
| `macros.js` | the calculator |
| `schema-validator.js` | the JSON Schema subset validator (shared with `migration/validate.js`) |

Expected failures throw a `DomainError` with a stable `code` (e.g. `FOOD_NOT_FOUND`,
`MEAL_NEEDS_REPLACEMENT`, `DAY_TYPE_REQUIRED`). Reads never throw for data problems.

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
- **Progress:** each date is `no_data`, `partial` (some of the five slots logged) or `complete` (all five). No-data days are never zero. Actual-intake averages use complete days only, with a separate labelled average over logged days. Per macro, a day is `hit` (logged ≥ target; targets are floors), `missed` (complete and short) or `undetermined` (partial and short).
- **Favourites:** live only in `preferences.json`. The optional Meal `favorite` field is not written, so there is one favourites store.
