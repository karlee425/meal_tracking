/*
 * amount.js — the shared amount control for a Food's quantity (V2_UI_CONTRACT.md §5.5.1,
 * V3 Slice 1 · C6) and the Add a serving form (§5.5.2).
 *
 * Grams stay canonical. A Food with named servings can also be entered as a serving × a
 * count. Everything numeric comes from the domain: resolveAmount turns the draft into the
 * canonical gram quantity and its display text; this file never converts, multiplies,
 * rounds or formats a quantity. A Food without servings keeps the grams-only field exactly as
 * before.
 *
 * The draft lives in memory only, on the open sheet (and in the sheet state carried through
 * Food detail, the Custom Food edit and Add a serving):
 *   { mode: 'grams' | 'serving', gramsText, servingId, countText, lastText }
 *   servingId  the serving last selected in this sheet (kept while in grams mode)
 *   lastText   the last canonical gram text a serving resolved to (the fallback if it goes)
 */

import { SERVING_COUNT_QUICK_PICKS, isUnfinishedServingCount, parseServingGrams } from '../src/domain/index.js';
import { escapeHtml } from './shell.js';
import { parseGrams, errorSlot } from './today.js';
import { viewHead } from './view-host.js';

/** Domain codes the amount control reports next to its fields (anything else is a real error). */
const AMOUNT_CODES = new Set(['INVALID_QUANTITY', 'INVALID_SERVING_COUNT', 'AMOUNT_TOO_SMALL', 'SERVING_NOT_FOUND']);

export const AMOUNT_MESSAGES = Object.freeze({
  INVALID_QUANTITY: 'Enter a weight above 0 g',
  INVALID_SERVING_COUNT: 'Enter a number of servings above 0, like 1, 1.5 or 1/2.',
  AMOUNT_TOO_SMALL: 'That comes to less than 0.01 g. Enter more servings.',
  SERVING_NOT_FOUND: 'That serving no longer exists.'
});

/** Quick picks: the count text each puts in the field, what it shows, and what it's called. */
const PICK_FACE = Object.freeze({ '1/4': '¼', '1/2': '½', '3/4': '¾', 1: '1', 2: '2' });
const PICK_NAME = Object.freeze({ '1/4': 'a quarter of a serving', '1/2': 'half a serving', '3/4': 'three quarters of a serving', 1: '1 serving', 2: '2 servings' });

/** The draft a sheet opens with: the first serving × 1 when the Food has servings, else grams. */
export function startAmount(app, foodId, gramsText = '') {
  const servings = app.getServings(foodId);
  if (!servings.length) return { mode: 'grams', gramsText, servingId: null, countText: '1', lastText: null };
  return { mode: 'serving', gramsText, servingId: servings[0].id, countText: '1', lastText: null };
}

/**
 * A draft carried back to the sheet (from Food detail, the Custom Food edit or Add a serving).
 * If its serving no longer exists, grams with the last canonical quantity it came to, and a
 * notice. Returns { draft, notice }.
 */
export function restoreAmount(app, foodId, draft) {
  const servings = app.getServings(foodId);
  if (draft.mode === 'serving' && !servings.some((s) => s.id === draft.servingId)) {
    return {
      draft: { ...draft, mode: 'grams', gramsText: draft.lastText !== null && draft.lastText !== undefined ? draft.lastText : draft.gramsText, servingId: null },
      notice: 'That serving no longer exists, so this is in grams now.'
    };
  }
  if (draft.mode === 'grams' && draft.servingId && !servings.some((s) => s.id === draft.servingId)) return { draft: { ...draft, servingId: null }, notice: '' };
  return { draft: { ...draft }, notice: '' };
}

/**
 * The draft as an amount: { amount, error }. amount is the domain's resolveAmount result
 * (canonical grams), or null with the code to show. A null code means nothing to say yet:
 * nothing typed, or a count still being typed ("1.", "1/", "1 1/", a lone "0" — the domain's
 * isUnfinishedServingCount). Either way there is no amount, so Log and Add to a meal stay off,
 * and pressing them shows the count message (log.js showAmountError).
 * Grams are read as the grams field always has (parseGrams) and passed through unchanged.
 */
