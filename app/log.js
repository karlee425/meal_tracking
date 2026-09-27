/*
 * log.js — the Log screen (V2_UI_CONTRACT.md §5, with Meal detail §6.4–6.5 read-only and the
 * Custom Food form §7.4 that Log opens).
 *
 * Log records; Today edits (§5.7). Layers, as on Today:
 *   resolveLogContext / logModel      where and when the user is logging (date · day type · slot)
 *   mealResults / foodResults         domain lists and searches, in the domain's order
 *   render…(…)                        pure HTML from domain results (formatting only)
 *   createLogActions(app)             thin wrappers around domain operations
 *   logScreen.mount(main)             DOM wiring: search, sheets, tray, focus, navigation
 *
 * Every number comes from a domain call (previews, calculateMealMacros, Food nutrition as
 * stored) and is only rounded for display. The tray and search text live in session.js.
 */

import { macros, constants } from '../src/domain/index.js';
import { escapeHtml } from './shell.js';
import {
  SLOT_LABELS, DAY_TYPE_LABELS, macroLine, formatDate, parseGrams, renderMealPreview,
  renderDayTypeDialog, renderFollowUpDialog, errorMessage, recipeOf, remainingSummary,
  createTodayActions, dialogHead, slotRadios, errorSlot
} from './today.js';
import { session, routeParams, isIsoDate } from './session.js';

const MEAL_TYPE_LABELS = Object.freeze({ breakfast: 'Breakfast', lunch: 'Lunch', snack: 'Snack', dinner: 'Dinner', other: 'Other' });
const oneDecimal = (values) => macros.roundMacros(values, 1);

/* ---------------- context: date · day type · slot (§5.2) ---------------- */

/**
 * Where Log logs to, from the route and the session.
 *   From Today (#/log?from=today&date=…&slot=…): that date and slot; returns there on success.
 *   From the Log tab (#/log): the date last viewed on Today (usually today), no slot.
 * A future date is kept (so the screen can say it can't be logged yet) but never logged.
 */
export function resolveLogContext(app, hash, state = session) {
  const params = routeParams(hash);
  const today = app.getToday();
  if (params.get('from') === 'today') {
    const date = isIsoDate(params.get('date')) ? params.get('date') : today;
    const slot = constants.MEAL_SLOTS.includes(params.get('slot')) ? params.get('slot') : null;
    return { origin: 'today', date, slot, launchDate: date };
  }
  const date = isIsoDate(state.todayDate) ? state.todayDate : today;
  return { origin: 'log', date, slot: null, launchDate: date };
}

/** Everything the Log screen shows about its context. */
export function logModel(app, ctx) {
  const today = app.getToday();
  return {
    ctx,
    date: ctx.date,
    isToday: ctx.date === today,
    future: ctx.date > today, // I-04: Log is disabled for a future date
    today,
    summary: app.getDaySummary(ctx.date),
    currentTargets: app.getAllCurrentTargets()
  };
}

const dateText = (model) => (model.isToday ? `Today · ${formatDate(model.date)}` : formatDate(model.date));

/* ---------------- lists (§5.3) ---------------- */

/**
 * Meals segment. Empty query: Favourite Saved Meals → Recently logged → Saved Meals → Library
 * (A-15: a favourited Library Meal stays in the Library group, starred). With a query: the
 * domain's searchMeals for Saved, then for Library, each in the domain's ranking.
 */
export function mealResults(app, query) {
  const fav = new Set(app.getPreferences().favoriteMeals);
  const row = (meal) => ({ meal, isFavorite: fav.has(meal.id), calc: app.calculateMealMacros(meal.id) });
  const q = String(query || '').trim();
  if (q) {
    return {
      mode: 'search',
      query: q,
      saved: app.searchMeals(q, { source: 'saved' }).map((hit) => row(hit.meal)),
      library: app.searchMeals(q, { source: 'library' }).map((hit) => row(hit.meal))
    };
  }
  const saved = app.getSavedMeals().map(row);
  return {
    mode: 'browse',
    favorites: saved.filter((x) => x.isFavorite && x.meal.source === 'saved'),
    recent: app.getRecentMeals().map(row),
    saved,
    library: app.getLibraryMeals().map(row),
    libraryOpen: saved.length === 0
  };
}

/**
 * Foods segment. Empty query: Favourite Foods → Recent Foods. With a query: searchFoods, in
 * the domain's ranking (the UI never re-ranks).
 */
export function foodResults(app, query) {
  const prefs = app.getPreferences();
  const fav = new Set(prefs.favoriteFoods);
  const q = String(query || '').trim();
  if (q) return { mode: 'search', query: q, fav, hits: app.searchFoods(q) };
  return {
    mode: 'browse',
    fav,
    favorites: prefs.favoriteFoods.map((id) => app.getFood(id)).filter(Boolean),
    recent: app.getRecentFoods()
  };
}

/* ---------------- rendering: screen ---------------- */

const retired = (meal) => !!(meal.metadata && meal.metadata.retired);

function mealRow(item, { future }) {
  const { meal, isFavorite, calc } = item;
  const name = escapeHtml(meal.name);
  const markers = `${meal.source === 'library' ? '<span class="marker">Library</span>' : ''}${retired(meal) ? '<span class="marker">Retired</span>' : ''}${isFavorite ? '<span class="marker" aria-label="Favourite">★</span>' : ''}`;
  const action = calc.valid
    ? `<button type="button" class="button" data-action="log-meal-start" data-meal="${escapeHtml(meal.id)}" aria-label="Log ${name}"${future ? ' disabled aria-describedby="log-future"' : ''}>Log</button>`
    : `<button type="button" class="button" data-action="meal-detail" data-meal="${escapeHtml(meal.id)}" aria-label="Fix ${name}">Fix</button>`;
  return `<li class="option-row">
<button type="button" class="option-main" data-action="meal-detail" data-meal="${escapeHtml(meal.id)}" aria-label="${name}: details">
<span class="meal-name">${name}</span>${markers}
<span class="meal-macros">${calc.valid ? macroLine(calc.totals) : 'Needs a fix'}</span>
</button>
${action}
</li>`;
}

function foodRow(hit, fav) {
  const food = hit.food || hit;
  const alias = hit.matchedOn === 'alias' ? `<span class="hint">matched: ${escapeHtml(hit.matchedText)}</span>` : '';
  return `<li class="option-row">
<button type="button" class="option-main" data-action="food" data-food="${escapeHtml(food.id)}" aria-label="${escapeHtml(`${food.name}, ${food.state}${food.brand ? `, ${food.brand}` : ''}: enter grams`)}">
<span class="meal-name">${escapeHtml(food.name)}</span><span class="state-chip">${escapeHtml(food.state)}</span>${food.brand ? `<span class="hint">${escapeHtml(food.brand)}</span>` : ''}${food.source === 'custom' ? '<span class="marker">My food</span>' : ''}${fav.has(food.id) ? '<span class="marker" aria-label="Favourite">★</span>' : ''}
<span class="meal-macros">${macroLine(food.nutrition)} per 100 g</span>${alias}
</button>
</li>`;
}

const group = (id, title, items, rowOf) => (items.length
  ? `<section class="option-group" aria-labelledby="${id}"><h3 id="${id}" class="group-title">${title}</h3><ul class="options">${items.map(rowOf).join('\n')}</ul></section>`
  : '');

