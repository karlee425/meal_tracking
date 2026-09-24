# Macro Tracking App — Formal Data Schema

## Purpose

This document defines the canonical V2 data model for the macro tracker redesign.

The architecture is intentionally limited to protein, carbohydrates, and fat. No energy/calorie field may be introduced into the canonical model, UI state, calculations, exports, migration output, or Macro Coach data.

## Source-of-truth rules

1. Foods own nutrition.
2. Meals own ingredient composition.
3. Meal macro totals are always derived from Foods + ingredient quantities.
4. Library Meals are app-managed recipes.
5. Saved Meals are user-managed living recipes.
6. A Meal Instance is the historical snapshot of what was actually logged.
7. Day owns day type and historical target snapshot.
8. Current Targets are configuration for future/new Days.
9. Progress is derived from Days; it is not an authoritative stored object.
10. Macro Coach recommendations are derived at runtime.
11. Stable Food IDs and Meal IDs never change.
12. Historical Meal Instances never silently change when source Foods, Meals, or Preferences change.
13. Historical Day target snapshots never silently change when current Targets change.
14. There must be no duplicate authoritative copy of meal recipes or nutrition.

## Entity model

### Food

```json
{
  "id": "food_core_chicken_breast_raw",
  "name": "Chicken Breast",
  "source": "core",
  "category": "protein",
  "brand": null,
  "state": "raw",
  "nutrition": {
    "basis": "100g",
    "protein": 22.5,
    "carbs": 0,
    "fat": 2.6
  },
  "measurement": {
    "canonicalUnit": "g",
    "servingSize": 100,
    "servingUnit": "g"
  },
  "tags": ["savory"],
  "aliases": ["chicken breast", "chicken"],
  "metadata": {
    "editable": false,
    "active": true
  }
}
```

Required fields:
- `id`
- `name`
- `source`
- `category`
- `state`
- `nutrition`
- `measurement`
- `metadata.active`

`source` is one of `core`, `custom`, `external`.

`state` is explicit. Do not infer raw/cooked/dry/prepared conversions at runtime.

Nutrition is stored on a 100g canonical basis for the current curated food set. The measurement model must also support non-gram user-facing units later.

Migration metadata used by the Prompt 1 data (all optional):
- `metadata.stateInferred: true` — the state was inferred during migration rather than stated in the legacy name. Inferred states never drive a nutrition conversion.
- `metadata.legacySwap` — a legacy swap name that does not resolve to a different Food. Kept as text, not repaired. `metadata.swapFoodId` is set only when the swap resolves.

### Meal

```json
{
  "id": "meal_library_B1",
  "name": "Big Oat Jar with Chia",
  "source": "library",
  "mealType": "breakfast",
  "ingredients": [
    {
      "foodId": "food_core_rolled_oats_dry",
      "quantity": 70,
      "unit": "g"
    }
  ],
  "favorite": false,
  "metadata": {}
}
```

Required:
- `id`
- `name`
- `source`
- `ingredients`

`source` is one of `library`, `saved`, `external`.

`mealType` describes what a Meal is (`breakfast`, `lunch`, `snack`, `dinner`, `other`). It is not the slot it is logged into — a Library Meal with `mealType: "snack"` can be logged into either snack slot.

Never store authoritative `protein`, `carbs`, or `fat` totals on a Meal.

Library Meal metadata carried from the legacy bank (all optional): `legacyId`, `lane`, `nativeDayType`, `weightDescription` (cooked/plated), `prepMinutes`, `batchSize`, `base`, `steps`, `storage`, `notes`, `ingredientLabels` (original bank wording keyed by Food ID, where it differs from the Food name), `garnishes` (unquantified lines, never part of the macro calculation), `isNew`, `retired`.

### Meal Instance

A Meal Instance is created at the logging boundary.

It stores:
- source meal ID when applicable
- historical meal name
- slot
- exact quantities
- Food IDs for provenance
- historical Food names
- historical P/C/F contribution for each ingredient
- historical totals
- timestamp

The ingredient snapshot is mandatory because source Foods can later be edited, retired, or deleted.

Logging slots (`mealSlot`) are exactly:
- `breakfast`
- `lunch`
- `snack_afternoon`
- `dinner`
- `snack_night`

