# Close the Carbs — source package

Everything needed to rebuild the daily check-in, exported 23 September 2026.
Companion to the **Health Stack Teardown** page, which explains *why* things are
the way they are. This file covers *what is in the box*.

All figures are grams. There is an absolute rule that no energy/calorie figure is
ever displayed — see **Non-negotiables** below before writing any formatter.

---

## What's here

```
src/
  close-the-carbs.html      the page, exactly as authored (155 KB, no build step)
  meal-bank.html            its sibling — the source of the meal data it holds
data/
  foods.json                182 foods, per-100 g. THE source of truth for macros
  meal-options.json          84 meal options, full records
  ingredients-flat.json     707 ingredient lines, one row each, already parsed
  ingredient-name-map.json  154 entries: bank wording -> food-table name
  targets.json              daily targets, per-slot split, night snack, day-type scaling
  yields.json               38 raw->cooked factors + 16 per-recipe overrides
  fibre.json                fibre per 100 g, soluble share, brisk-fermenting list
  portion-bounds.json       plausible portion min/typical/max per food category
  live-settings-doc.json    the actual stored document, pulled live (version 7)
tools/
  recost.js                 recompute every option from its ingredients
  gen-bank-docs.js          regenerate the reference documents; refuses to run on drift
```

Both HTML files are single-file, no dependencies, no build. Open either directly
in a browser and it runs — minus the hosted storage, which only exists inside
the artifact runtime.

`src/close-the-carbs.html` is the authored file. The published page wraps it in a
small skeleton (`<!doctype html><head>` with a charset, viewport and reset) that
is added at publish time and is not in this file. The two were diffed on export
and are otherwise identical.

---

## The data model, in one page

### A food — `data/foods.json`

```json
{ "n":"White rice, dry", "p":6.5, "f":0.6, "c":79.0,
  "cat":"grain", "t":["savory"],
  "y":2.9, "yk":"rice",
  "carb":1 }
```

`p/f/c` are per 100 g on the stated basis (raw or dry for anything cooked).
`cat` drives plausible portion bounds. `t` tags drive which fix suggestions get
offered. `y` is the cooked yield; `yk` groups foods that share one disputed
factor. `carb`/`fat` flag what a food is *for* when suggesting a correction.
`brandy:1` marks a branded item whose value came off a package panel.
`swap` names a like-for-like alternative.

### A meal option — `data/meal-options.json`

```json
{ "id":"L26", "slot":"lunch",
  "name":"Southwest Chicken Salad + Sourdough",
  "lane":"Mexican · from Instagram",
  "p":43.1, "f":18.9, "c":80.9,
  "wt":"~555 g",
  "min":25, "batch":5,
  "base":"80 g sourdough + 90 g black beans",
  "ing":"chicken breast 78 g; black beans canned 90 g; …",
  "steps":["…"], "store":"Fridge 4 days…", "note":"…",
  "native":"lift", "isnew":true }
```

**`p`, `f` and `c` are derived, never authored.** They are computed from `ing`
against `foods.json` and written back by `tools/recost.js`. Treat them as a
cache. `ing` is the record.

- `wt` is the **cooked, plated** weight. Everything in `ing` is **raw or dry**.
  These two never mix — see Non-negotiables.
- `base` is the weighed starch base, cooked. Every option must have one; a meal
  that says "serve with rice" instead of naming a weight has failed its audit.
- `native` (`lift` | `rest` | `long`) says which day type the option is sized
  for. Absent means a lifting day.
- `note` is prose explaining *why the option is built this way*. 77 of 84 have
  one, averaging ~200 characters. They are the least replaceable thing here.

`ingredients-flat.json` is the same data pre-parsed if you'd rather not implement
the `"name 123 g; name 45 g"` parser: `{option, slot, ingredient, grams, unit, food}`.

### The stored document — `data/live-settings-doc.json`

This is the real runtime state, pulled from the artifact's store on export:

```json
{ "bank":   { "meals":[ … 82 reduced records … ], "at":1758… },
  "customFoods":[ { "n":"Oats overnight", "p":10.7, "f":6.9, "c":66.3, … } ],
  "measured":{}, "yields":{}, "updatedAt":1758… }
```

Held at `meta/settings` via the artifact `db` capability. Two things to know:

1. **`bank.meals` is a copy.** The Meal Bank page is the source; this is
   refreshed by an export action. It holds 82 of the 84 options because two were
   retired by hand. Removing this duplication is the main architectural win
   available in a rebuild.
2. **`customFoods` are hers, entered by hand**, and they sit *alongside* the
   built-in table rather than overriding it. That has already produced one live
   conflict — see Known bad data.

Daily entries live under `days/<YYYY-MM-DD>` in the same store, keyed by slot.

---

## Non-negotiables

These are not preferences. Each came from a specific failure.

1. **No energy figures, anywhere.** Not per meal, per day, in a total, in
   parentheses, as "≈", as "energy" or "kcal" or any synonym. A source
   containing such a column is stripped before display. Build this as a
   formatter that *cannot* render that unit, not as a convention.
2. **Targets are floors, not ceilings.** Never propose a smaller portion. Never
   suggest adding protein. When something is short, say how many grams short and
   give a weighed fix — "add 60 g cooked rice and 40 g avocado", never "eat a
   bit more".
3. **Carbohydrate first, then fat.** Carbohydrate is the only structural gap.
   Fat runs 1–2 g over target by design, so flagging fat "over" in red is wrong.
4. **Corrections route to the afternoon snack, never dinner.** Dinner is cooked
   for two.
5. **Raw/dry and cooked/plated never share a column.** Shopping and costing are
   raw. Cooked weights exist only for checking a plate.
6. **Cost bottom-up, cooking fats included.** Never trust a published recipe
   panel. The one exception is a sealed branded product, where the panel is the
   only ground truth available.

---

## Known bad data — do not silently "fix" these

Two sources disagreeing is recorded as a conflict rather than resolved, on a
standing rule: say so and stop, don't average or pick.

| What | The disagreement | Impact |
|---|---|---|
| Cooked rice yield | `foods.json` says ×2.9; the Meal Bank uses ×3.0; an older file says ×3.14 | ~25 g of carbohydrate a day — about half the gap the whole system exists to close |
| Oats Overnight packet | Built-in row says 26.3 g protein/100 g; her hand-entered custom food says 10.7 | Makes breakfast option **B8** the least trustworthy record in the bank |
| Chicken / salmon / potato yields | ×0.72 / ×0.79 / ×0.78, all unmeasured reference values | Unknown, probably small |
| Potato yield basis | ×0.78 is a *roasting* yield; boiled potato is closer to ×1.0 | Logging a boiled potato by cooked weight over-credits carbohydrate ~28% |
| Branded items | granola, protein powder, crackers, jerky at implied values; the three snack items added 19 Sep came off published panels | Check against the packs actually bought |

All of the first four close with a kitchen scale and one evening.

---

## The tools

```bash
node tools/recost.js            # report every option whose stored macros disagree
node tools/recost.js --write    # recompute p/f/c from ingredients and write back
node tools/recost.js --check    # exit 1 if anything is out of date
node tools/gen-bank-docs.js     # rebuild the reference docs; runs --check first
```

Both read `src/meal-bank.html` and `src/close-the-carbs.html` from the directory
above them — adjust the paths at the top of each file if you move things.

`gen-bank-docs.js` refuses to emit a calorie word at all, and refuses to run if
any stored macro disagrees with its own ingredient list. That guard is the reason
the two stopped drifting; a rebuild should keep an equivalent.

---

## What the page does today, and where it hurts

Three tabs: **Today** (the carbohydrate number, protein and fat, four slots, a
weighed fix when short), **Meals** (a recipe builder that costs a new dish from
ingredients), **Trend** (hit-rate, a 21-day tick grid, which slot leaks).

**Logging is currently paused because the page is too slow to use daily.** That
is the problem to solve, and it is specific: logging a meal means finding a food,
entering a weight, and repeating per ingredient. Meanwhile 84 pre-costed options
are sitting in the same browser. **Logging a planned meal should be one tap** —
rebuilding it from parts is the fallback path, not the main one.

This matters beyond convenience. The primary metric is carb hit-rate — days out
of seven at or above target, deliberately not a weekly average, because shape is
the diagnosis. It cannot be computed while logging is paused, which parks the
open question the whole system exists to answer.

One more decision worth making early: **whether the rebuild carries fibre.** The
Meal Bank shows it; this page carries none. There is deliberately no fibre
target, so an interface that draws a fibre line re-creates a contradiction that
took two documents to settle.