/** The results region for the active segment. */
export function renderResults({ segment, meals, foods, future }) {
  const opts = { future };
  if (segment === 'foods') {
    if (foods.mode === 'search') {
      const q = escapeHtml(foods.query);
      const create = `<button type="button" class="button create-food" data-action="create-food">Create a food named “${q}”</button>`;
      if (!foods.hits.length) return `<p class="empty-note">No foods match “${q}”.</p>${create}`;
      return `<section class="option-group" aria-label="Foods matching ${q}"><ul class="options">${foods.hits.map((h) => foodRow(h, foods.fav)).join('\n')}</ul></section>${create}`;
    }
    if (!foods.favorites.length && !foods.recent.length) return '<p class="empty-note">Search for a food. Things you log will show up here.</p>';
    return `${group('foods-fav', 'Favourite foods', foods.favorites, (f) => foodRow(f, foods.fav))}
${group('foods-recent', 'Recent foods', foods.recent, (f) => foodRow(f, foods.fav))}`;
  }
  if (meals.mode === 'search') {
    if (!meals.saved.length && !meals.library.length) return `<p class="empty-note">No meals match “${escapeHtml(meals.query)}”.</p>`;
    return `${group('meals-saved', 'Saved meals', meals.saved, (m) => mealRow(m, opts))}
${group('meals-library', 'Library', meals.library, (m) => mealRow(m, opts))}`;
  }
  return `${meals.saved.length ? '' : '<p class="empty-note">No saved meals yet. Start with a meal from the Library.</p>'}
${group('meals-fav', 'Favourite saved meals', meals.favorites, (m) => mealRow(m, opts))}
${group('meals-recent', 'Recently logged', meals.recent, (m) => mealRow(m, opts))}
${group('meals-saved', 'Saved meals', meals.saved, (m) => mealRow(m, opts))}
<details class="option-group" data-library${meals.libraryOpen ? ' open' : ''}>
<summary class="group-title">Library (${meals.library.length})</summary>
<ul class="options">${meals.library.map((m) => mealRow(m, opts)).join('\n')}</ul>
</details>`;
}

/** Header, context bar, search and segment (§5.2, §5.3). */
export function renderLogTop(model, { segment, query }) {
  const { ctx, summary } = model;
  const back = ctx.origin === 'today'
    ? '<button type="button" class="link-button log-back" data-action="back"><span aria-hidden="true">‹ </span>Back to Today</button>'
    : '';
  const typeText = summary.exists ? DAY_TYPE_LABELS[summary.dayType] : 'Choose day type';
  return `${back}
<h1 id="screen-title" class="screen-title" tabindex="-1">Log</h1>
<section class="log-context" aria-labelledby="log-context-title">
<h2 id="log-context-title" class="visually-hidden">Logging to</h2>
<ul class="context-items">
<li><button type="button" class="chip context-chip" data-action="ctx-date" aria-label="Date: ${escapeHtml(dateText(model))}. Change date">${escapeHtml(dateText(model))}</button></li>
<li><button type="button" class="chip context-chip${summary.exists ? '' : ' is-empty'}" data-action="ctx-day-type" aria-label="Day type: ${typeText}. ${summary.exists ? 'Change day type' : 'Choose one'}"${model.future ? ' disabled' : ''}>${typeText}</button></li>
<li><button type="button" class="chip context-chip${ctx.slot ? '' : ' is-empty'}" data-action="ctx-slot" aria-label="Slot: ${ctx.slot ? SLOT_LABELS[ctx.slot] : 'not chosen'}. ${ctx.slot ? 'Change slot' : 'Choose a slot'}">${ctx.slot ? SLOT_LABELS[ctx.slot] : 'Choose slot'}</button></li>
</ul>
${model.future ? '<p id="log-future" class="note log-future">You can log this day when it arrives.</p>' : ''}
</section>
<div class="log-search">
<label class="visually-hidden" for="log-query">Search ${segment === 'foods' ? 'foods' : 'meals'}</label>
<input id="log-query" class="search-input" type="search" autocomplete="off" data-query value="${escapeHtml(query)}" placeholder="Search ${segment === 'foods' ? 'foods' : 'meals'}">
<div class="segment" role="group" aria-label="Show">
<button type="button" class="segment-button" data-action="segment" data-segment="meals" aria-pressed="${segment !== 'foods'}">Meals</button>
<button type="button" class="segment-button" data-action="segment" data-segment="foods" aria-pressed="${segment === 'foods'}">Foods</button>
</div>
</div>`;
}

/** The Log-tab confirmation (§5.8, §5.7): "Logged {name} to {Slot}" · View on Today · Edit. */
export function renderConfirmation(confirmation) {
  if (!confirmation) return '';
  const links = confirmation.instanceId
    ? ' <button type="button" class="link-button" data-action="view-today">View on Today</button> <button type="button" class="link-button" data-action="edit-on-today">Edit</button>'
    : '';
  return `<p class="log-confirmation">${escapeHtml(confirmation.message)}${links}</p>`;
}

/* ---------------- meal builder tray (§5.5, I-22) ---------------- */

/** The prefilled tray name: "{first food} + {n−1} more" (just the food's name for one). */
export function trayMealName(foodNames) {
  if (!foodNames.length) return '';
  const others = foodNames.length - 1;
  return others ? `${foodNames[0]} + ${others} more` : foodNames[0];
}

/** Tray ingredients from its rows, or null while any grams are not a usable weight. */
export function trayIngredients(tray) {
  const parsed = tray.map((row) => parseGrams(row.text));
  if (parsed.some((q) => q === null)) return null;
  return tray.map((row, i) => ({ foodId: row.foodId, quantity: parsed[i], unit: 'g' }));
}

/** The bar at the bottom of Log: "{n} foods · P / C / F" from previewMealInstance. */
export function renderTrayBar(tray, preview) {
  if (!tray.length) return '';
  const count = `${tray.length} ${tray.length === 1 ? 'food' : 'foods'}`;
  const totals = preview && preview.valid ? macroLine(preview.totals) : 'check the grams';
  return `<button type="button" class="tray-bar" data-action="tray-open" aria-label="Meal being built: ${count}, ${escapeHtml(totals)}. Review and log">
<span class="tray-count">${count}</span><span class="tray-totals">${escapeHtml(totals)}</span><span class="tray-cta">Review and log</span>
</button>`;
}

/* ---------------- presentation by width (§3.1, I-05) ---------------- */

/** Detail and editing surfaces; everything else in Log is a short choice (day type, date, slot, follow-up). */
export const LOG_VIEW_TYPES = Object.freeze(['meal-detail', 'meal', 'food', 'tray', 'custom-food']);

/**
 * 'compact' (< ~600 px) · 'medium' · 'wide' (≥ ~1024 px), with the stylesheet's Log breakpoints.
 * They are in em, so a larger text size counts as less room: two panes only when both fit.
 */
export const LOG_WIDE_QUERY = '(min-width: 64em)';
export const LOG_COMPACT_QUERY = '(max-width: 37.49em)';
export function widthClass(win) {
  const matches = (q) => !!(win && win.matchMedia && win.matchMedia(q).matches);
  if (matches(LOG_WIDE_QUERY)) return 'wide';
  return matches(LOG_COMPACT_QUERY) ? 'compact' : 'medium';
}

/**
 * How a Log surface is shown:
 *   wide     'pane'   — non-modal, in the right-hand pane beside the results (two panes)
 *   medium   'panel'  — detail/editing views as a side panel; short choices stay centred dialogs
 *   compact  'pushed' — detail/editing views full screen with a Back control; short choices are bottom sheets
 */
