# V2 data migration (Prompt 1)

Turns the legacy source files at the repository root into the canonical V2 data under
`data/` and `user-data/`, plus a report and ID maps under `migration/`.
Specification: `schema.md`, `migration-spec.md`, `prompts/01-data-migration.md`.

No dependencies beyond Node (tested on Node 22).

```bash
node migration/migrate.js           # generate → validate → write
node migration/migrate.js --check   # regenerate in memory; exit 1 if any generated file on disk differs
node migration/validate.js          # run the validation gates against the files on disk
```

## Files

| File | Role |
|---|---|
| `migrate.js` | The migration runner. Reads only the legacy sources and `migration-decisions.json`. |
| `validate.js` | The 16 blocking validation gates (G01–G16) and a small, dependency-free JSON Schema validator for the keyword subset the V2 schemas use. Unknown schema keywords throw rather than pass. |
| `macro-calc.js` | The one P/C/F formula the migration uses (`quantity / 100 × per-100 g value`, grams only). Migration tooling, not the V2 runtime utility — Prompt 2 owns that and the migration should import it once it exists, so there is still one formula. |
| `migration-decisions.json` | The approved decisions (retired meals, garnish lines, brand names, food-state rules, known audit issues). Change a decision here, re-run, review the report. |
| `expected-output-manifest.json`, `migration-source-map.json` | From the V2 package; the validator checks against both. |
| `migration-report.json` | Generated. Counts, conflicts, warnings, manual-review items, gate results. |
| `food-id-map.json` | Generated. Legacy food name → Food ID, custom foods, and every bank ingredient wording → Food ID. |
| `meal-id-map.json` | Generated. Legacy meal ID → Meal ID, with every original ingredient line and how it resolved. |

## Guarantees

- **Deterministic.** No timestamps or randomness; source order is preserved; output is
  byte-identical on every run (`--check` proves it).
- **Nothing written on failure.** Everything is generated and validated in memory first.
- **Blocking vs non-blocking.** `blockingErrors` (unresolved ingredient, non-gram unit,
  unapproved unquantified line, duplicate ID, targets ≠ approved, missing state rule) and
  any failed gate stop the run. `warnings` (preserved source anomalies) and `manualReview`
  (decisions that need a person) are recorded and do not stop it.
- **user-data is never overwritten.** Each `user-data/` file is seeded only if missing
  (written with the `wx` flag). The report records whether the existing file still equals
  the seed.
- **Legacy files are only read**, never moved or edited.
- **Only P/C/F.** The validator scans every canonical and generated file for forbidden
  nutrition-unit keys and values.

## How things map

- Food IDs: `food_core_` + the legacy name lower-cased with every non-alphanumeric run
  replaced by `_` (e.g. `Chicken breast, raw` → `food_core_chicken_breast_raw`). Custom
  Foods use `food_custom_`. IDs come from identity, never array position.
- Ingredient resolution: `CTC_FOOD` from `meal-bank.html` first (migration-only), then an
  exact Food name. Anything else blocks that meal. `ingredient-name-map.json` and
  `ingredients-flat.json` are used only as cross-checks.
- Food state: explicit when the legacy name says so (`raw`, `dry`, `frozen`, `canned`,
  `popped`, `roasted`); otherwise inferred by name or category from
  `migration-decisions.json` and flagged `metadata.stateInferred: true`. State never
  drives a conversion.
- Legacy meal `p/f/c` are compared with the calculation and then dropped.
- Yield conflicts are preserved on both sides: Food `metadata.yieldFactor` keeps
  `foods.json`; `data/reference/yields.json` is a byte-identical copy of `yields.json`.
