/*
 * foods.js — Food detail (V2_UI_CONTRACT.md §7.3), deleting a Custom Food (§7.6) and the
 * Food rows Settings lists (§7.1), shared by Log and Settings.
 *
 * A Food is only ever read from the domain (getFood / getCustomFoods / getPreferences) and
 * changed through it:
 *   favourite        setFavoriteFood(id, on)      preferences.favoriteFoods (A-31)
 *   don't suggest    setDislikedFood(id, on)      preferences.dislikedFoods; only the Coach reads
 *                                                 it (A-32) — search and Log's lists are unchanged
 *   edit / delete    updateCustomFood / deleteCustomFood (Custom Foods only, A-17)
 * None of these touches a logged meal: history carries its own snapshot (A-13). Values are
 * shown as stored, rounded for display by the domain helper; nothing is converted (A-16).
 */

import { macros } from '../src/domain/index.js';
import { escapeHtml } from './shell.js';
import { macroLine, dialogHead, errorSlot } from './today.js';
import { viewHead } from './view-host.js';

const oneDecimal = (values) => macros.roundMacros(values, 1);
const plural = (n, one, many) => (n === 1 ? one : many);

/** "App food" / "My food" (§7.3). */
export const sourceLabel = (food) => (food.source === 'custom' ? 'My food' : 'App food');

/**
 * Other names worth showing: the Food's aliases, without one that only repeats its name
 * (a new Custom Food's default alias is its own name in lower case).
 */
export function otherNames(food) {
  const name = String(food.name || '').trim().toLowerCase();
  return (food.aliases || []).filter((a) => String(a).trim() && String(a).trim().toLowerCase() !== name);
}

/** What Food detail shows for one Food, or null when it no longer exists. */
export function foodDetailModel(app, foodId) {
  const food = app.getFood(foodId);
  if (!food) return null;
  const prefs = app.getPreferences();
  return {
    food,
    isFavorite: prefs.favoriteFoods.includes(food.id),
    isDisliked: prefs.dislikedFoods.includes(food.id)
  };
}

/* ---------------- Food detail (§7.3) ---------------- */

/** The favourite toggle and "Don't suggest" (shared markup, updated in place so focus stays put). */
function preferenceControls({ food, isFavorite, isDisliked }) {
  const name = escapeHtml(food.name);
  return `<section class="food-prefs" aria-labelledby="fd-prefs-title">
<h3 id="fd-prefs-title" class="group-title">Your lists</h3>
<div class="food-pref-actions">
<button type="button" class="button" data-action="fd-favorite" data-sync="fd-favorite" aria-pressed="${isFavorite}" aria-label="Favourite ${name}"><span aria-hidden="true">${isFavorite ? '★' : '☆'}</span> Favourite</button>
<button type="button" class="button" data-action="fd-suggest" data-sync="fd-suggest" data-on="${isDisliked}">${isDisliked ? 'Suggest this food again' : 'Don’t suggest this food'}</button>
</div>
<p class="hint" data-sync="fd-suggest-note">${isDisliked
    ? 'Not suggested in Build My Next Meal. It still shows in search and your lists.'
    : 'Don’t suggest only affects Build My Next Meal. The food still shows in search.'}</p>
</section>`;
}

/**
 * Food detail: name, state, category, brand, source, P/C/F per 100 g, other names; Log this
 * food and Add to a meal when opened from Log; Favourite; Don't suggest; Edit · Delete for
 * Custom Foods ("App food · can't be edited" for Core Foods). Food metadata from the migration
 * (cooked-weight factors, roles, swaps, portion steps) is never shown (I-30).
 */
export function renderFoodDetail({ food, isFavorite, isDisliked, context = 'settings', future = false, note = '' }) {
  const per100 = oneDecimal(food.nutrition);
  const names = otherNames(food);
  const custom = food.source === 'custom';
  const logActions = context === 'log'
    ? `<div class="sheet-actions">
<button type="button" class="button primary" data-action="fd-log" data-food="${escapeHtml(food.id)}"${future ? ' disabled aria-describedby="fd-future"' : ''}>Log this food</button>
<button type="button" class="button" data-action="fd-add" data-food="${escapeHtml(food.id)}">Add to a meal</button>
</div>${future ? '<p id="fd-future" class="note">You can log this day when it arrives.</p>' : ''}`
    : '';
  const ownership = custom
    ? `<div class="sheet-actions">
<button type="button" class="button" data-action="fd-edit">Edit</button>
<button type="button" class="button danger" data-action="fd-delete">Delete</button>
</div>`
    : '';
  return `${viewHead(food.name, custom ? 'My food' : 'App food · can’t be edited')}
${note ? `<p class="note" role="status">${escapeHtml(note)}</p>` : ''}
<dl class="data-facts food-facts">
<div><dt>State</dt><dd><span class="state-chip">${escapeHtml(food.state)}</span></dd></div>
<div><dt>Category</dt><dd>${escapeHtml(food.category)}</dd></div>
${food.brand ? `<div><dt>Brand</dt><dd>${escapeHtml(food.brand)}</dd></div>` : ''}
<div><dt>Source</dt><dd>${sourceLabel(food)}</dd></div>
${names.length ? `<div><dt>Other names</dt><dd>${names.map(escapeHtml).join(', ')}</dd></div>` : ''}
</dl>
<div class="table-wrap"><table class="ingredients per-100-table">
<caption class="group-title">Per 100 g</caption>
<thead><tr><th scope="col">Protein</th><th scope="col">Carbs</th><th scope="col">Fat</th></tr></thead>
<tbody><tr><td>${per100.protein} g</td><td>${per100.carbs} g</td><td>${per100.fat} g</td></tr></tbody>
</table></div>
${logActions}
${preferenceControls({ food, isFavorite, isDisliked })}
${ownership}
${errorSlot}
<p class="visually-hidden" role="status" aria-live="polite" data-food-status></p>
<div class="sheet-actions"><button type="button" class="button" data-action="close">Close</button></div>`;
}

