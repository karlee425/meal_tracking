# V2 UI / Product Contract

**Repository:** `karlee425/meal_tracking` · **Branch:** `v2-data-architecture`
**Status:** authoritative implementation contract for the V2 UI. Written against the commit that adds this file (on `f040b70`, `2046613`, `2cd7932`). Supersedes `V2_UI_CONTRACT_DRAFT.md` and the review drafts. Amended by "Reconcile V2 product decisions" (A-41–A-45, I-58–I-60) and "Resolve remaining V2 contract ambiguities" (A-46–A-48; A-44 extended); A-46 and A-47 finalized by "Finalize Food picker detail contract".

---

## 0. How to read this

Every decision carries one tag, with an ID that points to the registers in §18–§21.

| Tag | Meaning |
|---|---|
| **APPROVED** `A-nn` | A product decision you've approved, or behaviour the domain enforces. Fixed; the UI conforms. |
| **IMPLEMENTATION NOTE** `I-nn` | How the UI implements an approved decision: layout, wording, flow details. Followed as written; a change to one of these doesn't change the product model, and can be made in review without reopening an approved decision. |
| **FUTURE / BACKLOG** `F-nn` | Explicitly outside V2. Not implemented, not stubbed. |

Where the domain already determines a behaviour, this contract describes what the code does. Every domain function named here exists in the repository; there are no outstanding domain gaps (§20).

**Words used in this document.** *Day*: one date's record (type, targets, logged meals, done state). *Logged meal*: a Meal Instance (a historical snapshot). *Saved Meal*: the user's recipe. *Library Meal*: app recipe. *Food*: Core (app) or Custom (user). *Slot*: where a meal was logged. *Remaining*: target − logged, per macro.

---

## 1. Product principles

| # | Principle | Tag |
|---|---|---|
| 1.1 | Protein, carbs and fat in grams are the only nutrition numbers anywhere: screens, labels, tooltips, charts, accessibility text, exports. No energy figure or synonym exists in the product. | APPROVED A-01 |
| 1.2 | Optimise for foods the user actually eats. Favourites, recents and Saved Meals come before the catalogue on every picking surface; search is the fallback. | APPROVED A-02 |
| 1.3 | Targets are daily only. Remaining = daily target − logged. No per-slot targets exist and nothing in the UI implies one. | APPROVED A-05, A-06 |
| 1.4 | Targets are floors. Reaching or passing one is shown neutrally, never as an error or overage. | APPROVED A-05 (domain `meetsTarget`) |
| 1.5 | A slot is a place, not a quota. An empty slot means "not logged", never "0 g". No slot is required. | APPROVED A-06 |
| 1.6 | A day is complete only when the user says so (Done Logging). | APPROVED A-07 |
| 1.7 | Logged meals are records. They show what was logged and never change because a Food or Saved Meal changed. | APPROVED A-13 |
| 1.8 | Every number on screen comes from a domain call or a stored snapshot. Screens format; they never calculate. | APPROVED A-30 |
| 1.9 | Food state (raw, cooked, dry…) is always visible where a Food is chosen, and never converted. Grams only. | APPROVED A-16 |
| 1.10 | Saving is visible. The user can always tell whether their data is saved, and a failure is never silent. | APPROVED A-24 |
| 1.11 | Calm and practical: no scores, streaks, badges, good/bad colouring or praise/scolding copy. | APPROVED A-22 · tone IMPLEMENTATION NOTE I-52 |

---

## 2. Information architecture

### 2.1 Structure

```
App shell
├── Primary: Today · Log · Meals · Progress          (persistent navigation)
├── Secondary: Settings                              (header control on every primary screen)
├── Global: save-status indicator                    (header, every screen)
└── Contextual (never in the nav):
    ├── Macro Coach            ← Today
    ├── Day-type chooser       ← Today, Log (when a date has no Day)
    ├── Logged-meal detail/edit← Today
    ├── Meal detail / editor   ← Meals, Log, Today, Coach
    ├── Food detail / Custom Food form ← Log, Food picker, Coach, Settings
    └── Backup / Restore       ← Settings (and error screens)
```

| Item | Tag |
|---|---|
| Primary navigation is exactly Today, Log, Meals, Progress, in that order. Today is the launch screen. | APPROVED A-03 |
| Settings is secondary, reached from a header control (gear) on every primary screen. | IMPLEMENTATION NOTE I-02 |
| Macro Coach has no nav item; it opens from Today only. | APPROVED A-03 |
| A global save-status indicator lives in the header of every screen (§4.8). | IMPLEMENTATION NOTE I-17 |

### 2.2 What each screen can reach

| From | Can reach |
|---|---|
| Today | Log (preset date + slot), Macro Coach, logged-meal detail → edit, Meal detail (source of a logged meal), day-type chooser, other dates, Settings |
| Log | Food detail, Meal detail, Custom Food form, day-type chooser, back to origin |
| Meals | Meal detail, Saved Meal editor (create/edit), Food picker (from editor), Log confirm sheet, Settings |
| Progress | Today for any listed date, Settings |
| Settings | Targets editor, My Custom Foods → Food detail/form, Favourites, Foods not to suggest, Backup, Restore, About |

### 2.3 Persistent navigation vs contextual actions

- **Persistent:** the four tabs, the Settings control and the save-status indicator. Always visible on primary screens. [IMPLEMENTATION NOTE I-01]
- **Contextual:** actions belonging to the current object (Add, Done Logging, Log this meal, Save a copy, Edit). Shown on the screen or sheet they act on, never in the nav. [IMPLEMENTATION NOTE I-01]
- **Pushed views** (detail, editor, form) hide the tab bar on mobile and show a back control; on desktop they open as a right-hand panel beside the list that launched them. [IMPLEMENTATION NOTE I-01]
- **Sheets/dialogs** are for short choices and confirmations: day type, slot, quantity, destructive confirmation, Coach. [IMPLEMENTATION NOTE I-01]

---

## 3. Navigation

### 3.1 Layout by width [IMPLEMENTATION NOTE I-05]

