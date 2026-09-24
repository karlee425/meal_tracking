# Claude Prompt 2 — Implement the Canonical Data Layer

The data migration is complete. Now implement the application data layer against the canonical schema.

Read:
- `schema.md`
- `migration-spec.md`
- `data/schemas/*`
- `data/foods/core-foods.json`
- `data/meals/library-meals.json`
- `data/targets.json`
- `user-data/custom-foods.json`
- `user-data/saved-meals.json`
- `user-data/daily-logs.json`
- `user-data/preferences.json`

## Architecture

Implement these domain operations:

### Foods
- `getFood(id)`
- `searchFoods(query)`
- `getRecentFoods()`
- `createCustomFood()`
- `updateCustomFood()`
- `deleteCustomFood()`

Core Foods are read-only.

### Meals
- `getLibraryMeals()`
- `getSavedMeals()`
- `getRecentMeals()`
- `getMeal(id)`
- `calculateMealMacros(meal)`
- `createSavedMeal()`
- `updateSavedMeal()`
- `duplicateSavedMeal()`
- `deleteSavedMeal()`

Library → Save must create an independent Saved Meal ID.

### Logging
- `createMealInstance()`
- `updateMealInstance()`
- `deleteMealInstance()`
- `getDay(date)`
- `createDay(date)`
- `updateDayType(date, dayType)`

Logging must create a historical snapshot of:
- Food ID
- Food name
- quantity
- unit
- ingredient P/C/F contribution
- meal name
- totals
- source meal ID when applicable

### Targets
- `getCurrentTargets(dayType)`
- `createTargetSnapshot(dayType)`

Use:
- Lift 150P / 293C / 70F
- Long Run 150P / 343C / 70F
- Rest 150P / 218C / 70F

Changing current targets later must not rewrite historical Day snapshots.

### Progress
Implement as a pure derived calculation:
- average actual
- average target
- days hit
- daily breakdown
- trend data

Never interpret missing meals as zero.

### Macro Coach preparation
Expose a clean context object containing:
- day type
- meal slot
- remaining P/C/F
- saved meals
- recent meals
- relevant Foods
- preferences

Do not build a chatbot. Do not add an AI dependency.

## Critical implementation rule

There must be one macro calculation utility.

No screen may implement its own P/C/F arithmetic.

The same calculation must power:
- meal detail
- logging
- Today
- Progress
- Macro Coach

## Data mutation rules

Editing a Saved Meal changes the living recipe.

Editing a Meal Instance changes only that instance.

Editing a Food may recalculate Saved Meals.

Editing a Food never changes historical Meal Instances.

Deleting a Saved Meal never deletes historical Meal Instances.

Deleting a Custom Food referenced by a Saved Meal must make that recipe visibly invalid and require Food replacement.

Do not silently repair missing references.

## Completion criteria

The application must be able to:
1. search Foods
2. create a Meal from Foods
3. calculate its P/C/F
4. save it
5. log it
6. modify the logged copy
7. preserve the Saved Meal
8. preserve historical snapshots
9. calculate today's remaining macros
10. change Day Type without changing logged food

Do not redesign the visual interface yet.