export function presentationFor(type, width) {
  if (width === 'wide') return 'pane';
  if (!LOG_VIEW_TYPES.includes(type)) return 'sheet';
  return width === 'compact' ? 'pushed' : 'panel';
}

/** Header for a detail/editing view: a Back control when pushed full screen, Close otherwise (CSS picks one). */
export const viewHead = (title, subtitle = '') => `<header class="sheet-head view-head">
<button type="button" class="link-button view-back" data-action="close"><svg class="icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M15 5l-7 7 7 7"/></svg>Back</button>
<h2 id="sheet-title" class="sheet-title">${escapeHtml(title)}</h2>
${subtitle ? `<p class="sheet-subtitle">${escapeHtml(subtitle)}</p>` : ''}
<button type="button" class="icon-button view-close" data-action="close" aria-label="Close"><svg class="icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M6 6l12 12M18 6 6 18"/></svg></button>
</header>`;

/* ---------------- rendering: sheets ---------------- */

/** "What's left after this" waits for the day type when the date has no Day yet (§5.5). */
function previewBlock(preview) {
  if (!preview) return '<p class="hint">Enter a weight to see what it adds.</p>';
  const wait = preview.valid && preview.dayTypeRequired ? '<p class="hint">What’s left after this shows once you choose the day type.</p>' : '';
  return `${renderMealPreview(preview)}${wait}`;
}

const slotError = '<p class="field-error" data-slot-error hidden>Choose a slot</p>';
const futureNote = (model) => (model.future ? '<p class="note">You can log this day when it arrives.</p>' : '');

/** Meal detail, read-only (§6.4), with the invalid-meal banner (§6.5). */
export function renderMealDetail({ meal, calc, isFavorite, foods, model }) {
  const kind = meal.source === 'saved' ? 'Saved meal' : 'Library meal';
  const subtitle = [MEAL_TYPE_LABELS[meal.mealType] || 'Other', kind, isFavorite ? '★ Favourite' : '', retired(meal) ? 'Retired' : ''].filter(Boolean).join(' · ');
  const meta = meal.metadata || {};
  const labels = meta.ingredientLabels || {};
  const missing = calc.problems.filter((p) => p.code === 'FOOD_MISSING');
  const banner = calc.valid ? '' : `<div class="banner" role="note"><p><strong>${escapeHtml(meal.name)} can’t be logged right now.</strong> ${missing.length
    ? `${missing.map((p) => escapeHtml(p.lastKnownName || 'A food')).join(', ')} ${missing.length === 1 ? 'was' : 'were'} deleted, so this meal needs a replacement.`
    : 'Some of its ingredients can’t be calculated.'} Meals you’ve already logged aren’t affected.</p></div>`;
  const rows = calc.ingredients.map((ing) => {
    if (ing.status !== 'ok') {
      const p = calc.problems.find((x) => x.index === ing.index) || {};
      const name = p.lastKnownName ? `Deleted food: ${escapeHtml(p.lastKnownName)}` : 'A deleted food';
      return `<tr><th scope="row">${name}</th><td>${ing.quantity} g</td><td colspan="3">—</td></tr>`;
    }
    const r = oneDecimal(ing);
    const food = foods[ing.foodId];
    const label = labels[ing.foodId] && labels[ing.foodId] !== ing.foodName ? `<span class="hint"> ${escapeHtml(labels[ing.foodId])}</span>` : '';
    return `<tr><th scope="row">${escapeHtml(ing.foodName)} ${food ? `<span class="state-chip">${escapeHtml(food.state)}</span>` : ''}${label}</th><td>${ing.quantity} g</td><td>${r.protein}</td><td>${r.carbs}</td><td>${r.fat}</td></tr>`;
  }).join('\n');
  const steps = Array.isArray(meta.steps) && meta.steps.length ? `<ol class="steps">${meta.steps.map((s) => `<li>${escapeHtml(s)}</li>`).join('')}</ol>` : '';
  const how = steps || meta.prepMinutes || meta.storage || meta.notes
    ? `<section class="how-to" aria-labelledby="how-title"><h3 id="how-title" class="group-title">How to make it</h3>
${meta.prepMinutes ? `<p>Prep: ${escapeHtml(meta.prepMinutes)} min</p>` : ''}${steps}
${meta.storage ? `<p><strong>Storage:</strong> ${escapeHtml(meta.storage)}</p>` : ''}${meta.notes ? `<p><strong>Notes:</strong> ${escapeHtml(meta.notes)}</p>` : ''}</section>`
    : '';
  const logButton = calc.valid
    ? `<button type="button" class="button primary" data-action="log-meal-start" data-meal="${escapeHtml(meal.id)}"${model.future ? ' disabled' : ''}>Log this meal</button>`
    : '<button type="button" class="button primary" disabled aria-describedby="detail-why">Log this meal</button><span id="detail-why" class="hint">Can’t be logged until the deleted food is replaced.</span>';
  return `${viewHead(meal.name, subtitle)}
${banner}
${calc.valid ? `<p class="preview-totals">${macroLine(calc.totals)}</p><p class="hint">Calculated from the ingredients below</p>` : '<p class="note">Totals will show once every ingredient is fixed.</p>'}
<div class="table-wrap"><table class="ingredients">
<caption class="visually-hidden">Ingredients</caption>
<thead><tr><th scope="col">Food</th><th scope="col">Grams</th><th scope="col"><abbr title="Protein">P</abbr></th><th scope="col"><abbr title="Carbs">C</abbr></th><th scope="col"><abbr title="Fat">F</abbr></th></tr></thead>
<tbody>${rows}</tbody>
</table></div>
${how}
${futureNote(model)}
<div class="sheet-actions">${logButton}<button type="button" class="button" data-action="close">Close</button></div>`;
}

