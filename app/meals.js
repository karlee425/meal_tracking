/*
 * meals.js — the Meals screen (V2_UI_CONTRACT.md §6): Saved Meals the user owns, Library Meals
 * the app ships, Meal detail, the Saved Meal editor (§6.6) with the Food picker (§7.5), Save a
 * copy / Duplicate / Delete (§6.7) and the repair flow for Saved Meals whose Food was deleted
 * (§6.5).
 *
 * Layers, as on Today and Log:
 *   mealsList(app, state)         domain lists and searches (+ the contract's filters)
 *   render…(…)                    pure HTML from domain results (formatting only)
 *   editor helpers                a draft meal the domain calculates (calculateMealMacros)
 *   createMealsActions(app)       thin wrappers around domain operations
 *   mealsScreen.mount(main)       DOM wiring, presented through view-host.js like Log
 *
 * Every P / C / F comes from the domain and is only rounded for display. Library Meals are
 * never changed: "Save a copy" makes a new Saved Meal. Logged meals are snapshots, so editing
 * or deleting a Saved Meal never touches history (the domain guarantees it).
 */

import { constants } from '../src/domain/index.js';
import { escapeHtml } from './shell.js';
import { macroLine, parseGrams, errorMessage, dialogHead, errorSlot } from './today.js';
import {
  MEAL_TYPE_LABELS, renderMealDetail, renderCustomFoodForm, customFoodInput,
  renderConfirmation, renderPicker, pickerResults, customFoodDirty
} from './log.js';
import { foodDetailModel, renderFoodDetail, renderDiscardFood } from './foods.js';
import { session, routeParams } from './session.js';
import { createViewHost, viewHead, syncInPlace } from './view-host.js';

/** Detail and editing surfaces (pushed / panel / pane); the rest are short choices. */
export const MEALS_VIEW_TYPES = Object.freeze(['meal-detail', 'editor', 'picker', 'custom-food', 'replace', 'food-detail']);

/* ---------------- lists (§6.1–6.3, §6.8) ---------------- */

/** Saved by default, Library when there are no Saved Meals; then the last choice this session. */
export function mealsSegment(state, app) {
  if (state.segment === 'saved' || state.segment === 'library') return state.segment;
  return app.getSavedMeals().length ? 'saved' : 'library';
}

/** I-26: Saved Meals by most recently updated, then name. (Library keeps its shipped order.) */
export function sortSavedMeals(meals) {
  const updated = (m) => (m.metadata && m.metadata.updatedAt) || '';
  return meals.slice().sort((a, b) => (updated(a) < updated(b) ? 1 : updated(a) > updated(b) ? -1 : a.name.localeCompare(b.name)));
}

/** The meal a Saved Meal was copied from, while it still exists (for "Copy of …"). */
export function copyOfName(app, meal) {
  const id = meal.metadata && meal.metadata.copiedFromMealId;
  const src = id ? app.getMeal(id) : null;
  return src ? src.name : null;
}

/** Saved Meals that need a fix: the domain can't calculate them (a Food they use was deleted, §6.5). */
export const needsFixCount = (app) => app.getSavedMeals().filter((m) => !app.calculateMealMacros(m.id).valid).length;

/**
 * The active segment's meals. No query: Saved by last update, Library in shipped order
 * (retired hidden). A query: searchMeals within the segment, in the domain's ranking (§6.2).
 * The type chip, the Favourites chip and the "Needs a fix" chip then filter; they never
 * reorder. "Needs a fix" is a view over the Saved Meals, decided by calculateMealMacros —
 * the same state the Coach footer counts (§8.3) — never a separate list.
 */
export function mealsList(app, { segment, query = '', type = 'all', favorites = false, needsFix = false }) {
  const fav = new Set(app.getPreferences().favoriteMeals);
  const q = String(query).trim();
  // I-24: retired Library Meals stay hidden from browsing, but a favourited one still shows
  // under the Favourites chip, marked "Retired".
  const library = () => (favorites
    ? app.getLibraryMeals({ includeRetired: true }).filter((m) => !(m.metadata && m.metadata.retired) || fav.has(m.id))
    : app.getLibraryMeals());
  const pool = q
    ? app.searchMeals(q, { source: segment, limit: 500 }).map((hit) => hit.meal)
    : segment === 'saved' ? sortSavedMeals(app.getSavedMeals()) : library();
  const items = pool
    .filter((m) => (type === 'all' || m.mealType === type) && (!favorites || fav.has(m.id)))
    .map((meal) => ({ meal, isFavorite: fav.has(meal.id), calc: app.calculateMealMacros(meal.id), copyOf: copyOfName(app, meal) }))
    .filter((x) => !(needsFix && segment === 'saved') || !x.calc.valid);
  return {
    segment,
    query: q,
    type,
    favorites,
    needsFix: needsFix && segment === 'saved', // a Saved-only filter (Library meals always calculate)
    fixCount: needsFixCount(app),
    savedCount: app.getSavedMeals().length,
    items
  };
}

/* ---------------- rendering: screen ---------------- */

const TYPE_FILTERS = Object.freeze(['all', ...constants.MEAL_TYPES]);
const typeLabel = (t) => (t === 'all' ? 'All' : MEAL_TYPE_LABELS[t]);

/**
 * Heading, New meal, Saved | Library, search, type chips and the Favourites chip (§6.1). The
 * "Needs a fix" chip (Saved only) is there while any Saved Meal needs a fix, or while it's on.
 */