/* ---------------- deleting a Custom Food (§7.6, A-17, A-37) ---------------- */

/** The Saved Meals that use a Food ({ id, name }), from getFoodUsage — history is never a dependency. */
export function foodUsageMeals(app, foodId) {
  return app.getFoodUsage(foodId).savedMealIds.map((id) => app.getMeal(id)).filter(Boolean).map((m) => ({ id: m.id, name: m.name }));
}

/** "Delete {name}? {n} Saved Meal(s) use it and will need a replacement … Meals you've already logged aren't affected." Cancel has the focus. */
export function renderDeleteFood({ food, meals }) {
  const n = meals.length;
  const impact = n
    ? ` ${n} ${plural(n, 'Saved Meal uses it and will need', 'Saved Meals use it and will need')} a replacement before you can log ${plural(n, 'it', 'them')}: ${meals.map((m) => `<strong>${escapeHtml(m.name)}</strong>`).join(', ')}.`
    : '';
  return `${dialogHead('Delete food?')}
<p>Delete <em>${escapeHtml(food.name)}</em>?${impact} Meals you’ve already logged aren’t affected.</p>
${errorSlot}
<div class="sheet-actions"><button type="button" class="button" data-action="close" data-autofocus>Cancel</button><button type="button" class="button danger" data-action="fd-delete-confirm">Delete food</button></div>`;
}

/**
 * After a delete: "Deleted. {n} Saved Meal(s) need a fix", with a link to each (from
 * affectedSavedMealIds) that opens it in Meals, where it's repaired (§6.5).
 */
export function deletedFoodMessage(app, food, result) {
  const meals = result.affectedSavedMealIds.map((id) => app.getMeal(id)).filter(Boolean);
  const n = meals.length;
  return {
    message: n ? `Deleted ${food.name}. ${n} ${plural(n, 'Saved Meal needs', 'Saved Meals need')} a fix:` : `Deleted ${food.name}.`,
    links: meals.map((m) => ({ href: `#/meals?meal=${encodeURIComponent(m.id)}`, label: m.name }))
  };
}

/** A message with optional links, as HTML (the links are escaped app routes). */
export function renderLinkedMessage(note) {
  if (!note) return '';
  const links = (note.links || []).map((l) => `<a href="${escapeHtml(l.href)}">${escapeHtml(l.label)}</a>`).join(', ');
  return `<p>${escapeHtml(note.message)}${links ? ` ${links}` : ''}</p>`;
}

/** Leaving the Custom Food form with unsaved edits (§3.2): Keep editing / Discard. */
export function renderDiscardFood() {
  return `${dialogHead('Discard changes?')}
<p>Your changes to this food haven’t been saved.</p>
<div class="sheet-actions"><button type="button" class="button primary" data-action="keep-editing" data-autofocus>Keep editing</button><button type="button" class="button danger" data-action="discard">Discard</button></div>`;
}

/* ---------------- Food rows for Settings (§7.1) ---------------- */

/** {Name} · state chip · brand · "My food" · "P · C · F per 100 g" · star; opens Food detail. */
export function foodDetailRow(food, { starred = false, trailing = '' } = {}) {
  return `<li class="option-row">
<button type="button" class="option-main" data-action="food-detail" data-food="${escapeHtml(food.id)}" aria-label="${escapeHtml(`${food.name}, ${food.state}${food.brand ? `, ${food.brand}` : ''}: details`)}">
<span class="meal-name">${escapeHtml(food.name)}</span><span class="state-chip">${escapeHtml(food.state)}</span>${food.brand ? `<span class="hint">${escapeHtml(food.brand)}</span>` : ''}${food.source === 'custom' ? '<span class="marker">My food</span>' : ''}${starred ? '<span class="marker" aria-label="Favourite">★</span>' : ''}
<span class="meal-macros">${macroLine(food.nutrition)} per 100 g</span>
</button>
${trailing}
</li>`;
}

/* ---------------- actions (domain calls only) ---------------- */

export function createFoodActions(app) {
  return {
    /** Star or unstar; returns the announcement. */
    setFavorite(food, on) {
      app.setFavoriteFood(food.id, on);
      return on ? `${food.name} added to favourites.` : `${food.name} removed from favourites.`;
    },
    /** Don't suggest (on) or suggest again (off); the Food itself never changes. */
    setNotSuggested(food, on) {
      app.setDislikedFood(food.id, on);
      return on ? `${food.name} won’t be suggested in Build My Next Meal.` : `${food.name} can be suggested again.`;
    },
    updateCustomFood: (id, patch) => app.updateCustomFood(id, patch),
    deleteCustomFood(food) {
      const result = app.deleteCustomFood(food.id);
      return deletedFoodMessage(app, food, result);
    }
  };
}