/** Log a Meal: totals, date · slot, what's left after, adjust grams for this time (§5.4). */
export function renderLogMealSheet({ model, preview, slot, adjusting, quantities, foods }) {
  const body = adjusting
    ? `<fieldset class="adjust"><legend>Grams for this time</legend>
${preview.ingredients.map((ing, i) => `<div class="adjust-row"><label for="adj-${i}">${escapeHtml(ing.foodName || ing.foodId)} <span class="state-chip">${escapeHtml(foods[ing.foodId] ? foods[ing.foodId].state : '')}</span></label>
<span class="grams-input"><input id="adj-${i}" type="text" inputmode="decimal" autocomplete="off" data-quantity-index="${i}" value="${escapeHtml(quantities[i])}"><span aria-hidden="true">g</span></span></div>`).join('\n')}
<p class="field-error" data-grams-error hidden>Enter a weight above 0 g</p>
</fieldset>`
    : '';
  return `${viewHead(preview.mealName || 'Log meal', `${dateText(model)} · Logging this doesn't change the saved or Library meal.`)}
<div class="preview" data-preview aria-live="polite">${previewBlock(preview)}</div>
${body}
${slotRadios('log-slot', slot)}
${slotError}
${futureNote(model)}
${errorSlot}
<div class="sheet-actions">
<button type="button" class="button primary" data-action="log-meal"${preview.valid && !model.future ? '' : ' disabled'}>Log</button>
${adjusting ? '' : '<button type="button" class="button" data-action="adjust">Adjust grams for this time</button>'}
<button type="button" class="button" data-action="close">Cancel</button>
</div>`;
}

/** Log a Food by weight (§5.5): state always shown, grams only, never converted. */
export function renderFoodSheet({ model, food, text, preview, slot }) {
  const valid = !!(preview && preview.valid);
  return `${viewHead(food.name, dateText(model))}
<p><span class="state-chip">${escapeHtml(food.state)}</span>${food.brand ? ` <span class="hint">${escapeHtml(food.brand)}</span>` : ''} Weigh it ${escapeHtml(food.state)}.</p>
<label class="field" for="qty-grams">Grams</label>
<span class="grams-input"><input id="qty-grams" type="text" inputmode="decimal" autocomplete="off" data-grams value="${escapeHtml(text || '')}" placeholder="grams" aria-describedby="qty-error"><span aria-hidden="true">g</span></span>
<p id="qty-error" class="field-error" data-grams-error hidden>Enter a weight above 0 g</p>
<div class="preview" data-preview aria-live="polite">${previewBlock(preview)}</div>
${slotRadios('log-slot', slot)}
${slotError}
${futureNote(model)}
${errorSlot}
<div class="sheet-actions">
<button type="button" class="button primary" data-action="log-food"${valid && !model.future ? '' : ' disabled'}>Log</button>
<button type="button" class="button" data-action="add-to-tray"${valid ? '' : ' disabled'}>Add to a meal</button>
<button type="button" class="button" data-action="close">Cancel</button>
</div>`;
}

/** The tray as one meal: grams, remove, name, slot, "Also save as a Saved Meal" (§5.5). */
export function renderTraySheet({ model, rows, preview, name, slot, alsoSave }) {
  const items = rows.map((row, i) => `<div class="adjust-row"><label for="tray-q-${i}">${escapeHtml(row.food ? row.food.name : row.foodId)} ${row.food ? `<span class="state-chip">${escapeHtml(row.food.state)}</span>` : ''}</label>
<span class="grams-input"><input id="tray-q-${i}" type="text" inputmode="decimal" autocomplete="off" data-tray-index="${i}" value="${escapeHtml(row.text)}"><span aria-hidden="true">g</span></span>
<button type="button" class="link-button" data-action="tray-remove" data-index="${i}" aria-label="Remove ${escapeHtml(row.food ? row.food.name : row.foodId)}">Remove</button></div>`).join('\n');
  const ready = !!(preview && preview.valid) && !model.future;
  return `${viewHead('Log as one meal', dateText(model))}
<fieldset class="adjust"><legend>Foods in this meal</legend>
${items}
<p class="field-error" data-grams-error hidden>Enter a weight above 0 g</p>
</fieldset>
<div class="preview" data-preview aria-live="polite">${preview ? previewBlock(preview) : ''}</div>
<label class="field" for="tray-name">Name</label>
<input id="tray-name" type="text" data-tray-name value="${escapeHtml(name)}" autocomplete="off">
<p class="field-error" data-name-error hidden>Give it a name</p>
${slotRadios('log-slot', slot)}
${slotError}
<label class="check-row"><input type="checkbox" data-also-save${alsoSave ? ' checked' : ''}> Also save as a Saved Meal</label>
${futureNote(model)}
${errorSlot}
<div class="sheet-actions">
<button type="button" class="button primary" data-action="tray-log"${ready ? '' : ' disabled'}>Log as one meal</button>
<button type="button" class="button" data-action="close">Keep browsing</button>
</div>`;
}

/** Pick the date to log for: today or a past date (I-04). */
export function renderDateSheet({ model, value }) {
  return `${dialogHead('Log for which day?')}
<label class="field" for="log-date">Date</label>
<input id="log-date" type="date" data-date max="${model.today}" value="${escapeHtml(value)}">
<p class="field-error" data-date-error hidden>You can log this day when it arrives.</p>
${errorSlot}
<div class="sheet-actions">
<button type="button" class="button primary" data-action="date-apply">Use this date</button>
<button type="button" class="button" data-action="date-today">Today</button>
<button type="button" class="button" data-action="close">Cancel</button>
</div>`;
}

/** Pick the slot for the context bar. */
export function renderSlotSheet({ slot }) {
  return `${dialogHead('Which slot?', 'Slots are just where you log food. None is required.')}
${slotRadios('ctx-slot', slot)}
${slotError}
<div class="sheet-actions">
<button type="button" class="button primary" data-action="slot-apply">Use this slot</button>
<button type="button" class="button" data-action="close">Cancel</button>
</div>`;
}

/* ---------------- Custom Food form (§7.4, A-27) ---------------- */

const CUSTOM_FOOD_MESSAGES = Object.freeze({
  NAME_REQUIRED: 'Give it a name.',
  CATEGORY_REQUIRED: 'Add a category, for example snack bar.',
  STATE_INVALID: 'Choose a state.',
  NUTRITION_REQUIRED: 'Required.',
  NUTRITION_NOT_A_NUMBER: 'Enter a number.',
  NUTRITION_NEGATIVE: 'Can’t be below 0.',
  NUTRITION_IMPOSSIBLE: 'Protein + carbs + fat can’t be more than 100 g in 100 g. Check the label — values per serving need converting to per 100 g.'
});

/** Text typed into a per-100 g field → a number, undefined when empty (never NaN), or the text as typed. */
export function parseAmount(text) {
  const t = String(text == null ? '' : text).trim().replace(',', '.');
  if (!t) return undefined;
  const n = Number(t);
  return Number.isFinite(n) ? n : t;
}

/** Form values → the domain's Custom Food input. The domain validates it. */
export function customFoodInput(values) {
  const aliases = String(values.aliases || '').split(',').map((a) => a.trim()).filter(Boolean);
  return {
    name: values.name,
    category: values.category,
    state: values.state || undefined,
    brand: String(values.brand || '').trim() || null,
    nutrition: { protein: parseAmount(values.protein), carbs: parseAmount(values.carbs), fat: parseAmount(values.fat) },
    ...(aliases.length ? { aliases } : {})
  };
}

const NEEDED_NAMES = Object.freeze({ name: 'name', category: 'category', state: 'state', 'nutrition.protein': 'protein', 'nutrition.carbs': 'carbs', 'nutrition.fat': 'fat', nutrition: 'protein + carbs + fat' });

/**
 * The Custom Food form. Save is disabled while the domain says the input is invalid; errors
 * show next to each field once it has been edited, and a line by Save always says what's
 * still needed, so nobody has to press a disabled button to find out.
 */
export function renderCustomFoodForm({ values, validation, touched }) {
  const shown = (field) => touched.has(field);
  const errorFor = (field) => {
    const e = validation.errors.find((x) => x.field === field);
    return e && shown(field.replace('nutrition.', '')) ? CUSTOM_FOOD_MESSAGES[e.code] || 'Check this value.' : '';
  };
  const fieldError = (field, id) => { const t = errorFor(field); return `<p id="${id}" class="field-error" data-sync="${id}"${t ? '' : ' hidden'}>${escapeHtml(t)}</p>`; };
  const impossible = validation.errors.find((x) => x.code === 'NUTRITION_IMPOSSIBLE');
  const dup = validation.warnings.find((w) => w.code === 'DUPLICATE_NAME');
  const text = (field, label, placeholder = '') => `<label class="field" for="cf-${field}">${label}</label>
<input id="cf-${field}" type="text" data-cf="${field}" value="${escapeHtml(values[field] || '')}" autocomplete="off"${placeholder ? ` placeholder="${placeholder}"` : ''} aria-describedby="cf-${field}-error">`;
  const amount = (field, label) => `<div class="amount-field"><label class="field" for="cf-${field}">${label}</label>
<span class="grams-input"><input id="cf-${field}" type="text" inputmode="decimal" data-cf="${field}" value="${escapeHtml(values[field] || '')}" autocomplete="off" aria-describedby="cf-${field}-error"><span aria-hidden="true">g</span></span>
${fieldError(`nutrition.${field}`, `cf-${field}-error`)}</div>`;
  return `${viewHead('New food', 'Your own food, per 100 g')}
${text('name', 'Name')}
${fieldError('name', 'cf-name-error')}
<p class="note" role="status" data-sync="cf-dup"${dup ? '' : ' hidden'}>${dup ? `You already have a food called ${escapeHtml(String(values.name).trim())}.` : ''}</p>
${text('category', 'Category', 'e.g. snack bar')}
${fieldError('category', 'cf-category-error')}
<label class="field" for="cf-state">State</label>
<select id="cf-state" data-cf="state" aria-describedby="cf-state-error">
<option value=""${values.state ? '' : ' selected'}>Choose…</option>
${constants.FOOD_STATES.map((s) => `<option value="${s}"${values.state === s ? ' selected' : ''}>${s}</option>`).join('')}
</select>
${fieldError('state', 'cf-state-error')}
${text('brand', 'Brand (optional)')}
<fieldset class="per-100"><legend>Per 100 g</legend>
${amount('protein', 'Protein')}
${amount('carbs', 'Carbs')}
${amount('fat', 'Fat')}
</fieldset>
<p class="field-error" role="alert" data-sync="cf-impossible"${impossible ? '' : ' hidden'}>${CUSTOM_FOOD_MESSAGES.NUTRITION_IMPOSSIBLE}</p>
${text('aliases', 'Other names (optional, comma-separated)')}
<p id="cf-save-hint" class="hint" data-sync="cf-save-hint"${validation.valid ? ' hidden' : ''}>${validation.valid ? '' : `Needed before saving: ${[...new Set(validation.errors.map((e) => NEEDED_NAMES[e.field] || e.field))].join(', ')}.`}</p>
${errorSlot}
<div class="sheet-actions">
<button type="button" class="button primary" data-action="cf-save" data-sync="cf-save" aria-describedby="cf-save-hint"${validation.valid ? '' : ' disabled'}>Save and enter grams</button>
<button type="button" class="button" data-action="close">Cancel</button>
</div>`;
}

/* ---------------- actions (domain calls only) ---------------- */

export function logErrorMessage(e) {
  switch (e && e.code) {
    case 'DAY_TYPE_REQUIRED': return 'Choose a day type first.';
    case 'DAY_EXISTS': return 'This day already has a day type.';
    case 'INVALID_FOOD': return 'Check the fields above.';
    default: return errorMessage(e);
  }
}

export function createLogActions(app) {
  const shared = createTodayActions(app);
  const dayLabel = (date) => (date === app.getToday() ? 'Today' : formatDate(date));
  const withType = (dayType) => (dayType ? { dayType } : {});
  const logged = (instance, date) => ({ instance, date, message: `Logged ${instance.mealName} to ${SLOT_LABELS[instance.mealSlot]}.` });
  return {
    chooseDayType(date, type) {
      app.createDay(date, type);
      return { message: `${dayLabel(date)} is a ${DAY_TYPE_LABELS[type]} day.` };
    },
    changeDayType(date, type) {
      if (app.previewDayTypeChange(date, type).noOp) return { noOp: true, message: '' };
      app.updateDayType(date, type);
      return { message: `Changed to ${DAY_TYPE_LABELS[type]}. Your logged food didn't change.` };
    },
    applyCurrentTargets: () => shared.applyCurrentTargets(),
    /** A Library or Saved Meal as it is, or with this time's grams. dayType only when the date has no Day yet. */
    logMeal({ date, mealSlot, mealId, ingredients, dayType }) {
      return logged(app.createMealInstance({ date, mealSlot, mealId, ...(ingredients ? { ingredients } : {}), ...withType(dayType) }), date);
    },
    logFood({ date, mealSlot, foodId, quantity, dayType }) {
      return logged(app.logFood({ date, mealSlot, foodId, quantity, ...withType(dayType) }), date);
    },
    /** The tray as one logged meal; optionally also a new Saved Meal with the same ingredients. */
    logTray({ date, mealSlot, ingredients, mealName, dayType, alsoSave }) {
      const result = logged(app.createMealInstance({ date, mealSlot, ingredients, mealName, ...withType(dayType) }), date);
      if (!alsoSave) return result;
      const savedMeal = app.createSavedMeal({ name: mealName, mealType: 'other', ingredients });
      return { ...result, savedMeal, message: `${result.message} Saved “${savedMeal.name}” as a saved meal.` };
    },
    createCustomFood: (values) => app.createCustomFood(customFoodInput(values)),
    saveAsNewSavedMeal: (args) => shared.saveAsNewSavedMeal(args),
    updateSavedMeal: (id, ingredients) => shared.updateSavedMeal(id, ingredients)
  };
}