export function renderMealsTop(state, { fixCount = 0 } = {}) {
  const seg = state.segment;
  return `<div class="meals-head">
<h1 id="screen-title" class="screen-title" tabindex="-1">Meals</h1>
<button type="button" class="button primary" data-action="new-meal">New meal</button>
</div>
<div class="log-search">
<label class="visually-hidden" for="meals-query">Search ${seg === 'library' ? 'Library meals' : 'saved meals'}</label>
<input id="meals-query" class="search-input" type="search" autocomplete="off" data-query value="${escapeHtml(state.query)}" placeholder="Search ${seg === 'library' ? 'Library' : 'saved meals'}">
<div class="segment" role="group" aria-label="Show">
<button type="button" class="segment-button" data-action="segment" data-segment="saved" aria-pressed="${seg === 'saved'}">Saved</button>
<button type="button" class="segment-button" data-action="segment" data-segment="library" aria-pressed="${seg === 'library'}">Library</button>
</div>
</div>
<div class="filter-chips" role="group" aria-label="Filter">
${TYPE_FILTERS.map((t) => `<button type="button" class="chip filter-chip" data-action="type-filter" data-type="${t}" aria-pressed="${state.type === t}">${typeLabel(t)}</button>`).join('\n')}
<button type="button" class="chip filter-chip" data-action="favorites-filter" aria-pressed="${!!state.favorites}"><span aria-hidden="true">★ </span>Favourites</button>
${seg === 'saved' ? `<button type="button" class="chip filter-chip" data-action="needs-fix-filter" aria-pressed="${!!state.needsFix}"${state.needsFix || fixCount ? '' : ' hidden'}>Needs a fix</button>` : ''}
</div>`;
}

function mealCard(item) {
  const { meal, isFavorite, calc, copyOf } = item;
  const name = escapeHtml(meal.name);
  const markers = `${meal.metadata && meal.metadata.retired ? '<span class="marker">Retired</span>' : ''}${isFavorite ? '<span class="marker" aria-label="Favourite">★</span>' : ''}${calc.valid ? '' : '<span class="marker marker-fix">Needs a fix</span>'}`;
  const action = calc.valid
    ? `<button type="button" class="button" data-action="log-meal" data-meal="${escapeHtml(meal.id)}" aria-label="Log ${name}">Log</button>`
    : `<button type="button" class="button" data-action="meal-detail" data-meal="${escapeHtml(meal.id)}" aria-label="Fix ${name}">Fix</button>`;
  return `<li class="option-row">
<button type="button" class="option-main" data-action="meal-detail" data-meal="${escapeHtml(meal.id)}" aria-label="${name}: details">
<span class="meal-name">${name}</span>${markers}
<span class="meal-type">${MEAL_TYPE_LABELS[meal.mealType] || 'Other'}${copyOf ? ` · Copy of ${escapeHtml(copyOf)}` : ''}</span>
<span class="meal-macros">${calc.valid ? macroLine(calc.totals) : 'Needs a fix'}</span>
</button>
${action}
</li>`;
}

/** The list for the active segment, with the §6.8 empty states. */
export function renderMealsList(list) {
  const q = escapeHtml(list.query);
  if (list.segment === 'saved' && list.savedCount === 0) {
    return `<div class="empty-state"><p class="empty-note">No saved meals yet. Save one from the Library, or create your own.</p>
<div class="sheet-actions"><button type="button" class="button" data-action="segment" data-segment="library">Browse Library</button><button type="button" class="button" data-action="new-meal">New meal</button></div></div>`;
  }
  if (!list.items.length) {
    if (list.favorites && !list.query && list.type === 'all' && !list.needsFix) return '<p class="empty-note">Star a meal to find it here.</p>';
    if (list.needsFix && !list.query && list.type === 'all' && !list.favorites) return '<p class="empty-note">No saved meals need a fix.</p><div class="sheet-actions"><button type="button" class="button" data-action="clear-filters">Show all meals</button></div>';
    const clear = [list.query ? '<button type="button" class="button" data-action="clear-search">Clear search</button>' : '', list.type !== 'all' || list.favorites || list.needsFix ? '<button type="button" class="button" data-action="clear-filters">Show all meals</button>' : ''].join('');
    return `<p class="empty-note">${list.query ? `No meals match “${q}”.` : 'No meals match these filters.'}</p><div class="sheet-actions">${clear}</div>`;
  }
  const title = list.segment === 'saved' ? (list.needsFix ? 'Saved meals that need a fix' : 'Your saved meals') : 'Library meals';
  return `<section class="option-group" aria-labelledby="meals-list-title"><h2 id="meals-list-title" class="group-title">${title}${list.query ? ` matching “${q}”` : ''}</h2>
<ul class="options">${list.items.map(mealCard).join('\n')}</ul></section>`;
}

/** The count, announced politely as the list changes. */
export const listCountText = (list) => `${list.items.length} ${list.items.length === 1 ? 'meal' : 'meals'}`;

/* ---------------- rendering: detail (§6.4, §6.5) ---------------- */

/** Meal detail for Meals: Log this meal · Saved: Edit, Duplicate, Delete · Library: Save a copy · star. */
export function renderMealsDetail({ meal, calc, isFavorite, foods, copyOf }) {
  const id = escapeHtml(meal.id);
  const saved = meal.source === 'saved';
  const why = calc.valid ? '' : '<p id="detail-why" class="hint">Log this meal and Duplicate are unavailable until the deleted food is replaced or removed.</p>';
  const disabled = calc.valid ? '' : ' disabled aria-describedby="detail-why"';
  const star = `<button type="button" class="button" data-action="favorite" data-meal="${id}" aria-pressed="${isFavorite}"><span aria-hidden="true">${isFavorite ? '★' : '☆'} </span>Favourite</button>`;
  const actions = `${why}<div class="sheet-actions">
<button type="button" class="button primary" data-action="log-meal" data-meal="${id}"${disabled}>Log this meal</button>
${saved
    ? `<button type="button" class="button" data-action="edit" data-meal="${id}">Edit</button>
<button type="button" class="button" data-action="duplicate" data-meal="${id}"${disabled}>Duplicate</button>
${star}
<button type="button" class="button danger" data-action="delete" data-meal="${id}">Delete</button>`
    : `<button type="button" class="button" data-action="save-copy" data-meal="${id}">Save a copy</button>
${star}`}
</div>${saved ? '' : '<p class="hint">Library meals can’t be changed. Save a copy to make your own version.</p>'}`;
  return renderMealDetail({ meal, calc, isFavorite, foods, model: null, provenance: copyOf ? `Copy of ${copyOf}` : '', repair: saved, actions });
}

/* ---------------- the Saved Meal editor (§6.6) ---------------- */

