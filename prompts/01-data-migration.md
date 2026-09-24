# Claude Prompt 1 — Build the Data Model + Migration

You are working in the existing `karlee425/meal_tracking` repository.

The product redesign has already been architected. Do NOT redesign the product, invent new features, or change the agreed navigation. Your job in this step is to implement the canonical data model and migrate the existing data safely.

Read these files first:
- `foods.json`
- `meal-options.json`
- `targets.json`
- `live-settings-doc.json`
- `yields.json`
- `portion-bounds.json`
- `meal-bank.html`
- `recost.js`

The authoritative implementation requirements are in:
- `schema.md`
- `migration-spec.md`

## Non-negotiable rules

1. Protein, carbs, and fat are the only nutrition dimensions.
2. Do not add energy/calorie fields.
3. Foods own nutrition.
4. Meals own ingredients.
5. Meal macros are calculated, never stored as authoritative values.
6. Meal Instances are historical snapshots.
7. Saved Meals are living recipes.
8. Historical Meal Instances never change because a Food or Meal changes.
9. Day target snapshots never silently change.
10. Stable IDs must never depend on array position.
11. Do not silently substitute unresolved Foods.
12. Do not fabricate historical logs.
13. Do not retain `live-settings-doc.json` as a runtime source.
14. Do not retain the embedded `M` meal array or `CTC_FOOD` map in runtime code.

## Exact source mapping

`foods.json` → `data/foods/core-foods.json`

`meal-options.json` → `data/meals/library-meals.json`

`live-settings-doc.json.customFoods` → `user-data/custom-foods.json`

`targets.json` → `data/targets.json`

`live-settings-doc.json.bank.meals` is a duplicate and must NOT be migrated as a second Library Meal source.

## Initial targets

Use exactly:

Lift:
- protein 150
- carbs 293
- fat 70

Long Run:
- protein 150
- carbs 343
- fat 70

Rest:
- protein 150
- carbs 218
- fat 70

## Required deliverables

Create:

data/
  foods/core-foods.json
  meals/library-meals.json
  targets.json
  reference/yields.json
  reference/portion-bounds.json
  schemas/food.schema.json
  schemas/meal.schema.json
  schemas/meal-instance.schema.json
  schemas/day.schema.json
  schemas/targets.schema.json
  schemas/preferences.schema.json

user-data/
  custom-foods.json
  saved-meals.json
  daily-logs.json
  preferences.json

migration/
  migration-report.json
  food-id-map.json
  meal-id-map.json

Also create/update:
- `schema.md`
- `migration-spec.md`

## Migration behavior

For every Food:
- create a stable ID
- map `n/p/f/c/cat/t`
- make state explicit
- preserve useful yield references as metadata/reference data
- convert legacy aliases into Food aliases
- preserve brand information when clearly identifiable

For every Library Meal:
- parse `ing`
- resolve every ingredient to a Food ID
- preserve quantities
- preserve useful recipe metadata
- calculate macros from ingredients
- compare calculated totals against legacy p/f/c
- do not store legacy p/f/c in the new Meal

If an ingredient cannot be resolved:
- stop that meal's migration
- report it in `migration-report.json`
- do not silently choose a similar Food

## Validation

Before finishing:
- verify all 84 `meal-options.json` meal IDs are represented
- verify the two custom Foods are represented
- verify no Library Meal has authoritative P/C/F fields
- verify no canonical file has energy/calorie fields
- verify target values exactly
- verify every ingredient references an existing Food ID
- verify duplicate meal source is not used
- verify `live-settings-doc.json` is no longer a runtime dependency

Do not move on to visual redesign until the data migration passes these gates.

At the end, provide:
1. files created/changed
2. migration counts
3. unresolved/ambiguous ingredients
4. legacy-vs-calculated macro discrepancies
5. any assumptions requiring manual review
