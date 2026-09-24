# Migration Specification — Existing Repo → Canonical V2 Data Model

## Source repository

`karlee425/meal_tracking`

The migration operates on the existing:
- `foods.json`
- `meal-options.json`
- `targets.json`
- `live-settings-doc.json`
- `yields.json`
- `portion-bounds.json`
- embedded legacy data in `meal-bank.html`

## Migration authority

### Foods

`foods.json` is the sole source for Core Food migration.

### Library Meals

`meal-options.json` is the sole source for Library Meal migration.

Do NOT merge `live-settings-doc.json -> bank.meals` back into the new Library Meals. It is a duplicate/older representation.

Current observed counts:
- `foods.json`: 182 foods
- `meal-options.json`: 84 meals
- `live-settings-doc.json -> bank.meals`: 82 meals
- `live-settings-doc.json -> customFoods`: 2 foods

`meal-options.json` contains two meal IDs not present in the duplicate live-settings meal bank: `L13` and `L16`. They must be retained.

## Exact file disposition

| Existing file/data | V2 destination |
|---|---|
| `foods.json` | `data/foods/core-foods.json` |
| `meal-options.json` | `data/meals/library-meals.json` |
| `targets.json` | `data/targets.json` |
| `live-settings-doc.json -> customFoods` | `user-data/custom-foods.json` |
| `live-settings-doc.json -> bank.meals` | discard as duplicate |
| `live-settings-doc.json -> measured` | discard unless a concrete preference is discovered |
| `live-settings-doc.json -> yields` | discard if empty; yield references remain in `data/reference/yields.json` |
| `yields.json` | `data/reference/yields.json` |
| `portion-bounds.json` | `data/reference/portion-bounds.json` |
| `meal-bank.html` embedded `M` | discard after Library Meals are migrated |
| `meal-bank.html` embedded `CTC_FOOD` | use once as migration resolution map, then delete |
| `meal-bank.html` embedded `TARGET` | discard; use `data/targets.json` |
| `meal-bank.html` embedded `SLOT_TARGET` | discard as authoritative target data |
| `meal-bank.html` embedded `SHIFT` / `SHIFT_FOOD` | discard as authoritative data; future Coach heuristic only |
| `meal-bank.html` embedded `DAYS` | do not hard-code recurring days into Day records |
| `meal-bank.html` embedded `NIGHT` | discard as authoritative target |
| `recost.js` | rewrite as canonical validation/calculation utility |
| `gen-bank-doc.js` | rewrite/remove depending on whether docs generation is retained |
| `close-the-carbs.html` | replace with V2 UI |
| `meal-bank.html` | replace with V2 UI/data layer |

## Food field mapping

Legacy:
- `n` → `name`
- `p` → `nutrition.protein`
- `f` → `nutrition.fat`
- `c` → `nutrition.carbs`
- `cat` → `category`
- `t` → `tags`
- `swap` → resolved Food reference in metadata
- `y` → `metadata.yieldFactor`
- `yk` → `metadata.yieldKey`
- `carb` → `metadata.macroRole = "carb"`
- `fat` → `metadata.macroRole = "fat"`
- `brandy` → `metadata.branded = true`
- `step` → `metadata.portionStep`

Add:
- stable `id`
- `source = "core"`
- explicit `state`
- `brand` where deterministically identifiable
- `aliases`
- measurement definition

Do not carry unknown legacy flags into the canonical schema unless their behavior is explicitly documented.

## Food state rules

Infer state only when the legacy name is explicit or unambiguous:
- `raw` for names ending/containing raw
- `dry` for dry grains/oats/pasta/rice
- `frozen` only when frozen is materially part of the food identity
- `prepared` for canned drained, popped, sauces, dairy products, etc.
- `baked` for bread-like baked foods
- otherwise `prepared` only after review; do not invent cooking conversions

Never transform raw ↔ cooked using yield at runtime.

## Stable ID policy

Generate IDs from normalized identity, not array position.

Pattern:
`food_core_<normalized_name>_<state>` when state is needed to disambiguate.

Examples:
- `food_core_chicken_breast_raw`
- `food_core_white_rice_dry`
- `food_core_fage_0_greek_yogurt`

Once assigned, IDs are permanent.

## Ingredient migration

Legacy meal `ing` is a semicolon-separated string.

Example:
`rolled oats 70 g; cottage cheese 2% 175 g; milk 2% 100 g`

must become structured ingredient records:
```json
[
  {"foodId":"food_core_rolled_oats_dry","quantity":70,"unit":"g"},
  {"foodId":"food_core_cottage_cheese_2","quantity":175,"unit":"g"},
  {"foodId":"food_core_milk_2","quantity":100,"unit":"g"}
]
```

Use the embedded legacy `CTC_FOOD` mapping from `meal-bank.html` as a migration-only alias map.

Do not keep `CTC_FOOD` in runtime code.

## Meal field mapping