/** A new, empty draft; or a draft of an existing Saved Meal. */
export function newDraft() {
  return { mode: 'new', id: null, name: '', mealType: 'other', rows: [], metadata: {}, original: { name: '', mealType: 'other', ingredients: [] }, copyNote: false };
}
export function draftFromMeal(meal, { copyNote = false } = {}) {
  const rows = meal.ingredients.map((i) => ({ foodId: i.foodId, text: String(i.quantity), unit: i.unit || 'g' }));
  return {
    mode: 'edit',
    id: meal.id,
    name: meal.name,
    mealType: meal.mealType || 'other',
    rows,
    metadata: JSON.parse(JSON.stringify(meal.metadata || {})),
    original: { name: meal.name, mealType: meal.mealType || 'other', ingredients: meal.ingredients.map((i) => ({ foodId: i.foodId, quantity: i.quantity })) },
    copyNote
  };
}

/** The draft's ingredients (grams parsed; null where not a usable weight). */
export const draftIngredients = (draft) => draft.rows.map((r) => ({ foodId: r.foodId, quantity: parseGrams(r.text), unit: r.unit || 'g' }));

/** The unsaved meal object the domain calculates live (calculateMealMacros accepts one). */
export const draftMeal = (draft) => ({ id: draft.id || 'draft', name: draft.name, source: 'saved', mealType: draft.mealType, ingredients: draftIngredients(draft), metadata: draft.metadata });

const sameIngredients = (a, b) => a.length === b.length && a.every((x, i) => x.foodId === b[i].foodId && x.quantity === b[i].quantity);
export const ingredientsChanged = (draft) => !sameIngredients(draftIngredients(draft), draft.original.ingredients);
export const draftDirty = (draft) => draft.name !== draft.original.name || draft.mealType !== draft.original.mealType || ingredientsChanged(draft);

/**
 * What still stops the draft from being saved, in words ([] when it can be saved). Only form
 * completeness: every number comes from the domain, and the domain checks again on save.
 */
export function draftNeeds(draft, calc) {
  const needs = [];
  if (!draft.name.trim()) needs.push('a name');
  if (!draft.rows.length) needs.push('at least one ingredient');
  else if (draftIngredients(draft).some((i) => i.quantity === null)) needs.push('a weight above 0 g for every ingredient');
  const missing = calc.problems.some((p) => p.code === 'FOOD_MISSING');
  if (missing && (ingredientsChanged(draft) || draft.mode === 'new')) needs.push('the deleted food replaced or removed');
  return needs;
}

export function renderEditor({ draft, calc, foods, touched }) {
  const needs = draftNeeds(draft, calc);
  const missingIdx = new Set(calc.problems.filter((p) => p.code === 'FOOD_MISSING').map((p) => p.index));
  const rows = draft.rows.map((row, i) => {
    const ing = calc.ingredients[i] || {};
    if (missingIdx.has(i)) {
      const p = calc.problems.find((x) => x.index === i) || {};
      const label = p.lastKnownName ? `Deleted food: ${escapeHtml(p.lastKnownName)}` : 'A deleted food';
      return `<div class="adjust-row is-missing"><span class="adjust-label">${label} · ${escapeHtml(row.text)} g</span>
<button type="button" class="link-button" data-action="row-replace" data-index="${i}">Replace</button>
<button type="button" class="link-button" data-action="row-remove" data-index="${i}" aria-label="Remove ${escapeHtml(p.lastKnownName || 'the deleted food')}">Remove</button></div>`;
    }
    const food = foods[row.foodId];
    const name = escapeHtml(food ? food.name : row.foodId);
    const bad = touched.has(i) && parseGrams(row.text) === null;
    const line = ing.status === 'ok' ? macroLine(ing) : '';
    return `<div class="adjust-row"><label for="ed-q-${i}">${name} ${food ? `<span class="state-chip">${escapeHtml(food.state)}</span>` : ''}</label>
<span class="grams-input"><input id="ed-q-${i}" type="text" inputmode="decimal" autocomplete="off" data-row="${i}" value="${escapeHtml(row.text)}" placeholder="grams"${bad ? ' aria-invalid="true"' : ''} aria-describedby="ed-q-${i}-error ed-q-${i}-macros"><span aria-hidden="true">g</span></span>
<button type="button" class="link-button" data-action="row-remove" data-index="${i}" aria-label="Remove ${name}">Remove</button>
<span id="ed-q-${i}-macros" class="hint row-macros" data-sync="row-${i}-macros">${line}</span>
<p id="ed-q-${i}-error" class="field-error" data-sync="row-${i}-error"${bad ? '' : ' hidden'}>Enter a weight above 0 g</p></div>`;
  }).join('\n');
  const nameBad = touched.has('name') && !draft.name.trim();
  const banner = draft.mode === 'edit'
    ? `<div class="banner banner-info" role="note"><p>${draft.copyNote ? 'This is your copy. Changes here don’t affect the Library meal. ' : ''}Changes apply the next time you log this meal. Meals you’ve already logged won’t change.</p></div>`
    : '';
  return `${viewHead(draft.mode === 'new' ? 'New Saved Meal' : 'Edit Saved Meal')}
${banner}
<label class="field" for="ed-name">Name</label>
<input id="ed-name" type="text" data-ed-name value="${escapeHtml(draft.name)}" autocomplete="off" aria-describedby="ed-name-error"${nameBad ? ' aria-invalid="true"' : ''}>
<p id="ed-name-error" class="field-error" data-sync="ed-name-error"${nameBad ? '' : ' hidden'}>Give it a name</p>
<fieldset class="slot-choice"><legend>Type</legend>
${constants.MEAL_TYPES.map((t) => `<label class="radio-chip"><input type="radio" name="ed-type" value="${t}"${draft.mealType === t ? ' checked' : ''}><span>${MEAL_TYPE_LABELS[t]}</span></label>`).join('\n')}
</fieldset>
<fieldset class="adjust"><legend>Ingredients</legend>
${rows || '<p class="hint">No ingredients yet.</p>'}
<button type="button" class="button add-ingredient" data-action="add-ingredient">Add ingredient</button>
</fieldset>
<div class="preview" data-sync="ed-totals" aria-live="polite">${calc.valid
    ? `<p class="preview-totals">${macroLine(calc.totals)}</p><p class="hint">Calculated from the ingredients</p>`
    : `<p class="hint">${missingIdx.size ? 'Totals will show once every ingredient is fixed.' : 'Totals show once every ingredient has a weight above 0 g.'}</p>`}</div>
<p id="ed-needs" class="hint" data-sync="ed-needs"${needs.length ? '' : ' hidden'}>${needs.length ? `Needed before saving: ${needs.join(', ')}.` : ''}</p>
${errorSlot}
<div class="sheet-actions">
<button type="button" class="button primary" data-action="editor-save" data-sync="ed-save" aria-describedby="ed-needs"${needs.length ? ' disabled' : ''}>Save</button>
<button type="button" class="button" data-action="close">Cancel</button>
</div>`;
}

