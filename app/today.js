/*
 * today.js — the Today screen (V2_UI_CONTRACT.md §4, with the Coach of §8 and the logging
 * sheets of §5.4–5.5 that Today opens).
 *
 * Layers, so the domain stays the only place anything is calculated or decided:
 *   todayModel(app)            reads domain state for the local date
 *   render…(…)                 pure HTML from domain results (formatting only)
 *   createTodayActions(app)    thin wrappers around domain operations, returning messages
 *   todayScreen.mount(main)    DOM wiring: events, dialogs, focus
 *
 * Every number shown comes from a domain call (getDaySummary, previews, Coach `after`,
 * snapshot totals) and is only rounded for display with macros.roundMacros.
 */

import { macros, constants, addDays } from '../src/domain/index.js';
import { escapeHtml } from './shell.js';
import { session, routeParams, isIsoDate } from './session.js';
import { createViewHost, viewHead, syncInPlace } from './view-host.js';
import {
  renderPicker, pickerResults, renderCustomFoodForm, customFoodInput, renderMealDetail,
  customFoodValues, customFoodPatch, customFoodDirty, validateCustomFoodForm
} from './log.js';
import {
  foodDetailModel, renderFoodDetail, renderDeleteFood, renderDiscardFood, foodUsageMeals, renderLinkedMessage, createFoodActions
} from './foods.js';

/* ---------------- labels and formatting ---------------- */

export const SLOT_LABELS = Object.freeze({
  breakfast: 'Breakfast',
  lunch: 'Lunch',
  snack_afternoon: 'Afternoon Snack',
  dinner: 'Dinner',
  snack_night: 'Night Snack'
});

export const DAY_TYPE_LABELS = Object.freeze({ lift: 'Lift', long_run: 'Long Run', rest: 'Rest' });

const MACRO_LABELS = Object.freeze({ protein: 'Protein', carbs: 'Carbs', fat: 'Fat' });
const MACRO_LETTERS = Object.freeze({ protein: 'P', carbs: 'C', fat: 'F' });

const whole = (values) => macros.roundMacros(values, 0);
const oneDecimal = (values) => macros.roundMacros(values, 1);

/** A gram figure for display: the domain's (rounded) number, with a true minus sign. */
export function grams(value) {
  return `${String(value).replace('-', '−')} g`;
}

/** "P 42 · C 60 · F 12 g" from a rounded {protein, carbs, fat}. */
export function macroLine(values) {
  const r = whole(values);
  return `P ${String(r.protein).replace('-', '−')} · C ${String(r.carbs).replace('-', '−')} · F ${String(r.fat).replace('-', '−')} g`;
}

/** The same line for screen readers. */
function macroSpeech(values) {
  const r = whole(values);
  return macros.MACROS.map((key) => `${MACRO_LABELS[key]} ${r[key]} grams`).join(', ');
}

export function formatDate(isoDate) {
  const [y, mo, d] = isoDate.split('-').map(Number);
  return new Intl.DateTimeFormat(undefined, { weekday: 'short', day: 'numeric', month: 'short' }).format(new Date(y, mo - 1, d));
}

// English weekday names, matching the app's English copy (§4.5.1 "What kind of day is Friday?").
const WEEKDAYS = Object.freeze(['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']);

/** The weekday a local ISO date falls on, e.g. "Friday". */
export function weekdayName(isoDate) {
  const [y, mo, d] = isoDate.split('-').map(Number);
  return WEEKDAYS[new Date(y, mo - 1, d).getDay()];
}

function formatTime(isoDateTime) {
  return new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' }).format(new Date(isoDateTime));
}