| Width (conceptual) | Navigation | Content |
|---|---|---|
| Compact (< ~600 px, phones) | Bottom tab bar, 4 items, icon + label | Single column. Sheets from the bottom. Pushed views full-screen. |
| Medium (~600–1024 px, tablets, narrow windows) | Bottom tab bar or left rail (implementation's choice) | Single column, wider cards; detail may open as a side panel when there's room. |
| Wide (> ~1024 px) | Left rail with labels | Two panes: list/summary left, detail right. Dialogs centred; sheets become anchored popovers or side panels. Max content width so numbers stay close together. |

Must work from 320 px wide with no horizontal scrolling and at 200 % text size.

### 3.2 Global behaviour [IMPLEMENTATION NOTE I-01]

- Switching tabs keeps each tab's state (scroll position, search text, selected segment, Progress range) for the session.
- The Today tab always has a way back to the real today ("Today" chip) when showing another date.
- Browser back/forward and deep links work: every primary screen and every Day (`?date=YYYY-MM-DD`) has a URL. Detail views may be URL-addressable; sheets aren't. Exact routing is an implementation detail.
- Leaving a form with unsaved edits asks "Discard changes?" (Keep editing / Discard).
- On app focus: the save queue is flushed on hide/close (`flushPersistence`), and if the local date has rolled over while the user was viewing "today", Today moves to the new date (§4.5.6).

### 3.3 Where actions return

Summarised here; full map in §16. [IMPLEMENTATION NOTE I-23]

| Action started from | After success, the user is on |
|---|---|
| Today (slot +, Add, Coach) | Today, scrolled to the slot, new row highlighted briefly |
| Log tab | Log, ready to log another item, with a "View on Today" link in the confirmation |
| Meals (Log this meal) | Meals (same place), with a "View on Today" link |
| Editor (Saved Meal, Custom Food) | The detail view of the thing just saved; except a Custom Food created or edited from the Log flow, which returns to the Log quantity sheet for that Food (§5.6, §7.4) |
| Settings actions | Settings, same section |

---

## 4. Today

The Day view for one date. Opens on `getToday()` (the device's local date). [APPROVED A-29]

### 4.1 Layout and hierarchy [IMPLEMENTATION NOTE I-06]

Top to bottom (compact); left column vs right column on wide screens:

1. **Header:** date ("Today · Fri 25 Sep" or "Wed 10 Sep"), ◀ ▶ date controls, day-type chip, save-status indicator, Settings.
2. **Macro panel**, the dominant element: three blocks in fixed order **Protein · Carbs · Fat**. Each shows:
   - **remaining grams** (largest number on the screen) with the word "left", or "Target reached" when met
   - "{logged} of {target} g" beneath (secondary)
   - a neutral progress bar whose fill is the domain's `progress[m]` (0–1, capped at 1 once reached) — never computed in the UI [APPROVED A-39]
3. **Day status line:** "Nothing logged yet" / "{n} meals logged · 3 of 5 slots" / "Done logging ✓".
4. **Slot list:** Breakfast, Lunch, Afternoon Snack, Dinner, Night Snack.
5. **Action bar:** **Build My Next Meal** (primary), **Add** (secondary), **Done Logging** (secondary; see 4.4). Sticky above the tab bar on compact screens; under the macro panel on wide screens.

Why remaining is largest: the question on opening the app is "what's left?". Logged and target are context.

### 4.2 Macro display rules

| Rule | Source | Tag |
|---|---|---|
| All values come from `getDaySummary(date)`: `target` (the Day's snapshot), `logged`, `remaining`, `reached`, `overBy`. No arithmetic in the UI. | domain | APPROVED A-30 |
| Displayed values are rounded with `macros.roundMacros` (whole grams on Today; one decimal in ingredient rows). Never written back. | domain helper | IMPLEMENTATION NOTE I-06 |
| `reached[m] === false` → "**{remaining} g left**". | domain | IMPLEMENTATION NOTE I-07 |
| `reached[m] === true` → "**Target reached**", with "+{overBy} g" in secondary text. Same colour family as normal. No red, no warning icon, no "over" framing. | domain | IMPLEMENTATION NOTE I-07 |
| Day exists, nothing logged (`logged: null`) → remaining shows the full target; the "of" line reads "Nothing logged yet". | domain | IMPLEMENTATION NOTE I-06 |
| No Day for the date → the macro panel is replaced by the day-type chooser (4.5.1). | domain (`exists: false`) | APPROVED A-09 |
| Targets shown are always the Day's snapshot, never live current targets. | domain | APPROVED A-12 |

### 4.3 Meal slots

#### 4.3.1 Appearance [IMPLEMENTATION NOTE I-08, I-09]

- All five slots are always shown in canonical order, even when empty.
- **Empty slot:** the slot name, a quiet "Not logged", and a **+** button. Never "0 g", never a warning.
- **Populated slot:** the slot name, then one row per logged meal in `loggedAt` order. Several logged meals per slot are normal. [APPROVED A-06, domain allows any number]
- **Logged-meal row:** meal name (snapshot `mealName`) · P / C / F from the snapshot `totals` · a small source marker ("Saved", "Library", or none for foods logged directly) · a ⋯ menu.
- **No slot subtotals.** A per-slot total next to each heading visually recreates slot targets. [IMPLEMENTATION NOTE I-09]
- The slot list's info control explains once: "Slots are just where you logged food. An empty slot means nothing's logged there, not that you ate nothing, and no slot is required." [IMPLEMENTATION NOTE I-08]

#### 4.3.2 Adding food [IMPLEMENTATION NOTE I-10]

| Entry | Opens | Preset |
|---|---|---|
| Slot **+** | Log (§5) on the Meals segment | date, slot |
| **Add** (action bar) | Log on the Meals segment | date; slot chosen in the confirm step |
| **Build My Next Meal** | Macro Coach (§8) | date |

From Log the user can pick a **Saved Meal**, a **Library Meal** or a **Food**; all three produce one logged meal in the chosen slot. [APPROVED capabilities A-13, A-15]

#### 4.3.3 Logged-meal detail (pushed view) [IMPLEMENTATION NOTE I-10]

| Shows | Source |
|---|---|
| Name, slot, date, "Logged at {local time}" | snapshot |
| Ingredient table: food name · grams · P · C · F | snapshot `ingredients[]` (not live Foods) |
| Totals: P · C · F | snapshot `totals` |
| Source line: "From Saved Meal *X*" / "From Library Meal *X*" / "From a meal that's since been deleted" / nothing (logged directly) | `sourceMealId` + `getMeal` |
| Note: "This is a record of what you logged. Later changes to foods or saved meals don't change it." | static |

Actions: **Edit this logged meal** (primary) · **Move to another slot** · **Delete** · **Edit Saved Meal "{name}"** (only if the source Saved Meal still exists; visually separate; opens the Saved Meal editor, not this record). [APPROVED distinction A-13]

#### 4.3.4 Editing a logged meal [APPROVED capability A-13, A-14 · layout IMPLEMENTATION NOTE I-10]

Title "**Edit logged meal**" with "{Slot} · {date}" underneath, never plain "Edit meal". Banner: "You're editing the record for {date}. Your Saved Meal won't change."

| Control | Domain |
|---|---|
| Name (required) | `patch.mealName` |
| Slot | `patch.mealSlot` |
| Ingredient grams (edit), remove, add ingredient (Food picker) | `patch.ingredients` — existing ingredients rescale from their own snapshot, so this works even if the Food was later changed or deleted; new ingredients use the current Food |
| Live totals and "what's left after this" while editing | `previewMealInstanceUpdate(date, id, patch)` → `instance`, `before`, `after` |
| Save | `updateMealInstance(date, id, patch)` |

- The last ingredient can't be removed; its remove control reads "Delete this logged meal instead". [domain: ≥ 1 ingredient]
- **After saving an instance whose source is an existing Saved Meal and whose ingredients changed**, one follow-up choice appears [APPROVED A-14]:
  1. **Just this time** (default)
  2. **Save as a new Saved Meal** → name → `createSavedMeal({ name, mealType, ingredients })`
  3. **Also update "{Saved Meal}"** → confirm: "This changes the recipe for next time. Meals you've already logged, including this one, stay as they are." → `updateSavedMeal(id, { ingredients })`
  
  If the source is a Library Meal, only 1 and 2 are offered (Library is read-only).

#### 4.3.5 Moving and removing [IMPLEMENTATION NOTE I-10]

- **Move to another slot:** slot sheet → `updateMealInstance(date, id, { mealSlot })`. Totals don't change (daily targets).
- **Delete:** dialog "Delete *{name}* from {Slot} on {date}? Saved and Library meals aren't affected." → `deleteMealInstance`. No undo in V2 (confirmation instead).
- If deleting the last logged meal of a Done day: the domain reopens the day automatically; the UI says "The day is no longer marked done because nothing is logged." [APPROVED A-08]

#### 4.3.6 How totals update

Every write is synchronous. After any add, edit, move or delete, Today re-reads `getDaySummary`; the macro panel and the row appear updated immediately, with no loading state. A polite screen-reader announcement states the new remaining values once. [APPROVED sync writes · IMPLEMENTATION NOTE announcement I-53]

### 4.4 Day state

#### 4.4.1 States [domain-defined, APPROVED A-07, A-08, A-09]

| State | Condition (`getDaySummary`) | What Today shows |
|---|---|---|
| **No Day** | `exists: false` | Day-type chooser; slots listed but "+" opens the chooser first; no Coach; no Done Logging |
| **Unstarted** | `exists`, `status: 'no_data'` | Full targets as remaining, "Nothing logged yet", Coach available, **Done Logging disabled** with hint "Log something first" |
| **In progress** | `status: 'partial'` | Normal Today; Done Logging enabled |
| **Done** | `status: 'complete'` (`loggingComplete: true`) | "Done logging ✓" status line and a subtle Done badge next to the date; Done Logging becomes **Reopen day**; everything else still works |

Slot coverage (`loggedSlots`) is shown as information ("3 of 5 slots"); it never changes the state. Five filled slots without Done Logging is still In progress. [APPROVED A-07]

#### 4.4.2 Done Logging [IMPLEMENTATION NOTE I-11]

- Button label **Done Logging**, secondary style, in the action bar. Enabled when at least one meal is logged. [domain refuses otherwise: `NOTHING_LOGGED`]
- Tap → `setDayLoggingComplete(date, true)`; no confirmation (it's reversible and changes no food).
- After: status line "Done logging ✓", confirmation message "Marked {Today|date} as done. It now counts as a complete day in Progress.", the button becomes **Reopen day**, and Build My Next Meal collapses to a quieter "Still eating? Build my next meal" link (§8.2).
- **Editing a Done day** is allowed directly: add, edit, move, delete all work, and the day stays Done (the domain keeps the flag). A small note appears the first time per day: "This day is marked done. Changes are saved and it stays done." [IMPLEMENTATION NOTE I-12]
- **Reopen day** → `setDayLoggingComplete(date, false)`; no confirmation (nothing is lost). [IMPLEMENTATION NOTE I-13]

#### 4.4.3 Effect on Progress [APPROVED A-21]

Done days count as `complete`: included in complete-day averages. Days with food but not Done are `partial`: included only in the "all logged days" average. No-data days are excluded. (The domain also classifies each macro as `hit` / `missed` / `undetermined`; those values feed Progress counts only and are never shown as labels or colours — see §9.4.)

### 4.5 Day type

#### 4.5.1 First selection (no Day for the date) [APPROVED A-09 · UI IMPLEMENTATION NOTE I-14]

- Card in place of the macro panel: "**What kind of day is {Friday}?**" with three large options: **Lift**, **Long Run**, **Rest**, each showing its current targets ("P 150 · C 293 · F 70 g") from `getAllCurrentTargets()`.
- **No option is preselected.** No weekday default, no "same as yesterday". [APPROVED A-04]
- Choose → `createDay(date, type)` → Today renders.
- Starting a log first (slot +, Add, a meal's Log button, the Log tab) opens this chooser as a sheet, then continues the same log without restarting.

#### 4.5.2 Changing the type (today or a past day) [APPROVED A-10 · UI IMPLEMENTATION NOTE I-15]

Tap the day-type chip → sheet with the three types, the current one marked.

- **Same type selected** → nothing happens, sheet closes. (The domain is a no-op too.)
- **Different type** → the sheet shows a preview from `previewDayTypeChange(date, type)`:
  - "Targets: C 293 → C 218 g" (all three macros, from `from.target` / `to.target`)
  - "Logged food stays exactly the same."
  - If `to.targetSource === 'restored'`: "Uses the Rest targets this day had before."
  - If `to.targetSource === 'current'` and the date is not today: "Uses your current Rest targets. Targets from {date} aren't on record for Rest."
  - Button: **Change to Rest** → `updateDayType(date, type)`.
- Today (a past date) always shows the date prominently in the sheet so a past-day correction is obviously a past-day correction.
- After: the macro panel re-reads; remaining recalculates; logged meals are untouched; a message "Changed to Rest. Your logged food didn't change."

#### 4.5.3 Applying current targets to today [APPROVED A-11 · UI IMPLEMENTATION NOTE I-16]

- Only offered on today's Day, and only when today's snapshot differs from the current targets for its type (an equality check of `getDaySummary(today).target` against `getCurrentTargets(type)`; no arithmetic). If they're equal, the domain call would be a no-op anyway.
- Where it appears: in the Settings flow right after targets for today's type are changed (§10.3), and as a quiet line in the day-type sheet: "Your Lift targets have changed since today was set up. **Use current targets for today**."
- Tap → confirm "Use current Lift targets for today? P 150 · C 310 · F 70. Logged food, today's day type and other days don't change." → `applyCurrentTargetsToToday()`.
- Never offered for past days; never automatic.

#### 4.5.4 What the user is told [IMPLEMENTATION NOTE I-15]

Every day-type change and target application shows before/after target values and the sentence "Logged food stays the same." The UI never uses words like "recalculate your meals" or "update history".

#### 4.5.5 Past days [IMPLEMENTATION NOTE I-03, I-04]

- The date controls reach any past date. Past Days can be viewed, created (with the chooser), logged into, edited, marked done, and their type corrected, all with the same screens. The header always shows the date; the "Today" chip returns to today.
- **Future dates:** viewable (empty) but not creatable in V2. The chooser and add actions are hidden with the note "You can log this day when it arrives." Planning is out of scope.

#### 4.5.6 Date rollover [IMPLEMENTATION NOTE I-03]

If the app is open across midnight and the user is on today, the next time the app gains focus Today moves to the new `getToday()` date, showing the chooser. Food eaten after midnight that belongs to the night before is logged by stepping back one day. There is no automatic rule.

### 4.6 Clearing a day [IMPLEMENTATION NOTE I-10]

Day header overflow → **Clear this day** → destructive dialog "Clear {date}? This deletes its day type and all {n} logged meals. Other days aren't affected." → `deleteDay(date)`. Today returns to the chooser.

### 4.7 Macro Coach entry

See §8. The entry is on Today only.

### 4.8 Persistence state on Today (and every screen) [APPROVED A-24 · UI IMPLEMENTATION NOTE I-17]

Read from `getPersistenceStatus()` and `onPersistenceChange(listener)`:

| `state` | Header indicator | Additional UI |
|---|---|---|
| `saved` | Quiet check + "Saved" (tooltip/secondary: "Saved {relative time}") | — |
| `saving` | "Saving…" (only shown if it lasts > ~1 s, to avoid flicker) | — |
| `error` | Warning icon + "Not saved" | Persistent banner under the header: "Your latest changes aren't saved on this device yet. They're still here, but will be lost if you close the app." Actions: **Try again** (`retryPersistence()`) · **Download a backup** (`exportUserData`). The banner stays until the status returns to `saved`. |
| `conflict` | Warning icon + "Changed elsewhere" | Blocking dialog: "This app is open in another tab or window, and that one saved more recently. To avoid overwriting it, this tab can't save." Actions: **Download this tab's data** (`exportUserData`) · **Reload** (reopens from storage; unsaved changes in this tab are lost, and the dialog says so). Editing is disabled until reload. |

Storage unavailable and invalid stored data are start-up conditions; see §13.

---

## 5. Log

### 5.1 Pattern [IMPLEMENTATION NOTE I-18]

Log is a **full-screen workflow**:

- As a tab, it's a primary screen.
- When started from Today (slot +, Add), the same screen opens pushed over Today with a back control, and returns there on success.
- On wide screens it's a two-pane view: results left, detail/quantity right.

Quantity entry and confirmations are **sheets** on top of it. It's not a modal-only flow, because users browse and search there.

### 5.2 Context bar: date, day type, slot [IMPLEMENTATION NOTE I-20]

Always visible at the top: **{Date} · {Day type} · {Slot}**, each tappable.

| Element | Rule |
|---|---|
| **Date** | From Today: the date shown there. From the Log tab: the date last viewed on Today (usually today). Tapping opens a date picker (today and past only, per I-04). |
| **Day type** | Shows the Day's type. If the date has no Day, it reads "Choose day type", and the chooser (4.5.1) opens before the first log is committed. Changing type from here uses the same sheet as Today (4.5.2). |
| **Slot** | Preset when launched from a slot. Otherwise empty; the confirm sheet requires a choice (five chips, one tap). `mealType` never restricts the slot [APPROVED A-06]. |

### 5.3 Screen content [IMPLEMENTATION NOTE I-19]

Search field (always visible) and a segment **Meals | Foods**. The default is Meals from "Add"/slot +, Foods when the user last used Foods, and remembered per session.

**Meals segment, empty query:**

1. **Favourite Saved Meals**
2. **Recently logged** (`getRecentMeals`: the source meals of recent logs, Saved or Library; this Log list is a shortcut, not the Coach's `recent` tier, which is Saved Meals only)
3. **Saved Meals** (all; `getSavedMeals`)
4. **Library** (collapsed group; expanded automatically when the user has no Saved Meals; `getLibraryMeals()`)

Favourited Library Meals show a star inside the Library group; they're never listed under Favourite Saved Meals. [APPROVED A-15]

**Meals segment, with a query:** matching Saved Meals, then matching Library Meals. `searchMeals(query)` (Saved, then Library by score; retired Library Meals excluded) [APPROVED A-35].

**Foods segment, empty query:** **Favourite Foods** (`preferences.favoriteFoods` → `getFood`) → **Recent Foods** (`getRecentFoods`). First run: a prompt to search.

**Foods segment, with a query:** `searchFoods(query)`, in the domain's ranking (exact › starts-with › all words › substring; name over alias). The UI doesn't re-rank. Last row: **Create a food named "{query}"** (§7.4).

### 5.4 Logging a Meal [APPROVED capability · UI IMPLEMENTATION NOTE I-19]

Tap a meal row → **Meal detail** (§6.4). The row's **Log** button → **confirm sheet**:

| Element | Source |
|---|---|
| Name, P / C / F | `previewMealInstance({ date, mealId })` (`totals`) |
| Date · slot (choose if not preset) | context bar |
| "After this: P {a} · C {b} · F {c} left" (or "Target reached") | preview `day.after` |
| **Log** | `createMealInstance({ date, mealSlot, mealId })` |
| **Adjust grams for this time** | ingredient gram editor with live preview (`previewMealInstance({ date, mealId, ingredients })`) → `createMealInstance({ date, mealSlot, mealId, ingredients })`. The Saved/Library Meal is unchanged. If grams changed on a Saved Meal, the same follow-up as 4.3.4 appears. |

Invalid Saved Meals show **Fix** instead of Log and route to Meal detail (§6.5). [APPROVED A-18]

### 5.5 Logging a Food [IMPLEMENTATION NOTE I-21, I-22]

Tap a Food row → **quantity sheet**. The quantity sheet has a **Food details** action that opens Food detail (§7.3); the row itself always opens the quantity sheet. [IMPLEMENTATION NOTE I-58]

| Element | Rule |
|---|---|
| Food name + **state chip** + brand | `food.state` always visible [APPROVED A-16] |
| Grams field | Numeric, decimals allowed, > 0. **Empty by default**, with placeholder "grams". The "g" suffix is always visible. No unit selector: grams are the only unit [APPROVED A-16]. |
| State reminder | "Weigh it {state}" (e.g. "Weigh it cooked"). If the user has the other state, they pick the other Food; the app never converts. |
| Live preview | `previewLogFood({ date, foodId, quantity, dayType? })` → this amount's P / C / F and "After this…" (`day.after`). With no Day yet, the "After this" line waits for the day type. |
| **Log** | `logFood({ date, mealSlot, foodId, quantity })` → one logged meal named after the Food |
| **Add to a meal** | Adds Food + grams to a **meal builder tray** instead (below) |
| Validation | Empty, 0, negative or non-numeric → inline "Enter a weight above 0 g"; Log disabled. Domain codes `INVALID_QUANTITY` / `MEAL_INVALID` map to the same message. |

**Meal builder tray** (IMPLEMENTATION NOTE I-22): a bar at the bottom of Log showing "{n} foods · P / C / F" (`previewMealInstance({ ingredients })`). **Log as one meal** → name (prefilled "{first food} + {n−1} more", editable) → `createMealInstance({ date, mealSlot, ingredients, mealName })`. An optional tick-box **Also save as a Saved Meal** → `createSavedMeal({ name, mealType, ingredients })`. The tray is kept while the user browses and cleared after logging. It isn't persisted across app restarts.

**A tray Food that no longer exists** (a Custom Food deleted while it was in the tray) [APPROVED A-43]: the row stays in the tray, marked "No longer available", and is never silently dropped. It's labelled with a user-facing name, never the Food's internal ID. The tray doesn't show grams-derived values or totals for it as if they were still valid. The row has an obvious **Remove**. **Log as one meal** is unavailable while such a row is in the tray, and the reason is shown. The other rows are kept. This is tray state in memory only: nothing stored or historical changes.

### 5.6 Custom Foods from Log

"Create a food named '{query}'" → Custom Food form (§7.4) with the name prefilled → on save, straight into the quantity sheet for the new Food. [IMPLEMENTATION NOTE I-31]

### 5.7 Editing and removing logged items

Log records; Today edits. Logged meals are edited, moved or deleted from Today (4.3.3–4.3.5). The Log confirmation message offers **View** and **Edit** links that open that logged meal on Today. [IMPLEMENTATION NOTE I-23]

### 5.8 After logging and navigation back [IMPLEMENTATION NOTE I-23]

- Writes are synchronous; the new logged meal and new remaining values exist immediately.
- Launched from Today → return to Today, scroll to the slot, highlight the new row for ~2 s, announce "Logged {name} to {Slot}. {remaining summary}."
- Launched from the Log tab → stay in Log with the context bar unchanged (to log the next thing). Confirmation: "Logged {name} to {Slot}" · **View on Today**.
- Back from Log without logging → return to the origin screen; nothing changes.

### 5.9 States

| State | Behaviour |
|---|---|
| No Saved Meals, no history | Meals: Library expanded. Foods: "Search for a food. Things you log will show up here." |
| No results | Meals: "No meals match '{q}'." Foods: "No foods match '{q}'." + **Create a food named '{q}'**. |
| Date has no Day | Context bar shows "Choose day type"; logging opens the chooser first, then completes. |
| Future date | Log is disabled for it: "You can log this day when it arrives." (I-04) |

---

## 6. Meals

### 6.1 Structure [IMPLEMENTATION NOTE I-24]

Segment **Saved | Library**. Defaults to Saved, or Library when the user has no Saved Meals; then remembers the last choice. Search field, type filter chips (All · Breakfast · Lunch · Snack · Dinner · Other, from `mealType`; filter only, never a slot rule), and a **Favourites** chip.

| | Saved Meals | Library Meals |
|---|---|---|
| Owner | User (user data) | App (shipped) [APPROVED A-15] |
| Edit directly | Yes | **No.** "Save a copy to edit" |
| Log | Yes, if valid | Yes |
| Favourite | Yes. Drives Coach tier 1. | Yes, as a bookmark only: filtered by the Library Favourites chip and starred, but never in the Saved favourites or Coach tier 1 [APPROVED A-15, A-20] |
| Duplicate | Yes | Via Save a copy |
| Delete | Yes | No |
| Retired | n/a | Hidden from browsing (`getLibraryMeals()` default); still shown if in Recent or Favourites, with a "Retired" marker, and still loggable [IMPLEMENTATION NOTE I-24] |

### 6.2 Search

`searchMeals(query, { source: 'saved' | 'library' })` within the active segment, in the domain's ranking (the same as Food search); retired Library Meals are never returned. The UI doesn't re-rank. [APPROVED A-35]

### 6.3 Meal card [IMPLEMENTATION NOTE I-26]

Name · type · P / C / F (`calculateMealMacros(id).totals`) · star · markers: "Copy of {Library name}" (Saved copies, from `metadata.copiedFromMealId`, if that meal still exists) · "Needs a fix" (invalid, replaces P/C/F; never partial numbers) · "Retired" (Library). Tap → detail. Card **Log** button → confirm sheet (§5.4).

Order: Saved sorted by most recently updated (`metadata.updatedAt`), then name. Library in its shipped order (breakfasts, lunches, dinners, snacks as curated). [IMPLEMENTATION NOTE I-26]

### 6.4 Meal detail [APPROVED data · layout IMPLEMENTATION NOTE I-26]

| Region | Content |
|---|---|
| Header | Name · type · Saved/Library · star · provenance line for copies |
| Totals | P / C / F, labelled "Calculated from the ingredients below" (derived; never editable) [APPROVED A-19] |
| Ingredients | One row per ingredient, in stored order: Food name + state chip · grams · P / C / F (`calculateMealMacros(...).ingredients[]`). A recipe label (`metadata.ingredientLabels[foodId]`, e.g. "red onion"), when different, shows as secondary text. |
| How to make it | Read-only, when present in the meal's metadata: `steps` (numbered), `prepMinutes`, `storage`, `notes`. Other metadata isn't shown. [IMPLEMENTATION NOTE I-29] |
| Actions | **Log this meal** · Saved: **Edit**, **Duplicate**, **Delete** · Library: **Save a copy** |

Not shown anywhere: `nativeDayType`, `lane`, `legacyId`, `isNew`, `weightDescription`, `base`, `batchSize`, `garnishes` (legacy bank fields with no V2 meaning; `nativeDayType` would imply day-type-specific meals, which V2 doesn't have). [IMPLEMENTATION NOTE I-29]

### 6.5 Invalid Saved Meal (a Food it uses was deleted) [APPROVED A-18 · UI IMPLEMENTATION NOTE I-27]

Domain: `calculateMealMacros(id)` → `valid: false`, `needsReplacement: true`, `totals: null`, `problems[]` with `foodId` and `lastKnownName`. Logging is refused (`MEAL_NEEDS_REPLACEMENT`), and duplicating is refused.

| Surface | UI |
|---|---|
| Card / list row | "Needs a fix" instead of P/C/F; Log replaced by **Fix** |
| Detail banner | "**{Meal} can't be logged right now.** {lastKnownName} was deleted, so this meal needs a replacement. Meals you've already logged aren't affected." |
| Missing ingredient row | "Deleted food: {lastKnownName} · {grams} g" (or "A deleted food" if no name) with **Replace** and **Remove** |
| Totals | "Totals will show once every ingredient is fixed." |
| Actions | Log and Duplicate disabled, with the reason written next to them; Edit, Delete and Favourite still work |
| Replace | Food picker, search prefilled with `lastKnownName` → confirm "Replace {old} with {new} ({state})?" with grams prefilled (editable) and a live preview → `replaceSavedMealIngredient(mealId, oldFoodId, newFoodId, { quantity })`. No automatic substitution, ever. |
| Remove | Confirm → `updateSavedMeal(id, { ingredients: without it })`. Not allowed for the only ingredient (offer Replace or Delete meal). |
| Coach | Excluded, and counted in a footer line (§8.4) |

### 6.6 Saved Meal editor [APPROVED data · UI IMPLEMENTATION NOTE I-27]

Title **New Saved Meal** / **Edit Saved Meal**. It never shares a title or layout with "Edit logged meal".

| Field | Rule |
|---|---|
| Name | Required |
| Type | Breakfast · Lunch · Snack · Dinner · Other (default Other) |
| Ingredients | ≥ 1. Each: Food (via Food picker, §7.5) + state chip + grams (> 0) + remove. Grams only. |
| Live totals | `calculateMealMacros(draftMeal)` on the unsaved object. P/C/F totals are always calculated, never typed in. [APPROVED A-19] |
| Method / notes | Not editable in V2 (existing text on copies is kept and shown read-only) [IMPLEMENTATION NOTE I-29; editing is future] |
| Save | `createSavedMeal({ name, mealType, ingredients })` / `updateSavedMeal(id, patch)` → Meal detail |
| Banner (edit) | "Changes apply the next time you log this meal. Meals you've already logged won't change." [APPROVED A-13] |
| Validation | Inline per field; domain errors `INVALID_MEAL` (name/ingredients), `INVALID_QUANTITY`, `FOOD_NOT_FOUND` (names the ingredient) |

### 6.7 Save a copy, Duplicate, Delete [APPROVED behaviour · copy IMPLEMENTATION NOTE I-28]

- **Save a copy** (Library) → name prompt (prefilled) → `createSavedMeal({ fromMealId, name })` → opens the new Saved Meal in the editor: "This is your copy. Changes here don't affect the Library meal." The Library Meal's favourite doesn't carry over. [APPROVED A-15]
- **Duplicate** (Saved) → `duplicateSavedMeal(id)` ("{name} (copy)") → editor.
- **Delete** (Saved) → dialog "Delete Saved Meal *{name}*? Meals you've already logged from it stay in your history." Button **Delete Saved Meal** → `deleteSavedMeal(id)`. Its favourite is removed by the domain. Logged meals that came from it then show "From a meal that's since been deleted". [APPROVED A-13]

### 6.8 States

| State | Behaviour |
|---|---|
| No Saved Meals | "No saved meals yet. Save one from the Library, or create your own." **Browse Library** · **New meal** |
| No favourites (chip on) | "Star a meal to find it here." |
| No results | "No meals match '{q}'." · clear search |

---

## 7. Foods and Custom Foods

### 7.1 Food rows [APPROVED data · UI IMPLEMENTATION NOTE I-30]

Wherever a Food is listed (Log, Food picker, Settings):

**{Name}** · **state chip** · brand (if any) · "My food" marker for Custom Foods · "P {x} · C {y} · F {z} per 100 g" · star · "matched: {alias}" hint when the search matched an alias.

Similar Foods are never merged or grouped: three Oats Overnight entries are three rows (see I-57). [APPROVED A-17]

### 7.2 Search and filtering

- `searchFoods(query, { limit })` covers Core and Custom Foods, names and aliases; inactive Foods are excluded by the domain. [APPROVED]
- **No category filters in V2**: categories are data-cleanup-grade strings (e.g. `veg` and `vegetable` both exist), and favourites/recents do the narrowing. [IMPLEMENTATION NOTE I-32]

### 7.3 Food detail [IMPLEMENTATION NOTE I-30]

Name, state, category, brand, source (App food / My food), P/C/F per 100 g, aliases (an alias identical to the name isn't repeated under other names [IMPLEMENTATION NOTE I-60]).

Entry points [APPROVED A-42]: the Log quantity sheet's **Food details** action (I-58), the Food picker (§7.5), Coach top-up Food items (§8.4), and Settings (My foods, Favourites, Foods not suggested). There is one Food detail. Opened from any of these, Back returns to where it was opened, with that context kept (search text, selection, open list).

Actions:

- **Log this food**. Not shown when opened from Settings: Settings is a food-management context, not a logging context, and there is no Settings → Log flow. To log a Food, the user searches for it in Log. [APPROVED A-41] Not shown when opened from the Food picker either (below). [APPROVED A-46] Not shown when opened from a Coach top-up Food; the Coach keeps its own **Log** for top-ups (§8.4). [APPROVED A-47]
- **Add to a meal** (builder tray, when opened from Log). It opens the quantity step first, since grams are required. [IMPLEMENTATION NOTE I-59]
- ☆ **Favourite** (`setFavoriteFood`). Not shown when opened from the Food picker. [APPROVED A-46]
- **Don't suggest this food** (`setDislikedFood`; affects only Coach suggestions [APPROVED A-32]; the Food still appears in search). Not shown when opened from the Food picker. [APPROVED A-46]
- Custom Foods only: **Edit** · **Delete**. Core Foods show "App food · can't be edited". [APPROVED A-17]
  - Opened from a Coach top-up Food: **Edit** and **Delete** are offered for Custom Foods as anywhere else. Deleting follows §7.6 (including the Saved Meal repair it can require), and Back returns to the Coach. There's no Coach-specific food management. [APPROVED A-47]
  - Opened from the Food picker: **Edit** and **Delete** are not offered. The picker runs inside an in-progress Saved Meal edit, and nothing done from it may invalidate that draft; the user manages the Food from Settings → My foods instead. [APPROVED A-46]

**From the Food picker, Food detail is information-only** [APPROVED A-46]: it exposes none of Food detail's logging or management actions (no **Log this food**, **Add to a meal**, **Favourite**, **Don't suggest this food**, **Edit** or **Delete**) and no action to choose the Food ("Select this food" or similar). Choosing a Food stays with the picker (§7.5); Food detail never becomes a second way to pick one. Back returns to the picker with its search text, the picker's state and the Saved Meal draft kept.

Actions by where Food detail was opened [APPROVED A-41, A-46, A-47]. Core Foods are read-only in every context (A-17).

| Opened from | Log this food | Add to a meal | Favourite | Don't suggest | Edit · Delete (Custom Foods) |
|---|---|---|---|---|---|
| Log (quantity sheet) | Yes | Yes | Yes | Yes | Yes |
| Coach top-up Food | No | No | Yes | Yes | Yes |
| Settings | No | No | Yes | Yes | Yes |
| Food picker | No | No | No | No | No |

Never shown: `yieldFactor`, `yieldKey`, `stateInferred`, `macroRole`, `swapFoodId`, `legacySwap`, `portionStep`. [IMPLEMENTATION NOTE I-30]

### 7.4 Custom Food form [APPROVED rules A-27 · UI IMPLEMENTATION NOTE I-31]

| Field | Rule |
|---|---|
| Name | Required; trimmed by the domain |
| Category | Required, free text (placeholder "e.g. snack bar") |
| State | Required: raw · dry · cooked · roasted · boiled · baked · prepared · frozen · other (`constants.FOOD_STATES`) |
| Brand | Optional |
| Protein, Carbs, Fat | Required, **per 100 g** (labelled as such), numbers ≥ 0. Per-serving entry is not in V2. |
| Aliases | Optional (comma-separated) |

- **Validation runs in the domain:** `validateCustomFood(input)` (or `(patch, { id })` when editing), called as fields change. Errors come back per field (`field`, `code`): NAME_REQUIRED, CATEGORY_REQUIRED, STATE_INVALID, NUTRITION_REQUIRED, NUTRITION_NOT_A_NUMBER, NUTRITION_NEGATIVE, NUTRITION_IMPOSSIBLE (P + C + F more than 100 g per 100 g). The UI turns each into a friendly message next to its field; NUTRITION_IMPOSSIBLE shows under the three macro fields: "Protein + carbs + fat can't be more than 100 g in 100 g. Check the label — values per serving need converting to per 100 g."
- **UI-only concerns:** an empty field is "required" (never NaN); a decimal comma is accepted as a point; Save is disabled while `valid` is false.
- **Warning, not an error:** `DUPLICATE_NAME` → "You already have a food called {name}." Save is still allowed.
- **Save:** `createCustomFood` / `updateCustomFood` → Food detail (or back to the quantity sheet if launched from Log). Editing from the Log flow (Food detail opened from the quantity sheet, then **Edit**) is part of the Log exception: **Save changes** returns to the Log quantity sheet for that Food, not to a standalone Food detail, keeping the grams, slot and context already chosen in Log where the session keeps them. Cancel and Back follow the normal navigation and "Discard changes?" rules (§3.2). [APPROVED A-48]
- **Edit banner:** "Changing these values updates your Saved Meals that use this food. Meals you've already logged won't change." [APPROVED A-13]

### 7.5 Food picker (inside meal creation, replacement, and logged-meal edits)

The Log Foods segment in "pick" mode: same search, favourites and recents. Choosing a Food returns it with a grams field to the calling editor; nothing is logged. [IMPLEMENTATION NOTE I-30] Food detail is reachable from the picker; Back returns to the picker with its search kept. [APPROVED A-42] There it's information-only (no Log this food, Add to a meal, Favourite, Don't suggest, Edit, Delete or choose action; §7.3), and the picker's state and the editor's draft are kept. [APPROVED A-46]

### 7.6 Deleting a Custom Food [APPROVED behaviour A-17 · UI IMPLEMENTATION NOTE I-31]

- Before confirming, show which Saved Meals use the Food: `getFoodUsage(foodId)` → `savedMealIds` (history is never a dependency). [APPROVED A-37]
- Dialog: "Delete *{name}*? {n} Saved Meal(s) use it and will need a replacement before you can log them: {list}. Meals you've already logged aren't affected."
- → `deleteCustomFood(id)`. Afterwards: "Deleted. {n} Saved Meal(s) need a fix" with links from `affectedSavedMealIds`.
- History: logged meals that used it keep showing its snapshot name and values.

### 7.7 Units and basis [APPROVED A-16]

Nutrition is per 100 g; quantities are grams. No other unit, no conversion, no yield factors anywhere in the UI.

---

## 8. Macro Coach

Answers "Given where I am today, what could I eat next?" using meals and foods the user already has. Deterministic lists, no chat, no AI, no scores. [APPROVED A-20]

### 8.1 Data

`getMacroCoachSuggestions({ date, mealSlot, limitPerTier? })` returns:

- `dayType`, `target`, `logged`, `remaining`, `reached`, `overBy`, `progress`
- `insufficientHistory` (fewer than 3 personal meals) and `personalMealCount`
- `tiers`, in fixed order: `favoriteSaved` → `recent` → `saved` → `library`. Each has `personalized`, `total`, and `items` of `{ mealId, name, source, mealType, isFavorite, totals, after: { logged, remaining, reached, overBy, progress } }`. Tiers 1–3 are Saved Meals only; tier 4 is non-retired Library Meals in shipped order. A meal appears once, in its first tier. Invalid meals are excluded. No score, rank or "best" field exists.
- `topUpFoods`: `{ personalized: [{ food, reasons }], starter: [{ food, reasons, usedInLibraryMeals }] }` (starter Foods only while history is thin)
- `excluded.needsReplacement`: meal IDs

The suggestions don't depend on `mealSlot`; the slot only decides where a chosen meal is logged. [APPROVED A-20, domain]

### 8.2 When it appears [IMPLEMENTATION NOTE I-34]

| Day state | Coach entry on Today |
|---|---|
| No Day / future date | Hidden (choose a day type first) |
| Unstarted or in progress | **Build My Next Meal**, the primary button in the action bar |
| Done | A quieter link: "Still eating? Build my next meal." It opens the same Coach, since targets are floors and eating more is fine. |

Opens as a bottom sheet on compact screens and a right-hand panel on wide screens (so the macro panel stays visible).

### 8.3 Layout, in order [IMPLEMENTATION NOTE I-35]

1. **Context header:** "{Day type} · Left today: P {x} · C {y} · F {z} g", with "Target reached" per macro where `reached` is true. If all three are reached: "You've reached today's targets." (Suggestions still show.)
2. **History notice** when `insufficientHistory`: "Not enough history yet for personal suggestions. These are starter meals from the Library. Log or save meals and this list becomes yours." Nothing is labelled personal when it isn't.
3. **Groups**, each hidden when empty, headings fixed [APPROVED order A-20]:

| Order | Tier | Heading | Presentation |
|---|---|---|---|
| 1 | `favoriteSaved` | Your favourites | Saved Meals the user starred |
| 2 | `recent` | Logged recently | Saved Meals logged recently, newest first |
| 3 | `saved` | Your saved meals | — |
| 4 | `library` | Starter meals from the Library | "Library" marker on each; a star if the user bookmarked it. Logged or favourited Library Meals stay in this group, in Library order. Retired ones never appear. |
| 5 | `topUpFoods` | Top up with a food | `personalized` first ("Favourite" / "Recent" reason), then `starter` ("Common in Library meals") |

4. **Per item:** name · marker · P / C / F · "**After this:** P {a} · C {b} · F {c} left" from `item.after` (same "Target reached" rule) · **Log** button · tap → Meal detail.
5. **Counts:** 3 items per group, then **Show all {total}**. When `insufficientHistory`, the Library group shows 5. Top-up shows 5. [IMPLEMENTATION NOTE I-35]
6. **Footer** when `excluded.needsReplacement` isn't empty: "{n} saved meal(s) need a fix" → Meals (filtered to those meals).

### 8.4 Actions [IMPLEMENTATION NOTE I-36]

- **Log** on a meal → the Log confirm sheet (§5.4) with date preset and the slot defaulting to the first empty slot after the most recently logged slot (editable). This is only a default and changes no numbers. **Adjust grams for this time** is available.
- A top-up Food → the quantity sheet (§5.5) with live preview. **The Coach never proposes a gram amount** in V2. [IMPLEMENTATION NOTE I-38]
- Tap an item → Meal detail / Food detail; back returns to the Coach.

### 8.5 After logging [IMPLEMENTATION NOTE I-37]

The Coach closes and Today shows the new row and updated remaining values. Reopening the Coach re-queries, so a just-logged Saved Meal now appears under "Logged recently" (or stays in "Your favourites" if starred), and every "After this" figure reflects the new remaining values.

### 8.6 Empty state

If every group is empty (only possible when all Library starters are excluded by disliked Foods and there's no history): "Nothing to suggest right now. Suggestions come from your saved and recently logged meals." **Add food** · **Browse meals**. [IMPLEMENTATION NOTE I-35]

### 8.7 Not in V2 [APPROVED A-20]

Chat or free text; AI-generated meals; macro-fit scores or "best match" ordering; carbs-first or other nutrition rules; suggested portion sizes; per-slot budgets; a Coach tab.

---

## 9. Progress

Progress is **descriptive, not judgmental** [APPROVED A-22]: it reports what was logged against each day's own targets, and nothing else. Its headline wording is "Reached on {n} of {m} logged days" [I-56].

### 9.1 Data [APPROVED A-21]

`getProgress({ period: 7 | 14 | 30, endDate: getToday() })` or `getProgress({ startDate, endDate })`. The result includes `basis`, `counts` (`complete`, `partial`, `noData`), `averages.completeDays` and `averages.loggedDays` (each with `days`, `actual`, `target`), `daysHit` per macro (`hit` / `missed` / `undetermined`), `daily[]` and `trend`.

### 9.2 Layout [IMPLEMENTATION NOTE I-39]

1. **Range selector:** 7 · 14 · 30 · Custom. The window ends today by default; ◀ ▶ move it by its own length (never past today). Custom opens start/end pickers: start ≤ end, end ≤ today, at most 90 days (I-41). An invalid range shows an inline message (`INVALID_PERIOD`).
2. **Basis line, always visible:** "Based on logged meals. Days with nothing logged aren't counted as zero."
3. **Logging coverage:** "Done {n} · Not marked done {n} · Nothing logged {n}", plus a strip of the range's days showing each day's status by shape and label (not colour alone).
4. **Averages per macro (P · C · F):**
   - Primary: "**On days marked done** ({n}): {avg} g · average target {t} g" (`averages.completeDays`). The target is averaged because it varies with day type.
   - Secondary: "Across all logged days ({n}, including days not marked done): {avg} g" (`averages.loggedDays`), labelled as reflecting logged meals only.
   - If there are no Done days: "No days marked done in this range yet", and the primary average is hidden.
5. **Reached target** per macro: "Reached on {hit} of {logged} logged days". Below-target days are not headlined: the day list shows each day's logged vs target, and "{n} days not marked done" appears with coverage. [IMPLEMENTATION NOTE I-56]
6. **Trend:** one macro at a time (P · C · F switch). Daily logged grams vs each day's target (a stepped line). `no_data` days are **gaps**, never zero points; partial days use a hollow marker; Done days a solid marker. A text summary is available for screen readers.
7. **Day list** (newest first): date · day type · status · P / C / F logged vs target. Tap → Today on that date.
8. **Day-type mix:** "Lift 4 · Long Run 1 · Rest 2" (counted from `daily[].dayType`). [IMPLEMENTATION NOTE I-39]

### 9.3 Few days / no days [IMPLEMENTATION NOTE I-42]

| Situation | Behaviour |
|---|---|
| Nothing logged in range | "Nothing logged between {start} and {end}." No charts, averages or zero lines. **Go to Today**. |
| 1–2 logged days | Coverage, averages and the day list show; the trend chart is replaced by "The trend appears once a few days are logged." |
| Only partial days | Coverage + "all logged days" average + list; the primary average is hidden with its explanation. |

### 9.4 Never shown [APPROVED A-22]

Energy figures, scores, grades, rankings, compliance or adherence scores, good/bad day labels, success/failure colours, "missed" / "failed" / "below target" labels or headlines (the domain's `missed` and `undetermined` values are never displayed as words), streaks, body weight, body composition, performance, any other nutrient, per-slot breakdowns, and any average that counts a no-data day as zero.

---

## 10. Profile / Settings

### 10.1 Sections [IMPLEMENTATION NOTE I-43]

1. **Targets:** Lift · Long Run · Rest, each "P {x} · C {y} · F {z} g" (`getAllCurrentTargets()`), with Edit.
2. **My foods:** the user's Custom Foods → Food detail; **New food**. `getCustomFoods()` (sorted by name). [APPROVED A-36]
3. **Favourites:** Saved Meals · Library bookmarks · Foods, each removable (`setFavoriteMeal` / `setFavoriteFood` with `false`).
4. **Foods not suggested:** `dislikedFoods`, removable (`setDislikedFood(id, false)`).
5. **Data on this device:**
   - Save status ("All changes saved · {time}" or the current error, with Try again)
   - "Protected from automatic clean-up: Yes / Not granted" (the result of `requestPersistentStorage()`)
   - Last backup date
   - **Download backup**, **Restore from backup** (§11)
6. **About:** app version, data format version (`BACKUP_FORMAT_VERSION`), "Macros only: protein, carbs and fat, in grams." The app version comes from the repository's single authoritative version source; the UI never keeps a second, hand-maintained version constant. The repository has no application-version source yet, so About shows **Version unavailable** until one is introduced by a later, explicit decision. The data format version is never presented as the app version. [APPROVED A-44]

Not in V2 Settings: `mealPreferences` and `coachingPreferences` toggles (no domain behaviour reads them), themes beyond following the system, units, accounts, notifications. [IMPLEMENTATION NOTE I-43]

### 10.2 Editing targets [APPROVED behaviour A-12 · UI IMPLEMENTATION NOTE I-44]

- Form for one day type: three whole-number gram fields, required, ≥ 0, finite. Domain errors: `INVALID_TARGETS` with field details.
- Confirm dialog: "Change **Lift** targets to P 150 · C 310 · F 70? This applies to days you set up from now on. Days already set up keep their targets." → `updateCurrentTargets(type, values)`.
- No suggested targets, no automatic changes. The app never changes targets on its own.

### 10.3 Applying to today [APPROVED A-11 · UI IMPLEMENTATION NOTE I-44]

After a successful change, if today has a Day of the same type, a follow-up offers: "Also use these targets for today?" **Use for today** → `applyCurrentTargetsToToday()` · **Not now**. Past Days are never offered this and never change. [APPROVED A-12]

### 10.4 Preferences stored for the UI [IMPLEMENTATION NOTE I-48]

The UI may keep its own small settings in `preferences.appPreferences` via `updatePreferences` (e.g. `lastBackupAt`, remembered segments). They're part of backups. No nutrition meaning is ever stored there.

---

## 11. Backup / Restore

### 11.1 Backup [APPROVED format A-26 · UI IMPLEMENTATION NOTE I-46]

| Step | Behaviour |
|---|---|
| Start | Settings → Data → **Download backup** |
| What's exported | `exportUserData()`: targets, Custom Foods, Saved Meals, Days with their logged meals, preferences. Format `macro-tracker-v2-backup`, version 1, `exportedAt`. Not included: Core Foods, Library Meals, schemas (shipped with the app) or anything derived. |
| File | JSON, named `macro-tracker-backup-YYYY-MM-DD.json` (local date) |
| Before download | A short sheet: "Backup of everything you've entered on this device: {n} logged days, {n} saved meals, {n} of your foods." **Download**. (Counts from `validateBackup(exportUserData()).summary`.) |
| Success | "Backup downloaded." `appPreferences.lastBackupAt` updated. |
| Failure (browser blocked the download) | "The backup couldn't be downloaded. Nothing was changed. Try again, or check your browser's download settings." |
| Works while saving is failing | Yes: export reads what's in the app now, which is exactly what may not be saved yet. That's why it's offered in the save-error banner. |

### 11.2 Restore [APPROVED semantics A-26 · UI IMPLEMENTATION NOTE I-47]

| Step | Behaviour |
|---|---|
| 1 Choose file | Settings → Data → **Restore from backup** → file picker (`.json`) |
| 2 Validate | Read as text → `validateBackup(text)`. Nothing changes during validation. |
| 3a Invalid | Message by `code`, and **nothing is changed**: |
| | `BACKUP_UNREADABLE`: "This file isn't a backup this app can read." |
| | `BACKUP_INCOMPATIBLE`: "This backup is from a different or newer version of the app and can't be restored here." |
| | `BACKUP_INVALID`: "This backup has problems, so it wasn't restored. Your current data is untouched." Details disclosure lists the first few problems in plain language. |
| 3b Valid → preview | "Backup from {exportedAt, local}: {n} logged days · {n} logged meals · {n} saved meals · {n} of your foods" (`summary`) vs the same counts for current data. Warning: "Restoring **replaces everything** in the app on this device: targets, your foods, saved meals, every logged day and your preferences. It can't be undone." |
| 4 Protect current data | A prominent secondary button **Download current data first** (`exportUserData`), recommended before continuing |
| 5 Confirm | **Replace my data** (destructive style; Cancel is the default focus) → `restoreUserData(text)`: validated again, then one atomic write |
| 6 Success | "Restored. {summary}." Save status goes saving → saved. Today and every tab re-read. |
| 6 Failure | A validation failure at this step shows the same messages as 3a, with current data untouched [APPROVED A-26]. If the durable save then fails, the normal save-error banner applies (the restored data is in the app; Try again / Download). |

---

## 12. First-run experience

What a brand-new user sees, with no stored data. [APPROVED data A-23 · UI IMPLEMENTATION NOTE I-49]

| Step | What happens | Persisted? |
|---|---|---|
| 1 Open | `openBrowserDataLayer()`: nothing stored, so user data comes from the shipped seed: canonical targets (Lift 150/293/70, Long Run 150/343/70, Rest 150/218/70), the two migrated Custom Foods, no Saved Meals, no Days, default preferences. Core Foods and Library Meals come from the app. | No. Nothing is written by opening. The save indicator stays hidden until the first save. |
| 2 Today | Header "Today · {date}"; day-type chooser with the three types and their targets, none preselected; five empty slots ("Not logged"); a one-time welcome card: "Log what you eat against three daily targets: protein, carbs and fat. Start with a meal from the Library or search for a food." | No |
| 3 Choose day type | `createDay(today, type)`; the macro panel appears with full targets as remaining; "Nothing logged yet" | **Yes: first save.** Then `requestPersistentStorage()` is asked once (I-51) |
| 4 First log | Slot + or Add → Log with the **Library expanded** (no Saved Meals yet) and Foods ready for search. Logging creates the first logged meal. | Yes |
| 5 Coach | `insufficientHistory: true` → the history notice, starter meals from the Library (5), and starter Foods ("Common in Library meals") | — |
| 6 Custom Foods | Available from search ("Create a food named …") and Settings → My foods, which already lists the two seeded Oats Overnight foods (I-57) | On save |
| 7 Backup | Not prompted on day one. Settings shows "Last backup: never". | — |

No account, sign-in or onboarding carousel. [APPROVED A-25]

---

## 13. Edge cases and error states

The UI explains what happened and what to do in plain language. Error codes, IDs and stack details appear only inside a "Details" disclosure.

### 13.1 Start-up conditions (before any screen can show data)

| Condition | How it's detected | UI | Tag |
|---|---|---|---|
| **Loading** | `openBrowserDataLayer()` pending | Today-shaped skeleton, no numbers or zeros; "Opening your data" announced once | IMPLEMENTATION NOTE I-50 |
| **Browser storage unavailable** (private window, storage disabled, IndexedDB missing) | `openBrowserDataLayer()` rejects with `DomainError` `STORAGE_UNAVAILABLE` [APPROVED A-33] | Blocking screen: "This browser isn't letting the app save your data (this can happen in a private window). Open the app in a normal browser window to use it." No "continue without saving" mode: logging into something that won't save is exactly the failure to avoid. | IMPLEMENTATION NOTE I-50 |
| **Stored data fails validation** | `DATA_INVALID`, with `error.readStoredRecord()` [APPROVED A-23] | Blocking screen: "Your saved data couldn't be opened, so nothing has been changed or deleted." Actions: **Download the stored data** (the raw record as a JSON file) · **Restore from a backup** · **Start over with empty data** (only after the download, behind a destructive confirmation). Restore: file → `recoverStoredData({ backup })` (validated in full first; an invalid backup writes nothing). Start over: `recoverStoredData({ startFresh: true })` (the shipped first-run seed). Both replace the stored record only on this explicit choice, then open the app normally [APPROVED A-38]. | IMPLEMENTATION NOTE I-50 |
| **Stored data from an unknown format/version** | `STORED_DATA_UNRECOGNIZED`, with `error.readStoredRecord()` [APPROVED A-33] | Same screen and recovery as above | IMPLEMENTATION NOTE I-50 |

### 13.2 While using the app

| Case | Behaviour | Tag |
|---|---|---|
| **No data** (date without a Day) | Day-type chooser; nothing is created by viewing | APPROVED A-09 |
| **Partial day** | Normal Today; status "Not marked done"; Progress counts it as partial | APPROVED A-07 |
| **Completed day** | "Done logging ✓"; still editable; Reopen available | APPROVED A-07 · IMPLEMENTATION NOTE I-12, I-13 |
| **Done day, last meal deleted** | Domain reopens it; message "No longer marked done, because nothing is logged." | APPROVED A-08 |
| **Invalid Saved Meal** | §6.5 | APPROVED A-18 |
| **Food deleted between listing and logging** | `FOOD_NOT_FOUND` → "That food no longer exists." The list refreshes. | IMPLEMENTATION NOTE I-10 |
| **Custom Food deleted while it's in the meal tray** | The row stays, marked "No longer available", with a user-facing name (never an ID) and **Remove**. Logging the tray is unavailable until it's removed; the other rows are kept (§5.5). | APPROVED A-43 |
| **Deleted Custom Food in history** | Logged meals show the snapshot name and values as recorded; no warning on history | APPROVED A-13 |
| **Saved Meal changed after logging** | Logged meals keep their snapshot; the detail view's source link opens the current recipe | APPROVED A-13 |
| **Saved Meal deleted after logging** | Logged meals unchanged; source line "From a meal that's since been deleted"; "Edit Saved Meal" hidden | APPROVED A-13 |
| **Retired Library Meal in Log's Recent list or Favourites** | "Retired" marker; still viewable and loggable there. Never in the Coach (A-20). | IMPLEMENTATION NOTE I-24 |
| **Save failure** | Save-error banner (§4.8), change kept in the app; Try again (`retryPersistence()`); Download a backup | APPROVED A-24 · IMPLEMENTATION NOTE I-17 |
| **Storage full** | Surfaces as a save failure; banner adds "Your device may be low on storage." | IMPLEMENTATION NOTE I-17 |
| **Another tab saved more recently** | `conflict` dialog (§4.8): download this tab's data or reload; editing blocked until reload | APPROVED A-24 · IMPLEMENTATION NOTE I-17 |
| **Changing today's day type** | §4.5.2; preview of old → new targets; food unchanged | APPROVED A-10 |
| **Changing a past day's type** | Same sheet, date prominent; "restored" vs "current targets" sentence | APPROVED A-10 · IMPLEMENTATION NOTE I-15 |
| **Same type chosen** | Sheet closes; nothing written | APPROVED A-10 |
| **Invalid backup** | §11.2 3a, current data untouched | APPROVED A-26 |
| **Restore failure** | Validation: same as invalid backup, untouched. Durable save afterwards: save-error banner. | APPROVED A-26 · IMPLEMENTATION NOTE I-47 |
| **No Coach recommendations** | §8.6 | IMPLEMENTATION NOTE I-35 |
| **No search results** | §5.9, with "Create a food named…" for Foods | IMPLEMENTATION NOTE I-19 |
| **Empty Saved Meals** | §6.8 | IMPLEMENTATION NOTE I-24 |
| **Empty Custom Foods** | Settings → My foods: "No foods of your own yet. Create one when something isn't in search." **New food** | IMPLEMENTATION NOTE I-33 |
| **Empty Progress history** | §9.3 | IMPLEMENTATION NOTE I-42 |
| **Two actions race** (e.g. `DAY_EXISTS`, `MEAL_INSTANCE_NOT_FOUND`) | Re-read and show the current state quietly | IMPLEMENTATION NOTE I-10 |
| **Date rolls over while open** | §4.5.6 | IMPLEMENTATION NOTE I-03 |

### 13.3 Domain error code → UI message [IMPLEMENTATION NOTE I-10]

| Code | Where | Message / behaviour |
|---|---|---|
| `DAY_TYPE_REQUIRED` | logging to a date without a Day | open the chooser, then continue |
| `NOTHING_LOGGED` | Done Logging on an empty day | shouldn't be reachable (button disabled); "Log something first" |
| `MEAL_NEEDS_REPLACEMENT` | logging an invalid Saved Meal | route to §6.5 |
| `MEAL_INVALID` | copy/duplicate an invalid meal; bad ingredient | "This meal uses a food that's been deleted. Replace it first." |
| `INVALID_QUANTITY` / `UNSUPPORTED_UNIT` | gram fields | "Enter a weight above 0 g" |
| `INVALID_FOOD` (with `details[].field`) | Custom Food form | per-field messages (§7.4) |
| `INVALID_MEAL`, `INVALID_MEAL_INSTANCE` | editors | per-field ("Give it a name", "Add at least one ingredient") |
| `INVALID_TARGETS` (with details) | target form | "Targets need to be whole grams, 0 or more" |
| `FOOD_NOT_FOUND`, `MEAL_NOT_FOUND`, `MEAL_INSTANCE_NOT_FOUND`, `DAY_NOT_FOUND`, `INGREDIENT_NOT_FOUND`, `NOT_FOUND` | stale references | "That {thing} no longer exists." and refresh |
| `CORE_FOOD_READ_ONLY`, `LIBRARY_MEAL_READ_ONLY`, `IMMUTABLE_ID`, `READ_ONLY`, `INVALID_*` enum codes, `INVALID_ARGUMENT` | programming errors (UI shouldn't allow them) | generic "Something went wrong. Nothing was changed." + Details |
| `VALIDATION_FAILED`, `PERSIST_FAILED` | any write | "That didn't save. Nothing was changed." + Details |
| `INVALID_DATE`, `INVALID_PERIOD` | date pickers | inline under the picker |
| `BACKUP_UNREADABLE`, `BACKUP_INCOMPATIBLE`, `BACKUP_INVALID` | restore | §11.2 |
| `DATA_INVALID`, `STORED_DATA_UNRECOGNIZED`, `STORAGE_UNAVAILABLE` | start-up | §13.1 |
| `STORAGE_CONFLICT` | recovery, if another tab wrote meanwhile | "The app changed in another tab. Close other tabs and try again." Nothing written |

---

## 14. Accessibility [IMPLEMENTATION NOTE I-53; target WCAG 2.2 AA]

| Area | Requirement |
|---|---|
| **Keyboard** | Every action is reachable and operable by keyboard in a logical order. Tabs are a navigation landmark. Desktop shortcuts: `/` focuses search in Log/Meals; Enter confirms the focused form; Esc closes the top sheet or dialog. No keyboard traps except intentional focus containment in dialogs. |
| **Focus** | Always-visible focus ring (≥ 2 px, ≥ 3:1 contrast). Opening a sheet/dialog moves focus into it (the first field, or the title); closing returns focus to the control that opened it. After logging from Today, focus lands on the new row. After a destructive dialog, focus goes to the nearest logical element. |
| **Dialogs and sheets** | Modal semantics with a title; background inert; Esc and a visible close control; destructive dialogs default-focus Cancel. |
| **Forms** | Visible labels (never placeholder-only); units in the label ("Protein per 100 g"); required fields marked in text; errors inline, programmatically tied to the field, and summarised at the top of long forms. Validation and a disabled Save are complementary [APPROVED A-45]: while editing, invalid fields are identified by the existing (domain) validation, which may run on blur (or as fields change) for field-level feedback, and **Save stays disabled while the form is invalid** (§7.4, §10.2). Validation runs again on submit, including Enter or any programmatic submission, as a final guard; a submission while invalid saves nothing and moves focus to the first invalid field. The UI never duplicates validation rules. |
| **Macro values for screen readers** | Each macro reads as one phrase: "Carbs: 142 grams left of 293", "Protein: target reached, 12 grams past", "Fat: 30 of 70 grams logged". Logged-meal rows read "Chicken bowl, lunch, protein 42 grams, carbs 60 grams, fat 12 grams". The same terms as the visible text. |
| **Live updates** | One polite announcement after each write (new remaining values, or save status changes to error/conflict). Not on every keystroke. |
| **Colour independence** | Macro identity, day status (Done / Not marked done / Nothing logged), save state and "target reached" always pair colour with text and/or an icon or shape. Charts use markers and labels, not colour alone. |
| **Contrast** | Text ≥ 4.5:1; large numerals and essential graphics ≥ 3:1; in both light and dark. |
| **Touch targets** | ≥ 44 × 44 px, with ≥ 8 px between adjacent targets, especially destructive vs non-destructive ones. |
| **Responsive and zoom** | Works from 320 px wide and at 200 % text size without loss of content or horizontal scrolling; landscape usable. |
| **Reduced motion** | Honour the system setting: no sliding sheets or animated highlights (use instant state changes); nothing flashes. |
| **Charts** | Every chart has a text summary, and the day list serves as its accessible table. |
| **Language** | Plain, specific, no jargon ("snapshot", "IndexedDB", "revision" never appear in the UI). |

---

## 15. Visual and product direction [IMPLEMENTATION NOTE I-52]

**Feel:** a calm, modern daily tool. Practical and fitness-aware without gym-culture styling. Information-dense but easy to scan in two seconds at the table. Polished like a real consumer app. No CSS, colours or fonts are chosen here.

| Aspect | Direction |
|---|---|
| **Typography** | One sans family with tabular (fixed-width) numerals. Hierarchy: (1) remaining grams, large display weight; (2) screen and section titles; (3) meal names and body; (4) secondary figures ("of 293 g", per 100 g), smaller and muted; (5) captions and hints. Numbers never shrink below body size. |
| **Macro presentation** | Always Protein · Carbs · Fat, in that order, with "g" always shown. Each macro has one consistent identity (label + a restrained hue + a small shape/initial) across every screen. The hues are balanced and none reads as a warning. Progress bars fill toward target and read "full" at or past it. |
| **Cards** | Soft grouping with generous padding, light borders or subtle elevation (not both). One card per slot on Today; one per meal in lists. No nested cards. |
| **Buttons** | One primary action per region (Build My Next Meal on Today, Log in sheets, Save in editors). Secondary actions are outline/tonal; destructive actions are only styled as destructive inside confirmation dialogs. Labels are verbs. |
| **Forms** | Single column, labels above fields, units attached to fields, numeric keypads for grams, inline errors in plain language. |
| **Status** | Save state: a small icon + word in the header (quiet when saved, clear when not). System errors (save failure, conflict) may use a warning colour; **nutrition values never do**. Done day: a subtle check badge, not a celebration. |
| **Colour system** | Neutral base (near-white / near-black surfaces), one brand accent for primary actions and focus, three macro hues, one warning hue reserved for system problems. Light and dark from the start. No gradients beyond the barely-there. |
| **Spacing** | A consistent 4/8-based rhythm; generous around the macro panel, tighter inside lists; whitespace separates, lines rarely. |
| **Imagery and icons** | Simple line icons. No food photography requirement, no cartoon fitness imagery, no emoji in UI chrome. |
| **Motion** | Short, functional transitions (sheet in/out, row highlight). No celebratory animation. |
| **Copy tone** | Short, warm, plain. No exclamation marks, praise, scolding or streak language. "Target reached", "Not logged", "Nothing logged yet", "Done logging". |

**Avoid:** gamification (streaks, badges, confetti, levels), traffic-light nutrition colouring, a single big "total" number at the top, clinical dashboard styling (gauges, dense grids), bodybuilding aesthetics, and the old Close the Carbs structure (per-slot bars, slot percentages, "slot closed", fix lists). [APPROVED A-28 for the legacy exclusion]

---

## 16. Cross-screen interaction map

```
                    ┌──────────── Settings ────────────┐
                    │ Targets ─ edit ─→ (apply to today?)│
                    │ My foods ─→ Food detail ─→ Custom Food form
                    │ Favourites · Not suggested         │
                    │ Data ─→ Backup · Restore            │
                    └───────────────▲───────────────────┘
                                    │ (header, any tab)
 ┌───────── Today ──────────────────┼────────────────────────────┐
 │ date ◀▶ · day type chip ──→ Day-type sheet (preview → change)  │
 │ slot + / Add ──────────────→ LOG (preset date/slot) ──┐       │
 │ Build My Next Meal ────────→ COACH ──→ Log confirm ────┤       │
 │ logged row ─→ Logged-meal detail ─→ Edit logged meal   │       │
 │                     └──→ Edit Saved Meal (Meals editor) │       │
 │ Done Logging / Reopen day                              │       │
 └───────────────▲──────────────────────────────────────────┘       │
                 │  return after logging (from Today/Coach)          │
                 └───────────────────────────────────────────────────┘
 LOG ─ Meals: Saved/Recent/Library ─→ Meal detail ─→ Log confirm
     └ Foods: search/fav/recent ─→ Quantity sheet ─→ Log / Add to meal tray
                                  └→ Create a food ─→ Custom Food form ─→ Quantity sheet
 MEALS ─ Saved | Library ─→ Meal detail ─→ Log confirm · Edit · Duplicate · Delete · Save a copy
                                          └→ Saved Meal editor ─→ Food picker
 PROGRESS ─ range ─→ day row ─→ Today (that date) ─ back ─→ Progress (range kept)
```

| From | Action | Goes to | Returns to after success | On cancel/back |
|---|---|---|---|---|
| Today | slot + / Add | Log (pushed) | Today, row highlighted | Today |
| Today | Build My Next Meal | Coach (sheet/panel) | Today, row highlighted | Today |
| Coach | item → Log | Log confirm sheet | Today | Coach |
| Coach | item tap | Meal/Food detail | — | Coach |
| Today | logged row | Logged-meal detail | — | Today |
| Logged-meal detail | Edit this logged meal | Edit logged meal | Logged-meal detail (then follow-up choice if applicable) | Detail |
| Logged-meal detail | Edit Saved Meal | Saved Meal editor | Meal detail → back to logged-meal detail | Logged-meal detail |
| Today | day-type chip | Day-type sheet | Today | Today |
| Log tab | log anything | confirm/quantity sheet | Log (confirmation with View on Today) | Log |
| Log | Create a food | Custom Food form | Quantity sheet for the new Food | Log results |
| Meals | card Log | Log confirm sheet | Meals (confirmation with View on Today) | Meals |
| Meals | New meal / Edit / Duplicate / Save a copy | Saved Meal editor | Meal detail | Previous view |
| Saved Meal editor | Add ingredient | Food picker | Editor with the Food added | Editor |
| Food picker | Food details | Food detail | — | Food picker, search kept |
| Meal detail (invalid) | Replace | Food picker → replace confirm | Meal detail (now valid if all fixed) | Meal detail |
| Progress | day row | Today (that date) | — | Progress, range kept |
| Settings | Edit targets | Targets form → confirm | Settings (with "use for today?" if relevant) | Settings |
| Settings | Download backup | Backup sheet | Settings | Settings |
| Settings | Restore | File picker → preview → confirm | Today (fresh data) | Settings |
| Save-error banner | Download a backup | Backup sheet | Same screen | Same screen |
| Start-up error | Restore / Download / Start over | Recovery (`recoverStoredData`) | Today | Error screen |

No dead ends: every pushed view has back; every sheet has cancel; every empty state offers one action. [IMPLEMENTATION NOTE I-01]

---

## 17. Domain / UI boundary

### 17.1 Responsibilities

| UI | Domain (`src/domain/`, `src/browser/`) |
|---|---|
| Layout, navigation, focus, copy, accessibility | All P/C/F arithmetic (`macros.js`) |
| Local date for display; calls `getToday()` for "today" | Validation (schemas, invariants, finite numbers, Custom Food rules) |
| Parsing text input to numbers; empty → "required" | Day completeness, day-type history and target snapshots |
| Choosing which domain call to make and when | Historical snapshots; what a logged meal contains |
| Formatting numbers with `macros.roundMacros` | Coach tiers and ordering; Progress statuses and aggregates |
| Turning `DomainError.code` into messages | Persistence, atomic writes, revision/conflict detection, save status |
| File download / file picking for backups | Backup format, validation and atomic restore |
| Remembering UI-only preferences via `updatePreferences({ appPreferences })` | Loading canonical app data (`app-data.js`) |

### 17.2 The UI must not [APPROVED A-30]

Compute or recompute macros (including "remaining after", sums, negating remaining); read `food.nutrition` in arithmetic; apply yield factors or convert raw ↔ cooked; decide completion from slots; edit a logged meal's snapshot except through `updateMealInstance`; write storage directly (no IndexedDB/localStorage/cookies in UI code); fetch data or use dynamic `import()`; import domain internals other than `src/domain/index.js` (browser modules from `src/browser/` are allowed); show a number the domain didn't return.

These are enforced by existing tests once the UI directory is classified as `runtime` in `runtime-boundary.json`: the arithmetic scan (code only; labels and class names are fine), the forbidden-terms scan (every UI file, comments and copy included), the import boundary, the storage/fetch ban, and the legacy-identifier scan.

### 17.3 Domain API by screen (all exist in the repository)

| Screen | Calls |
|---|---|
| **App start** | `openBrowserDataLayer()` → `{ app, adapter }` · `requestPersistentStorage()` · on `DATA_INVALID`: `error.readStoredRecord()` |
| **Global** | `getPersistenceStatus()` · `onPersistenceChange()` · `flushPersistence()` · `retryPersistence()` · `getToday()` |
| **Today** | `getDaySummary` · `getDay` · `createDay` · `getAllCurrentTargets` · `getCurrentTargets` · `previewDayTypeChange` · `updateDayType` · `applyCurrentTargetsToToday` · `setDayLoggingComplete` · `updateMealInstance` · `previewMealInstanceUpdate` · `deleteMealInstance` · `deleteDay` · `getMeal` · `createSavedMeal` · `updateSavedMeal` · `macros.roundMacros` |
| **Log** | `searchFoods` · `getRecentFoods` · `getFood` · `getPreferences` · `getSavedMeals` · `getLibraryMeals` · `getRecentMeals` · `calculateMealMacros` · `previewLogFood` · `previewMealInstance` · `logFood` · `createMealInstance` · `createSavedMeal` · `setFavoriteFood` · `setFavoriteMeal` · `searchMeals` |
| **Meals** | `getSavedMeals` · `getLibraryMeals` · `getMeal` · `calculateMealMacros` · `createSavedMeal` · `updateSavedMeal` · `replaceSavedMealIngredient` · `duplicateSavedMeal` · `deleteSavedMeal` · `setFavoriteMeal` · `previewMealInstance` · `createMealInstance` · `searchMeals` |
| **Foods** | `searchFoods` · `getFood` · `validateCustomFood` · `createCustomFood` · `updateCustomFood` · `deleteCustomFood` · `setFavoriteFood` · `setDislikedFood` · `constants.FOOD_STATES` · `getCustomFoods` · `getFoodUsage` |
| **Coach** | `getMacroCoachSuggestions` · `previewMealInstance` · `previewLogFood` · `createMealInstance` · `logFood` |
| **Progress** | `getProgress` · `getToday` |
| **Settings** | `getAllCurrentTargets` · `updateCurrentTargets` · `applyCurrentTargetsToToday` · `getDaySummary` · `getPreferences` · `updatePreferences` · `setFavoriteMeal` · `setFavoriteFood` · `setDislikedFood` · `getMeal` · `getFood` · `getCustomFoods` |
| **Backup / Restore** | `exportUserData` · `validateBackup` · `restoreUserData` · `BACKUP_FORMAT_VERSION` · `recoverStoredData` (start-up recovery) |
| **Enums** | `constants.DAY_TYPES`, `MEAL_SLOTS`, `MEAL_TYPES`, `FOOD_STATES`: pickers read these, never hard-coded lists |

---

## 18. Approved decisions

| ID | Decision | Source |
|---|---|---|
| A-01 | Protein, carbs, fat in grams only; no energy figure, synonym or derived score anywhere (UI, copy, accessibility text, exports). | Locked; tests O/14 |
| A-02 | Optimise for foods the user actually eats. | Locked |
| A-03 | Primary nav Today · Log · Meals · Progress; Settings secondary; Coach contextual from Today, no tab. | Locked |
| A-04 | Day types Lift / Long Run / Rest (`lift`, `long_run`, `rest`); canonical targets 150/293/70, 150/343/70, 150/218/70; no weekly schedule or automatic type. | Locked; `data/targets.json` |
| A-05 | Daily targets only; remaining = target − logged; targets are floors. | Locked; `targetStatus` |
| A-06 | Five slots (breakfast, lunch, snack_afternoon, dinner, snack_night); no slot targets; no required night snack; `mealType` never restricts slot; any number of logged meals per slot. | Locked; domain |
| A-07 | A Day is complete only via explicit Done Logging (`loggingComplete`); slot coverage never decides it. | Locked; `2046613` |
| A-08 | Done needs ≥ 1 logged meal (`NOTHING_LOGGED`); deleting the last logged meal reopens the Day. | Domain |
| A-09 | Days are created when needed; a date needs a day type before logging; viewing creates nothing. | Domain |
| A-10 | Day-type change (today or past): logged food unchanged; replaced snapshot kept; switching back restores it; otherwise current targets; same type = no-op. | Locked; `2046613` |
| A-11 | `applyCurrentTargetsToToday()` is explicit, today only, changes nothing else. | Locked; `2046613` |
| A-12 | Changing current targets affects new Days only; never an existing snapshot. | Locked; domain |
| A-13 | Logged meals are historical snapshots: unaffected by Food/Saved Meal edits or deletions; editing a logged meal never changes its Saved Meal. | Locked; domain |
| A-14 | After editing a logged meal: log the change only / save as a new Saved Meal / update the Saved Meal after confirmation. | `schema.md` |
| A-15 | Library Meals are app-managed, read-only, loggable; Save a copy makes an independent Saved Meal; Library favourites are allowed, stay in Library, and don't carry over to copies. | Locked; `f040b70` |
| A-16 | Food state explicit and never converted; nutrition per 100 g; quantities in grams only. | Locked; domain |
| A-17 | Core Foods read-only; Custom Foods create/edit/delete; deleting one makes dependent Saved Meals need a replacement; similar Foods never merged; no automatic substitution. | Domain |
| A-18 | Invalid Saved Meal: `totals: null`, no partial totals, can't be logged or duplicated, repaired by replace/remove. | Domain |
| A-19 | Meal P/C/F totals are always derived from ingredients; never stored or typed. | Locked; domain |
| A-20 | Coach: deterministic tiers — 1 favourite Saved Meals → 2 recently logged Saved Meals → 3 other Saved Meals → 4 Library starter meals (non-retired, shipped order) — with individual Foods as a separate top-up path. Tiers 1–3 are Saved Meals only: favouriting or logging a Library Meal never moves it out of tier 4. No score, fit ranking, "best meal", inferred preference, AI or chat; the Coach may show totals and what would remain. Fewer than 3 personal meals → `insufficientHistory` (starters and starter Foods, labelled as not personal). | Approved; domain `getMacroCoachSuggestions` |
| A-21 | Progress: statuses no_data / partial / complete; complete-day averages plus labelled logged-day average; hit / missed / undetermined per macro; ranges 7 / 14 / 30 / custom; no-data ≠ zero. | Locked; domain |
| A-22 | Progress excludes energy, scores, good/bad ratings, weight, body fat, performance. | Locked |
| A-23 | Browser-first; IndexedDB via the browser adapter; canonical data via `src/browser/app-data.js`; stored user data wins over seed; invalid stored data is never silently overwritten. | Locked; `f040b70` |
| A-24 | Save status `saved` / `saving` / `error` / `conflict` exposed for every adapter through the data layer (`getPersistenceStatus`, `onPersistenceChange`, `flushPersistence`, `retryPersistence`); a failed background save keeps the change in memory and must be visible and actionable. | Approved; domain |
| A-25 | No authentication or cloud sync in V2; storage stays sync-compatible. | Locked |
| A-26 | Manual backup/restore; versioned format; restore validates everything before one atomic replace; failure leaves data untouched. | Locked; `2046613` |
| A-27 | Custom Food rules: required name/category/state; P/C/F finite ≥ 0; P + C + F ≤ 100 g per 100 g (+1 g tolerance); names trimmed; duplicate names warn, never block. | Domain |
| A-28 | Legacy pages are retired reference only; not UI templates. | Locked |
| A-29 | "Today" is the device's local calendar date (`getToday()`). | Domain; incident rule |
| A-30 | One canonical calculator; the UI calls it and never computes P/C/F. | Locked; tests N/18 |
| A-31 | Favourites live only in preferences (`favoriteMeals`, `favoriteFoods`). | Domain |
| A-32 | Disliked Foods only affect Coach suggestions. | Domain |
| A-33 | Start-up storage failures have stable codes: `STORAGE_UNAVAILABLE` (browser storage missing/refused), `STORED_DATA_UNRECOGNIZED` (a record this app doesn't know) and `DATA_INVALID` (a known record that fails validation), the latter two with `error.readStoredRecord()`. Write validation failures are `VALIDATION_FAILED`. The UI never parses messages. | Approved; `src/browser/*`, store |
| A-34 | Retrying a failed save goes through the data layer: `retryPersistence()` (a no-op reporting `saved` on synchronous adapters). | Approved; domain |
| A-35 | Meal search: `searchMeals(query, { source?, limit? })` over Saved and Library Meals, ranked and normalised exactly like `searchFoods`; retired Library Meals never returned. | Approved; domain |
| A-36 | Custom Food listing: `getCustomFoods()`, sorted by name then ID. | Approved; domain |
| A-37 | Food usage: `getFoodUsage(foodId)` → the Saved Meals that use it. Logged history is never a deletion dependency. | Approved; domain |
| A-38 | Invalid stored data is never discarded automatically. Recovery is an explicit user choice: `recoverStoredData({ backup })` (validated in full first; an invalid backup writes nothing) or `recoverStoredData({ startFresh: true })` (shipped seed). | Approved; `src/browser/app-data.js` |
| A-39 | Progress-bar fill comes from the domain: `targetStatus().progress` (logged ÷ target, capped at 1) in `getDaySummary`, previews and Coach `after`. The UI never divides macros. | Approved; domain |
| A-40 | NaN, Infinity and −Infinity are rejected at every input boundary (schemas, store, copies) and can never be stored as `null`. | Approved; domain |
| A-41 | Food detail opened from Settings (My foods, Favourites, Foods not suggested) doesn't offer **Log this food**; there's no Settings → Log flow. | Approved; product decision D1 |
| A-42 | Food detail is reachable from the Log quantity sheet, the Food picker, Coach top-up Foods and Settings; it's one implementation; Back returns to the originating context with its search/selection kept. | Approved; product decision D3 |
| A-43 | A Custom Food deleted while in the meal tray stays as a row marked "No longer available" (user-facing name, never an ID), with Remove; the tray can't be logged until it's removed; the rest of the tray is kept; nothing stored changes. | Approved; product decision D4 |
| A-44 | The About app version comes from one authoritative repository version source, never a second hand-maintained constant. Until such a source exists, About shows "Version unavailable"; no version number is invented and the data format version is never shown as the app version. | Approved; product decision D2 (extended) |
| A-45 | Disabled Save while invalid and submit-time validation are complementary: Save stays disabled while invalid; validation may run on blur; submit (including Enter or programmatic) re-validates, saves nothing if invalid, and focuses the first invalid field. | Approved; resolves the §7.4/§10.2 vs §14 inconsistency |
| A-46 | Food detail opened from the Food picker is information-only: no Log this food, Add to a meal, Favourite, Don't suggest, Edit or Delete, and no choose action. Selection stays with the picker; Back returns to it with its search, picker state and the Saved Meal draft kept. | Approved; product decision (finalized) |
| A-47 | Food detail opened from a Coach top-up Food offers Favourite, Don't suggest and Custom Food Edit and Delete as elsewhere, but not Log this food (the Coach has its own Log for top-ups). Core Foods stay read-only; deletion follows §7.6; Back returns to the Coach. No Coach-specific food management. | Approved; product decision (finalized) |
| A-48 | A Custom Food edited from the Log flow returns to the Log quantity sheet for that Food after Save changes (not to a standalone Food detail), keeping the Log context where the session keeps it. | Approved; product decision |

---

## 19. Implementation notes

How the UI implements the approved decisions. Followed as written.

| ID | Note | § |
|---|---|---|
| I-01 | App shell: tabs persistent; contextual actions on their screens; pushed views for detail/editors; sheets/dialogs for short choices; state kept per tab; "Discard changes?" on dirty forms; no dead ends. | 2, 3, 16 |
| I-02 | Settings via a header gear on every primary screen. | 2 |
| I-03 | Today is a Day view for any date with ◀ ▶ and a "Today" chip; past days fully usable; midnight rollover moves "today" on next focus; no after-midnight rule. | 4.5.5–6 |
| I-04 | Future dates viewable but not creatable or loggable. | 4.5.5 |
| I-05 | Conceptual breakpoints: compact < ~600 px (bottom tabs), medium, wide > ~1024 px (left rail, two panes); 320 px and 200 % text supported. | 3.1 |
| I-06 | Today hierarchy: remaining grams largest, then "{logged} of {target} g", neutral bars; whole-gram display via `roundMacros`. | 4.1–4.2 |
| I-07 | "{n} g left" / "Target reached" + "+{overBy} g", neutral styling. | 4.2 |
| I-08 | All five slots always shown; empty = "Not logged" + "+"; one-time slot explainer. | 4.3.1 |
| I-09 | No per-slot subtotals. | 4.3.1 |
| I-10 | Logged-meal detail and row actions (edit, move, delete, clear day); error-code message map; quiet re-read on races. | 4.3, 4.6, 13.3 |
| I-11 | Done Logging button (disabled when nothing is logged), no confirmation; Done status line/badge; button becomes Reopen day. | 4.4.2 |
| I-12 | A Done day stays editable without reopening and stays Done; one-time note. | 4.4.2 |
| I-13 | Reopen day needs no confirmation. | 4.4.2 |
| I-14 | Day-type chooser shows the three types with targets, none preselected; starting a log first opens it as a sheet and continues. | 4.5.1 |
| I-15 | Day-type change sheet shows the preview (old → new targets, restored vs current wording) and "Logged food stays the same"; date prominent for past days. | 4.5.2, 4.5.4 |
| I-16 | "Use current targets for today" offered only when today's snapshot differs, from Settings and the day-type sheet, with confirmation. | 4.5.3 |
| I-17 | Header save indicator; persistent error banner with Try again + Download a backup; blocking conflict dialog with Download + Reload. | 4.8 |
| I-18 | Log is a full-screen workflow (tab, or pushed over Today); two panes on wide screens. | 5.1 |
| I-19 | Log content: Meals | Foods segment; empty-query order favourites → recent → saved → Library (expanded when no Saved Meals); no-result states. | 5.3, 5.9 |
| I-20 | Context bar Date · Day type · Slot; slot required, preset from Today. | 5.2 |
| I-21 | Grams field empty by default; state reminder "Weigh it {state}"; live preview via `previewLogFood`. | 5.5 |
| I-22 | Meal builder tray to log several Foods as one meal, with optional "Also save as a Saved Meal". | 5.5 |
| I-23 | Return rules after logging (Today → Today highlighted; Log tab → stay; Meals → stay); edits happen on Today. | 3.3, 5.7–5.8 |
| I-24 | Meals: Saved | Library segment (Library default when no Saved Meals); type and Favourites filters; retired Library Meals hidden unless in Recent/Favourites. | 6.1 |
| I-25 | Meals and Log search use `searchMeals` as returned (no UI ranking). | 5.3, 6.2 |
| I-26 | Meal card and detail content; Saved sorted by last updated, Library in shipped order. | 6.3–6.4 |
| I-27 | Invalid Saved Meal presentation and repair flow; Saved Meal editor with live derived totals. | 6.5–6.6 |
| I-28 | Copy/Duplicate/Delete flows and wording. | 6.7 |
| I-29 | Show read-only method (`steps`, `prepMinutes`, `storage`, `notes`); hide legacy metadata (`nativeDayType`, `lane`, `weightDescription`, `base`, `batchSize`, …); method not editable in V2. | 6.4, 6.6 |
| I-30 | Food row and detail content (state chip, per 100 g, My food marker, alias hint); Food picker = Log Foods in pick mode; migration metadata hidden. | 7.1, 7.3, 7.5 |
| I-31 | Custom Food form with live `validateCustomFood`, per-field messages, duplicate warning; delete flow with impact list. | 7.4, 7.6 |
| I-32 | No Food category filters in V2. | 7.2 |
| I-33 | "My foods" lives in Settings (plus creation from search). | 10.1 |
| I-34 | Coach entry: primary on unstarted/in-progress days; quiet link on Done days; hidden without a Day or on future dates; sheet/panel. | 8.2 |
| I-35 | Coach layout: context header, history notice, fixed-order groups (hidden when empty), 3 per group (5 Library when history is thin, 5 top-ups), Show all, needs-a-fix footer, empty state. | 8.3, 8.6 |
| I-36 | Coach actions: Log → confirm sheet with a default slot (next empty after the last logged); Adjust grams available. | 8.4 |
| I-37 | Coach closes after logging; re-queries when reopened. | 8.5 |
| I-38 | No suggested portion sizes in V2. | 8.4 |
| I-39 | Progress layout: range selector, basis line, coverage, averages (Done days primary), reached-target counts, per-macro trend with gaps, day list, day-type mix. | 9.2 |
| I-40 | Status labels: "Done" · "Not marked done" · "Nothing logged". | 9.2 |
| I-41 | Custom range: end ≤ today, max 90 days. | 9.2 |
| I-42 | Few-data behaviour: no chart under 3 logged days; empty range message. | 9.3 |
| I-43 | Settings sections: Targets, My foods, Favourites, Foods not suggested, Data on this device, About; no preference toggles without behaviour. | 10.1 |
| I-44 | Target edit form + confirmation + "also use for today?" follow-up. | 10.2–10.3 |
| I-45 | "Don't suggest this food" on Food detail; removable list in Settings. | 7.3, 10.1 |
| I-46 | Backup: JSON download `macro-tracker-backup-YYYY-MM-DD.json` with a counts summary; offered in the save-error banner. | 11.1 |
| I-47 | Restore: file → validate → preview counts vs current → "Download current data first" → "Replace my data". | 11.2 |
| I-48 | UI-only settings (e.g. `lastBackupAt`) stored in `appPreferences`; "Last backup" shown in Settings; no backup nagging. | 10.4 |
| I-49 | First-run sequence (welcome card, chooser, Library-first logging, Coach starters). | 12 |
| I-50 | Start-up: skeleton; blocking screens for storage unavailable and invalid/unknown stored data; no "continue without saving". | 13.1 |
| I-51 | Call `requestPersistentStorage()` once after the first save; show the result in Settings. | 10.1, 12 |
| I-52 | Visual direction and copy tone (§15). | 15 |
| I-53 | Accessibility baseline, WCAG 2.2 AA (§14). | 14 |
| I-54 | UI lives in a new top-level directory (e.g. `app/`), classified as `runtime` in `runtime-boundary.json`, served from the repository root. | 22 |
| I-55 | Hosting: any static host that serves the repository root with `.json` as `application/json` (e.g. GitHub Pages or a local static server). Which host to use is a deployment choice, not part of the UI contract. | 22 |
| I-56 | Progress shows "Reached on {n} of {m} logged days" and "{k} days not marked done"; a below-target count for Done days (`missed`) is not headlined; the day list shows logged vs target per day. | 9.2 |
| I-57 | Data note, outside the UI: the first-run seed holds two Oats Overnight Custom Foods whose values conflict with the Core packet (10.7 vs 26.3 g protein per 100 g). Resolve from the pack label before first real use, through the normal Custom Food flow. The UI shows all three separately. | 7.1, 12 |
| I-58 | Log reaches Food detail through a **Food details** action on the quantity sheet; the Food row keeps opening the quantity sheet. | 5.5, 7.3 |
| I-59 | **Add to a meal** from Food detail opens the quantity step first (grams are required). | 7.3 |
| I-60 | An alias identical to the Food's name isn't repeated under other names on Food detail. | 7.3 |

---

## 20. Domain APIs added for the UI (formerly gaps)

All gaps from the review are implemented; none remain.

| Former gap | Now | Tag |
|---|---|---|
| Start-up storage errors had no codes | `STORAGE_UNAVAILABLE`, `STORED_DATA_UNRECOGNIZED`, `DATA_INVALID` | A-33 |
| Retry only on the adapter | `retryPersistence()` | A-34 |
| No meal search | `searchMeals()` | A-35 |
| No Custom Food list | `getCustomFoods()` | A-36 |
| No Food usage query | `getFoodUsage()` | A-37 |
| No recovery from unreadable stored data | `recoverStoredData()` | A-38 |
| Bars would have needed UI division | `progress` in `targetStatus` | A-39 |

If the UI finds it needs a number or rule the domain doesn't provide, the implementation stops and raises it. It is never filled in UI code.

---

## 21. Future / backlog (not in V2)

| ID | Item |
|---|---|
| F-01 | Undo / restore of deleted items (V2 uses confirmation dialogs) |
| F-02 | Per-serving Custom Food entry (V2: per 100 g only) |
| F-03 | Editing meal method / notes (V2 shows existing text read-only) |
| F-04 | Suggested portion sizes or any portion solver |
| F-05 | Macro-fit ranking, scoring or a "best meal" in the Coach |
| F-06 | Coach ordering beyond the approved tiers (e.g. slot affinity, recency within Library) |
| F-07 | Accounts, authentication, cloud sync, cloud backup, multi-device merge |
| F-08 | Food category filters |
| F-09 | Non-gram units (egg, slice, scoop) |
| F-10 | External Foods, online databases, barcode or photo logging |
| F-11 | Meal planning, future-day logging, grocery lists |
| F-12 | Last-used quantity prefill |
| F-13 | Versioned current targets (effective dates for past Days) |
| F-14 | Re-using unsaved (ad-hoc) meals from Recent |
| F-15 | Meal and coaching preference toggles |
| F-16 | Backup reminders and automatic backups |

---

## 22. Implementation handoff notes

1. **Serving and loading.** Serve the repository root; the UI imports `src/browser/app-data.js` (`openBrowserDataLayer`, `recoverStoredData`) and `src/domain/index.js`. No bundler is required. JSON-module import attributes need Chrome/Edge 123+, Safari 17.2+ (iOS 17.2+), Firefox 138+. [A-23, I-55]
2. **Classify the UI directory as `runtime`** in `runtime-boundary.json` before committing it; the existing tests then scan it. [I-54]
3. **Test constraints that shape UI code** (all existing):
   - no macro arithmetic in `.js/.mjs/.jsx/.ts/.tsx/.html` code or in CSS `calc()`; labels, class names and copy are fine
   - format numbers with template strings or a formatter, not `value + ' g'`
   - bars use `progress`
   - no energy terms anywhere, comments and aria text included
   - import the domain only via `src/domain/index.js`
   - no `fetch`, dynamic `import()`, IndexedDB, localStorage, sessionStorage or cookies in UI code; keep remembered UI state in memory or in `appPreferences`
   - avoid the legacy identifiers the scan rejects: `TARGET(S)`, `SHIFT`, `NIGHT`, `DAYS`, `FOODS` and `M` as bare identifiers, `perSlot`, `nightSnack`, `yieldFactor`/`yieldKey`, the quoted string `'long'`, legacy file or storage names, and AI-service names
4. **Build order (suggested):** (a) app shell, start-up states (§13.1) and save indicator; (b) Today with the day-type flows and Done Logging; (c) Log (Foods, then Meals, then the tray); (d) Meals, the editor and invalid-meal repair; (e) Custom Foods; (f) Coach; (g) Progress; (h) Settings, Backup/Restore; (i) the accessibility pass.
5. **Verification each stage:** the full test suite; plus a real-browser check of the published build: reload, save a second and third time, full browser restart, a second tab, a date near midnight, and the invalid-data recovery screen. Nothing is "done" on a first-save success.
6. **Numbers:** always from `getDaySummary`, previews, `calculateMealMacros`, snapshot `totals`, `getProgress`, or Coach `after`. Rounding only via `macros.roundMacros`. Never store a rounded number.
7. **Copy:** use the wording in this contract where it's given; keep new copy in the same plain, neutral tone. No energy terms, no praise or blame.
8. **Out of scope:** everything in §21.

*End of contract.*