/* ---------------- Food picker (§7.5) and replacement (§6.5) ---------------- */

// The Food picker (the Log Foods list in "pick" mode) lives with that list in log.js, shared
// by Meals and Today (§7.5); re-exported here for the Meals screen and its tests.
export { renderPicker };

/** "Replace {old} with {new} ({state})?" with grams prefilled and a live preview (§6.5). */
export function renderReplace({ oldName, food, text, ingredientPreview, mealCalc }) {
  const q = parseGrams(text);
  return `${viewHead(`Replace ${oldName}`)}
<p>Replace ${escapeHtml(oldName)} with ${escapeHtml(food.name)} (${escapeHtml(food.state)})?</p>
<label class="field" for="rep-grams">Grams</label>
<span class="grams-input"><input id="rep-grams" type="text" inputmode="decimal" autocomplete="off" data-rep-grams value="${escapeHtml(text)}" aria-describedby="rep-error"><span aria-hidden="true">g</span></span>
<p id="rep-error" class="field-error" data-grams-error${q === null ? '' : ' hidden'}>Enter a weight above 0 g</p>
<div class="preview" data-preview aria-live="polite">${ingredientPreview && ingredientPreview.valid ? `<p class="preview-totals">This amount: ${macroLine(ingredientPreview.totals)}</p>` : ''}${mealCalc && mealCalc.valid ? `<p class="preview-after">Meal after: ${macroLine(mealCalc.totals)}</p>` : ''}</div>
${errorSlot}
<div class="sheet-actions"><button type="button" class="button primary" data-action="replace-confirm"${q === null ? ' disabled' : ''}>Replace</button><button type="button" class="button" data-action="close">Cancel</button></div>`;
}

/* ---------------- short choices ---------------- */

export function renderDeleteMeal({ meal }) {
  return `${dialogHead('Delete Saved Meal?')}
<p>Delete Saved Meal “${escapeHtml(meal.name)}”? Meals you’ve already logged from it stay in your history.</p>
${errorSlot}
<div class="sheet-actions"><button type="button" class="button" data-action="close" data-autofocus>Cancel</button><button type="button" class="button danger" data-action="delete-confirm">Delete Saved Meal</button></div>`;
}

export function renderSaveCopy({ meal, name }) {
  return `${dialogHead('Save a copy', `Your own version of “${meal.name}” that you can change.`)}
<label class="field" for="copy-name">Name</label>
<input id="copy-name" type="text" data-copy-name value="${escapeHtml(name)}" autocomplete="off" aria-describedby="copy-name-error">
<p id="copy-name-error" class="field-error" data-name-error hidden>Give it a name</p>
${errorSlot}
<div class="sheet-actions"><button type="button" class="button primary" data-action="save-copy-confirm">Save a copy</button><button type="button" class="button" data-action="close">Cancel</button></div>`;
}

export function renderRemoveIngredient({ meal, name }) {
  return `${dialogHead('Remove ingredient?')}
<p>Remove ${escapeHtml(name)} from “${escapeHtml(meal.name)}”? Meals you’ve already logged aren’t affected.</p>
${errorSlot}
<div class="sheet-actions"><button type="button" class="button" data-action="close" data-autofocus>Cancel</button><button type="button" class="button danger" data-action="remove-confirm">Remove</button></div>`;
}

export function renderDiscard() {
  return `${dialogHead('Discard changes?')}
<p>Your changes to this meal haven’t been saved.</p>
<div class="sheet-actions"><button type="button" class="button primary" data-action="keep-editing" data-autofocus>Keep editing</button><button type="button" class="button danger" data-action="discard">Discard</button></div>`;
}

/* ---------------- actions (domain calls only) ---------------- */

export function mealsErrorMessage(e, context = '') {
  switch (e && e.code) {
    case 'FOOD_NOT_FOUND':
      return context === 'repair'
        ? 'Another ingredient was also deleted. Use Edit to replace or remove them together.'
        : 'An ingredient’s food no longer exists. Replace or remove it.';
    case 'MEAL_INVALID': return 'This meal can’t be copied until the deleted food is replaced or removed.';
    case 'LIBRARY_MEAL_READ_ONLY': return 'Library meals can’t be changed. Save a copy to make your own version.';
    case 'INGREDIENT_NOT_FOUND': return 'That ingredient is no longer in this meal.';
    default: return errorMessage(e);
  }
}

export function createMealsActions(app) {
  return {
    /** Create or update from the editor's draft. An unchanged ingredient list isn't sent. */
    saveDraft(draft) {
      const name = draft.name.trim();
      if (draft.mode === 'new') {
        const meal = app.createSavedMeal({ name, mealType: draft.mealType, ingredients: draftIngredients(draft) });
        return { meal, message: `Saved “${meal.name}”.` };
      }
      const patch = { name, mealType: draft.mealType, ...(ingredientsChanged(draft) ? { ingredients: draftIngredients(draft) } : {}) };
      const meal = app.updateSavedMeal(draft.id, patch);
      return { meal, message: `Saved changes to “${meal.name}”. Meals you’ve already logged didn’t change.` };
    },
    duplicate(id) {
      const meal = app.duplicateSavedMeal(id);
      return { meal, message: `Duplicated as “${meal.name}”.` };
    },
    saveCopy(id, name) {
      const meal = app.createSavedMeal({ fromMealId: id, name });
      return { meal, message: `Saved a copy: “${meal.name}”.` };
    },
    deleteMeal(id) {
      const meal = app.getMeal(id);
      app.deleteSavedMeal(id);
      return { message: `Deleted “${meal.name}”. Meals you’ve already logged from it stay in your history.` };
    },
    setFavorite(id, on) {
      app.setFavoriteMeal(id, on);
      return { message: on ? 'Added to favourites.' : 'Removed from favourites.' };
    },
    replaceIngredient(id, oldFoodId, newFoodId, quantity) {
      const meal = app.replaceSavedMealIngredient(id, oldFoodId, newFoodId, { quantity });
      return { meal, message: `Replaced. “${meal.name}” can be logged again${app.calculateMealMacros(id).valid ? '' : ' once its other ingredients are fixed'}.` };
    },
    removeIngredient(id, index) {
      const current = app.getMeal(id);
      const meal = app.updateSavedMeal(id, { ingredients: current.ingredients.filter((_, i) => i !== index) });
      return { meal, message: 'Ingredient removed.' };
    },
    createCustomFood: (values) => app.createCustomFood(customFoodInput(values))
  };
}