/** Text typed into a grams field → a number, or null if it isn't a usable weight. */
export function parseGrams(text) {
  const t = String(text == null ? '' : text).trim().replace(',', '.');
  if (!t) return null;
  const n = Number(t);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/* ---------------- model ---------------- */

/** Everything Today shows, read from the domain for one date (default: the local date). */
export function todayModel(app, date = app.getToday()) {
  const today = app.getToday();
  const summary = app.getDaySummary(date);
  const day = summary.exists ? app.getDay(date) : null;
  // §12 / I-49: first run is "no stored data" — nothing has ever been saved on this device (the
  // data layer reports no save yet, and none is pending or failing). The first save (choosing
  // the day type, or anything else) ends it for good; nothing extra is stored to remember it.
  const status = app.getPersistenceStatus();
  const firstRun = date === today && !summary.exists && !!status && status.state === 'saved' && !status.lastSavedAt;
  const bySlot = {};
  for (const slot of constants.MEAL_SLOTS) bySlot[slot] = day ? day.mealInstances.filter((mi) => mi.mealSlot === slot) : [];
  const sourceOf = {};
  for (const mi of day ? day.mealInstances : []) {
    const meal = mi.sourceMealId ? app.getMeal(mi.sourceMealId) : null;
    sourceOf[mi.id] = mi.sourceMealId ? (meal ? meal.source : 'deleted') : null;
  }
  return {
    date,
    isToday: date === today,
    isFuture: date > today, // I-04: viewable, empty, never created or logged into
    firstRun,
    prevDate: addDays(date, -1),
    nextDate: addDays(date, 1),
    summary,
    day,
    bySlot,
    sourceOf,
    currentTargets: app.getAllCurrentTargets()
  };
}

/**
 * The slot a new meal defaults to: the first empty slot after the most recently logged one
 * (§8.4). A default only — the user can pick any slot, and it never changes any number.
 */
export function defaultSlot(day) {
  const slots = constants.MEAL_SLOTS;
  const instances = day ? day.mealInstances : [];
  if (!instances.length) return slots[0];
  const latest = instances.reduce((a, b) => (b.loggedAt > a.loggedAt ? b : a));
  const used = new Set(instances.map((mi) => mi.mealSlot));
  for (let k = slots.indexOf(latest.mealSlot); k < slots.length; k++) if (!used.has(slots[k])) return slots[k];
  return latest.mealSlot;
}

/** The date Today shows for a route: a real ?date= (past, today or future, I-03/I-04), else today. */
export function todayViewDate(app, hash) {
  const requested = routeParams(hash).get('date');
  return requested && isIsoDate(requested) ? requested : app.getToday();
}

/** The route for a day on Today: plain #/today for the local date (so it follows midnight, §4.5.6). */
export const dayHref = (date, today) => (date === today ? '#/today' : `#/today?date=${date}`);

/** §4.4.2 / I-12 wording, shown once per day the first time a Done day is edited. */
export const DONE_EDIT_NOTE = 'This day is marked done. Changes are saved and it stays done.';

/**
 * Whether an add, edit, move or delete on `date` should show the Done-day note: only while the
 * day is (still) Done, and only the first time per day this session. Records it when it does.
 * Marking a day done is not an edit, and nothing here changes any data.
 */
export function claimDoneEditNote(state, date, summary) {
  if (!summary || summary.status !== 'complete' || state.doneNotes.includes(date)) return false;
  state.doneNotes.push(date);
  return true;
}

/**
 * Surfaces presented as views (pushed · panel · pane, §2.3): the logged meal, its editor and
 * Food picker, and the Meal and Food detail the Coach and a logged meal's source line open.
 * Everything else is a short sheet on compact and medium screens; on wide screens it opens in
 * the right-hand pane — the Coach included (§8.2), so the macro panel stays visible.
 */
export const TODAY_VIEW_TYPES = Object.freeze(['instance', 'edit', 'picker', 'custom-food', 'meal-detail', 'food-detail']);
/** Day-level sheets opened from Today itself (day type, day menu, clear day): modal sheets at every width. */
export const TODAY_SHEET_TYPES = Object.freeze(['day-type', 'day-menu', 'clear-day']);

/**
 * "Left today: P 42 g · C target reached · F 12 g." from getDaySummary, for the announcement
 * after logging (§5.8). Rounded domain values only.
 */
export function remainingSummary(summary, { isToday, date }) {
  if (!summary || !summary.exists) return '';
  const r = whole(summary.remaining);
  const parts = macros.MACROS.map((key) => `${MACRO_LETTERS[key]} ${summary.reached[key] ? 'target reached' : grams(r[key])}`);
  return `${isToday ? 'Left today' : `Left on ${formatDate(date)}`}: ${parts.join(' · ')}.`;
}

/* ---------------- screen rendering ---------------- */

function renderMacroPanel(summary) {
  const target = whole(summary.target);
  const remaining = whole(summary.remaining);
  const overBy = whole(summary.overBy);
  const logged = summary.logged ? whole(summary.logged) : null;
  const items = macros.MACROS.map((key) => {
    // §4.2 / I-07: short of target → "{remaining} g left"; reached → "Target reached" with
    // "+{overBy} g" as secondary text. Both values come from getDaySummary; neutral styling.
    const reached = summary.reached[key];
    const headline = reached
      ? '<p class="macro-remaining"><span class="macro-number is-reached">Target reached</span></p>'
      : `<p class="macro-remaining"><span class="macro-number">${grams(remaining[key])}</span> <span class="macro-caption">left</span></p>`;
    const ofLine = logged ? `${logged[key]} of ${target[key]} g logged` : 'Nothing logged yet';
    const over = reached ? `<p class="macro-over" data-over-by>+${overBy[key]} g</p>` : '';
    const standing = reached ? `target reached, ${overBy[key]} grams past` : `${remaining[key]} grams left of ${target[key]}`;
    const speech = `${MACRO_LABELS[key]}: ${standing}. ${logged ? `${logged[key]} of ${target[key]} grams logged` : 'Nothing logged yet'}.`;
    return `<li class="macro" data-macro="${key}">
<p class="visually-hidden">${escapeHtml(speech)}</p>
<div aria-hidden="true">
<p class="macro-name"><span class="macro-mark">${MACRO_LETTERS[key]}</span>${MACRO_LABELS[key]}</p>
${headline}
${over}
<p class="macro-of">${ofLine}</p>
<span class="macro-bar"><span class="macro-fill" style="--fill: ${summary.progress[key]}"></span></span>
</div>
</li>`;
  }).join('\n');
  return `<section class="macro-panel" aria-labelledby="macro-heading">
<h2 id="macro-heading" class="visually-hidden">What's left today</h2>
<ul class="macros">
${items}
</ul>
</section>`;
}

/**
 * §4.1 / §4.4.1. Slot coverage is information only ("3 of 5 slots"): the day's state comes
 * from summary.status alone, and completion only from Done Logging. The slot note on the
 * same screen says no slot is required.
 */
export function statusLine(summary) {
  if (summary.status === 'complete') return 'Done logging <span aria-hidden="true">✓</span>';
  if (summary.status === 'no_data') return 'Nothing logged yet';
  return `${summary.instanceCount} ${summary.instanceCount === 1 ? 'meal' : 'meals'} logged · ${summary.loggedSlots.length} of ${constants.MEAL_SLOTS.length} slots`;
}

function renderActionBar(summary) {
  const done = summary.status === 'complete';
  const nothing = summary.instanceCount === 0;
  const coach = done
    ? '<button type="button" class="link-button" data-action="coach">Still eating? Build my next meal</button>'
    : '<button type="button" class="button primary" data-action="coach">Build My Next Meal</button>';
  const doneButton = done
    ? '<button type="button" class="button" data-action="reopen">Reopen day</button>'
    : `<button type="button" class="button" data-action="done"${nothing ? ' disabled aria-describedby="done-hint"' : ''}>Done Logging</button>${nothing ? '<span id="done-hint" class="hint">Log something first</span>' : ''}`;
  return `<div class="action-bar">
${coach}
<button type="button" class="button" data-action="add">Add</button>
${doneButton}
</div>`;
}

function sourceMarker(source) {
  if (source === 'saved') return '<span class="marker">Saved</span>';
  if (source === 'library') return '<span class="marker">Library</span>';
  return '';
}

function renderSlots(model, { enabled, addable = true }) {
  const slots = constants.MEAL_SLOTS.map((slot) => {
    const rows = model.bySlot[slot];
    const list = rows.length
      ? `<ul class="meal-rows">${rows.map((mi) => `<li><button type="button" class="meal-row" data-action="open-instance" data-id="${escapeHtml(mi.id)}" aria-label="${escapeHtml(`${mi.mealName}, ${SLOT_LABELS[slot]}, ${macroSpeech(mi.totals)}`)}">
<span class="meal-name">${escapeHtml(mi.mealName)}</span>${sourceMarker(model.sourceOf[mi.id])}
<span class="meal-macros">${macroLine(mi.totals)}</span>
</button></li>`).join('\n')}</ul>`
      : '<p class="slot-empty">Not logged</p>';
    return `<section class="slot" aria-labelledby="slot-${slot}">
<div class="slot-head">
<h3 id="slot-${slot}" class="slot-name">${SLOT_LABELS[slot]}</h3>
${addable ? `<button type="button" class="icon-button" data-action="add" data-slot="${slot}" aria-label="Add to ${SLOT_LABELS[slot]}"${enabled ? '' : ' data-needs-day="true"'}><svg class="icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M12 5v14M5 12h14"/></svg></button>` : ''}
</div>
${list}
</section>`;
  }).join('\n');
  return `<section class="slots" aria-labelledby="slots-heading">
<h2 id="slots-heading" class="section-title">Meals</h2>
<p class="slots-note">Slots are just where you log food. An empty slot means nothing's logged there, not that you ate nothing. No slot is required, including Night Snack.</p>
${slots}
</section>`;
}

/** §12 step 2: the one-time welcome card (first run only; its wording is the contract's). */
export const WELCOME_TEXT = 'Log what you eat against three daily targets: protein, carbs and fat. Start with a meal from the Library or search for a food.';
function renderWelcome() {
  return `<section class="welcome-card" aria-label="Welcome" data-welcome>
<p>${WELCOME_TEXT}</p>
</section>`;
}

function renderChooser(model) {
  const options = constants.DAY_TYPES.map((type) => `<li><button type="button" class="day-type-option" data-action="choose-day-type" data-type="${type}">
<span class="day-type-name">${DAY_TYPE_LABELS[type]}</span>
<span class="day-type-targets">${macroLine(model.currentTargets[type])}</span>
</button></li>`).join('\n');
  return `<section class="chooser" aria-labelledby="chooser-heading">
<h2 id="chooser-heading" class="section-title">What kind of day is ${weekdayName(model.date)}?</h2>
<p class="chooser-note">Your targets for ${model.isToday ? 'today' : 'this day'} come from the day type you choose.</p>
<ul class="day-type-options">
${options}
</ul>
</section>`;
}

/** ◀ ▶ (§4.1, I-03): the previous and next calendar day. Future days can be viewed, never logged (I-04). */
function renderDateNav(model) {
  return `<div class="date-nav" role="group" aria-label="Change day">
<button type="button" class="icon-button" data-action="prev-day" aria-label="Previous day, ${escapeHtml(formatDate(model.prevDate))}"><svg class="icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M15 5l-7 7 7 7"/></svg></button>
<button type="button" class="icon-button" data-action="next-day" aria-label="Next day, ${escapeHtml(formatDate(model.nextDate))}"><svg class="icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M9 5l7 7-7 7"/></svg></button>
</div>`;
}

/** The Today screen body for a model. doneNote: show the one-time Done-day note (§4.4.2). */
export function renderToday(model, { doneNote = false } = {}) {
  const { summary } = model;
  const type = summary.exists ? DAY_TYPE_LABELS[summary.dayType] : null;
  // §4.1 header: "Today · {date}" for today; another day shows its date and a way back to today.
  const head = `<div class="today-head">
<h1 id="screen-title" class="screen-title" tabindex="-1">${model.isToday ? 'Today' : escapeHtml(formatDate(model.date))}</h1>
${renderDateNav(model)}
<p class="today-date">${model.isToday ? escapeHtml(formatDate(model.date)) : model.isFuture ? 'Future day' : 'Past day'}${summary.status === 'complete' ? ' <span class="badge">Done</span>' : ''}</p>
${model.isToday ? '' : '<a class="chip" href="#/today" aria-label="Go to today">Today</a>'}
${type ? `<button type="button" class="chip" data-action="day-type" aria-label="Day type: ${type}. Change day type">${type}</button>` : ''}
${summary.exists ? '<button type="button" class="icon-button day-menu" data-action="day-menu" aria-haspopup="dialog" aria-label="More actions for this day"><svg class="icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><circle cx="5" cy="12" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="19" cy="12" r="1.6"/></svg></button>' : ''}
</div>`;
  if (model.isFuture) {
    // I-04: viewable and empty; no chooser, no add actions, nothing is created by looking.
    return `${head}
<p class="note future-note">You can log this day when it arrives.</p>
${renderSlots(model, { enabled: false, addable: false })}`;
  }
  if (!summary.exists) {
    return `${head}
${model.firstRun ? renderWelcome() : ''}
${renderChooser(model)}
${renderSlots(model, { enabled: false })}`;
  }
  return `${head}
${renderMacroPanel(summary)}
<p class="day-status" data-day-status>${statusLine(summary)}</p>
${doneNote && summary.status === 'complete' ? `<p class="note done-note" data-done-note>${DONE_EDIT_NOTE}</p>` : ''}
${renderActionBar(summary)}
${renderSlots(model, { enabled: true })}`;
}

/* ---------------- dialog rendering ---------------- */

export function slotRadios(name, selected) {
  return `<fieldset class="slot-choice">
<legend>Slot</legend>
${constants.MEAL_SLOTS.map((slot) => `<label class="radio-chip"><input type="radio" name="${name}" value="${slot}"${slot === selected ? ' checked' : ''}><span>${SLOT_LABELS[slot]}</span></label>`).join('\n')}
</fieldset>`;
}

/** "After this: P a · C b · F c left" (or target reached) from a domain standing. */
export function afterLine(standing) {
  if (!standing) return '';
  const r = whole(standing.remaining);
  const parts = macros.MACROS.map((key) => `${MACRO_LETTERS[key]} ${standing.reached[key] ? 'target reached' : `${String(r[key]).replace('-', '−')} g left`}`);
  return `After this: ${parts.join(' · ')}`;
}

export const dialogHead = (title, subtitle = '') => `<header class="sheet-head">
<h2 id="sheet-title" class="sheet-title">${escapeHtml(title)}</h2>
${subtitle ? `<p class="sheet-subtitle">${escapeHtml(subtitle)}</p>` : ''}
<button type="button" class="icon-button" data-action="close" aria-label="Close"><svg class="icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M6 6l12 12M18 6 6 18"/></svg></button>
</header>`;

export const errorSlot = '<p class="sheet-error" role="alert" data-error hidden></p>';

/** Day type: first choice, or a change with its preview (§4.5). */
export function renderDayTypeDialog({ model, selected, preview, applyPreview, confirmingApply, continueTo }) {
  const current = model.summary.exists ? model.summary.dayType : null;
  if (confirmingApply && applyPreview) {
    return `${dialogHead('Use current targets for today?')}
<p>${DAY_TYPE_LABELS[applyPreview.dayType]} targets for today become ${macroLine(applyPreview.to)} (now ${macroLine(applyPreview.from)}).</p>
<p>Logged food, today's day type and other days don't change.</p>
${errorSlot}
<div class="sheet-actions"><button type="button" class="button primary" data-action="apply-targets">Use for today</button><button type="button" class="button" data-action="close">Cancel</button></div>`;
  }
  const options = constants.DAY_TYPES.map((type) => `<label class="radio-row"><input type="radio" name="day-type" value="${type}"${type === (selected || current) ? ' checked' : ''}>
<span class="radio-text"><span class="day-type-name">${DAY_TYPE_LABELS[type]}${type === current ? ' <span class="marker">Current</span>' : ''}</span>
<span class="day-type-targets">${macroLine(model.currentTargets[type])}</span></span></label>`).join('\n');
  let detail = '';
  if (current && preview && !preview.noOp) {
    const note = preview.to.targetSource === 'restored'
      ? `Uses the ${DAY_TYPE_LABELS[preview.to.dayType]} targets this day had before.`
      : `Uses your current ${DAY_TYPE_LABELS[preview.to.dayType]} targets.${model.isToday === false ? ` Targets from ${formatDate(model.date)} aren't on record for ${DAY_TYPE_LABELS[preview.to.dayType]}.` : ''}`;
    detail = `<div class="preview" aria-live="polite">
<p>Targets: ${macroLine(preview.from.target)} → ${macroLine(preview.to.target)}</p>
<p>${note} Logged food stays exactly the same.</p>
</div>`;
  }
  const applyLine = current && applyPreview && applyPreview.applies
    ? `<p class="apply-note">Your ${DAY_TYPE_LABELS[current]} targets have changed since today was set up. <button type="button" class="link-button" data-action="confirm-apply-targets">Use current targets for today</button></p>`
    : '';
  const primary = current
    ? `<button type="button" class="button primary" data-action="change-day-type"${!selected || selected === current ? ' disabled' : ''}>${selected && selected !== current ? `Change to ${DAY_TYPE_LABELS[selected]}` : 'Change day type'}</button>`
    : '<button type="button" class="button primary" data-action="choose-day-type-confirm"' + (selected ? '' : ' disabled') + '>Set day type</button>';
  // §4.5.2: a past day's sheet always shows its date, so a correction is obviously a past-day one.
  const pastDate = model.isToday === false && model.date ? ` · ${formatDate(model.date)}` : '';
  return `${dialogHead(current ? `Day type${pastDate}` : `What kind of day is ${weekdayName(model.date)}?`, current ? 'Changing it never changes your logged food.' : (continueTo ? 'Choose a day type first, then add your meal.' : ''))}
<fieldset class="day-type-choice"><legend class="visually-hidden">Day type</legend>
${options}
</fieldset>
${detail}
${applyLine}
${errorSlot}
<div class="sheet-actions">${primary}<button type="button" class="button" data-action="close">Cancel</button></div>`;
}

/** Log a meal: totals, what's left after, slot, and "adjust grams for this time" (§5.4). */
export function renderMealConfirmDialog({ preview, slot, adjusting, quantities, foods }) {
  const title = preview.mealName || 'Log meal';
  const body = adjusting
    ? `<fieldset class="adjust"><legend>Grams for this time</legend>
${preview.ingredients.map((ing, i) => `<div class="adjust-row"><label for="adj-${i}">${escapeHtml(ing.foodName || ing.foodId)} <span class="state-chip">${escapeHtml(foods[ing.foodId] ? foods[ing.foodId].state : '')}</span></label>
<span class="grams-input"><input id="adj-${i}" type="text" inputmode="decimal" autocomplete="off" data-quantity-index="${i}" value="${escapeHtml(quantities[i])}"><span aria-hidden="true">g</span></span></div>`).join('\n')}
<p class="field-error" data-grams-error hidden>Enter a weight above 0 g</p>
</fieldset>`
    : '';
  return `${dialogHead(title, 'Logging this doesn\'t change the saved or Library meal.')}
<div class="preview" data-preview aria-live="polite">${renderMealPreview(preview)}</div>
${body}
${slotRadios('log-slot', slot)}
${errorSlot}
<div class="sheet-actions">
<button type="button" class="button primary" data-action="log-meal"${preview.valid ? '' : ' disabled'}>Log</button>
${adjusting ? '' : '<button type="button" class="button" data-action="adjust">Adjust grams for this time</button>'}
<button type="button" class="button" data-action="close">Cancel</button>
</div>`;
}

export function renderMealPreview(preview) {
  if (!preview.valid) return '<p>Some ingredients can\'t be calculated, so this can\'t be logged.</p>';
  return `<p class="preview-totals">${macroLine(preview.totals)}</p>
${preview.day && preview.day.after ? `<p class="preview-after">${afterLine(preview.day.after)}</p>` : ''}`;
}

/** Log a single Food by weight (Coach top-up, §5.5). Grams only; state shown, never converted. */
export function renderQuantityDialog({ food, slot, text, preview }) {
  return `${dialogHead(food.name)}
<p><span class="state-chip">${escapeHtml(food.state)}</span> Weigh it ${escapeHtml(food.state)}.</p>
<label class="field" for="qty-grams">Grams</label>
<span class="grams-input"><input id="qty-grams" type="text" inputmode="decimal" autocomplete="off" data-grams value="${escapeHtml(text || '')}" placeholder="grams"><span aria-hidden="true">g</span></span>
<p class="field-error" data-grams-error hidden>Enter a weight above 0 g</p>
<div class="preview" data-preview aria-live="polite">${preview ? renderMealPreview(preview) : '<p class="hint">Enter a weight to see what it adds.</p>'}</div>
${slotRadios('log-slot', slot)}
${errorSlot}
<div class="sheet-actions">
<button type="button" class="button primary" data-action="log-food"${preview && preview.valid ? '' : ' disabled'}>Log</button>
<button type="button" class="button" data-action="close">Cancel</button>
</div>`;
}

/** A logged meal as the historical record it is (§4.3.3). */
export function renderInstanceDialog({ instance, slot, date, source, sourceName }) {
  const rows = instance.ingredients.map((ing) => {
    const r = oneDecimal(ing);
    return `<tr><th scope="row">${escapeHtml(ing.foodName)}</th><td>${ing.quantity} g</td><td>${r.protein}</td><td>${r.carbs}</td><td>${r.fat}</td></tr>`;
  }).join('\n');
  const t = whole(instance.totals);
  // §13.2 / §2.2: the source line opens the current recipe (read-only Meal detail) while that
  // meal exists; a deleted source is plain text. The logged meal itself never changes.
  const sourceLink = (label) => `<button type="button" class="link-button" data-action="source-meal" data-meal="${escapeHtml(instance.sourceMealId)}" aria-label="${escapeHtml(`${label} ${sourceName}: open the current recipe`)}">“${escapeHtml(sourceName)}”</button>`;
  const sourceText = source === 'saved' ? `From Saved Meal ${sourceLink('Saved Meal')}`
    : source === 'library' ? `From Library Meal ${sourceLink('Library Meal')}`
      : source === 'deleted' ? 'From a meal that’s since been deleted' : '';
  return `${viewHead(instance.mealName, `${SLOT_LABELS[slot]} · ${formatDate(date)} · Logged at ${formatTime(instance.loggedAt)}`)}
${sourceText ? `<p class="source-line">${sourceText}</p>` : ''}
<div class="table-wrap"><table class="ingredients">
<caption class="visually-hidden">Ingredients as logged</caption>
<thead><tr><th scope="col">Food</th><th scope="col">Grams</th><th scope="col"><abbr title="Protein">P</abbr></th><th scope="col"><abbr title="Carbs">C</abbr></th><th scope="col"><abbr title="Fat">F</abbr></th></tr></thead>
<tbody>${rows}</tbody>
<tfoot><tr><th scope="row">Total</th><td></td><td>${t.protein}</td><td>${t.carbs}</td><td>${t.fat}</td></tr></tfoot>
</table></div>
<p class="note">This is a record of what you logged. Later changes to foods or saved meals don't change it.</p>
${errorSlot}
<div class="sheet-actions">
<button type="button" class="button primary" data-action="edit-instance">Edit this logged meal</button>
<button type="button" class="button" data-action="move-instance">Move to another slot</button>
<button type="button" class="button danger" data-action="delete-instance">Delete</button>
</div>
${source === 'saved' && instance.sourceMealId ? `<p class="edit-source">Want to change the recipe for next time? <a class="link-button" href="#/meals?meal=${encodeURIComponent(instance.sourceMealId)}&edit=1" data-action="edit-saved-meal" data-meal="${escapeHtml(instance.sourceMealId)}">Edit Saved Meal “${escapeHtml(sourceName)}”</a></p>` : ''}`;
}

/**
 * Edit one logged meal: name, slot, grams, remove, add an ingredient (§4.3.4). The Saved Meal
 * is untouched. An added ingredient shows its Food's state chip (A-16); grams only.
 */
export function renderEditDialog({ instance, date, name, slot, rows, preview }) {
  const single = rows.length === 1;
  return `${viewHead('Edit logged meal', `${SLOT_LABELS[instance.mealSlot]} · ${formatDate(date)}`)}
<p class="note">You're editing the record for ${escapeHtml(formatDate(date))}. Your saved meal won't change.</p>
<label class="field" for="edit-name">Name</label>
<input id="edit-name" type="text" data-edit-name value="${escapeHtml(name)}" autocomplete="off">
<p class="field-error" data-name-error hidden>Give it a name</p>
${slotRadios('edit-slot', slot)}
<fieldset class="adjust"><legend>Ingredients</legend>
${rows.map((row, i) => `<div class="adjust-row"><label for="edit-q-${i}">${escapeHtml(row.foodName)}${row.state ? ` <span class="state-chip">${escapeHtml(row.state)}</span>` : ''}</label>
<span class="grams-input"><input id="edit-q-${i}" type="text" inputmode="decimal" autocomplete="off" data-quantity-index="${i}" value="${escapeHtml(row.text)}"><span aria-hidden="true">g</span></span>
${single ? '' : `<button type="button" class="link-button" data-action="remove-ingredient" data-index="${i}" aria-label="Remove ${escapeHtml(row.foodName)}">Remove</button>`}</div>`).join('\n')}
${single ? '<p class="hint">A logged meal needs at least one ingredient. <button type="button" class="link-button" data-action="delete-instance">Delete this logged meal instead</button></p>' : ''}
<p class="field-error" data-grams-error hidden>Enter a weight above 0 g</p>
<button type="button" class="button add-ingredient" data-action="add-ingredient">Add an ingredient</button>
</fieldset>
<div class="preview" data-preview aria-live="polite">${preview ? `<p class="preview-totals">${macroLine(preview.instance.totals)}</p><p class="preview-after">${afterLine(preview.after)}</p>` : ''}</div>
${errorSlot}
<div class="sheet-actions"><button type="button" class="button primary" data-action="save-instance">Save</button><button type="button" class="button" data-action="close">Cancel</button></div>`;
}

/**
 * The editor's fields as they stand (name, slot, each row's Food and grams text), for
 * "Discard changes?" (§3.2). Compared with the same key taken when the editor opened.
 */
export const editKey = ({ name, slot, rows }) => JSON.stringify([String(name || '').trim(), slot, rows.map((r) => [r.foodId, String(r.text || '').trim()])]);
/** Whether the logged-meal editor differs from what it opened with. */
export const editDirty = (edit) => !!edit && typeof edit.original === 'string' && editKey(edit) !== edit.original;

/** Leaving the logged-meal editor with unsaved edits (§3.2, I-01): Keep editing / Discard. */
export function renderDiscardEdit() {
  return `${dialogHead('Discard changes?')}
<p>Your changes to this logged meal haven’t been saved. Discard keeps it as it was.</p>
<div class="sheet-actions"><button type="button" class="button primary" data-action="keep-editing" data-autofocus>Keep editing</button><button type="button" class="button danger" data-action="discard">Discard</button></div>`;
}

export function renderMoveDialog({ instance, slot }) {
  return `${dialogHead(`Move ${instance.mealName}`)}
${slotRadios('move-slot', slot)}
<p class="note">Moving it doesn't change any numbers.</p>
${errorSlot}
<div class="sheet-actions"><button type="button" class="button primary" data-action="save-move">Move</button><button type="button" class="button" data-action="close">Cancel</button></div>`;
}

export function renderDeleteDialog({ instance, date }) {
  return `${dialogHead('Delete logged meal?')}
<p>Delete “${escapeHtml(instance.mealName)}” from ${SLOT_LABELS[instance.mealSlot]} on ${escapeHtml(formatDate(date))}? Saved and Library meals aren't affected.</p>
${errorSlot}
<div class="sheet-actions"><button type="button" class="button" data-action="close" data-autofocus>Cancel</button><button type="button" class="button danger" data-action="confirm-delete">Delete logged meal</button></div>`;
}

/** Day header overflow (§4.6): the day-level actions. */
export function renderDayMenuDialog() {
  return `${dialogHead('This day')}
<div class="sheet-actions stacked">
<button type="button" class="button danger" data-action="clear-day">Clear this day</button>
<button type="button" class="button" data-action="close" data-autofocus>Cancel</button>
</div>`;
}

/** Clear a Day (§4.6) → deleteDay(date). Destructive, so Cancel takes focus. */
export function renderClearDayDialog({ date, instanceCount }) {
  const what = instanceCount === 0 ? 'its day type'
    : instanceCount === 1 ? 'its day type and its 1 logged meal'
      : `its day type and all ${instanceCount} logged meals`;
  return `${dialogHead(`Clear ${formatDate(date)}?`)}
<p>This deletes ${what}. Other days aren't affected.</p>
${errorSlot}
<div class="sheet-actions"><button type="button" class="button" data-action="close" data-autofocus>Cancel</button><button type="button" class="button danger" data-action="confirm-clear-day">Clear day</button></div>`;
}

/** After changing grams of a meal from a Saved Meal (§4.3.4, A-14). */
export function renderFollowUpDialog({ savedName, mode, newName, library = false }) {
  if (mode === 'name') {
    return `${dialogHead('Save as a new saved meal')}
<label class="field" for="new-meal-name">Name</label>
<input id="new-meal-name" type="text" data-new-name value="${escapeHtml(newName)}" autocomplete="off">
<p class="field-error" data-name-error hidden>Give it a name</p>
${errorSlot}
<div class="sheet-actions"><button type="button" class="button primary" data-action="followup-save-new">Save</button><button type="button" class="button" data-action="close">Cancel</button></div>`;
  }
  if (mode === 'confirm-update') {
    return `${dialogHead(`Update “${savedName}”?`)}
<p>This changes the recipe for next time. Meals you've already logged, including this one, stay as they are.</p>
${errorSlot}
<div class="sheet-actions"><button type="button" class="button primary" data-action="followup-update">Update saved meal</button><button type="button" class="button" data-action="close">Cancel</button></div>`;
  }
  return `${dialogHead('Keep this change just for today?', 'Your logged meal is saved.')}
<div class="sheet-actions stacked">
<button type="button" class="button primary" data-action="close" data-autofocus>Just this time</button>
<button type="button" class="button" data-action="followup-name">Save as a new saved meal</button>
${library ? '' : `<button type="button" class="button" data-action="followup-confirm-update">Also update “${escapeHtml(savedName)}”</button>`}
</div>`;
}

/* ---------------- Coach ---------------- */

const TIER_HEADINGS = Object.freeze({
  favoriteSaved: 'Your favourites',
  recent: 'Logged recently',
  saved: 'Your saved meals',
  library: 'Starter meals from the Library'
});

/** How many items a group shows before "Show all" (§8.3). */
export function coachVisibleCount(tier, suggestions) {
  if (tier === 'library' && suggestions.insufficientHistory) return 5;
  if (tier === 'topUp') return 5;
  return 3;
}

/** The Coach sheet, from getMacroCoachSuggestions as returned (order untouched). */
export function renderCoachDialog({ suggestions, expanded = {}, note = null }) {
  const r = whole(suggestions.remaining);
  const allReached = macros.MACROS.every((key) => suggestions.reached[key]);
  const left = macros.MACROS.map((key) => `${MACRO_LETTERS[key]} ${suggestions.reached[key] ? 'target reached' : grams(r[key])}`).join(' · ');
  const groups = suggestions.tiers.filter((t) => t.items.length).map((t) => {
    const limit = expanded[t.tier] ? t.items.length : coachVisibleCount(t.tier, suggestions);
    const items = t.items.slice(0, limit).map((item) => `<li class="option-row">
<button type="button" class="option-main" data-action="coach-meal-detail" data-meal="${escapeHtml(item.mealId)}" aria-label="${escapeHtml(item.name)}: details"><span class="meal-name">${escapeHtml(item.name)}</span>${item.source === 'library' ? '<span class="marker">Library</span>' : ''}${item.isFavorite ? '<span class="marker" aria-label="Favourite">★</span>' : ''}
<span class="meal-macros">${macroLine(item.totals)}</span>
<span class="preview-after">${afterLine(item.after)}</span></button>
<button type="button" class="button" data-action="coach-log-meal" data-meal="${escapeHtml(item.mealId)}" aria-label="Log ${escapeHtml(item.name)}">Log</button>
</li>`).join('\n');
    const more = t.items.length > limit ? `<button type="button" class="link-button" data-action="coach-more" data-tier="${t.tier}">Show all ${t.items.length}</button>` : '';
    return `<section class="option-group" aria-labelledby="coach-${t.tier}"><h3 id="coach-${t.tier}" class="group-title">${TIER_HEADINGS[t.tier]}</h3><ul class="options">${items}</ul>${more}</section>`;
  }).join('\n');
  const foods = [...suggestions.topUpFoods.personalized.map((x) => ({ ...x, why: x.reasons.includes('favorite') ? 'Favourite' : 'Recent' })), ...suggestions.topUpFoods.starter.map((x) => ({ ...x, why: 'Common in Library meals' }))];
  const foodLimit = expanded.topUp ? foods.length : coachVisibleCount('topUp', suggestions);
  const foodGroup = foods.length ? `<section class="option-group" aria-labelledby="coach-topup"><h3 id="coach-topup" class="group-title">Top up with a food</h3><ul class="options">
${foods.slice(0, foodLimit).map((x) => `<li class="option-row"><button type="button" class="option-main" data-action="coach-food-detail" data-food="${escapeHtml(x.food.id)}" aria-label="${escapeHtml(`${x.food.name}, ${x.food.state}: details`)}"><span class="meal-name">${escapeHtml(x.food.name)}</span><span class="state-chip">${escapeHtml(x.food.state)}</span><span class="marker">${x.why}</span>
<span class="meal-macros">${macroLine(x.food.nutrition)} per 100 g</span></button>
<button type="button" class="button" data-action="coach-log-food" data-food="${escapeHtml(x.food.id)}" aria-label="Log ${escapeHtml(x.food.name)} by weight">Log</button></li>`).join('\n')}
</ul>${foods.length > foodLimit ? '<button type="button" class="link-button" data-action="coach-more" data-tier="topUp">Show all ' + foods.length + '</button>' : ''}</section>` : '';
  // §8.6: the empty state offers its two ways on — Log's food search, and Meals.
  const nothing = !groups && !foodGroup
    ? `<p class="empty-note">Nothing to suggest right now. Suggestions come from your saved and recently logged meals.</p>
<div class="sheet-actions"><button type="button" class="button" data-action="coach-add-food">Add food</button><button type="button" class="button" data-action="coach-browse-meals">Browse meals</button></div>`
    : '';
  // §8.3 item 6: "{n} saved meal(s) need a fix" → Meals, filtered to those meals.
  const n = suggestions.excluded.needsReplacement.length;
  const fix = n
    ? `<p class="note coach-fix"><button type="button" class="link-button" data-action="coach-fix">${n} saved ${n === 1 ? 'meal needs' : 'meals need'} a fix</button> ${n === 1 ? 'It isn’t' : 'They aren’t'} suggested until ${n === 1 ? 'it’s' : 'they’re'} fixed.</p>`
    : '';
  return `${dialogHead('Build my next meal', `${DAY_TYPE_LABELS[suggestions.dayType]} · Left today: ${left}`)}
${note ? `<div class="foods-message" role="status">${renderLinkedMessage(note)}</div>` : ''}
${allReached ? '<p class="note">You\'ve reached today\'s targets.</p>' : ''}
${suggestions.insufficientHistory ? '<p class="note">Not enough history yet for personal suggestions. These are starter meals from the Library. Log or save meals and this list becomes yours.</p>' : ''}
${groups}
${foodGroup}
${nothing}
${fix}`;
}

/* ---------------- actions (domain calls only) ---------------- */

const errorMessage = (e) => {
  switch (e && e.code) {
    case 'INVALID_QUANTITY':
    case 'UNSUPPORTED_UNIT': return 'Enter a weight above 0 g.';
    case 'MEAL_NEEDS_REPLACEMENT':
    case 'MEAL_INVALID': return "This meal uses a food that's been deleted, so it can't be logged until it's fixed.";
    case 'FOOD_NOT_FOUND': return 'That food no longer exists.';
    case 'MEAL_NOT_FOUND': return 'That meal no longer exists.';
    case 'MEAL_INSTANCE_NOT_FOUND': return 'That logged meal no longer exists.';
    case 'INVALID_MEAL_INSTANCE':
    case 'INVALID_MEAL': return 'Give it a name and at least one ingredient.';
    case 'NOTHING_LOGGED': return 'Log something first.';
    default: return "That didn't save. Nothing was changed.";
  }
};
export { errorMessage };

/** Instance ingredients as a patch/recipe ingredient list. */
export const recipeOf = (ingredients) => ingredients.map((i) => ({ foodId: i.foodId, quantity: i.quantity, unit: i.unit || 'g' }));

/** Today's actions for the date it shows (getDate; default the local date). */
export function createTodayActions(app, getDate = () => app.getToday()) {
  const date = getDate;
  const dayWord = () => (date() === app.getToday() ? 'today' : formatDate(date()));
  return {
    chooseDayType(type) {
      app.createDay(date(), type);
      return { message: `${date() === app.getToday() ? 'Today' : formatDate(date())} is a ${DAY_TYPE_LABELS[type]} day.` };
    },
    changeDayType(type) {
      const preview = app.previewDayTypeChange(date(), type);
      if (preview.noOp) return { noOp: true, message: '' };
      app.updateDayType(date(), type);
      return { message: `Changed to ${DAY_TYPE_LABELS[type]}. Your logged food didn't change.` };
    },
    applyCurrentTargets() {
      app.applyCurrentTargetsToToday();
      return { message: "Today now uses your current targets. Logged food didn't change." };
    },
    logMeal({ mealId, mealSlot, ingredients }) {
      const instance = app.createMealInstance({ date: date(), mealSlot, mealId, ...(ingredients ? { ingredients } : {}) });
      return { instance, message: `Logged ${instance.mealName} to ${SLOT_LABELS[mealSlot]}.` };
    },
    logFood({ foodId, quantity, mealSlot }) {
      const instance = app.logFood({ date: date(), mealSlot, foodId, quantity });
      return { instance, message: `Logged ${instance.mealName} to ${SLOT_LABELS[mealSlot]}.` };
    },
    updateInstance(id, patch) {
      const instance = app.updateMealInstance(date(), id, patch);
      return { instance, message: 'Logged meal updated.' };
    },
    moveInstance(id, mealSlot) {
      const instance = app.updateMealInstance(date(), id, { mealSlot });
      return { instance, message: `Moved to ${SLOT_LABELS[mealSlot]}.` };
    },
    deleteInstance(id) {
      const wasDone = app.getDaySummary(date()).loggingComplete;
      app.deleteMealInstance(date(), id);
      const reopened = wasDone && !app.getDaySummary(date()).loggingComplete;
      return { reopened, message: reopened ? 'Deleted. The day is no longer marked done, because nothing is logged.' : 'Deleted.' };
    },
    clearDay() {
      const date0 = date();
      app.deleteDay(date0);
      return { message: `Cleared ${formatDate(date0)}. Other days weren't affected.` };
    },
    setDone(done) {
      app.setDayLoggingComplete(date(), done);
      return { message: done ? `Marked ${dayWord()} as done. It now counts as a complete day in Progress.` : `Reopened ${dayWord()}.` };
    },
    saveAsNewSavedMeal({ name, mealType, ingredients }) {
      const meal = app.createSavedMeal({ name, mealType: mealType || 'other', ingredients: recipeOf(ingredients) });
      return { meal, message: `Saved “${meal.name}” as a new saved meal.` };
    },
    updateSavedMeal(mealId, ingredients) {
      const meal = app.updateSavedMeal(mealId, { ingredients: recipeOf(ingredients) });
      return { meal, message: `Updated “${meal.name}” for next time.` };
    }
  };
}

/* ---------------- DOM wiring ---------------- */

function sameRecipe(a, b) {
  return a.length === b.length && a.every((x, i) => x.foodId === b[i].foodId && x.quantity === b[i].quantity);
}

/** The Today screen, mounted by the shell into <main>. */
export const todayScreen = {
  mount(main, { app, win, doc }) {
    // The date comes from the route (#/today?date=YYYY-MM-DD): ◀ ▶, Progress's day list and
    // Log's "View on Today" all use it. A past or future date is shown as that day; a future
    // day is viewable and empty (I-04). No date, or an invalid one, shows today.
    let viewDate = todayViewDate(app, win.location.hash);
    const followsToday = viewDate === app.getToday();
    const actions = createTodayActions(app, () => viewDate);
    const foodActions = createFoodActions(app);
    let model = todayModel(app, viewDate);
    let ui = null; // the open surface's state
    let highlightId = null;
    let doneNoteDate = null; // the day whose one-time Done-day note is showing (§4.4.2)

    // One dialog, presented by the shared view host (§2.3, §3.1): the logged-meal detail, its
    // editor and the Food picker are views — pushed full screen on phones, a side panel on
    // tablets, a right-hand pane beside Today on wide screens. Today's own sheets (Coach, day
    // type, day menu…) stay modal sheets at every width.
    main.innerHTML = `<div class="today-page view-page" data-today-page>
<div data-today-body></div>
<dialog class="sheet" aria-labelledby="sheet-title" data-sheet></dialog>
</div>
<p class="today-message" role="status" aria-live="polite" data-message></p>`;
    const page = main.querySelector('[data-today-page]');
    const body = main.querySelector('[data-today-body]');
    const dialog = main.querySelector('[data-sheet]');
    const messageEl = main.querySelector('[data-message]');

    let messageTimer = null;
    const say = (text) => {
      messageEl.textContent = '';
      if (messageTimer) clearTimeout(messageTimer);
      if (!text) return;
      messageEl.textContent = text;
      messageTimer = setTimeout(() => { messageEl.textContent = ''; }, 6000);
    };

    const host = createViewHost({
      page, dialog, win, doc,
      viewTypes: TODAY_VIEW_TYPES,
      sheetTypes: TODAY_SHEET_TYPES,
      fallbackFocus: () => body.querySelector('#screen-title'),
      onClose: () => { ui = null; },
      beforeLeave
    });

    function refresh({ focusId } = {}) {
      model = todayModel(app, viewDate);
      session.todayDate = viewDate;
      body.innerHTML = renderToday(model, { doneNote: doneNoteDate === model.date });
      if (focusId) {
        const row = body.querySelector(`[data-id="${CSS.escape(focusId)}"]`);
        if (row) {
          row.classList.add('is-new');
          row.focus();
          row.scrollIntoView({ block: 'center' });
          if (dialog.open) host.returnFocusTo(row);
          highlightId = focusId;
          setTimeout(() => { if (highlightId === focusId) row.classList.remove('is-new'); }, 2000);
        }
      }
    }

    function showError(e) {
      const el = dialog.querySelector('[data-error]');
      const text = errorMessage(e);
      if (el) { el.textContent = text; el.hidden = false; } else say(text);
    }

    function openDialog(next) {
      // A Today sheet (Coach, day type…) asked for while a detail pane is open beside Today on a
      // wide screen: the pane closes first, then the sheet opens as it always has.
      if (dialog.open && dialog.dataset.present === 'pane' && TODAY_SHEET_TYPES.includes(next.type)) {
        const trigger = doc.activeElement;
        dialog.addEventListener('close', () => win.setTimeout(() => {
          openDialog(next);
          if (trigger && trigger.isConnected) host.returnFocusTo(trigger);
        }, 0), { once: true });
        closeDialog();
        return;
      }
      // A Today control (e.g. Build My Next Meal) used while a pane is open beside Today: the pane
      // shows the new surface, and closing it returns focus to that control (§14).
      const trigger = doc.activeElement;
      const fromToday = dialog.open && trigger && !dialog.contains(trigger) && body.contains(trigger);
      ui = next;
      host.open(next.type, drawDialog, { startAtTitle: next.type === 'instance' });
      if (fromToday) host.returnFocusTo(trigger);
    }

    const closeDialog = () => host.close();

    function drawDialog() {
      if (!ui) return;
      switch (ui.type) {
        case 'day-type': dialog.innerHTML = renderDayTypeDialog({ model, ...ui }); break;
        case 'meal': dialog.innerHTML = renderMealConfirmDialog(ui); break;
        case 'quantity': dialog.innerHTML = renderQuantityDialog(ui); break;
        case 'instance': dialog.innerHTML = renderInstanceDialog(ui); break;
        case 'edit': dialog.innerHTML = renderEditDialog(ui); break;
        case 'picker': dialog.innerHTML = renderPicker({ title: 'Add an ingredient', query: ui.query, results: pickerResults(app, ui.query) }); break;
        case 'custom-food': dialog.innerHTML = renderCustomFoodForm(ui); break;
        case 'move': dialog.innerHTML = renderMoveDialog(ui); break;
        case 'delete': dialog.innerHTML = renderDeleteDialog(ui); break;
        case 'followup': dialog.innerHTML = renderFollowUpDialog(ui); break;
        case 'day-menu': dialog.innerHTML = renderDayMenuDialog(); break;
        case 'clear-day': dialog.innerHTML = renderClearDayDialog(ui); break;
        case 'coach': dialog.innerHTML = renderCoachDialog(ui); break;
        case 'meal-detail': dialog.innerHTML = renderMealDetail({ ...mealDetailData(ui.mealId), model: { future: model.isFuture } }); break;
        case 'food-detail': dialog.innerHTML = renderFoodDetail({ ...ui, context: ui.pickUi ? 'picker' : 'coach' }); break;
        case 'food-delete': dialog.innerHTML = renderDeleteFood(ui); break;
        case 'discard-food': dialog.innerHTML = renderDiscardFood({ created: !!ui.form.pickUi }); break;
        case 'discard-edit': dialog.innerHTML = renderDiscardEdit(); break;
        default: break;
      }
    }

    /**
     * Escape, Back or Close on a sub-surface of the logged-meal editor steps back to what opened
     * it: the Food picker back to the editor (its rows kept), a new-food form back to the picker.
     * Everything else closes, as before.
     */
    function beforeLeave() {
      if (!ui) return true;
      // The logged-meal editor with unsaved edits asks first (§3.2, I-01); untouched, it just closes.
      if (ui.type === 'edit') {
        keepEditFields(ui);
        // §16: cancelling an edit returns to the logged-meal detail; unsaved edits ask first.
        if (!editDirty(ui)) { openInstance(ui.instance.id); return false; }
        openDialog({ type: 'discard-edit', back: ui, proceed: null });
        return false;
      }
      // §16: a Log sheet opened from a Coach item (or a Meal detail) returns there on cancel.
      if ((ui.type === 'meal' || ui.type === 'quantity') && ui.back) { stepBackTo(ui.back); return false; }
      // After an edit, the follow-up returns to the logged-meal detail (§16).
      if (ui.type === 'followup' && ui.instanceId && model.day && model.day.mealInstances.some((mi) => mi.id === ui.instanceId)) { openInstance(ui.instanceId); return false; }
      if (ui.type === 'discard-edit') { keepEditing(); return false; }
      if (ui.type === 'picker') { backToEdit(ui.edit, '[data-action="add-ingredient"]'); return false; }
      // Food detail from the picker (information-only, A-46): Back returns to the picker as it was.
      if (ui.type === 'food-detail' && ui.pickUi) { backToPicker(ui); return false; }
      if (ui.type === 'custom-food' && ui.pickUi) {
        if (customFoodDirty(ui)) { openDialog({ type: 'discard-food', form: ui, proceed: null }); return false; }
        openDialog(ui.pickUi);
        return false;
      }
      // Food detail's own forms step back to it, asking first about unsaved edits (§3.2, §7.4).
      if (ui.type === 'custom-food' && ui.mode === 'edit') {
        if (customFoodDirty(ui)) { openDialog({ type: 'discard-food', form: ui, proceed: null }); return false; }
        openFoodDetail(ui.foodId, ui.detail.back);
        return false;
      }
      if (ui.type === 'discard-food') { keepEditing(); return false; }
      if (ui.type === 'food-delete') { openFoodDetail(ui.food.id, ui.detail.back); return false; }
      // Meal / Food detail opened from the Coach or a logged meal's source line: Back returns there (§8.4, §16).
      if ((ui.type === 'meal-detail' || ui.type === 'food-detail') && ui.back) { returnTo(ui.back, ui); return false; }
      return true;
    }

    /* ---- "Discard changes?" (§3.2, I-01): Back, Close, Escape and navigating away ---- */

    /**
     * What leaving now would lose: 'edit' (the logged-meal editor, including its Food picker and
     * the new-food form opened from it), 'food' (a Custom Food edit from Food detail),
     * 'prompt' (the question is already showing), or null (nothing unsaved).
     */
    function unsaved() {
      if (!ui) return null;
      if (ui.type === 'discard-edit' || ui.type === 'discard-food') return 'prompt';
      if (ui.type === 'edit') keepEditFields(ui);
      const edit = ui.type === 'edit' ? ui : ui.type === 'picker' ? ui.edit : (ui.type === 'custom-food' || ui.type === 'food-detail') && ui.pickUi ? ui.pickUi.edit : null;
      if (edit && (editDirty(edit) || (ui.type === 'custom-food' && customFoodDirty(ui)))) return 'edit';
      if (ui.type === 'custom-food' && ui.mode === 'edit' && customFoodDirty(ui)) return 'food';
      return null;
    }
    /**
     * Before Today is left (another tab, a link, browser Back) or another Today control replaces
     * the open pane: true when nothing would be lost; otherwise asks and returns false, and
     * proceed() runs only after Discard. Keep editing stays exactly where it was.
     */
    function guardLeave(proceed) {
      const kind = unsaved();
      if (!kind) return true;
      if (kind === 'prompt') {
        ui.proceed = proceed;
        const keep = dialog.querySelector('[data-action="keep-editing"]');
        if (keep) keep.focus();
      } else if (kind === 'edit') {
        openDialog({ type: 'discard-edit', back: ui, proceed });
      } else {
        openDialog({ type: 'discard-food', form: ui, proceed });
      }
      return false;
    }
    this._leaveGuard = guardLeave;
    /** Keep editing: back to the form as it was left (the editor keeps its rows, name and slot). */
    function keepEditing() {
      const back = ui.type === 'discard-edit' ? ui.back : ui.form;
      if (back.type === 'edit') backToEdit(back); else openDialog(back);
    }
    /** Discard: nothing is written. Then where the user was going, or back a step. */
    function discardChanges() {
      const { proceed } = ui;
      if (proceed) {
        dialog.addEventListener('close', () => win.setTimeout(proceed, 0), { once: true });
        closeDialog();
        return;
      }
      if (ui.type === 'discard-edit') { openInstance(ui.back.instance.id); return; } // §16: back to the logged-meal detail, unchanged
      const form = ui.form;
      if (form.pickUi) openDialog(form.pickUi); else openFoodDetail(form.foodId, form.detail.back);
    }

    /* ---- Meal and Food detail from the Coach (§8.4) and a logged meal's source line (§13.2) ---- */
    function mealDetailData(mealId) {
      const meal = app.getMeal(mealId);
      const calc = app.calculateMealMacros(mealId);
      const foods = {};
      for (const ing of calc.ingredients) { const f = app.getFood(ing.foodId); if (f) foods[ing.foodId] = f; }
      return { meal, calc, foods, isFavorite: app.getPreferences().favoriteMeals.includes(mealId) };
    }
    function openMealDetail(mealId, back) {
      if (!app.getMeal(mealId)) { showError({ code: 'MEAL_NOT_FOUND' }); return; }
      openDialog({ type: 'meal-detail', mealId, back });
    }
    function openFoodDetail(foodId, back, note = '') {
      const detail = foodDetailModel(app, foodId);
      if (!detail) { returnTo(back); return; }
      openDialog({ type: 'food-detail', ...detail, note, back });
    }
    /** Where a Log sheet opened from the Coach or a Meal detail goes back to. */
    function stepBackTo(back) {
      if (back.type === 'meal-detail') openMealDetail(back.mealId, back.back);
      else returnTo(back);
    }
    /** Back to the Coach (re-queried, so it reflects any change; groups stay expanded) or the logged meal. */
    function returnTo(back, from = null) {
      if (!back) { closeDialog(); return; }
      if (back.type === 'coach') {
        back.suggestions = app.getMacroCoachSuggestions({ date: model.date, mealSlot: defaultSlot(model.day) });
        openDialog(back);
        back.note = null; // a delete message shows once
        const item = from && (from.type === 'meal-detail'
          ? dialog.querySelector(`[data-action="coach-meal-detail"][data-meal="${CSS.escape(from.mealId)}"]`)
          : dialog.querySelector(`[data-action="coach-food-detail"][data-food="${CSS.escape(from.food.id)}"]`));
        if (item) item.focus();
        return;
      }
      openInstance(back.instance.id);
      const link = dialog.querySelector('[data-action="source-meal"]');
      if (link) link.focus();
    }
    function refreshFoodDetail(message) {
      Object.assign(ui, foodDetailModel(app, ui.food.id));
      syncInPlace(dialog, renderFoodDetail({ ...ui, context: 'coach' }), doc);
      const el = dialog.querySelector('[data-food-status]');
      if (el) { el.textContent = ''; el.textContent = message; }
    }

    const checkedSlot = (name) => { const el = dialog.querySelector(`input[name="${name}"]:checked`); return el ? el.value : null; };

    function openMeal(mealId, slot, back = null) {
      const preview = app.previewMealInstance({ date: model.date, mealId });
      const foods = {};
      for (const ing of preview.ingredients) { const f = app.getFood(ing.foodId); if (f) foods[ing.foodId] = f; }
      openDialog({ type: 'meal', mealId, preview, slot: slot || defaultSlot(model.day), adjusting: false, quantities: preview.ingredients.map((i) => String(i.quantity)), original: recipeOf(preview.ingredients), foods, back });
    }

    function openInstance(id) {
      const instance = model.day.mealInstances.find((mi) => mi.id === id);
      if (!instance) return;
      const source = model.sourceOf[id];
      const meal = instance.sourceMealId ? app.getMeal(instance.sourceMealId) : null;
      openDialog({ type: 'instance', instance, slot: instance.mealSlot, date: model.date, source, sourceName: meal ? meal.name : '' });
    }

    /** After a write. dayEdit: an add, edit, move or delete on this day (for the Done-day note). */
    /**
     * After a write. dayEdit: an add, edit, move or delete on this day — its message also states
     * the new remaining values, once (§4.3.6, I-53). reopen: a logged meal whose detail comes
     * back afterwards (§16: an edit returns to the logged-meal detail).
     */
    function afterChange(result, { focusId, followUp, dayEdit = false, reopen = null } = {}) {
      if (dayEdit && claimDoneEditNote(session.today, model.date, app.getDaySummary(model.date))) doneNoteDate = model.date;
      refresh({ focusId });
      const summary = app.getDaySummary(model.date);
      say(dayEdit && summary.exists ? `${result.message} ${remainingSummary(summary, { isToday: model.isToday, date: model.date })}` : result.message);
      if (followUp) openDialog(reopen ? { ...followUp, instanceId: reopen } : followUp);
      else if (reopen && model.day && model.day.mealInstances.some((mi) => mi.id === reopen)) openInstance(reopen);
      else closeDialog();
    }

    /**
     * The follow-up after changing a logged meal's ingredients (A-14): for a Saved Meal source,
     * Just this time · Save as a new Saved Meal · Also update it; after editing a logged meal from
     * a Library source (read-only), the first two only (§4.3.4). Logging with adjusted grams
     * offers it for Saved Meals only (§5.4).
     */
    function followUpFor(instance, changed, { editing = false } = {}) {
      if (!changed || !instance.sourceMealId) return null;
      const meal = app.getMeal(instance.sourceMealId);
      if (!meal || !(meal.source === 'saved' || (editing && meal.source === 'library'))) return null;
      return { type: 'followup', mode: 'choice', savedId: meal.id, savedName: meal.name, mealType: meal.mealType, ingredients: instance.ingredients, newName: `${meal.name} (adjusted)`, library: meal.source === 'library' };
    }

    /* ---- the logged-meal editor and its Food picker (§4.3.4, §7.5) ---- */
    function keepEditFields(edit) {
      const name = dialog.querySelector('[data-edit-name]');
      if (name) edit.name = name.value;
      edit.slot = checkedSlot('edit-slot') || edit.slot;
    }
    function backToEdit(edit, focusSelector) {
      ui = edit;
      host.open('edit', drawDialog);
      updateEditPreview();
      const el = focusSelector ? dialog.querySelector(focusSelector) : null;
      if (el) el.focus();
    }
    /** Food detail from the picker (§7.5, A-42, A-46): information only; the picker and the edit are kept. */
    function openPickerFoodDetail(foodId, pickUi) {
      const detail = foodDetailModel(app, foodId);
      if (!detail) { openDialog(pickUi); showError({ code: 'FOOD_NOT_FOUND' }); return; }
      openDialog({ type: 'food-detail', ...detail, note: '', pickUi });
    }
    function backToPicker(detailUi) {
      openDialog(detailUi.pickUi);
      const el = dialog.querySelector(`[data-action="picker-food-detail"][data-food="${CSS.escape(detailUi.food.id)}"]`) || dialog.querySelector('[data-pick-query]');
      if (el) el.focus();
    }
    /** A Food chosen in the picker joins the edit as a new row with empty grams; nothing is saved yet. */
    function pickIngredient(foodId, pickUi) {
      const food = app.getFood(foodId);
      if (!food) { showError({ code: 'FOOD_NOT_FOUND' }); return; }
      const edit = pickUi.edit;
      edit.rows.push({ foodId: food.id, unit: 'g', foodName: food.name, state: food.state, text: '' });
      backToEdit(edit, `#edit-q-${edit.rows.length - 1}`);
    }

    /* ---- live previews on input ---- */
    main.addEventListener('input', (event) => {
      if (!ui) return;
      const el = event.target;
      if (ui.type === 'meal' && el.matches('[data-quantity-index]')) {
        ui.quantities[Number(el.dataset.quantityIndex)] = el.value;
        const parsed = ui.quantities.map(parseGrams);
        const ok = parsed.every((q) => q !== null);
        dialog.querySelector('[data-grams-error]').hidden = ok;
        const logButton = dialog.querySelector('[data-action="log-meal"]');
        if (!ok) { logButton.disabled = true; return; }
        ui.preview = app.previewMealInstance({ date: model.date, mealId: ui.mealId, ingredients: ui.original.map((ing, i) => ({ ...ing, quantity: parsed[i] })) });
        dialog.querySelector('[data-preview]').innerHTML = renderMealPreview(ui.preview);
        logButton.disabled = !ui.preview.valid;
      } else if (ui.type === 'quantity' && el.matches('[data-grams]')) {
        ui.text = el.value;
        const q = parseGrams(el.value);
        dialog.querySelector('[data-grams-error]').hidden = q !== null || el.value.trim() === '';
        ui.preview = q === null ? null : app.previewLogFood({ date: model.date, foodId: ui.food.id, quantity: q });
        dialog.querySelector('[data-preview]').innerHTML = ui.preview ? renderMealPreview(ui.preview) : '<p class="hint">Enter a weight to see what it adds.</p>';
        dialog.querySelector('[data-action="log-food"]').disabled = !(ui.preview && ui.preview.valid);
      } else if (ui.type === 'edit' && el.matches('[data-quantity-index]')) {
        ui.rows[Number(el.dataset.quantityIndex)].text = el.value;
        updateEditPreview();
      } else if (ui.type === 'edit' && el.matches('[data-edit-name]')) {
        ui.name = el.value;
        updateEditPreview();
      } else if (ui.type === 'picker' && el.matches('[data-pick-query]')) {
        ui.query = el.value;
        dialog.querySelector('[data-pick-results]').innerHTML = pickerResults(app, ui.query);
      } else if (ui.type === 'custom-food' && el.matches('[data-cf]')) {
        syncCustomFood(el);
      } else if (ui.type === 'followup' && el.matches('[data-new-name]')) {
        ui.newName = el.value;
      }
    });

    /** The Custom Food form (a new food from the picker, or an edit from Food detail): domain validation as fields change (§7.4). */
    function syncCustomFood(el) {
      ui.values[el.dataset.cf] = el.value;
      ui.touched.add(el.dataset.cf);
      ui.validation = validateCustomFoodForm(app, ui);
      syncInPlace(dialog, renderCustomFoodForm(ui), doc);
    }

    function editPatch() {
      const parsed = ui.rows.map((row) => parseGrams(row.text));
      if (parsed.some((q) => q === null)) return null;
      return { mealName: ui.name.trim(), mealSlot: checkedSlot('edit-slot') || ui.slot, ingredients: ui.rows.map((row, i) => ({ foodId: row.foodId, unit: row.unit, quantity: parsed[i] })) };
    }

    function updateEditPreview() {
      // Rows without a usable weight are marked, so a submit while invalid (Enter, §14) can focus the first.
      dialog.querySelectorAll('[data-quantity-index]').forEach((input) => {
        input.toggleAttribute('data-invalid', parseGrams(ui.rows[Number(input.dataset.quantityIndex)].text) === null);
      });
      const patch = editPatch();
      dialog.querySelector('[data-grams-error]').hidden = !!patch;
      // A-45: Save stays disabled while the form is invalid — no usable grams, or no name.
      const nameEl = dialog.querySelector('[data-edit-name]');
      const noName = !String(ui.name || '').trim();
      if (nameEl) { nameEl.toggleAttribute('data-invalid', noName); if (noName) nameEl.setAttribute('aria-invalid', 'true'); else nameEl.removeAttribute('aria-invalid'); }
      const nameError = dialog.querySelector('[data-name-error]');
      if (nameError) nameError.hidden = !noName;
      dialog.querySelector('[data-action="save-instance"]').disabled = !patch || noName;
      if (!patch) { ui.preview = null; dialog.querySelector('[data-preview]').innerHTML = ''; return; }
      try {
        ui.preview = app.previewMealInstanceUpdate(model.date, ui.instance.id, { ingredients: patch.ingredients });
        dialog.querySelector('[data-preview]').innerHTML = `<p class="preview-totals">${macroLine(ui.preview.instance.totals)}</p><p class="preview-after">${afterLine(ui.preview.after)}</p>`;
      } catch (e) { showError(e); }
    }

    main.addEventListener('change', (event) => {
      if (ui && ui.type === 'day-type' && event.target.name === 'day-type') {
        const type = event.target.value;
        ui.selected = type;
        ui.preview = model.summary.exists ? app.previewDayTypeChange(model.date, type) : null;
        drawDialog();
        const radio = dialog.querySelector(`input[name="day-type"][value="${type}"]`);
        if (radio) radio.focus();
      } else if (ui && ui.type === 'custom-food' && event.target.matches('[data-cf]')) {
        syncCustomFood(event.target);
      }
    });

    /** ◀ / ▶: another day's Today, at its own URL; the same control keeps the focus. */
    function goToDate(date, control) {
      session.today.focus = control;
      win.location.replace(dayHref(date, app.getToday()));
    }

    main.addEventListener('click', (event) => {
      const el = event.target.closest('[data-action]');
      if (!el || !main.contains(el)) return;
      // A Today control used beside an open pane (wide screens) would replace an unsaved form: ask first.
      if (dialog.open && !dialog.contains(el) && !guardLeave(() => { if (el.isConnected) el.click(); })) return;
      const action = el.dataset.action;
      try {
        switch (action) {
          case 'close': if (beforeLeave()) closeDialog(); break;
          case 'prev-day': goToDate(model.prevDate, 'prev-day'); break;
          case 'next-day': goToDate(model.nextDate, 'next-day'); break;
          case 'choose-day-type': afterChange(actions.chooseDayType(el.dataset.type)); break;
          case 'day-type': openDialog({ type: 'day-type', selected: model.summary.dayType, preview: null, applyPreview: model.isToday ? app.previewApplyCurrentTargetsToToday() : null }); break;
          case 'choose-day-type-confirm': afterChange(actions.chooseDayType(ui.selected)); break;
          case 'change-day-type': {
            const result = actions.changeDayType(ui.selected);
            if (result.noOp) closeDialog(); else afterChange(result);
            break;
          }
          case 'confirm-apply-targets': ui.confirmingApply = true; drawDialog(); break;
          case 'apply-targets': afterChange(actions.applyCurrentTargets()); break;
          case 'add': {
            // §4.3.2: slot + and Add open Log with this date (and slot) preset; Log returns here.
            const slot = el.dataset.slot || null;
            session.log.launchedFromToday = true;
            win.location.hash = `#/log?from=today&date=${model.date}${slot ? `&slot=${slot}` : ''}`;
            break;
          }
          case 'adjust': ui.adjusting = true; ui.slot = checkedSlot('log-slot') || ui.slot; drawDialog(); dialog.querySelector('[data-quantity-index]')?.focus(); break;
          case 'log-meal': {
            const mealSlot = checkedSlot('log-slot');
            let ingredients;
            if (ui.adjusting) {
              const parsed = ui.quantities.map(parseGrams);
              if (parsed.some((q) => q === null)) { dialog.querySelector('[data-grams-error]').hidden = false; break; }
              ingredients = ui.original.map((ing, i) => ({ ...ing, quantity: parsed[i] }));
            }
            const changed = ingredients && !sameRecipe(ingredients, ui.original);
            const result = actions.logMeal({ mealId: ui.mealId, mealSlot, ingredients: changed ? ingredients : undefined });
            afterChange(result, { focusId: result.instance.id, followUp: followUpFor(result.instance, changed), dayEdit: true });
            break;
          }
          case 'coach': {
            const suggestions = app.getMacroCoachSuggestions({ date: model.date, mealSlot: defaultSlot(model.day) });
            openDialog({ type: 'coach', suggestions, expanded: {} });
            break;
          }
          case 'coach-more': ui.expanded[el.dataset.tier] = true; drawDialog(); break;
          case 'coach-log-meal': openMeal(el.dataset.meal, null, ui); break;
          case 'coach-log-food': openDialog({ type: 'quantity', food: app.getFood(el.dataset.food), slot: defaultSlot(model.day), text: '', preview: null, back: ui }); break;
          case 'log-food': {
            const q = parseGrams(ui.text);
            if (q === null) { dialog.querySelector('[data-grams-error]').hidden = false; break; }
            const result = actions.logFood({ foodId: ui.food.id, quantity: q, mealSlot: checkedSlot('log-slot') });
            afterChange(result, { focusId: result.instance.id, dayEdit: true });
            break;
          }
          case 'open-instance': openInstance(el.dataset.id); break;
          // §16: the Saved Meal editor in Meals comes back to this logged meal's detail when done (the link itself navigates).
          case 'edit-saved-meal': session.savedMealEdit = { mealId: el.dataset.meal, date: model.date, instanceId: ui && ui.instance ? ui.instance.id : null }; break;
          case 'edit-instance': {
            const instance = ui.instance;
            const edit = { type: 'edit', instance, date: model.date, name: instance.mealName, slot: instance.mealSlot, rows: instance.ingredients.map((i) => ({ foodId: i.foodId, unit: i.unit, foodName: i.foodName, text: String(i.quantity) })), preview: null };
            edit.original = editKey(edit);
            openDialog(edit);
            break;
          }
          case 'remove-ingredient': {
            keepEditFields(ui);
            ui.rows.splice(Number(el.dataset.index), 1);
            drawDialog();
            updateEditPreview();
            break;
          }
          case 'add-ingredient': {
            keepEditFields(ui);
            openDialog({ type: 'picker', query: '', edit: ui });
            break;
          }
          case 'food': if (ui && ui.type === 'picker') pickIngredient(el.dataset.food, ui); break;
          case 'picker-food-detail': if (ui && ui.type === 'picker') openPickerFoodDetail(el.dataset.food, ui); break;
          case 'create-food': {
            if (!ui || ui.type !== 'picker') break;
            const values = { name: String(ui.query || '').trim(), category: '', state: '', brand: '', protein: '', carbs: '', fat: '', aliases: '' };
            openDialog({ type: 'custom-food', values, initial: { ...values }, touched: new Set(), validation: app.validateCustomFood(customFoodInput(values)), pickUi: ui });
            break;
          }
          case 'cf-save': {
            ui.validation = validateCustomFoodForm(app, ui);
            if (!ui.validation.valid) { syncInPlace(dialog, renderCustomFoodForm(ui), doc); break; } // Save is disabled while invalid
            if (ui.mode === 'edit') {
              const food = foodActions.updateCustomFood(ui.foodId, customFoodPatch(ui.values));
              openFoodDetail(food.id, ui.detail.back, 'Saved.'); // §7.4: back to the detail of the Food just saved
              break;
            }
            const food = app.createCustomFood(customFoodInput(ui.values));
            pickIngredient(food.id, ui.pickUi);
            break;
          }
          /* Coach items → Meal / Food detail (§8.4); the logged meal's source → its current recipe (§13.2) */
          case 'coach-meal-detail': openMealDetail(el.dataset.meal, ui); break;
          case 'coach-food-detail': openFoodDetail(el.dataset.food, ui); break;
          case 'source-meal': openMealDetail(el.dataset.meal, ui); break;
          case 'log-meal-start': openMeal(el.dataset.meal, null, ui && ui.type === 'meal-detail' ? ui : null); break;
          case 'fd-favorite': refreshFoodDetail(foodActions.setFavorite(ui.food, !ui.isFavorite)); break;
          case 'fd-suggest': refreshFoodDetail(foodActions.setNotSuggested(ui.food, !ui.isDisliked)); break;
          case 'fd-edit': {
            const food = app.getFood(ui.food.id);
            if (!food) { returnTo(ui.back); break; }
            const values = customFoodValues(food);
            const form = { type: 'custom-food', mode: 'edit', foodId: food.id, initial: { ...values }, values, touched: new Set(), detail: ui };
            form.validation = validateCustomFoodForm(app, form);
            openDialog(form);
            break;
          }
          case 'fd-delete': openDialog({ type: 'food-delete', food: ui.food, meals: foodUsageMeals(app, ui.food.id), detail: ui }); break;
          case 'fd-delete-confirm': {
            const back = ui.detail.back;
            const note = foodActions.deleteCustomFood(ui.food); // §7.6: history untouched; Saved Meals that use it need a fix
            if (back && back.type === 'coach') back.note = note;
            refresh();
            returnTo(back);
            break;
          }
          case 'keep-editing': keepEditing(); break;
          case 'discard': discardChanges(); break;
          /* Coach footer and empty state: to Meals, or Log's food search (§8.3, §8.6) */
          case 'coach-fix': host.leave({ method: 'push', href: '#/meals?filter=needs-fix' }); break;
          case 'coach-browse-meals': host.leave({ method: 'push', href: '#/meals' }); break;
          case 'coach-add-food': {
            session.log.segment = 'foods';
            session.log.launchedFromToday = true;
            host.leave({ method: 'push', href: `#/log?from=today&date=${model.date}` });
            break;
          }
          case 'save-instance': {
            const patch = editPatch();
            if (!patch) { dialog.querySelector('[data-grams-error]').hidden = false; break; }
            if (!patch.mealName) { dialog.querySelector('[data-name-error]').hidden = false; break; }
            const before = recipeOf(ui.instance.ingredients);
            const result = actions.updateInstance(ui.instance.id, patch);
            const changed = !sameRecipe(recipeOf(result.instance.ingredients), before);
            afterChange(result, { focusId: result.instance.id, followUp: followUpFor(result.instance, changed, { editing: true }), dayEdit: true, reopen: result.instance.id });
            break;
          }
          case 'move-instance': openDialog({ type: 'move', instance: ui.instance, slot: ui.instance.mealSlot }); break;
          case 'save-move': {
            const slot = checkedSlot('move-slot');
            if (slot === ui.instance.mealSlot) { closeDialog(); break; }
            const result = actions.moveInstance(ui.instance.id, slot);
            afterChange(result, { focusId: result.instance.id, dayEdit: true });
            break;
          }
          case 'delete-instance': openDialog({ type: 'delete', instance: ui.instance, date: model.date }); break;
          case 'confirm-delete': afterChange(actions.deleteInstance(ui.instance.id), { dayEdit: true }); break;
          case 'day-menu': openDialog({ type: 'day-menu' }); break;
          case 'clear-day': openDialog({ type: 'clear-day', date: model.date, instanceCount: model.summary.instanceCount }); break;
          case 'confirm-clear-day': afterChange(actions.clearDay()); break;
          case 'done': afterChange(actions.setDone(true)); break;
          case 'reopen': afterChange(actions.setDone(false)); break;
          case 'followup-name': ui.mode = 'name'; drawDialog(); dialog.querySelector('[data-new-name]').focus(); break;
          case 'followup-confirm-update': ui.mode = 'confirm-update'; drawDialog(); break;
          case 'followup-save-new': {
            const name = (ui.newName || '').trim();
            if (!name) { dialog.querySelector('[data-name-error]').hidden = false; break; }
            afterChange(actions.saveAsNewSavedMeal({ name, mealType: ui.mealType, ingredients: ui.ingredients }), { reopen: ui.instanceId || null });
            break;
          }
          case 'followup-update': afterChange(actions.updateSavedMeal(ui.savedId, ui.ingredients), { reopen: ui.instanceId || null }); break;
          default: break;
        }
      } catch (e) {
        showError(e);
      }
    });

    // The local date can roll over while the app is open (§4.5.6).
    // "The next time the app gains focus" (§4.5.6): becoming visible or the window being focused.
    // A form with unsaved edits is never closed for it; the move waits for the next focus.
    const onVisible = () => {
      if (followsToday && doc.visibilityState === 'visible' && app.getToday() !== model.date && !unsaved()) { viewDate = app.getToday(); closeDialog(); refresh(); }
    };
    doc.addEventListener('visibilitychange', onVisible);
    win.addEventListener('focus', onVisible);
    this._cleanup = () => { host.destroy(); doc.removeEventListener('visibilitychange', onVisible); win.removeEventListener('focus', onVisible); if (messageTimer) clearTimeout(messageTimer); };

    // A handoff from Log (§5.8): highlight the meal just logged, or open it for editing (§5.7).
    const handoff = session.handoff && session.handoff.date === viewDate ? session.handoff : null;
    session.handoff = null;
    // Logging to a Done day from Log is an add on that day (§4.4.2): the one-time note applies.
    if (handoff && handoff.highlightId && claimDoneEditNote(session.today, viewDate, app.getDaySummary(viewDate))) doneNoteDate = viewDate;
    refresh(handoff && handoff.highlightId ? { focusId: handoff.highlightId } : {});
    // After ◀ / ▶ the same control keeps the focus (the screen re-renders for the new day).
    const focusControl = session.today.focus;
    session.today.focus = null;
    if (focusControl && !handoff) {
      const control = body.querySelector(`[data-action="${focusControl}"]`);
      if (control) { control.focus(); return true; }
    }
    if (!handoff) return false;
    if (handoff.message) say(handoff.message);
    if (handoff.openInstanceId && model.day && model.day.mealInstances.some((mi) => mi.id === handoff.openInstanceId)) {
      openInstance(handoff.openInstanceId);
      return true;
    }
    return !!(handoff.highlightId && body.querySelector(`[data-id="${CSS.escape(handoff.highlightId)}"]`));
  },

  /** Asked by the shell before a route change (§3.2): false keeps Today while "Discard changes?" asks. */
  leaveGuard(proceed) {
    return this._leaveGuard ? this._leaveGuard(proceed) : true;
  },

  unmount() {
    this._leaveGuard = null;
    if (this._cleanup) { this._cleanup(); this._cleanup = null; }
  }
};