/* ---------------- after logging and leaving (§5.8) ---------------- */

/** The segment Log opens on: the one last used this session, else Meals (§5.3). */
export const logSegment = (state) => (state.segment === 'foods' ? 'foods' : 'meals');

/**
 * What happens after a successful log.
 *   From Today → { to: 'today', handoff } — Today highlights the row and announces
 *     "Logged {name} to {Slot}. {remaining summary}."
 *   From the Log tab → { to: 'log', confirmation } — "Logged {name} to {Slot}." · View on Today · Edit.
 */
export function afterLogging(app, ctx, result, note = '') {
  const message = note ? `${result.message} ${note}` : result.message;
  if (ctx.origin === 'today') {
    const summary = app.getDaySummary(result.date);
    const left = remainingSummary(summary, { isToday: result.date === app.getToday(), date: result.date });
    return { to: 'today', handoff: { date: result.date, highlightId: result.instance.id, message: `${message} ${left}` } };
  }
  return { to: 'log', confirmation: { message, instanceId: result.instance.id, date: result.date } };
}

/**
 * How to get back to Today. When Log was opened from Today on the same date, step back in
 * history (so the browser's Back doesn't return to Log); otherwise replace Log's entry with
 * that date's Today.
 */
export function returnToToday(state, ctx, date) {
  const back = state.launchedFromToday && ctx.origin === 'today' && date === ctx.launchDate;
  return back ? { method: 'back' } : { method: 'replace', href: `#/today?date=${date}` };
}

/* ---------------- DOM wiring ---------------- */

function sameRecipe(a, b) {
  return a.length === b.length && a.every((x, i) => x.foodId === b[i].foodId && x.quantity === b[i].quantity);
}