/* ---------------- DOM wiring ---------------- */

/** The Meals screen, mounted by the shell into <main>. */
export const mealsScreen = {
  mount(main, { app, win, doc }) {
    const state = session.meals;
    state.segment = mealsSegment(state, app);
    const actions = createMealsActions(app);
    let ui = null; // the surface in the dialog
    let draft = null; // the editor's draft, kept while the picker / form / discard prompt are on top
    let touched = new Set();
    let announcement = null;
    let fromToday = null; // §16: opened by Today's "Edit Saved Meal"; when done, back to that logged meal

    main.innerHTML = `<div class="meals-page view-page" data-meals-page>
<div class="meals-screen" data-meals-body>
<div data-meals-top></div>
<div class="log-confirmation-region" data-announce role="status" aria-live="polite"></div>
<p class="visually-hidden" data-count role="status" aria-live="polite"></p>
<div class="log-results" data-list></div>
</div>
<dialog class="sheet" aria-labelledby="sheet-title" data-sheet></dialog>
</div>`;
    const page = main.querySelector('[data-meals-page]');
    const top = main.querySelector('[data-meals-top]');
    const announceEl = main.querySelector('[data-announce]');
    const countEl = main.querySelector('[data-count]');
    const listEl = main.querySelector('[data-list]');
    const dialog = main.querySelector('[data-sheet]');
    const searchInput = () => top.querySelector('[data-query]');

    const renderTop = () => { top.innerHTML = renderMealsTop(state, { fixCount: needsFixCount(app) }); };
    function renderList({ announceCount = false } = {}) {
      const list = mealsList(app, state);
      listEl.innerHTML = renderMealsList(list);
      // The "Needs a fix" chip follows repairs and deletions without re-rendering the search field.
      const fixChip = top.querySelector('[data-action="needs-fix-filter"]');
      if (fixChip) fixChip.hidden = !(state.needsFix || list.fixCount);
      if (announceCount) countEl.textContent = listCountText(list);
    }
    const renderAnnouncement = () => { announceEl.innerHTML = renderConfirmation(announcement); };
    /** A new Saved Meal (created, copied or duplicated) is shown where it now lives: Saved. */
    function showSaved() {
      if (state.segment !== 'saved') { state.segment = 'saved'; renderTop(); }
      renderList();
    }
    const announce = (message) => { announcement = message ? { message } : null; renderAnnouncement(); };

    /* ---- surfaces: presented like Log's (view-host.js) ---- */
    const host = createViewHost({
      page, dialog, win, doc,
      viewTypes: MEALS_VIEW_TYPES,
      fallbackFocus: () => searchInput() || main.querySelector('#screen-title'),
      onClose: () => {
        ui = null;
        draft = null;
        if (fromToday) {
          const f = fromToday;
          fromToday = null;
          session.handoff = { date: f.date, openInstanceId: f.instanceId };
          host.leave({ method: 'back' });
        }
      },
      beforeLeave
    });
    this._cleanup = () => host.destroy();

    const foodsFor = (ids) => Object.fromEntries(ids.map((id) => [id, app.getFood(id)]).filter(([, f]) => f));
    function draw() {
      if (!ui) return;
      switch (ui.type) {
        case 'meal-detail': {
          const meal = app.getMeal(ui.mealId);
          if (!meal) { host.close(); return; }
          const calc = app.calculateMealMacros(meal.id);
          dialog.innerHTML = renderMealsDetail({ meal, calc, foods: foodsFor(calc.ingredients.map((i) => i.foodId)), isFavorite: app.getPreferences().favoriteMeals.includes(meal.id), copyOf: copyOfName(app, meal) });
          break;
        }
        case 'editor': dialog.innerHTML = renderEditor({ draft, calc: app.calculateMealMacros(draftMeal(draft)), foods: foodsFor(draft.rows.map((r) => r.foodId)), touched }); break;
        case 'picker': dialog.innerHTML = renderPicker({ title: ui.title, query: ui.query, results: pickerResults(app, ui.query) }); break;
        // The one Food detail (foods.js), information-only from the picker (§7.3, A-46).
        case 'food-detail': dialog.innerHTML = renderFoodDetail({ ...ui, context: 'picker' }); break;
        case 'custom-food': dialog.innerHTML = renderCustomFoodForm(ui); break;
        case 'replace': dialog.innerHTML = renderReplace(ui); break;
        case 'delete': dialog.innerHTML = renderDeleteMeal({ meal: app.getMeal(ui.mealId) }); break;
        case 'save-copy': dialog.innerHTML = renderSaveCopy({ meal: app.getMeal(ui.mealId), name: ui.name }); break;
        case 'remove-ingredient': dialog.innerHTML = renderRemoveIngredient({ meal: app.getMeal(ui.mealId), name: ui.name }); break;
        case 'discard': dialog.innerHTML = renderDiscard(); break;
        case 'discard-food': dialog.innerHTML = renderDiscardFood({ created: true }); break;
        default: break;
      }
    }
    function show(next, opts = {}) {
      ui = next;
      host.open(ui.type, draw, opts);
    }
    /** Redraw the current surface in place and put focus on one of its controls. */
    function redraw(focusSelector) {
      draw();
      const el = focusSelector && dialog.querySelector(focusSelector);
      if (el) el.focus();
    }
    function showError(e, context) {
      const el = dialog.open ? dialog.querySelector('[data-error]') : null;
      const text = mealsErrorMessage(e, context);
      if (el) { el.textContent = text; el.hidden = false; } else announce(text);
    }

    const openDetail = (mealId) => show({ type: 'meal-detail', mealId }, { startAtTitle: true });
    function openEditor(next, { returnTo }) {
      draft = { ...next, returnTo };
      touched = new Set();
      show({ type: 'editor' });
    }
    function backToEditor(focusSelector) {
      ui = { type: 'editor' };
      host.open('editor', draw);
      if (focusSelector) { const el = dialog.querySelector(focusSelector); if (el) el.focus(); }
    }
    function syncEditor() {
      syncInPlace(dialog, renderEditor({ draft, calc: app.calculateMealMacros(draftMeal(draft)), foods: foodsFor(draft.rows.map((r) => r.foodId)), touched }), doc);
    }

    /**
     * Before Escape, Back or Close leaves the current surface: sub-surfaces step back to what
     * opened them, and an editor with unsaved changes asks "Discard changes?" (§3.2).
     */
    function beforeLeave() {
      if (!ui) return true;
      switch (ui.type) {
        case 'picker':
          if (ui.parent === 'editor') backToEditor('[data-action="add-ingredient"]'); else openDetail(ui.mealId);
          return false;
        case 'custom-food':
          // §7.4 / §3.2: a new food with unsaved values asks first; untouched, back to the picker.
          if (customFoodDirty(ui)) { show({ type: 'discard-food', form: ui, proceed: null }); return false; }
          show(ui.pickUi);
          return false;
        case 'discard-food': show(ui.form); return false;
        case 'food-detail': backToPicker(ui); return false;
        case 'replace': openDetail(ui.mealId); return false;
        case 'discard': backToEditor(); return false;
        case 'editor':
          if (draft && draftDirty(draft)) { show({ type: 'discard' }); return false; }
          if (draft && draft.returnTo === 'detail' && draft.id && app.getMeal(draft.id)) { const id = draft.id; draft = null; openDetail(id); return false; }
          return true;
        case 'delete':
        case 'save-copy':
        case 'remove-ingredient':
          openDetail(ui.mealId);
          return false;
        default: return true;
      }
    }
    const requestLeave = () => { if (beforeLeave()) host.close(); };

    /**
     * Before Meals is left (another tab, a link, browser Back) or a Meals control replaces the
     * open pane: true when nothing unsaved would be lost; otherwise "Discard changes?" asks and
     * proceed() runs only after Discard (§3.2, I-01).
     */
    function guardLeave(proceed) {
      if (!ui) return true;
      if (ui.type === 'discard' || ui.type === 'discard-food') {
        ui.proceed = proceed;
        const keep = dialog.querySelector('[data-action="keep-editing"]');
        if (keep) keep.focus();
        return false;
      }
      if (draft && draftDirty(draft)) { show({ type: 'discard', proceed }); return false; }
      if (ui.type === 'custom-food' && customFoodDirty(ui)) { show({ type: 'discard-food', form: ui, proceed }); return false; }
      return true;
    }
    this._leaveGuard = guardLeave;

    /**
     * Food detail from the picker (§7.5, A-42, A-46): information only. The picker object itself
     * (search text, mode, the row it's for) is kept, and so is the editor's draft; Back returns
     * to the picker with focus on the Food's Details button.
     */
    function openPickerFoodDetail(foodId, pickUi) {
      const detail = foodDetailModel(app, foodId);
      if (!detail) { redraw('[data-pick-query]'); showError({ code: 'FOOD_NOT_FOUND' }); return; }
      show({ type: 'food-detail', ...detail, pickUi }, { startAtTitle: true });
    }
    function backToPicker(detailUi) {
      show(detailUi.pickUi);
      const el = dialog.querySelector(`[data-action="picker-food-detail"][data-food="${CSS.escape(detailUi.food.id)}"]`) || dialog.querySelector('[data-pick-query]');
      if (el) el.focus();
    }

    /** A Food chosen in the picker goes back to whoever asked for it; nothing is logged (§7.5). */
    function pick(foodId, pickUi) {
      if (pickUi.mode === 'add') {
        draft.rows.push({ foodId, text: '', unit: 'g' });
        backToEditor(`#ed-q-${draft.rows.length - 1}`);
      } else if (pickUi.mode === 'replace-row') {
        draft.rows[pickUi.rowIndex] = { foodId, text: draft.rows[pickUi.rowIndex].text, unit: 'g' };
        backToEditor(`#ed-q-${pickUi.rowIndex}`);
      } else {
        const food = app.getFood(foodId);
        const next = { type: 'replace', mealId: pickUi.mealId, index: pickUi.index, oldFoodId: pickUi.oldFoodId, oldName: pickUi.oldName, food, text: String(pickUi.oldQuantity) };
        replacePreview(next);
        show(next);
      }
    }
    function replacePreview(r) {
      const q = parseGrams(r.text);
      const meal = app.getMeal(r.mealId);
      r.ingredientPreview = q === null ? null : app.previewMealInstance({ ingredients: [{ foodId: r.food.id, quantity: q, unit: 'g' }], mealName: r.food.name });
      r.mealCalc = q === null || !meal ? null : app.calculateMealMacros({ ...meal, ingredients: meal.ingredients.map((i, k) => (k === r.index ? { foodId: r.food.id, quantity: q, unit: 'g' } : i)) });
    }

    /* ---- input ---- */
    main.addEventListener('input', (event) => {
      const el = event.target;
      if (el.matches('[data-query]')) { state.query = el.value; renderList({ announceCount: true }); return; }
      if (!ui) return;
      if (ui.type === 'editor' && el.matches('[data-row]')) {
        const i = Number(el.dataset.row);
        draft.rows[i].text = el.value;
        touched.add(i);
        el.setAttribute('aria-invalid', String(parseGrams(el.value) === null));
        syncEditor();
      } else if (ui.type === 'editor' && el.matches('[data-ed-name]')) {
        draft.name = el.value;
        touched.add('name');
        el.setAttribute('aria-invalid', String(!el.value.trim()));
        syncEditor();
      } else if (ui.type === 'picker' && el.matches('[data-pick-query]')) {
        ui.query = el.value;
        dialog.querySelector('[data-pick-results]').innerHTML = pickerResults(app, ui.query);
      } else if (ui.type === 'custom-food' && el.matches('[data-cf]')) {
        ui.values[el.dataset.cf] = el.value;
        ui.touched.add(el.dataset.cf);
        ui.validation = app.validateCustomFood(customFoodInput(ui.values));
        syncInPlace(dialog, renderCustomFoodForm(ui), doc);
      } else if (ui.type === 'replace' && el.matches('[data-rep-grams]')) {
        ui.text = el.value;
        replacePreview(ui);
        const ok = parseGrams(ui.text) !== null;
        dialog.querySelector('[data-grams-error]').hidden = ok;
        dialog.querySelector('[data-action="replace-confirm"]').disabled = !ok;
        const parts = [];
        if (ui.ingredientPreview && ui.ingredientPreview.valid) parts.push(`<p class="preview-totals">This amount: ${macroLine(ui.ingredientPreview.totals)}</p>`);
        if (ui.mealCalc && ui.mealCalc.valid) parts.push(`<p class="preview-after">Meal after: ${macroLine(ui.mealCalc.totals)}</p>`);
        dialog.querySelector('[data-preview]').innerHTML = parts.join('');
      } else if (ui.type === 'save-copy' && el.matches('[data-copy-name]')) {
        ui.name = el.value;
      }
    });
    main.addEventListener('change', (event) => {
      const el = event.target;
      if (!ui) return;
      if (ui.type === 'editor' && el.name === 'ed-type') { draft.mealType = el.value; syncEditor(); }
      else if (ui.type === 'custom-food' && el.matches('[data-cf]')) {
        ui.values[el.dataset.cf] = el.value;
        ui.touched.add(el.dataset.cf);
        ui.validation = app.validateCustomFood(customFoodInput(ui.values));
        syncInPlace(dialog, renderCustomFoodForm(ui), doc);
      }
    });

    /* ---- actions ---- */
    main.addEventListener('click', (event) => {
      const el = event.target.closest('[data-action]');
      if (!el || !main.contains(el)) return;
      // A Meals control used beside an open pane (wide screens) would replace an unsaved editor: ask first.
      if (dialog.open && !dialog.contains(el) && !guardLeave(() => { if (el.isConnected) el.click(); })) return;
      const mealId = el.dataset.meal || (ui && ui.mealId);
      try {
        switch (el.dataset.action) {
          case 'close': requestLeave(); break;

          /* list */
          case 'segment':
            state.segment = el.dataset.segment;
            renderTop();
            renderList({ announceCount: true });
            top.querySelector(`[data-segment="${state.segment}"]`).focus();
            break;
          case 'type-filter':
            state.type = el.dataset.type;
            renderTop();
            renderList({ announceCount: true });
            top.querySelector(`[data-type="${state.type}"]`).focus();
            break;
          case 'favorites-filter':
            state.favorites = !state.favorites;
            renderTop();
            renderList({ announceCount: true });
            top.querySelector('[data-action="favorites-filter"]').focus();
            break;
          case 'clear-search': state.query = ''; renderTop(); renderList({ announceCount: true }); searchInput().focus(); break;
          case 'needs-fix-filter':
            state.needsFix = !state.needsFix;
            renderTop();
            renderList({ announceCount: true });
            top.querySelector('[data-action="needs-fix-filter"]').focus();
            break;
          case 'clear-filters': state.type = 'all'; state.favorites = false; state.needsFix = false; renderTop(); renderList({ announceCount: true }); searchInput().focus(); break;
          case 'new-meal': openEditor(newDraft(), { returnTo: 'list' }); break;
          case 'meal-detail': openDetail(mealId); break;

          /* "Log this meal" uses Log's one logging flow and comes back here (§3.3) */
          case 'log-meal':
            session.log.launchedFromMeals = true;
            draft = null;
            host.leave({ method: 'push', href: `#/log?from=meals&meal=${encodeURIComponent(mealId)}` });
            break;
          case 'view-today':
          case 'edit-on-today':
            if (!announcement || !announcement.instanceId) break;
            session.handoff = { date: announcement.date, ...(el.dataset.action === 'view-today' ? { highlightId: announcement.instanceId } : { openInstanceId: announcement.instanceId }) };
            win.location.hash = `#/today?date=${announcement.date}`;
            break;

          /* detail */
          case 'favorite': {
            const on = !app.getPreferences().favoriteMeals.includes(mealId);
            announce(actions.setFavorite(mealId, on).message);
            renderList();
            redraw('[data-action="favorite"]');
            break;
          }
          case 'edit': openEditor(draftFromMeal(app.getMeal(mealId)), { returnTo: 'detail' }); break;
          case 'duplicate': {
            const r = actions.duplicate(mealId);
            announce(r.message);
            showSaved();
            openEditor(draftFromMeal(r.meal), { returnTo: 'detail' });
            break;
          }
          case 'save-copy': show({ type: 'save-copy', mealId, name: app.getMeal(mealId).name }); break;
          case 'save-copy-confirm': {
            const name = String(ui.name || '').trim();
            if (!name) { dialog.querySelector('[data-name-error]').hidden = false; dialog.querySelector('[data-copy-name]').focus(); break; }
            const r = actions.saveCopy(ui.mealId, name);
            announce(r.message);
            showSaved();
            openEditor(draftFromMeal(r.meal, { copyNote: true }), { returnTo: 'detail' });
            break;
          }
          case 'delete': show({ type: 'delete', mealId }); break;
          case 'delete-confirm': {
            const r = actions.deleteMeal(ui.mealId);
            announce(r.message);
            renderList({ announceCount: false });
            host.returnFocusTo(searchInput());
            ui = null;
            host.close();
            break;
          }
          case 'repair-replace': {
            const meal = app.getMeal(mealId);
            const index = Number(el.dataset.index);
            const problem = app.calculateMealMacros(mealId).problems.find((p) => p.index === index) || {};
            const oldName = problem.lastKnownName || 'the deleted food';
            show({ type: 'picker', mode: 'replace-meal', parent: 'detail', mealId, index, oldFoodId: meal.ingredients[index].foodId, oldName, oldQuantity: meal.ingredients[index].quantity, title: `Replace ${oldName}`, query: problem.lastKnownName || '' });
            break;
          }
          case 'repair-remove': {
            const index = Number(el.dataset.index);
            const problem = app.calculateMealMacros(mealId).problems.find((p) => p.index === index) || {};
            show({ type: 'remove-ingredient', mealId, index, name: problem.lastKnownName || 'the deleted food' });
            break;
          }
          case 'remove-confirm': {
            const r = actions.removeIngredient(ui.mealId, ui.index);
            announce(r.message);
            renderList();
            openDetail(r.meal.id);
            break;
          }
          case 'replace-confirm': {
            const q = parseGrams(ui.text);
            if (q === null) { dialog.querySelector('[data-grams-error]').hidden = false; break; }
            const id = ui.mealId;
            try {
              const r = actions.replaceIngredient(id, ui.oldFoodId, ui.food.id, q);
              announce(r.message);
              renderList();
              openDetail(id);
            } catch (e) { showError(e, 'repair'); }
            break;
          }

          /* editor */
          case 'add-ingredient': show({ type: 'picker', mode: 'add', parent: 'editor', title: 'Add an ingredient', query: '' }); break;
          case 'row-remove': {
            const i = Number(el.dataset.index);
            draft.rows.splice(i, 1);
            touched = new Set([...touched].filter((k) => typeof k !== 'number'));
            redraw(draft.rows.length ? `#ed-q-${Math.min(i, draft.rows.length - 1)}` : '[data-action="add-ingredient"]');
            break;
          }
          case 'row-replace': {
            const i = Number(el.dataset.index);
            const problem = app.calculateMealMacros(draftMeal(draft)).problems.find((p) => p.index === i) || {};
            show({ type: 'picker', mode: 'replace-row', parent: 'editor', rowIndex: i, title: `Replace ${problem.lastKnownName || 'the deleted food'}`, query: problem.lastKnownName || '' });
            break;
          }
          case 'editor-save': {
            const needs = draftNeeds(draft, app.calculateMealMacros(draftMeal(draft)));
            if (needs.length) { touched = new Set(['name', ...draft.rows.map((_, i) => i)]); syncEditor(); break; }
            const r = actions.saveDraft(draft);
            announce(r.message);
            showSaved();
            draft = null;
            openDetail(r.meal.id);
            break;
          }
          case 'keep-editing': if (ui.type === 'discard-food') show(ui.form); else backToEditor(); break;
          case 'discard': {
            if (ui.proceed) {
              const proceed = ui.proceed;
              draft = null;
              fromToday = null; // going somewhere else instead
              dialog.addEventListener('close', () => win.setTimeout(proceed, 0), { once: true });
              host.close();
              break;
            }
            if (ui.type === 'discard-food') { show(ui.form.pickUi); break; }
            const d = draft;
            draft = null;
            if (d && d.mode === 'edit' && d.returnTo === 'detail' && app.getMeal(d.id)) openDetail(d.id);
            else { ui = null; host.close(); }
            break;
          }

          /* picker */
          case 'food': pick(el.dataset.food, ui); break;
          case 'picker-food-detail': openPickerFoodDetail(el.dataset.food, ui); break;
          case 'create-food': {
            const values = { name: String(ui.query || '').trim(), category: '', state: '', brand: '', protein: '', carbs: '', fat: '', aliases: '' };
            show({ type: 'custom-food', values, initial: { ...values }, touched: new Set(), validation: app.validateCustomFood(customFoodInput(values)), pickUi: ui });
            break;
          }
          case 'cf-save': {
            ui.validation = app.validateCustomFood(customFoodInput(ui.values));
            if (!ui.validation.valid) { syncInPlace(dialog, renderCustomFoodForm(ui), doc); break; } // Save is disabled while invalid
            const food = actions.createCustomFood(ui.values);
            const pickUi = ui.pickUi;
            ui = pickUi;
            pick(food.id, pickUi);
            break;
          }
          default: break;
        }
      } catch (e) {
        showError(e);
      }
    });

    renderTop();
    renderList();
    // After "Log this meal": the same confirmation as the Log tab, with View on Today (§3.3).
    if (session.mealsHandoff) { announcement = session.mealsHandoff.confirmation; session.mealsHandoff = null; }
    renderAnnouncement();

    // #/meals?meal=ID opens that meal; &edit=1 opens a Saved Meal in the editor (Today's
    // "Edit Saved Meal" link, §4.3.3). The query is then dropped so a refresh doesn't repeat it.
    const params = routeParams(win.location.hash);
    // #/meals?filter=needs-fix (the Coach footer, §8.3): Saved, filtered to the meals that need a fix.
    if (params.get('filter') === 'needs-fix') {
      Object.assign(state, { segment: 'saved', query: '', type: 'all', favorites: false, needsFix: true });
      win.history.replaceState(null, '', '#/meals');
      renderTop();
      renderList({ announceCount: true });
    }
    const linked = params.get('meal') ? app.getMeal(params.get('meal')) : null;
    if (params.get('meal')) win.history.replaceState(null, '', '#/meals');
    const handback = session.savedMealEdit;
    session.savedMealEdit = null;
    if (linked) {
      if (params.get('edit') === '1' && linked.source === 'saved') {
        // From Today's logged-meal detail: cancelling goes straight back there, and after saving,
        // the Meal detail's Back does (§16).
        fromToday = handback && handback.mealId === linked.id && handback.instanceId ? handback : null;
        openEditor(draftFromMeal(linked), { returnTo: fromToday ? 'today' : 'detail' });
      }
      else openDetail(linked.id);
      return true;
    }
    return false;
  },

  /** Asked by the shell before a route change (§3.2): false keeps Meals while "Discard changes?" asks. */
  leaveGuard(proceed) {
    return this._leaveGuard ? this._leaveGuard(proceed) : true;
  },

  unmount() {
    this._leaveGuard = null;
    if (this._cleanup) { this._cleanup(); this._cleanup = null; }
  }
};
