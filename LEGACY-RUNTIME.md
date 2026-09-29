# Legacy runtime — retired (Prompt 3)

The V2 runtime is `src/` (the domain layer in `src/domain/` plus its adapters). It reads only the
canonical data in `data/` and `user-data/`, and every protein/carbs/fat number comes from
`src/domain/macros.js`.

The two pre-V2 pages and their tools are **retired from the runtime**. They stay in the repository
byte-for-byte, as rollback/reference and (for some) as migration inputs, but nothing in the V2
runtime loads, imports or copies from them. `runtime-boundary.json` classifies every file, and
`tests/runtime-boundary.test.mjs` enforces the boundary: it reports the exact file, line and
identifier of any legacy dependency in runtime code or canonical data, and it fails if a legacy
file changes.

They were retired rather than rewired because their screens are built on the rules V2 removes.
Swapping their data access would change what they show, which is UI redesign work, not cleanup.
Each blocker is listed below so the UI rebuild can address it deliberately.

The published claude.ai versions of these pages are separate and are not changed by this
repository. Their stored data (days, settings, week plans) is not read by V2, and historical logs
are not imported.

## `close-the-carbs.html` — the old check-in / logging page

| Legacy piece | Why it is not V2 | V2 replacement | UI rebuild note |
|---|---|---|---|
| `FOODS` (embedded food table) | Second copy of Food nutrition | Foods API over `data/foods/core-foods.json` + `user-data/custom-foods.json` | Search with `searchFoods` |
| `BANK_SEED` / `BANK_MEALS` (embedded bank with stored totals) | Second meal bank; stored P/C/F totals | Library / Saved Meals; `calculateMealMacros` | Meal totals are always derived |
| `BANK_ALIAS` | Second ingredient-name map | Food `aliases` (built from the migration alias map) | — |
| `TARGETS` (per-slot targets; day total = sum of slots) | Fixed per-slot allocation; keys `lifting` / `longrun` | `getCurrentTargets` / Day `targetSnapshot`; remaining = daily target − logged | Slot bars, "slot closed at 80 %", slot fixes and Trend "leaks" have no V2 rule to draw on; the Today design must decide what replaces them |
| `NIGHT` (18/4/18) | Mandatory night-snack rule, drifted from 17.3/4.3/17.7 | None. `snack_night` is an ordinary slot | A missing slot is "not logged", never zero |
| `defaultType()` (Sat long run, Sun rest) | Hard-coded weekly schedule | Day type is chosen per Day (`createDay`, `dayType` on first log) | The UI asks, or offers a user preference later |
| `computeMacros` cooked basis + editable yields | Runtime raw↔cooked conversion | None: Food state is descriptive; separate Foods for separate states | Logging by cooked weight needs a cooked Food, not a conversion |
| `totalsOf`, `slotTotals`, `dayTotals`, solver, `sourceFixes` | Screen-level P/C/F arithmetic | `macros.js` via `getDaySummary`, `calculateMealMacros`, `getProgress` | The portion solver and gap fixes are coaching features for the Macro Coach stage, not the data layer |
| Storage: browser storage + hosted `days`, `meta/settings`, `checkin/state` | Separate day and settings formats (the source of the live-settings export) | `user-data/daily-logs.json`, `user-data/preferences.json`, `user-data/custom-foods.json` via an adapter | A browser adapter for the hosted store is UI-integration work |
| `askForMeal` / `lookupFood` (calls Claude from the page) | AI dependency | None in V2 | Out of scope until the Macro Coach stage |

## `meal-bank.html` — the old planner

| Legacy piece | Why it is not V2 | V2 replacement | UI rebuild note |
|---|---|---|---|
| `M` (embedded meals with stored `p/f/c`) | Second meal store; stored totals | `data/meals/library-meals.json`, `user-data/saved-meals.json` | — |
| `CTC_FOOD` | Alias map | Used once by the migration only (`migration/`) | — |
| `TARGET`, `SLOT_TARGET`, `NIGHT` | Hard-coded daily / per-slot / night targets; key `long` | Targets API + Day snapshots | — |
| `SHIFT`, `SHIFT_FOOD`, `carbFor` | Carb-shift rules by day type | None as authoritative rules (possible future coaching heuristic) | The week builder's day-type sizing needs a V2 design |
| `DAYS` | Fixed weekly lift/long/rest pattern | Day type per Day | — |
| `ctcPayload` export to Close the Carbs | Pushes a duplicate bank with stored totals | None: one Meal store | — |
| Fibre tables, yields for cooked display | Fibre is not a V2 dimension; yields are reference only | `data/reference/yields.json` is reference data, never used in calculation | — |
| Storage: browser storage + hosted `state/current` | Week plan / checks / hidden options format | Not migrated (planning is a V1 non-goal) | — |

## Legacy tools

| File | Status |
|---|---|
| `recost.js` | Obsolete: it rewrote stored meal totals inside `meal-bank.html`. V2 never stores meal totals. **Do not run.** Its paths do not resolve in this repository. |
| `gen-bank-docs.js` | Generated the Claude Project bank documents from `meal-bank.html`. Not part of V2. |

## Legacy data files

`foods.json`, `meal-options.json`, `targets.json`, the live-settings export, `yields.json`,
`portion-bounds.json`, `ingredient-name-map.json`, `ingredients-flat.json`: migration inputs and
cross-check evidence (see `migration/`). `fibre.json`: reference only. `README.md`: the original
source-package description, kept as-is.

## Deliberately unchanged

- **`favorite: false` on Library Meals** (written by the Prompt 1 migration). The runtime never reads
  or writes a Meal's `favorite` field; `user-data/preferences.json` (`favoriteMeals`) is the only
  favourites store, and a test enforces that. Removing the field would mean regenerating
  `data/meals/library-meals.json` and is left for a later, explicit decision.
- **Legacy files are not deleted.** They are rollback/reference and migration inputs.
