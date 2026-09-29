# Claude Prompt 3 — Remove Legacy Architecture + Stress-Test

The canonical data layer is implemented. Now remove the legacy architecture and validate the system.

## Remove

The runtime application must no longer depend on:
- `live-settings-doc.json`
- embedded `M` meal arrays
- embedded `CTC_FOOD`
- hard-coded `TARGET`
- hard-coded `SLOT_TARGET`
- hard-coded `SHIFT`
- hard-coded `SHIFT_FOOD`
- independent stored Meal P/C/F totals

The legacy files may remain temporarily as migration inputs/documentation, but they must not be runtime dependencies.

## Run these tests

### Test 1 — Saved Meal logging
Log a Saved Meal. Verify a Meal Instance snapshot is created.

### Test 2 — Modify logged meal
Change one ingredient quantity. Verify:
- instance changes
- Saved Meal does not

### Test 3 — Edit Saved Meal
Change a Saved Meal. Verify:
- future use changes
- existing Meal Instance does not

### Test 4 — Food update
Change a Custom Food's nutrition. Verify:
- Saved Meals recalculate
- future logs use new values
- historical instances do not change

### Test 5 — Food deletion
Delete a Custom Food used by a Saved Meal. Verify:
- Saved Meal is marked invalid
- user is asked to replace the Food
- historical logs remain valid

### Test 6 — Day Type change
Change Lift → Rest after logging food. Verify:
- food stays identical
- target context changes
- remaining macros recalculate

### Test 7 — Target change
Change current Lift target. Verify:
- future/new Day uses new target
- existing Day target snapshots remain unchanged

### Test 8 — Partial day
Log only lunch. Verify:
- absent meals are not treated as eaten zero
- Progress identifies the data as based on logged meals

### Test 9 — Duplicate foods
Keep similar Foods separate. Verify the system never auto-merges them.

### Test 10 — Raw/cooked
Verify raw and cooked Foods are separate states and no silent yield conversion occurs.

### Test 11 — Library copy
Save a Library Meal. Edit the saved copy. Verify the Library Meal does not change.

### Test 12 — Direct food logging
Log a Food without creating a named Saved Meal. Verify this is supported.

### Test 13 — Meal calculation
For every Library and Saved Meal:
- every ingredient resolves
- totals calculate
- no stored authoritative P/C/F totals exist

### Test 14 — Forbidden nutrition field scan
Search all runtime and canonical data for:
- `calorie`
- `calories`
- `kcal`
- `energy`

Remove any implementation fields if found.

### Test 15 — Duplicate source scan
Search for:
- `live-settings-doc`
- `CTC_FOOD`
- `var M =`
- `SLOT_TARGET`
- `carbShiftByDayType`

The result should show migration-only references, not runtime dependencies.

Report every failure explicitly. Do not mask failed tests.