/** The Log screen, mounted by the shell into <main>. */
export const logScreen = {
  mount(main, { app, win, doc }) {
    const state = session.log;
    state.segment = logSegment(state);
    const ctx = resolveLogContext(app, win.location.hash);
    if (ctx.origin !== 'today') state.launchedFromToday = false;
    const actions = createLogActions(app);
    let model = logModel(app, ctx);
    let ui = null;
    let opener = null;
    let pendingFocus = null;
    let afterClose = null; // runs once when the open sheet closes (the follow-up after an adjusted log)
    let followNote = '';
    let confirmation = null;

    // data-origin lets the stylesheet treat Log opened from Today as a pushed, full-screen
    // destination on compact screens (no tab bar underneath; §2.3).
    main.innerHTML = `<div class="log-page" data-log-page>
<div class="log-screen" data-log-body data-origin="${ctx.origin}">
<div data-log-top></div>
<div class="log-confirmation-region" data-confirmation role="status" aria-live="polite"></div>
<div class="log-results" data-results></div>
<div class="tray" data-tray aria-live="polite"></div>
</div>
<dialog class="sheet" aria-labelledby="sheet-title" data-sheet></dialog>
</div>`;
    const page = main.querySelector('[data-log-page]');
    const top = main.querySelector('[data-log-top]');
    const confirmEl = main.querySelector('[data-confirmation]');
    const results = main.querySelector('[data-results]');
    const trayEl = main.querySelector('[data-tray]');
    const dialog = main.querySelector('[data-sheet]');

    const trayRows = () => state.tray.map((row) => ({ ...row, food: app.getFood(row.foodId) }));
    const currentTrayName = () => (state.trayName !== null ? state.trayName : trayMealName(trayRows().map((r) => (r.food ? r.food.name : r.foodId))));
    function trayPreview(withDate) {
      const ingredients = trayIngredients(state.tray);
      if (!ingredients || !ingredients.length) return null;
      return app.previewMealInstance({ ...(withDate ? { date: ctx.date } : {}), ingredients, mealName: currentTrayName() || 'Meal' });
    }

    function renderTop() {
      model = logModel(app, ctx);
      top.innerHTML = renderLogTop(model, { segment: state.segment, query: state.query });
    }
    function renderList() {
      results.innerHTML = renderResults({
        segment: state.segment,
        meals: state.segment === 'foods' ? null : mealResults(app, state.query),
        foods: state.segment === 'foods' ? foodResults(app, state.query) : null,
        future: model.future
      });
    }
    const renderTray = () => { trayEl.innerHTML = renderTrayBar(state.tray, trayPreview(false)); trayEl.classList.toggle('is-empty', !state.tray.length); };
    const renderConfirm = () => { confirmEl.innerHTML = renderConfirmation(confirmation); };
    function renderAll() { renderTop(); renderConfirm(); renderList(); renderTray(); }

    /* ---- sheets, panes and pushed views (§3.1) ---- */
    let width = 'medium';
    let modal = true;
    // A full-screen view on compact screens gets its own history entry, so the browser's
    // Back closes it (like any pushed view) instead of leaving Log.
    let viewEntry = false;
    let skipPops = 0;
    let replaceAfterPop = null;
    function popViewEntry() {
      if (!viewEntry) return;
      viewEntry = false;
      skipPops += 1;
      win.history.back();
    }
    const onPop = () => {
      if (replaceAfterPop) { const href = replaceAfterPop; replaceAfterPop = null; win.location.replace(href); return; }
      if (skipPops) { skipPops -= 1; return; }
      if (viewEntry) { viewEntry = false; closeDialog(); } // browser Back closed the pushed view
    };
    win.addEventListener('popstate', onPop);
    this._cleanup = () => win.removeEventListener('popstate', onPop);

    function openDialog(next) {
      const wasOpen = dialog.open;
      if (!wasOpen) { opener = doc.activeElement; width = widthClass(win); }
      ui = next;
      const present = presentationFor(ui.type, width);
      dialog.dataset.present = present;
      drawDialog();
      if (!wasOpen) {
        modal = present !== 'pane';
        if (modal) dialog.showModal();
        else { page.classList.add('has-view'); dialog.show(); } // wide: the right-hand pane
      }
      if (present === 'pushed' && !viewEntry) { win.history.pushState({ logView: true }, '', win.location.href); viewEntry = true; }
      // A read-only detail view starts at its title (and top); forms start at their first field.
      const auto = dialog.querySelector('[data-autofocus]')
        || (ui.type === 'meal-detail' ? null : dialog.querySelector('input:not([type=radio]):not([type=checkbox]), select, .sheet-actions .button.primary:not([disabled])'))
        || dialog.querySelector('#sheet-title');
      if (auto) { if (auto.id === 'sheet-title') auto.setAttribute('tabindex', '-1'); auto.focus(); }
    }
    const closeDialog = () => { if (dialog.open) dialog.close(); };
    // Escape closes the non-modal pane too (modal dialogs get it from the browser).
    dialog.addEventListener('keydown', (event) => { if (event.key === 'Escape' && dialog.open && !modal) { event.preventDefault(); closeDialog(); } });
    dialog.addEventListener('close', () => {
      popViewEntry();
      page.classList.remove('has-view');
      delete dialog.dataset.present;
      ui = null;
      dialog.innerHTML = '';
      const next = afterClose;
      afterClose = null;
      if (next) next();
      const target = pendingFocus && pendingFocus.isConnected ? pendingFocus
        : opener && opener.isConnected ? opener : main.querySelector('#screen-title');
      opener = null;
      pendingFocus = null;
      if (target) target.focus();
    });
    function drawDialog() {
      if (!ui) return;
      switch (ui.type) {
        case 'day-type': dialog.innerHTML = renderDayTypeDialog({ model, ...ui }); break;
        case 'date': dialog.innerHTML = renderDateSheet({ model, ...ui }); break;
        case 'slot': dialog.innerHTML = renderSlotSheet(ui); break;
        case 'meal-detail': dialog.innerHTML = renderMealDetail({ model, ...ui }); break;
        case 'meal': dialog.innerHTML = renderLogMealSheet({ model, ...ui }); break;
        case 'food': dialog.innerHTML = renderFoodSheet({ model, ...ui }); break;
        case 'tray': dialog.innerHTML = renderTraySheet({ model, ...ui }); break;
        case 'custom-food': dialog.innerHTML = renderCustomFoodForm(ui); break;
        case 'followup': dialog.innerHTML = renderFollowUpDialog(ui); break;
        default: break;
      }
    }
    function showError(e) {
      const el = dialog.open ? dialog.querySelector('[data-error]') : null;
      if (el) { el.textContent = logErrorMessage(e); el.hidden = false; } else { confirmation = { message: logErrorMessage(e) }; renderConfirm(); }
    }
    const checkedSlot = (name) => { const el = dialog.querySelector(`input[name="${name}"]:checked`); return el ? el.value : null; };
    function requireSlot(name = 'log-slot') {
      const slot = checkedSlot(name);
      if (!slot) {
        const err = dialog.querySelector('[data-slot-error]');
        if (err) err.hidden = false;
        const first = dialog.querySelector(`input[name="${name}"]`);
        if (first) first.focus();
      }
      return slot;
    }

    function openMealDetail(mealId) {
      const meal = app.getMeal(mealId);
      if (!meal) { showError({ code: 'MEAL_NOT_FOUND' }); return; }
      const calc = app.calculateMealMacros(mealId);
      const foods = {};
      for (const ing of calc.ingredients) { const f = app.getFood(ing.foodId); if (f) foods[ing.foodId] = f; }
      openDialog({ type: 'meal-detail', meal, calc, foods, isFavorite: app.getPreferences().favoriteMeals.includes(mealId) });
    }
    function openMeal(mealId) {
      const preview = app.previewMealInstance({ date: ctx.date, mealId });
      if (!preview.valid) { openMealDetail(mealId); return; } // A-18: an invalid meal routes to its detail
      const foods = {};
      for (const ing of preview.ingredients) { const f = app.getFood(ing.foodId); if (f) foods[ing.foodId] = f; }
      openDialog({ type: 'meal', mealId, preview, slot: ctx.slot, adjusting: false, quantities: preview.ingredients.map((i) => String(i.quantity)), original: recipeOf(preview.ingredients), foods });
    }
    function openFood(foodId, text = '') {
      const food = app.getFood(foodId);
      if (!food) { showError({ code: 'FOOD_NOT_FOUND' }); return; }
      const q = parseGrams(text);
      openDialog({ type: 'food', food, text, preview: q === null ? null : app.previewLogFood({ date: ctx.date, foodId, quantity: q }), slot: ctx.slot });
    }
    function openTray() {
      openDialog({ type: 'tray', rows: trayRows(), preview: trayPreview(true), name: currentTrayName(), slot: ctx.slot, alsoSave: false });
    }

    /* ---- logging: day type first when the date has no Day (§5.2, §5.9) ---- */
    function commit(spec) {
      if (model.future) return;
      if (!model.summary.exists) { openDialog({ type: 'day-type', selected: null, preview: null, applyPreview: null, continueTo: spec }); return; }
      run(spec);
    }
    function run(spec, dayType) {
      let result;
      if (spec.kind === 'meal') result = actions.logMeal({ date: ctx.date, mealSlot: spec.slot, mealId: spec.mealId, ingredients: spec.ingredients, dayType });
      else if (spec.kind === 'food') result = actions.logFood({ date: ctx.date, mealSlot: spec.slot, foodId: spec.foodId, quantity: spec.quantity, dayType });
      else {
        result = actions.logTray({ date: ctx.date, mealSlot: spec.slot, ingredients: spec.ingredients, mealName: spec.mealName, alsoSave: spec.alsoSave, dayType });
        state.tray = [];
        state.trayName = null;
      }
      renderAll();
      const follow = spec.kind === 'meal' ? followUpFor(result.instance, spec.changed) : null;
      followNote = '';
      if (follow) { afterClose = () => finish(result); openDialog(follow); } else finish(result);
    }
    function followUpFor(instance, changed) {
      if (!changed || !instance.sourceMealId) return null;
      const meal = app.getMeal(instance.sourceMealId);
      if (!meal || meal.source !== 'saved') return null; // Library meals are read-only: nothing to offer
      return { type: 'followup', mode: 'choice', savedId: meal.id, savedName: meal.name, mealType: meal.mealType, ingredients: instance.ingredients, newName: `${meal.name} (adjusted)` };
    }
    /** §5.8: back to Today with the new row highlighted, or stay on Log with View / Edit. */
    function finish(result) {
      const outcome = afterLogging(app, ctx, result, followNote);
      followNote = '';
      if (outcome.to === 'today') { goToToday(outcome.handoff); return; }
      confirmation = outcome.confirmation;
      renderConfirm();
      pendingFocus = top.querySelector('[data-query]');
      closeDialog();
    }
    function goToToday(handoff) {
      session.handoff = handoff;
      const nav = returnToToday(state, ctx, handoff ? handoff.date : ctx.launchDate);
      state.launchedFromToday = false;
      afterClose = null;
      const hadViewEntry = viewEntry; // a pushed view's history entry sits on top of Log's
      viewEntry = false;
      closeDialog();
      if (nav.method === 'back') win.history.go(hadViewEntry ? -2 : -1);
      else if (hadViewEntry) { replaceAfterPop = nav.href; win.history.back(); }
      else win.location.replace(nav.href);
    }
    function showOnToday(extra) {
      if (!confirmation || !confirmation.instanceId) return;
      session.handoff = { date: confirmation.date, ...extra };
      win.location.hash = `#/today?date=${confirmation.date}`;
    }

    /* ---- custom food form: domain validation as fields change (§7.4) ---- */
    function syncCustomFood() {
      ui.validation = app.validateCustomFood(customFoodInput(ui.values));
      const tpl = doc.createElement('template');
      tpl.innerHTML = renderCustomFoodForm(ui);
      // Update in place (never replace): a field's change event fires on the same click that
      // presses Save, and replacing the button mid-click would swallow that click.
      for (const el of tpl.content.querySelectorAll('[data-sync]')) {
        const current = dialog.querySelector(`[data-sync="${el.dataset.sync}"]`);
        if (!current) continue;
        for (const name of current.getAttributeNames()) if (!el.hasAttribute(name)) current.removeAttribute(name);
        for (const name of el.getAttributeNames()) current.setAttribute(name, el.getAttribute(name));
        if (current.innerHTML !== el.innerHTML) current.innerHTML = el.innerHTML;
      }
    }

    /* ---- input ---- */
    main.addEventListener('input', (event) => {
      const el = event.target;
      if (el.matches('[data-query]')) { state.query = el.value; renderList(); return; }
      if (!ui) return;
      if (ui.type === 'meal' && el.matches('[data-quantity-index]')) {
        ui.quantities[Number(el.dataset.quantityIndex)] = el.value;
        const parsed = ui.quantities.map(parseGrams);
        const ok = parsed.every((q) => q !== null);
        dialog.querySelector('[data-grams-error]').hidden = ok;
        const button = dialog.querySelector('[data-action="log-meal"]');
        if (!ok) { button.disabled = true; return; }
        ui.preview = app.previewMealInstance({ date: ctx.date, mealId: ui.mealId, ingredients: ui.original.map((ing, i) => ({ ...ing, quantity: parsed[i] })) });
        dialog.querySelector('[data-preview]').innerHTML = previewBlock(ui.preview);
        button.disabled = !ui.preview.valid || model.future;
      } else if (ui.type === 'food' && el.matches('[data-grams]')) {
        ui.text = el.value;
        const q = parseGrams(el.value);
        dialog.querySelector('[data-grams-error]').hidden = q !== null || el.value.trim() === '';
        ui.preview = q === null ? null : app.previewLogFood({ date: ctx.date, foodId: ui.food.id, quantity: q });
        dialog.querySelector('[data-preview]').innerHTML = previewBlock(ui.preview);
        const valid = !!(ui.preview && ui.preview.valid);
        dialog.querySelector('[data-action="log-food"]').disabled = !valid || model.future;
        dialog.querySelector('[data-action="add-to-tray"]').disabled = !valid;
      } else if (ui.type === 'tray' && el.matches('[data-tray-index]')) {
        const i = Number(el.dataset.trayIndex);
        state.tray[i].text = el.value;
        ui.rows[i].text = el.value;
        const ok = trayIngredients(state.tray) !== null;
        dialog.querySelector('[data-grams-error]').hidden = ok;
        ui.preview = ok ? trayPreview(true) : null;
        dialog.querySelector('[data-preview]').innerHTML = ui.preview ? previewBlock(ui.preview) : '';
        dialog.querySelector('[data-action="tray-log"]').disabled = !(ui.preview && ui.preview.valid) || model.future;
        renderTray();
      } else if (ui.type === 'tray' && el.matches('[data-tray-name]')) {
        ui.name = el.value;
        state.trayName = el.value;
      } else if (ui.type === 'custom-food' && el.matches('[data-cf]')) {
        ui.values[el.dataset.cf] = el.value;
        ui.touched.add(el.dataset.cf); // errors show as the user edits, not only after Save
        syncCustomFood();
      } else if (ui.type === 'followup' && el.matches('[data-new-name]')) {
        ui.newName = el.value;
      }
    });

    main.addEventListener('change', (event) => {
      const el = event.target;
      if (!ui) return;
      if (ui.type === 'day-type' && el.name === 'day-type') {
        ui.selected = el.value;
        ui.preview = model.summary.exists ? app.previewDayTypeChange(ctx.date, el.value) : null;
        drawDialog();
        const radio = dialog.querySelector(`input[name="day-type"][value="${el.value}"]`);
        if (radio) radio.focus();
      } else if (el.name === 'log-slot' || el.name === 'ctx-slot') {
        const err = dialog.querySelector('[data-slot-error]');
        if (err) err.hidden = true;
      } else if (ui.type === 'tray' && el.matches('[data-also-save]')) {
        ui.alsoSave = el.checked;
      } else if (ui.type === 'custom-food' && el.matches('[data-cf]')) {
        ui.values[el.dataset.cf] = el.value;
        ui.touched.add(el.dataset.cf);
        syncCustomFood();
      }
    });

    /* ---- actions ---- */
    main.addEventListener('click', (event) => {
      const el = event.target.closest('[data-action]');
      if (!el || !main.contains(el)) return;
      try {
        switch (el.dataset.action) {
          case 'close': closeDialog(); break;
          case 'back': goToToday(null); break;
          case 'segment': {
            state.segment = el.dataset.segment;
            renderTop();
            renderList();
            top.querySelector(`[data-segment="${state.segment}"]`).focus();
            break;
          }
          case 'ctx-date': openDialog({ type: 'date', value: ctx.date }); break;
          case 'date-today':
          case 'date-apply': {
            const value = el.dataset.action === 'date-today' ? app.getToday() : dialog.querySelector('[data-date]').value;
            const err = dialog.querySelector('[data-date-error]');
            if (!isIsoDate(value) || value > app.getToday()) {
              err.textContent = isIsoDate(value) ? 'You can log this day when it arrives.' : 'Choose a date.';
              err.hidden = false;
              break;
            }
            ctx.date = value;
            confirmation = null;
            closeDialog();
            renderAll();
            break;
          }
          case 'ctx-slot': openDialog({ type: 'slot', slot: ctx.slot }); break;
          case 'slot-apply': {
            const slot = requireSlot('ctx-slot');
            if (!slot) break;
            ctx.slot = slot;
            closeDialog();
            renderTop();
            break;
          }
          case 'ctx-day-type':
            openDialog({ type: 'day-type', selected: model.summary.dayType, preview: null, applyPreview: model.isToday && model.summary.exists ? app.previewApplyCurrentTargetsToToday() : null, continueTo: null });
            break;
          case 'choose-day-type-confirm': {
            const spec = ui.continueTo;
            const type = ui.selected;
            if (spec) { run(spec, type); break; } // creates the Day and the logged meal together
            confirmation = actions.chooseDayType(ctx.date, type);
            renderAll();
            closeDialog();
            break;
          }
          case 'change-day-type': {
            const result = actions.changeDayType(ctx.date, ui.selected);
            if (!result.noOp) { confirmation = result; renderAll(); }
            closeDialog();
            break;
          }
          case 'confirm-apply-targets': ui.confirmingApply = true; drawDialog(); break;
          case 'apply-targets': confirmation = actions.applyCurrentTargets(); renderAll(); closeDialog(); break;
          case 'meal-detail': openMealDetail(el.dataset.meal); break;
          case 'log-meal-start': openMeal(el.dataset.meal); break;
          case 'adjust': ui.adjusting = true; ui.slot = checkedSlot('log-slot') || ui.slot; drawDialog(); dialog.querySelector('[data-quantity-index]')?.focus(); break;
          case 'log-meal': {
            let ingredients;
            if (ui.adjusting) {
              const parsed = ui.quantities.map(parseGrams);
              if (parsed.some((q) => q === null)) { dialog.querySelector('[data-grams-error]').hidden = false; break; }
              ingredients = ui.original.map((ing, i) => ({ ...ing, quantity: parsed[i] }));
            }
            const slot = requireSlot();
            if (!slot) break;
            const changed = !!ingredients && !sameRecipe(ingredients, ui.original);
            commit({ kind: 'meal', slot, mealId: ui.mealId, ingredients: changed ? ingredients : undefined, changed });
            break;
          }
          case 'food': openFood(el.dataset.food); break;
          case 'log-food': {
            const q = parseGrams(ui.text);
            if (q === null) { dialog.querySelector('[data-grams-error]').hidden = false; break; }
            const slot = requireSlot();
            if (!slot) break;
            commit({ kind: 'food', slot, foodId: ui.food.id, quantity: q });
            break;
          }
          case 'add-to-tray': {
            const q = parseGrams(ui.text);
            if (q === null) { dialog.querySelector('[data-grams-error]').hidden = false; break; }
            state.tray.push({ foodId: ui.food.id, text: String(q) });
            closeDialog();
            renderTray();
            break;
          }
          case 'tray-open': openTray(); break;
          case 'tray-remove': {
            state.tray.splice(Number(el.dataset.index), 1);
            renderTray();
            if (!state.tray.length) { state.trayName = null; pendingFocus = top.querySelector('[data-query]'); closeDialog(); break; }
            ui.rows = trayRows();
            ui.preview = trayPreview(true);
            ui.name = currentTrayName();
            ui.slot = checkedSlot('log-slot') || ui.slot;
            drawDialog();
            dialog.querySelector('[data-tray-index]')?.focus();
            break;
          }
          case 'tray-log': {
            const ingredients = trayIngredients(state.tray);
            if (!ingredients) { dialog.querySelector('[data-grams-error]').hidden = false; break; }
            const name = String(ui.name || '').trim();
            if (!name) { dialog.querySelector('[data-name-error]').hidden = false; dialog.querySelector('[data-tray-name]').focus(); break; }
            const slot = requireSlot();
            if (!slot) break;
            commit({ kind: 'tray', slot, ingredients, mealName: name, alsoSave: ui.alsoSave });
            break;
          }
          case 'create-food': {
            const values = { name: state.query.trim(), category: '', state: '', brand: '', protein: '', carbs: '', fat: '', aliases: '' };
            openDialog({ type: 'custom-food', values, touched: new Set(), validation: app.validateCustomFood(customFoodInput(values)) });
            break;
          }
          case 'cf-save': {
            ui.validation = app.validateCustomFood(customFoodInput(ui.values));
            if (!ui.validation.valid) { syncCustomFood(); break; } // Save is disabled while invalid; a guard only
            const food = actions.createCustomFood(ui.values);
            renderList();
            openFood(food.id); // §5.6: straight into the quantity sheet for the new Food
            break;
          }
          case 'view-today': showOnToday({ highlightId: confirmation.instanceId }); break;
          case 'edit-on-today': showOnToday({ openInstanceId: confirmation.instanceId }); break;
          case 'followup-name': ui.mode = 'name'; drawDialog(); dialog.querySelector('[data-new-name]').focus(); break;
          case 'followup-confirm-update': ui.mode = 'confirm-update'; drawDialog(); break;
          case 'followup-save-new': {
            const name = (ui.newName || '').trim();
            if (!name) { dialog.querySelector('[data-name-error]').hidden = false; break; }
            followNote = actions.saveAsNewSavedMeal({ name, mealType: ui.mealType, ingredients: ui.ingredients }).message;
            closeDialog();
            break;
          }
          case 'followup-update': followNote = actions.updateSavedMeal(ui.savedId, ui.ingredients).message; closeDialog(); break;
          default: break;
        }
      } catch (e) {
        showError(e);
      }
    });

    renderAll();
    return false;
  },

  unmount() {
    if (this._cleanup) { this._cleanup(); this._cleanup = null; }
  }
};