There is no fixed per-slot macro allocation. Remaining macros are calculated for the day: daily target − logged P/C/F.

### Day

```json
{
  "id": "day_2026-09-24",
  "date": "2026-09-24",
  "dayType": "lift",
  "targetSnapshot": {
    "protein": 150,
    "carbs": 293,
    "fat": 70
  },
  "mealInstances": []
}
```

`targetSnapshot` is copied when a Day is created. It is authoritative for that date.

### Targets

Current configuration:

```json
{
  "lift": {
    "protein": 150,
    "carbs": 293,
    "fat": 70
  },
  "long_run": {
    "protein": 150,
    "carbs": 343,
    "fat": 70
  },
  "rest": {
    "protein": 150,
    "carbs": 218,
    "fat": 70
  }
}
```

The source repo calls the long-run type `long`; the canonical model calls it `long_run`.

Do not migrate the legacy `perSlot`, `nightSnack`, or `carbShiftByDayType` structures as authoritative targets. They become future coaching heuristics if needed. Targets are daily only; remaining macros are always daily target − logged P/C/F.

### Preferences

V1 is intentionally lightweight:

```json
{
  "favoriteFoods": [],
  "favoriteMeals": [],
  "dislikedFoods": [],
  "mealPreferences": {
    "preferredMealSize": "moderate",
    "preferQuickMeals": false
  },
  "coachingPreferences": {
    "recommendSavedMealsFirst": true,
    "considerVariety": true
  },
  "appPreferences": {}
}
```

### Progress

Progress is derived, not persisted as authoritative data.

It is calculated from:
- Days
- Meal Instances
- target snapshots

Missing meal slots are not interpreted as zero intake.

## Macro calculation

For a food with P/C/F per 100g:

`contribution = quantity / 100 × food nutrition`

Meal totals are the sum of ingredient contributions.

Use a single shared calculation function everywhere:
- Meal detail
- logging flow
- Today
- Progress
- Macro Coach

Do not maintain separate macro math in individual screens.

## Historical boundary

```text
Food
  ↓
Meal Recipe
  ↓
LOGGING BOUNDARY
  ↓
Meal Instance Snapshot
  ↓
Day
```

Changes above the logging boundary affect future calculations only.

Changes below the boundary are historical user records and must not silently recalculate.

## Food lifecycle

Core Foods:
- app-managed
- can be updated or retired
- should not be hard-deleted if references remain

Custom Foods:
- user-managed
- create/edit/delete
- stable ID
- if deleted while referenced by a Saved Meal, the Saved Meal becomes invalid and asks the user to replace the missing Food
- historical Meal Instances remain valid

If a Food's nutrition changes:
- current Food changes
- Saved Meals recalculate
- future Meal Instances use new values
- existing Meal Instances do not change

## Meal lifecycle

Library:
- app-managed
- can be logged without saving
- saving creates an independent Saved Meal copy

Saved:
- user-managed
- edit/duplicate/log/delete
- editing changes future use only
- deleting does not delete history

A modified Meal Instance can:
1. log the modification only
2. save as a new Meal
3. explicitly update the Saved Meal after confirmation

## Day lifecycle

A Day is created on first interaction with that date.

Day type can change later. Changing it:
- changes target context
- does not change logged food
- does not rewrite historical Meal Instances

Deleting a Day's logged data removes its Meal Instances and target snapshot for that date only.

## Search and units

Search is the primary food-entry interface.

Canonical internal quantity is grams for the current data set, while the measurement model supports future user-facing units such as:
- egg
- tortilla
- slice
- packet
- scoop

No silent unit conversion should occur.

## Explicit non-goals for V1

Do not add:
- restaurant database
- barcode scanning
- AI food recognition
- grocery lists
- social sharing
- photo logging
- recipe generation
- full meal planning
- food-quality scoring
- weight/body-composition tracking
- performance tracking
- permanent Macro Coach tab

## Change log

- 2026-09-24 (Prompt 1 migration): Meal Instance `mealSlot` changed from `breakfast | lunch | snack | dinner | other` to the agreed logging slots `breakfast | lunch | snack_afternoon | dinner | snack_night` (also in `data/schemas/meal-instance.schema.json`). Meal `mealType` is unchanged. Documented the migration metadata fields on Food and Library Meal.