export function resolveDraft(app, foodId, draft) {
  if (draft.mode !== 'serving') {
    const q = parseGrams(draft.gramsText);
    if (q === null) return { amount: null, error: String(draft.gramsText || '').trim() ? 'INVALID_QUANTITY' : null };
    return { amount: app.resolveAmount(foodId, { quantity: q }), error: null };
  }
  try {
    return { amount: app.resolveAmount(foodId, { servingId: draft.servingId, count: draft.countText }), error: null };
  } catch (e) {
    if (!e || !AMOUNT_CODES.has(e.code)) throw e;
    const typing = e.code === 'INVALID_SERVING_COUNT' && (!String(draft.countText || '').trim() || isUnfinishedServingCount(draft.countText));
    return { amount: null, error: typing ? null : e.code };
  }
}

/**
 * Switching mode (D9). Serving → grams fills the grams field with the canonical grams the
 * serving came to (the same number either way). Grams → serving picks the serving last
 * selected in this sheet if it still exists, else the first, at a count of 1.
 */
export function switchAmount(app, foodId, draft, mode, resolved = null) {
  if (mode === draft.mode) return { ...draft };
  if (mode === 'grams') {
    return { ...draft, mode: 'grams', gramsText: resolved && resolved.serving ? resolved.text : draft.gramsText };
  }
  const servings = app.getServings(foodId);
  if (!servings.length) return { ...draft };
  const servingId = servings.some((s) => s.id === draft.servingId) ? draft.servingId : servings[0].id;
  return { ...draft, mode: 'serving', servingId, countText: '1' };
}

/** Shown by Log / Add to a meal while serving mode has no usable amount (§5.5.1). */
export const SERVING_ACTIONS_HINT = 'Enter a number of servings greater than 0 to continue.';

/**
 * Whether serving mode is blocking the actions: the domain resolved no amount from the draft
 * (resolveDraft / resolveAmount). Nothing here parses or judges the count itself.
 */
export const servingActionsBlocked = (draft, resolved) => !!draft && draft.mode === 'serving' && !resolved;

/**
 * The hint beside the actions, for a Food with servings. Not a live region: it is read in place
 * and as the description of the count field and the disabled buttons, never announced per keystroke.
 */
export function renderActionsHint({ draft, resolved }) {
  return `<p id="qty-actions-hint" class="hint actions-hint" data-actions-hint${servingActionsBlocked(draft, resolved) ? '' : ' hidden'}>${SERVING_ACTIONS_HINT}</p>`;
}

/** "Logs as 45 g" — the canonical quantity as the domain wrote it; ≈ and "estimate" only for an approximate serving. */
export function renderServingGrams(amount) {
  if (!amount || !amount.serving) return '';
  const approx = amount.serving.approximate;
  const rounded = amount.rounded ? ' <span class="hint">(rounded to 0.01 g)</span>' : '';
  return approx
    ? `Logs as <span aria-hidden="true">≈ </span><span class="visually-hidden">approximately </span>${escapeHtml(amount.text)} g <span class="estimate-label">estimate</span>${rounded}`
    : `Logs as ${escapeHtml(amount.text)} g${rounded}`;
}

/** The grams field exactly as the quantity sheet has always had it (§5.5). */
export function renderGramsField(text) {
  return `<label class="field" for="qty-grams">Grams</label>
<span class="grams-input"><input id="qty-grams" type="text" inputmode="decimal" autocomplete="off" data-grams value="${escapeHtml(text || '')}" placeholder="grams" aria-describedby="qty-error"><span aria-hidden="true">g</span></span>
<p id="qty-error" class="field-error" data-grams-error hidden>Enter a weight above 0 g</p>`;
}

/**
 * The amount control for a Food that has servings: Servings / Grams, then either the serving,
 * its count and the quick picks, or the grams field. amount / error from resolveDraft.
 */