- `id` → stable Library Meal ID
- `slot` → `mealType`
- `name` → `name`
- `lane` → metadata/tag
- `p/f/c` → discard after validation
- `wt` → `metadata.weightDescription`
- `min` → `metadata.prepMinutes`
- `batch` → `metadata.batchSize`
- `base` → `metadata.base`
- `ing` → `ingredients`
- `steps` → `metadata.steps`
- `store` → `metadata.storage`
- `note` → `metadata.notes`
- `native` → `metadata.nativeDayType`
- `isnew` → metadata only if still useful

Do not store meal P/C/F as authoritative fields.

## Meal validation

For every migrated Library Meal:
1. resolve every ingredient to a Food ID
2. verify quantity > 0
3. calculate P/C/F from Foods
4. compare calculated totals with legacy `p/f/c`
5. write a migration report
6. block final migration if an ingredient cannot be resolved
7. do not silently substitute a different Food

Legacy totals are validation evidence only and must not survive in the canonical Meal object.

## Custom Food migration

The two current `live-settings-doc.json -> customFoods` entries become:
- `food_custom_oats_overnight`
- `food_custom_oats_overnight_brand`

Preserve their current P/C/F values and tags. Preserve `looked` only as migration metadata if useful; do not make it part of core Food semantics.

## Targets migration

Canonical initial targets are explicitly:

- Lift: 150P / 293C / 70F
- Long Run: 150P / 343C / 70F
- Rest: 150P / 218C / 70F

The legacy source uses `long`; canonical uses `long_run`.

Do not migrate:
- `perSlot`
- `nightSnack`
- `carbShiftByDayType`

as authoritative target values.

These are legacy coaching/distribution heuristics and can be reintroduced later in Macro Coach.

## Historical data

The existing repo is primarily a prototype and does not contain a canonical Day/Meal Instance history store.

Do not fabricate historical Days or Meal Instances during migration.

The migration should initialize an empty:
- `daily-logs.json`
- `preferences.json`

and let new logging create historical snapshots.

## Duplicate elimination

After V2 data is generated:
- `live-settings-doc.json` must no longer be loaded by the application.
- `meal-bank.html` must not contain an embedded meal bank.
- `meal-bank.html` must not contain a second Food map.
- UI code must not contain authoritative target values.
- meal totals must not be duplicated as stored fields.

## Validation gates

Migration is complete only if:
- every Core Food has a stable ID
- every Library Meal ingredient resolves
- no Meal contains authoritative P/C/F totals
- no target file contains legacy `p/f/c` keys
- no runtime file loads `live-settings-doc.json`
- no runtime file contains `CTC_FOOD`
- no runtime file contains the legacy `M` meal array
- no historical record is generated
- the 84 Library Meal source IDs are represented
- the two custom Foods are represented
- initial targets equal 150/293/70 for Lift, 150/343/70 for Long Run, and 150/218/70 for Rest (P/C/F)
- no calorie/energy fields exist anywhere in canonical data

## Migration report

Generate:
`migration/migration-report.json`

It must include:
- source counts
- destination counts
- duplicate meal IDs
- unresolved ingredient references
- ambiguous ingredient references
- legacy-vs-calculated meal macro differences
- generated Food IDs
- generated Meal IDs
- custom Food IDs
- validation errors

## Approved migration decisions (24 September 2026)

These were approved in the Prompt 1 migration review and are encoded in `migration/migration-decisions.json`:

1. Preserve all 84 Library Meals from `meal-options.json`.
2. Keep L13 and L16 with `metadata.retired: true`.
3. Do not silently substitute or merge Foods.
4. The two 0 g cilantro lines (L26, D30) are garnishes/notes (`metadata.garnishes`), not structured macro ingredients.
5. Inferred Food states are acceptable when flagged with `metadata.stateInferred: true`.
6. No nutrition conversions based on inferred raw/cooked/prepared state.
7. Preserve the yield conflicts between `foods.json` and `yields.json` and report them; do not resolve them.
8. Preserve the Oats Overnight discrepancy and report it; do not merge/substitute those Foods.
9. Broken swap references are not invented or silently repaired.
10. Legacy source files stay in their original locations during migration.
11. Historical Close the Carbs hosted logs are not imported.
12. Nutrition-data audit issues are not resolved during this migration.
13. The earlier Lift gate "150/293/343" was a typo, corrected above to 150/293/70.
14. `data/targets.json` holds daily targets only; remaining macros are daily target − logged P/C/F.
15. Meal Instance logging slots are `breakfast`, `lunch`, `snack_afternoon`, `dinner`, `snack_night`; Library Meals keep `mealType: "snack"`.

## Implementation

See `migration/README.md`. In short:

```bash
node migration/migrate.js           # generate, validate, write (never overwrites user-data/)
node migration/migrate.js --check   # prove the committed output equals a fresh run
node migration/validate.js          # run the validation gates against the files on disk
```

Note: the legacy generator file is named `gen-bank-docs.js` in the repository (the table above says `gen-bank-doc.js`).