export function renderAmountControl({ servings, draft, amount = null, error = null }) {
  const serving = draft.mode === 'serving';
  const mode = `<fieldset class="slot-choice amount-mode">
<legend>Amount</legend>
<label class="radio-chip"><input type="radio" name="amount-mode" value="serving" data-amount-mode${serving ? ' checked' : ''}><span>Servings</span></label>
<label class="radio-chip"><input type="radio" name="amount-mode" value="grams" data-amount-mode${serving ? '' : ' checked'}><span>Grams</span></label>
</fieldset>`;
  if (!serving) return `${mode}\n${renderGramsField(draft.gramsText)}`;
  const options = servings.map((s) => `<option value="${escapeHtml(s.id)}"${s.id === draft.servingId ? ' selected' : ''}>${escapeHtml(s.label)}${s.approximate ? ' (estimate)' : ''}</option>`).join('');
  const picks = SERVING_COUNT_QUICK_PICKS.map((p) => `<button type="button" class="chip" data-action="count-pick" data-count-pick="${p}" aria-label="${PICK_NAME[p]}" aria-pressed="${String(draft.countText).trim() === p}">${PICK_FACE[p]}</button>`).join('');
  const message = error ? AMOUNT_MESSAGES[error] || AMOUNT_MESSAGES.INVALID_SERVING_COUNT : '';
  return `${mode}
<label class="field" for="qty-serving">Serving</label>
<select id="qty-serving" data-serving>${options}</select>
<label class="field" for="qty-count">Number of servings</label>
<span class="grams-input"><input id="qty-count" type="text" inputmode="decimal" autocomplete="off" data-count value="${escapeHtml(draft.countText || '')}" aria-describedby="qty-count-error qty-serving-grams${!amount && !error ? ' qty-actions-hint' : ''}"></span>
<div class="quick-picks" role="group" aria-label="Quick amounts">${picks}</div>
<p id="qty-count-error" class="field-error" data-count-error${message ? '' : ' hidden'}>${escapeHtml(message)}</p>
<p id="qty-serving-grams" class="serving-grams" data-serving-grams>${renderServingGrams(amount)}</p>`;
}

/* ---------------- Add a serving (§5.5.2) ---------------- */

export const SERVING_FORM_MESSAGES = Object.freeze({
  SERVING_LABEL_REQUIRED: 'Give it a name, for example scoop.',
  SERVING_LABEL_RESERVED: 'Grams are always available. Use another name.',
  SERVING_LABEL_DUPLICATE: 'This food already has a serving with that name.',
  INVALID_SERVING_GRAMS: 'Enter grams above 0, with up to 2 decimal places.'
});

export const emptyServingValues = () => ({ label: '', grams: '', approximate: false });

/** Whether the Add a serving form differs from the blank form it opened with (for "Discard changes?"). */
export const servingFormDirty = (form) => form.values.label !== form.initial.label || form.values.grams !== form.initial.grams || form.values.approximate !== form.initial.approximate;

/**
 * Form values → createServing's input. The grams text is read by the domain's parseServingGrams
 * (plain digits and one decimal point or comma; "45.", "1e2" or "0x10" are null), and
 * createServing validates the rest.
 */
export const servingInput = (values) => ({ label: values.label, grams: parseServingGrams(values.grams), approximate: values.approximate === true });

/** The Add a serving form. errors: the domain's details [{ field, code }] after a Save that failed. */
export function renderServingForm({ food, values, errors = [] }) {
  const errorFor = (field) => { const e = errors.find((x) => x.field === field); return e ? SERVING_FORM_MESSAGES[e.code] || 'Check this value.' : ''; };
  const fieldError = (field) => { const t = errorFor(field); return `<p id="srv-${field}-error" class="field-error"${t ? '' : ' hidden'}>${escapeHtml(t)}</p>`; };
  return `${viewHead('Add a serving', food.name)}
<p class="hint">A name for an amount of this food, and what it weighs. Logging still records grams.</p>
<label class="field" for="srv-label">Name</label>
<input id="srv-label" type="text" data-srv="label" value="${escapeHtml(values.label)}" autocomplete="off" placeholder="for example scoop" aria-describedby="srv-label-error"${errorFor('label') ? ' aria-invalid="true"' : ''}>
${fieldError('label')}
<label class="field" for="srv-grams">Grams in one serving</label>
<span class="grams-input"><input id="srv-grams" type="text" inputmode="decimal" data-srv="grams" value="${escapeHtml(values.grams)}" autocomplete="off" aria-describedby="srv-grams-error"${errorFor('grams') ? ' aria-invalid="true"' : ''}><span aria-hidden="true">g</span></span>
${fieldError('grams')}
<label class="radio-row"><input type="checkbox" data-srv="approximate"${values.approximate ? ' checked' : ''}><span class="radio-text"><span>This weight is an estimate</span><span class="hint">It shows ≈ and “estimate” wherever this serving is used.</span></span></label>
${errorSlot}
<div class="sheet-actions">
<button type="button" class="button primary" data-action="srv-save">Save serving</button>
<button type="button" class="button" data-action="close">Cancel</button>
</div>`;
}
