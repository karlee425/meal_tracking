/*
 * settings.js — Settings (V2_UI_CONTRACT.md §10) with manual Backup / Restore (§11).
 *
 * Sections in the contract's order (§10.1): Targets · My foods · Favourites · Foods not
 * suggested · Data on this device · About. Everything goes through the data layer:
 *   targets   getAllCurrentTargets · validateTargets (a dry run) · updateCurrentTargets ·
 *             previewApplyCurrentTargetsToToday / applyCurrentTargetsToToday (today only, on request)
 *   foods     getCustomFoods (A-36) → Food detail (foods.js) · the Custom Food form (log.js) ·
 *             setFavoriteMeal / setFavoriteFood / setDislikedFood with false to remove from a list
 *   backup    exportUserData → validateBackup (the text to be saved) → a local file
 *   restore   validateBackup (nothing changes) → preview → explicit confirm → restoreUserData
 *             (validated again, then one atomic replacement; any failure changes nothing)
 *   earlier-format copies (§11.3)  services.formatCopies.list() (read-only) → olderFormatBackup +
 *             validateBackup → "Download older-format backup" / "Download raw migration archive";
 *             neither download writes anything or updates lastBackupAt
 * There is no automatic backup, no sync and no reset here.
 */

import { BACKUP_FORMAT_VERSION, constants, olderFormatBackup } from '../src/domain/index.js';
import { escapeHtml, restoreErrorMessage, restoreFileErrorMessage, isArchiveConflict, backupSummaryText, exportedAtText, detailsDisclosure } from './shell.js';
import { DAY_TYPE_LABELS, dialogHead, errorSlot } from './today.js';
import { createViewHost, viewHead, syncInPlace } from './view-host.js';
import { resetSession } from './session.js';
import { MEAL_TYPE_LABELS, renderCustomFoodForm, customFoodInput, customFoodValues, customFoodPatch, customFoodDirty, validateCustomFoodForm } from './log.js';
import {
  foodDetailModel, renderFoodDetail, renderDeleteFood, renderDiscardFood, foodUsageMeals, foodDetailRow, renderLinkedMessage, createFoodActions,
  renderDeleteServing, servingFormValues
} from './foods.js';
import { renderServingForm, emptyServingValues, servingFormDirty, servingInput, servingPatch } from './amount.js';

/** The target form, Food detail and the Custom Food form are views; confirmations and the backup / restore sheets are short choices. */
export const SETTINGS_VIEW_TYPES = Object.freeze(['target-edit', 'food-detail', 'custom-food', 'serving-form']);
const FIELDS = Object.freeze([['protein', 'Protein'], ['carbs', 'Carbs'], ['fat', 'Fat']]);

/* ---------------- formatting ---------------- */

/** "P 150 · C 293 · F 70 g", exactly as stored (targets are shown as set, not re-rounded). */
export const targetLine = (t) => `P ${t.protein} · C ${t.carbs} · F ${t.fat} g`;

/** Text typed into a target field → the value the domain checks: undefined when empty (never NaN), a number otherwise. */
export function parseTargetInput(text) {
  const t = String(text == null ? '' : text).trim().replace(',', '.');
  if (!t) return undefined;
  return Number(t); // NaN / Infinity stay as they are: validateTargets rejects them
}
export const parseTargets = (values) => Object.fromEntries(FIELDS.map(([key]) => [key, parseTargetInput(values[key])]));

/** Save status for "Data on this device" (§10.1), from the data layer's persistence status. */
export function saveStatusText(status) {
  if (!status) return '';
  switch (status.state) {
    case 'saving': return 'Saving…';
    case 'error': return 'Your latest changes aren’t saved on this device yet.';
    case 'conflict': return isArchiveConflict(status)
      ? 'Saving is paused to protect your earlier data. Reloading won’t resolve this.'
      : 'Changed in another tab or window. Reload to continue.';
    default: return status.lastSavedAt ? `All changes saved · ${exportedAtText(status.lastSavedAt)}` : 'Nothing has needed saving yet.';
  }
}

/* ---------------- the screen ---------------- */

function targetsSection(targets) {
  const cards = constants.DAY_TYPES.map((type) => `<li class="target-card">
<h3 class="target-type">${DAY_TYPE_LABELS[type]}</h3>
<p class="target-values">${targetLine(targets[type])}</p>
<button type="button" class="button" data-action="edit-targets" data-type="${type}" aria-label="Edit ${DAY_TYPE_LABELS[type]} targets">Edit</button>
</li>`).join('\n');
  return `<section class="settings-section" aria-labelledby="targets-title">
<h2 id="targets-title" class="section-title">Targets</h2>
<p class="section-note">Daily targets in grams for each day type. A day keeps the targets it was set up with.</p>
<ul class="target-cards">
${cards}
</ul>
</section>`;
}

/* ---------------- My foods · Favourites · Foods not suggested (§10.1, A-31, A-32, A-36) ---------------- */

/**
 * The food lists Settings shows, straight from the domain: Custom Foods sorted by the domain
 * (name, then ID); favourites split into Saved Meals, Library bookmarks (A-15) and Foods; and
 * the Foods not to suggest. IDs that no longer resolve are left out (the domain removes them
 * on delete anyway).
 */
export function settingsFoodsModel(app) {
  const prefs = app.getPreferences();
  const meals = prefs.favoriteMeals.map((id) => app.getMeal(id)).filter(Boolean);
  const food = (id) => app.getFood(id);
  return {
    custom: app.getCustomFoods(),
    favoriteFoodIds: new Set(prefs.favoriteFoods),
    favorites: {
      saved: meals.filter((m) => m.source === 'saved'),
      library: meals.filter((m) => m.source === 'library'),
      foods: prefs.favoriteFoods.map(food).filter(Boolean)
    },
    notSuggested: prefs.dislikedFoods.map(food).filter(Boolean)
  };
}

function myFoodsSection(foods, note) {
  const list = foods.custom.length
    ? `<ul class="options" data-list="my-foods">${foods.custom.map((f) => foodDetailRow(f, { starred: foods.favoriteFoodIds.has(f.id) })).join('\n')}</ul>`
    : '<p class="empty-note">No foods of your own yet. Create one when something isn’t in search.</p>';
  return `<section class="settings-section" aria-labelledby="my-foods-title">
<h2 id="my-foods-title" class="section-title" tabindex="-1">My foods</h2>
<p class="section-note">Foods you’ve added, per 100 g. App foods can’t be changed.</p>
<div class="foods-message" data-foods-message role="status">${renderLinkedMessage(note)}</div>
${list}
<div class="sheet-actions"><button type="button" class="button" data-action="new-food">New food</button></div>
</section>`;
}

const mealLine = (meal) => `<span class="meal-name">${escapeHtml(meal.name)}</span>${meal.source === 'library' ? '<span class="marker">Library</span>' : ''}${meal.metadata && meal.metadata.retired ? '<span class="marker">Retired</span>' : ''}<span class="hint">${MEAL_TYPE_LABELS[meal.mealType] || 'Other'}</span>`;

function favouritesSection(foods) {
  const { saved, library } = foods.favorites;
  const mealGroup = (id, title, meals) => (meals.length ? `<section class="option-group" aria-labelledby="${id}"><h3 id="${id}" class="group-title">${title}</h3>
<ul class="options" data-list="${id}">${meals.map((m) => `<li class="option-row"><span class="option-text">${mealLine(m)}</span>
<button type="button" class="button" data-action="unfavorite-meal" data-meal="${escapeHtml(m.id)}" aria-label="Remove ${escapeHtml(m.name)} from favourites">Remove</button></li>`).join('\n')}</ul></section>` : '');
  const foodGroup = foods.favorites.foods.length ? `<section class="option-group" aria-labelledby="fav-foods"><h3 id="fav-foods" class="group-title">Foods</h3>
<ul class="options" data-list="fav-foods">${foods.favorites.foods.map((f) => foodDetailRow(f, {
    starred: true,
    trailing: `<button type="button" class="button" data-action="unfavorite-food" data-food="${escapeHtml(f.id)}" aria-label="Remove ${escapeHtml(f.name)} from favourites">Remove</button>`
  })).join('\n')}</ul></section>` : '';
  const any = saved.length || library.length || foods.favorites.foods.length;
  return `<section class="settings-section" aria-labelledby="favourites-title">
<h2 id="favourites-title" class="section-title" tabindex="-1">Favourites</h2>
${any ? `${mealGroup('fav-saved', 'Saved meals', saved)}
${mealGroup('fav-library', 'Library bookmarks', library)}
${foodGroup}` : '<p class="empty-note">Nothing starred yet. Star meals in Meals, and foods from their details.</p>'}
</section>`;
}

function notSuggestedSection(foods) {
  const list = foods.notSuggested.length
    ? `<ul class="options" data-list="not-suggested">${foods.notSuggested.map((f) => foodDetailRow(f, {
      starred: foods.favoriteFoodIds.has(f.id),
      trailing: `<button type="button" class="button" data-action="suggest-again" data-food="${escapeHtml(f.id)}" aria-label="Suggest ${escapeHtml(f.name)} again">Suggest again</button>`
    })).join('\n')}</ul>`
    : '<p class="empty-note">None. Choose “Don’t suggest this food” in a food’s details to leave it out.</p>';
  return `<section class="settings-section" aria-labelledby="not-suggested-title">
<h2 id="not-suggested-title" class="section-title" tabindex="-1">Foods not suggested</h2>
<p class="section-note">Left out of Build My Next Meal. They still show in search and your lists.</p>
${list}
</section>`;
}

/** The restore outcome line: an alert for problems (nothing changed), a status for success. */
export function restoreMessage(r) {
  if (!r) return '';
  return `<p>${escapeHtml(r.message)}</p>${r.tone === 'error' ? detailsDisclosure(r.code, r.errors) : ''}`;
}

/** §10.1: the browser's answer to requestPersistentStorage() — "Yes" only when it granted protection. */
export const protectionText = (state) => (state === 'granted' ? 'Yes' : 'Not granted');

/* ---------------- earlier-format copies (§11.3) ---------------- */

/**
 * The earlier-format copies for "Data on this device", from services.formatCopies.list():
 *   load = { state: 'loading' } | { state: 'error', code, errors } | { state: 'ready', copies }
 * For each copy whose original record is a well-formed version-1 record (no inspection problems,
 * pending or archived alike), the older-format backup is built (olderFormatBackup: the pre-upgrade
 * data, copied exactly) and validated through the domain (validateBackup). Only a valid one is
 * offered. Nothing is written here.
 */
export function formatCopiesModel(app, load) {
  if (!load || load.state !== 'ready') return load || null;
  return {
    state: 'ready',
    copies: load.copies.map((copy) => {
      let older;
      if (!copy.original || (copy.problems && copy.problems.length)) {
        older = { valid: false, code: null, errors: copy.problems && copy.problems.length ? copy.problems : ['the original record can’t be read'] };
      } else {
        try {
          const backup = olderFormatBackup(copy.original);
          const check = app.validateBackup(backup);
          older = check.valid && check.formatVersion === 1
            ? { valid: true, backup, summary: check.summary }
            : { valid: false, code: check.code || 'BACKUP_INVALID', errors: check.errors || [] };
        } catch (e) {
          older = { valid: false, code: (e && e.code) || 'BACKUP_INVALID', errors: (e && e.details) || [] };
        }
      }
      return { ...copy, older };
    })
  };
}

/**
 * Loads the copies list for Settings, read-only. Each load gets a generation number and only the
 * newest load's answer is kept, so an older response never replaces a newer one. After a save,
 * the list is read again while it is still loading or still shows a pending copy (the first
 * save stores that copy as a migration archive). onChange(model) gets every state, starting
 * with { state: 'loading' }.
 */
export function createCopiesLoader(app, list, onChange) {
  let generation = 0;
  let current = { state: 'loading' };
  let stopped = false;
  function load() {
    const mine = ++generation;
    current = { state: 'loading' };
    onChange(current);
    return Promise.resolve()
      .then(() => list())
      .then((copies) => formatCopiesModel(app, { state: 'ready', copies }),
        (e) => ({ state: 'error', code: (e && e.code) || null, errors: e && e.message ? [e.message] : [] }))
      .then((next) => {
        if (stopped || mine !== generation) return;
        current = next;
        onChange(current);
      });
  }
  function onStatus(status) {
    if (stopped || !status || status.state !== 'saved') return;
    if (current.state === 'loading' || (current.state === 'ready' && current.copies.some((c) => c.kind === 'pending'))) load();
  }
  return { load, onStatus, current: () => current, stop() { stopped = true; } };
}

function formatCopyItem(c, i) {
  const when = c.savedAt ? exportedAtText(c.savedAt) : 'an unknown date';
  const rev = c.revision ? ` (revision ${c.revision})` : '';
  const malformed = !!(c.problems && c.problems.length > 0) || !c.original;
  const label = c.kind === 'pending' ? 'Pre-upgrade copy' : 'Migration archive';
  const what = malformed
    ? `<p><strong>${label}:</strong> it isn’t in the expected form, so an older-format backup can’t be made from it.</p>${detailsDisclosure(null, c.problems || [])}`
    : c.kind === 'pending'
      ? `<p><strong>Pre-upgrade copy:</strong> your data as the earlier version saved it on ${escapeHtml(when)}${rev}. It hasn’t been stored as a migration archive yet. Your next change upgrades the data on this device and keeps this copy as one.</p>`
      : `<p><strong>Migration archive:</strong> your data as the earlier version saved it on ${escapeHtml(when)}${rev}, kept when this app upgraded it.</p>`;
  let older = '';
  if (c.older && c.older.valid) {
    older = `<button type="button" class="button" data-action="download-older-backup" data-copy="${i}">Download older-format backup</button> <span class="hint">A backup the earlier version of the app can restore.</span>`;
  } else if (!malformed) {
    older = `<p>An older-format backup can’t be made from this copy.</p>${detailsDisclosure(c.older && c.older.code, (c.older && c.older.errors) || [])}`;
  }
  let raw = '';
  if (c.kind === 'archive') {
    raw = c.exactJson
      ? `<button type="button" class="button" data-action="download-raw-archive" data-copy="${i}">Download raw migration archive</button> <span class="hint">Not a backup; it can’t be restored.</span>`
      : '<p>This archive can’t be saved exactly as a file, so it isn’t offered for download.</p>';
  }
  return `<li class="format-copy">
${what}
${older ? `<div>${older}</div>` : ''}
${raw ? `<div>${raw}</div>` : ''}
</li>`;
}

/** The inside of the earlier-format copies block: loading, can't be read, none, or one item per copy. */
export function renderFormatCopiesBody(model) {
  if (!model) return '';
  if (model.state === 'loading') return '<p class="hint" role="status">Checking for an earlier-format copy…</p>';
  if (model.state === 'error') return `<div role="alert"><p>Earlier-format copies couldn’t be read. Nothing was changed.</p>${detailsDisclosure(model.code, model.errors || [])}</div>`;
  if (!model.copies.length) return '<p class="hint">No earlier-format copy on this device. One is kept only when this app upgrades data saved by an earlier version.</p>';
  return `<ul class="format-copies">
${model.copies.map(formatCopyItem).join('\n')}
</ul>`;
}

function formatCopiesBlock(model) {
  if (!model) return '';
  return `<div class="format-copies-block" aria-labelledby="format-copies-title">
<h3 id="format-copies-title">Earlier-format copies</h3>
<div data-format-copies>${renderFormatCopiesBody(model)}</div>
<p class="hint" role="status" data-format-copies-note></p>
</div>`;
}

function dataSection({ status, lastBackupAt, restore, protection, formatCopies = null }) {
  return `<section class="settings-section" aria-labelledby="data-title">
<h2 id="data-title" class="section-title">Data on this device</h2>
<dl class="data-facts">
<div><dt>Save status</dt><dd><span data-save-status>${escapeHtml(saveStatusText(status))}</span>${status && status.state === 'error' ? ' <button type="button" class="link-button" data-action="retry-save">Try again</button>' : ''}</dd></div>
<div><dt>Protected from automatic clean-up</dt><dd><span data-storage-protection>${protectionText(protection)}</span></dd></div>
<div><dt>Last backup</dt><dd>${lastBackupAt ? escapeHtml(exportedAtText(lastBackupAt)) : 'Never'}</dd></div>
</dl>
<p class="section-note">A backup is a file you download and keep yourself. The app doesn’t back up automatically, and nothing leaves this device.</p>
<div class="sheet-actions">
<button type="button" class="button" data-action="backup">Download backup</button>
<button type="button" class="button" data-action="restore">Restore from backup</button>
<input type="file" accept=".json,application/json" data-restore-file hidden tabindex="-1" aria-hidden="true">
</div>
<div class="restore-message${restore && restore.tone === 'error' ? ' is-error' : ''}" data-restore-message role="${restore && restore.tone === 'error' ? 'alert' : 'status'}">${restoreMessage(restore)}</div>
${formatCopiesBlock(formatCopies)}
</section>`;
}

function aboutSection() {
  return `<section class="settings-section" aria-labelledby="about-title">
<h2 id="about-title" class="section-title">About</h2>
<dl class="data-facts">
<div><dt>App</dt><dd>Macro Tracker</dd></div>
<div><dt>App version</dt><dd>Version unavailable</dd></div>
<div><dt>Data format version</dt><dd>${BACKUP_FORMAT_VERSION}</dd></div>
</dl>
<p class="section-note">Macros only: protein, carbs and fat, in grams.</p>
</section>`;
}

export function renderSettings({ targets, status, lastBackupAt, restore, foods, foodsNote = null, protection = null, formatCopies = null }) {
  return `<h1 id="screen-title" class="screen-title" tabindex="-1">Settings</h1>
${targetsSection(targets)}
${myFoodsSection(foods, foodsNote)}
${favouritesSection(foods)}
${notSuggestedSection(foods)}
${dataSection({ status, lastBackupAt, restore, protection, formatCopies })}
${aboutSection()}`;
}

/* ---------------- targets (§10.2, §10.3) ---------------- */

// Wording for the domain's codes (§13 error table: "Targets need to be whole grams, 0 or more"); the rule itself is validateTargets.
const TARGET_MESSAGES = Object.freeze({
  TARGET_NOT_A_VALID_NUMBER: 'Enter whole grams, 0 or more.',
  TARGET_NOT_A_WHOLE_NUMBER: 'Use whole grams, no decimals.'
});

/** The form for one day type. Checked by the domain (validateTargets) as fields change; Save is disabled while invalid or unchanged. */
export function renderTargetForm({ dayType, values, original, validation, touched }) {
  const parsed = parseTargets(values);
  const unchanged = FIELDS.every(([key]) => parsed[key] === original[key]);
  const invalidFields = new Set(validation.errors.map((e) => e.field));
  const needs = !validation.valid
    ? `Needed before saving: ${FIELDS.filter(([key]) => invalidFields.has(key)).map(([, label]) => label.toLowerCase()).join(', ')} as whole grams, 0 or more.`
    : unchanged ? 'No changes yet.' : '';
  const field = ([key, label]) => {
    const err = validation.errors.find((e) => e.field === key);
    const shown = err && touched.has(key);
    return `<div class="amount-field"><label class="field" for="tf-${key}">${label}</label>
<span class="grams-input"><input id="tf-${key}" type="text" inputmode="numeric" autocomplete="off" data-target-field="${key}" value="${escapeHtml(values[key])}" aria-describedby="tf-${key}-error" data-sync="tf-${key}-state"${shown ? ' aria-invalid="true"' : ''}><span aria-hidden="true">g</span></span>
<p id="tf-${key}-error" class="field-error" data-sync="tf-${key}-error"${shown ? '' : ' hidden'}>${shown ? escapeHtml(TARGET_MESSAGES[err.code] || TARGET_MESSAGES.TARGET_NOT_A_VALID_NUMBER) : ''}</p></div>`;
  };
  return `${viewHead(`Edit ${DAY_TYPE_LABELS[dayType]} targets`, 'Daily targets in grams')}
<div class="banner banner-info" role="note"><p>Changes apply to days you set up from now on. Days already set up keep their targets.</p></div>
<fieldset class="per-100"><legend>Targets</legend>
${FIELDS.map(field).join('\n')}
</fieldset>
<p id="tf-needs" class="hint" data-sync="tf-needs"${needs ? '' : ' hidden'}${validation.valid ? '' : ` data-first-invalid="tf-${(FIELDS.find(([key]) => invalidFields.has(key)) || FIELDS[0])[0]}"`}>${needs}</p>
${errorSlot}
<div class="sheet-actions">
<button type="button" class="button primary" data-action="target-save" data-sync="tf-save" aria-describedby="tf-needs"${validation.valid && !unchanged ? '' : ' disabled'}>Save</button>
<button type="button" class="button" data-action="close">Cancel</button>
</div>`;
}

export function renderTargetConfirm({ dayType, parsed }) {
  const type = DAY_TYPE_LABELS[dayType];
  return `${dialogHead('Change targets?')}
<p>Change <strong>${type}</strong> targets to P ${parsed.protein} · C ${parsed.carbs} · F ${parsed.fat}? This applies to days you set up from now on. Days already set up keep their targets.</p>
${errorSlot}
<div class="sheet-actions"><button type="button" class="button primary" data-action="target-confirm">Change ${type} targets</button><button type="button" class="button" data-action="close">Cancel</button></div>`;
}

export function renderApplyToday({ dayType, preview }) {
  const type = DAY_TYPE_LABELS[dayType];
  return `${dialogHead('Also use these targets for today?')}
<p>Today is a ${type} day set up with ${targetLine(preview.from)}. Using the new targets changes today only: ${targetLine(preview.to)}. Logged food, today’s day type and other days don’t change.</p>
${errorSlot}
<div class="sheet-actions"><button type="button" class="button primary" data-action="apply-today">Use for today</button><button type="button" class="button" data-action="close" data-autofocus>Not now</button></div>`;
}

export function renderDiscardTargets() {
  return `${dialogHead('Discard changes?')}
<p>Your target changes haven’t been saved.</p>
<div class="sheet-actions"><button type="button" class="button primary" data-action="keep-editing" data-autofocus>Keep editing</button><button type="button" class="button danger" data-action="discard">Discard</button></div>`;
}

/* ---------------- backup (§11.1) and restore (§11.2) ---------------- */

export function renderBackupSheet({ summary, note }) {
  return `${dialogHead('Download backup')}
<p>Backup of everything you’ve entered on this device: ${summary.days} logged ${summary.days === 1 ? 'day' : 'days'}, ${summary.savedMeals} saved ${summary.savedMeals === 1 ? 'meal' : 'meals'}, ${summary.customFoods} of your foods.</p>
<p class="hint">It’s a file you keep yourself. Restoring it later replaces the data on this device.</p>
${note ? `<p class="field-error" role="alert">${escapeHtml(note)}</p>` : ''}
<div class="sheet-actions"><button type="button" class="button primary" data-action="backup-download">Download</button><button type="button" class="button" data-action="close">Cancel</button></div>`;
}

const countOf = (n, one, many) => `${n} ${n === 1 ? one : many}`;
/**
 * What a restore does to reserved serving IDs (C5), from validateBackup's or restoreUserData's
 * servingIds ({ carriedForward, revived }), for the preview ('preview') or the result ('result').
 * Empty when neither applies, so ordinary restores read exactly as before.
 */
export function servingIdsText(servingIds, when = 'preview') {
  if (!servingIds || (!servingIds.carriedForward && !servingIds.revived)) return '';
  const { carriedForward: kept, revived } = servingIds;
  const parts = [];
  if (kept) {
    parts.push(when === 'preview'
      ? `${countOf(kept, 'serving', 'servings')} on this device ${kept === 1 ? 'isn’t' : 'aren’t'} in the backup and will be removed; ${kept === 1 ? 'its ID stays' : 'their IDs stay'} reserved so ${kept === 1 ? 'it’s' : 'they’re'} never reused`
      : `${countOf(kept, 'serving', 'servings')} removed, ${kept === 1 ? 'its ID' : 'their IDs'} kept reserved`);
  }
  if (revived) {
    parts.push(when === 'preview'
      ? `${countOf(revived, 'serving', 'servings')} deleted on this device will come back from the backup`
      : `${countOf(revived, 'deleted serving', 'deleted servings')} brought back from the backup`);
  }
  return `Servings: ${parts.join('; ')}.`;
}

/** The preview and confirmation before anything is replaced. Cancel has the focus. */
export function renderRestorePreview({ summary, current, exportedAt, note, servingIds = null }) {
  const servings = servingIdsText(servingIds, 'preview');
  return `${dialogHead('Restore this backup?')}
<p>Backup from ${escapeHtml(exportedAtText(exportedAt))}: ${escapeHtml(backupSummaryText(summary))}.</p>
<p class="hint">On this device now: ${escapeHtml(backupSummaryText(current))}.</p>${servings ? `\n<p class="hint">${escapeHtml(servings)}</p>` : ''}
<div class="banner" role="note"><p>Restoring <strong>replaces everything</strong> in the app on this device: targets, your foods, saved meals, every logged day and your preferences. It can’t be undone.</p></div>
<button type="button" class="button restore-keep" data-action="download-current">Download current data first</button>
${note ? `<p class="hint" role="status">${escapeHtml(note)}</p>` : ''}
${errorSlot}
<div class="sheet-actions"><button type="button" class="button" data-action="close" data-autofocus>Cancel</button><button type="button" class="button danger" data-action="restore-confirm">Replace my data</button></div>`;
}

/* ---------------- DOM wiring ---------------- */

/** The Settings screen, mounted by the shell into <main>. */
export const settingsScreen = {
  mount(main, { app, win, doc, services = {} }) {
    let ui = null;
    let restore = null; // the last restore outcome, shown in "Data on this device"
    let foodsNote = null; // the last Custom Food delete outcome, shown in "My foods"
    let foodOrigin = null; // the list Food detail was opened from, so focus can go back to that row
    const foodActions = createFoodActions(app);
    // Earlier-format copies (§11.3): read asynchronously, never blocking the screen; read-only.
    let copies = services.formatCopies ? { state: 'loading' } : null;
    const copiesLoader = services.formatCopies
      ? createCopiesLoader(app, () => services.formatCopies.list(), (next) => { copies = next; drawCopies(); })
      : null;

    main.innerHTML = `<div class="settings-page view-page" data-settings-page>
<div class="settings-screen" data-settings-body></div>
<dialog class="sheet" aria-labelledby="sheet-title" data-sheet></dialog>
</div>
<p class="visually-hidden" role="status" aria-live="polite" data-settings-status></p>`;
    const page = main.querySelector('[data-settings-page]');
    const body = main.querySelector('[data-settings-body]');
    const dialog = main.querySelector('[data-sheet]');
    const statusEl = main.querySelector('[data-settings-status]');
    const announce = (text) => { statusEl.textContent = ''; statusEl.textContent = text; };

    function render() {
      body.innerHTML = renderSettings({
        targets: app.getAllCurrentTargets(),
        status: app.getPersistenceStatus(),
        lastBackupAt: (app.getPreferences().appPreferences || {}).lastBackupAt || null,
        restore,
        foods: settingsFoodsModel(app),
        foodsNote,
        protection: services.storageProtection ? services.storageProtection.state() : null,
        formatCopies: copies
      });
    }
    function drawCopies() {
      const el = body.querySelector('[data-format-copies]');
      if (el) el.innerHTML = renderFormatCopiesBody(copies);
    }
    function copiesNote(text) {
      const el = body.querySelector('[data-format-copies-note]');
      if (el) { el.textContent = ''; el.textContent = text; }
    }
    function loadCopies() {
      if (copiesLoader) copiesLoader.load();
    }
    // Keep the save-status line current without re-rendering (or moving focus).
    const unsubscribe = app.onPersistenceChange((status) => {
      const el = body.querySelector('[data-save-status]');
      if (el) el.textContent = saveStatusText(status);
      // The first save after an upgrade stores the pending copy as a migration archive: re-read.
      if (copiesLoader) copiesLoader.onStatus(status);
    });
    // The browser's answer can arrive while Settings is open (it's asked after the first save).
    const unsubscribeProtection = services.storageProtection
      ? services.storageProtection.onChange((state) => {
        const el = body.querySelector('[data-storage-protection]');
        if (el) el.textContent = protectionText(state);
      })
      : null;

    const host = createViewHost({
      page, dialog, win, doc,
      viewTypes: SETTINGS_VIEW_TYPES,
      fallbackFocus: () => main.querySelector('#screen-title'),
      onClose: () => { ui = null; },
      beforeLeave
    });
    this._cleanup = () => { if (copiesLoader) copiesLoader.stop(); host.destroy(); if (typeof unsubscribe === 'function') unsubscribe(); if (unsubscribeProtection) unsubscribeProtection(); };

    function draw() {
      if (!ui) return;
      switch (ui.type) {
        case 'target-edit': dialog.innerHTML = renderTargetForm(ui); break;
        case 'target-confirm': dialog.innerHTML = renderTargetConfirm(ui); break;
        case 'apply-today': dialog.innerHTML = renderApplyToday(ui); break;
        case 'discard': dialog.innerHTML = renderDiscardTargets(); break;
        case 'backup': dialog.innerHTML = renderBackupSheet(ui); break;
        case 'restore-preview': dialog.innerHTML = renderRestorePreview(ui); break;
        case 'food-detail': dialog.innerHTML = renderFoodDetail({ ...ui, context: 'settings' }); break;
        case 'custom-food': dialog.innerHTML = renderCustomFoodForm(ui); break;
        case 'food-delete': dialog.innerHTML = renderDeleteFood(ui); break;
        case 'serving-form': dialog.innerHTML = renderServingForm(ui); break;
        case 'serving-delete': dialog.innerHTML = renderDeleteServing(ui); break;
        case 'discard-food': dialog.innerHTML = ui.form.type === 'serving-form'
          ? renderDiscardFood({ serving: ui.form.mode === 'add', editedServing: ui.form.mode === 'edit' })
          : renderDiscardFood(); break;
        default: break;
      }
    }
    const show = (next) => { ui = next; host.open(ui.type, draw); };
    const formDirty = (form) => FIELDS.some(([key]) => parseTargetInput(form.values[key]) !== form.original[key]);
    function backToForm(form) { show(form); }
    function beforeLeave() {
      if (!ui) return true;
      if (ui.type === 'target-edit' && formDirty(ui)) { show({ type: 'discard', form: ui }); return false; }
      if (ui.type === 'target-confirm' || ui.type === 'discard') { backToForm(ui.form); return false; }
      // The food forms step back to the view they came from, asking first about unsaved edits (§3.2).
      if (ui.type === 'custom-food') {
        if (customFoodDirty(ui)) { show({ type: 'discard-food', form: ui }); return false; }
        if (ui.mode === 'edit') { openFoodDetail(ui.foodId); return false; }
        return true;
      }
      if (ui.type === 'serving-form') {
        if (servingFormDirty(ui)) { show({ type: 'discard-food', form: ui }); return false; }
        backToDetail(ui.food.id, ui.servingId ? `[data-action="fd-serving-edit"][data-serving="${ui.servingId}"]` : null);
        return false;
      }
      if (ui.type === 'serving-delete') { backToDetail(ui.food.id, `[data-action="fd-serving-delete"][data-serving="${ui.serving.id}"]`); return false; }
      if (ui.type === 'discard-food') { backToForm(ui.form); return false; }
      if (ui.type === 'food-delete') { openFoodDetail(ui.food.id); return false; }
      return true;
    }
    /**
     * Before Settings is left (another tab, a link, browser Back) or a Settings control replaces
     * the open pane: true when no form holds unsaved changes; otherwise "Discard changes?" asks
     * and proceed() runs only after Discard (§3.2, I-01).
     */
    function guardLeave(proceed) {
      if (!ui) return true;
      if (ui.type === 'discard' || ui.type === 'discard-food') {
        ui.proceed = proceed;
        const keep = dialog.querySelector('[data-action="keep-editing"]');
        if (keep) keep.focus();
        return false;
      }
      if (ui.type === 'target-edit' && formDirty(ui)) { show({ type: 'discard', form: ui, proceed }); return false; }
      if (ui.type === 'target-confirm' && formDirty(ui.form)) { show({ type: 'discard', form: ui.form, proceed }); return false; }
      if (ui.type === 'custom-food' && customFoodDirty(ui)) { show({ type: 'discard-food', form: ui, proceed }); return false; }
      if (ui.type === 'serving-form' && servingFormDirty(ui)) { show({ type: 'discard-food', form: ui, proceed }); return false; }
      return true;
    }
    this._leaveGuard = guardLeave;

    /* ---- My foods, Favourites, Foods not suggested ---- */
    function openFoodDetail(foodId, note = '') {
      const detail = foodDetailModel(app, foodId);
      if (!detail) { render(); if (dialog.open) host.close(); announce('That food no longer exists.'); return; }
      ui = { type: 'food-detail', ...detail, note };
      host.open(ui.type, draw, { startAtTitle: true });
      returnToFoodRow(foodId);
    }
    /** After the lists re-render behind Food detail, closing it returns to the same Food's row. */
    function returnToFoodRow(foodId) {
      const rows = [...body.querySelectorAll(`[data-action="food-detail"][data-food="${foodId}"]`)];
      const row = rows.find((r) => r.closest(`[data-list="${foodOrigin}"]`)) || rows[0];
      host.returnFocusTo(row || body.querySelector('#my-foods-title'));
    }
    /** Favourite / Don't suggest changed from Food detail: the lists behind it and the detail's controls (in place). */
    function refreshFoodDetail(message) {
      Object.assign(ui, foodDetailModel(app, ui.food.id));
      render();
      returnToFoodRow(ui.food.id);
      syncInPlace(dialog, renderFoodDetail({ ...ui, context: 'settings' }), doc);
      const el = dialog.querySelector('[data-food-status]');
      if (el) { el.textContent = ''; el.textContent = message; }
    }
    /* ---- servings on Food detail (C7, §7.3): Add · Edit · Delete · Make default ---- */
    /** The serving a Food detail control names, as stored now — never another one (null: it's gone). */
    const currentServing = (foodId, servingId) => app.getServings(foodId).find((s) => s.id === servingId) || null;
    /** Food detail again, from the domain as it is now; then focus and say what happened. */
    function backToDetail(foodId, focusSelector, message = '') {
      openFoodDetail(foodId);
      if (!ui || ui.type !== 'food-detail') return;
      const target = (focusSelector && dialog.querySelector(focusSelector)) || dialog.querySelector('[data-action="fd-serving-add"]');
      if (target) target.focus();
      if (message) { const el = dialog.querySelector('[data-food-status]'); if (el) { el.textContent = ''; el.textContent = message; } }
    }
    /** A serving that no longer exists (deleted elsewhere): Food detail as it is now, and say so. Nothing is changed. */
    const servingGone = (foodId) => backToDetail(foodId, null, 'That serving no longer exists.');
    function openDetailServingForm(mode, serving = null) {
      const values = serving ? servingFormValues(serving) : emptyServingValues();
      show({ type: 'serving-form', mode, food: ui.food, foodId: ui.food.id, servingId: serving ? serving.id : null, values, initial: { ...values }, errors: [] });
    }
    /** Save Add / Edit serving: one domain call; field problems stay on the form; success returns to Food detail. */
    function saveServingFromDetail() {
      const form = ui;
      let result;
      try {
        result = form.mode === 'edit'
          ? foodActions.updateServing(form.food, form.servingId, servingPatch(form.values, form.initial))
          : foodActions.addServing(form.food, servingInput(form.values));
      } catch (e) {
        if (!e || e.code !== 'INVALID_SERVING') throw e;
        form.errors = e.details || [];
        draw();
        const first = form.errors.find((x) => x.field === 'label' || x.field === 'grams');
        const field = dialog.querySelector(`#srv-${first ? first.field : 'label'}`);
        if (field) field.focus();
        return;
      }
      backToDetail(form.food.id, `[data-action="fd-serving-edit"][data-serving="${result.serving.id}"]`, result.message);
    }
    /** Delete confirmed: the serving named by the dialog, by ID. Focus the next row, else Add a serving. */
    function deleteServingConfirmed() {
      const { food, serving } = ui;
      const index = app.getServings(food.id).findIndex((s) => s.id === serving.id);
      const result = foodActions.deleteServing(food, serving);
      const next = result.remaining[Math.min(Math.max(index, 0), result.remaining.length - 1)];
      backToDetail(food.id, next ? `[data-action="fd-serving-edit"][data-serving="${next.id}"]` : null, result.message);
    }
    function openFoodForm(form) {
      form.validation = validateCustomFoodForm(app, form);
      show(form);
    }
    function syncFoodForm() {
      ui.validation = validateCustomFoodForm(app, ui);
      syncInPlace(dialog, renderCustomFoodForm(ui), doc);
    }
    /**
     * After removing an item from a list, focus the next item's button in the same list, or the
     * section heading when the list is now empty (so focus never falls back to the page top).
     */
    function removedFrom(listSelector, index, headingId, message) {
      render();
      const buttons = [...body.querySelectorAll(`${listSelector} [data-action]:not(.option-main)`)];
      const next = buttons[Math.min(index, buttons.length - 1)];
      (next || body.querySelector(`#${headingId}`)).focus();
      announce(message);
    }
    const indexIn = (el) => [...el.closest('ul').querySelectorAll('[data-action]:not(.option-main)')].indexOf(el);
    function showDialogError(e) {
      const el = dialog.querySelector('[data-error]');
      const text = e && e.code === 'INVALID_TARGETS' ? 'Targets need to be whole grams, 0 or more.'
        : e && e.code === 'INVALID_FOOD' ? 'Check the fields above.'
          : e && (e.code === 'FOOD_NOT_FOUND' || e.code === 'NOT_FOUND') ? 'That food no longer exists.'
            : 'That didn’t save. Nothing was changed.';
      if (el) { el.textContent = text; el.hidden = false; } else announce(text);
    }
    function setRestore(next) {
      restore = next;
      const el = body.querySelector('[data-restore-message]');
      if (!el) return;
      el.setAttribute('role', next && next.tone === 'error' ? 'alert' : 'status');
      el.classList.toggle('is-error', !!(next && next.tone === 'error'));
      el.innerHTML = restoreMessage(next);
    }

    /* ---- restore: read → validate (nothing changes) → preview → confirm → replace ---- */
    async function onRestoreFile(input) {
      const file = input.files && input.files[0];
      input.value = '';
      if (!file) return;
      let text;
      try { text = await file.text(); } catch {
        setRestore({ tone: 'error', message: restoreErrorMessage('BACKUP_UNREADABLE'), code: 'BACKUP_UNREADABLE', errors: [] });
        return;
      }
      const result = app.validateBackup(text); // the file's own format decides, not its extension
      if (!result.valid) {
        // A raw migration archive is never a backup: it stays refused, and the message says what it is.
        setRestore({ tone: 'error', message: restoreFileErrorMessage(result.code, text), code: result.code, errors: result.errors });
        return;
      }
      setRestore(null);
      show({ type: 'restore-preview', text, summary: result.summary, servingIds: result.servingIds, current: app.validateBackup(app.exportUserData()).summary, exportedAt: JSON.parse(text).exportedAt, note: '' });
    }

    main.addEventListener('input', (event) => {
      const el = event.target;
      if (ui && ui.type === 'custom-food' && el.matches('[data-cf]')) {
        ui.values[el.dataset.cf] = el.value;
        ui.touched.add(el.dataset.cf); // errors show as the user edits (§7.4)
        syncFoodForm();
        return;
      }
      if (ui && ui.type === 'serving-form' && el.matches('[data-srv="label"], [data-srv="grams"]')) {
        ui.values[el.dataset.srv] = el.value;
        const err = dialog.querySelector(`#srv-${el.dataset.srv}-error`);
        if (err) err.hidden = true;
        el.removeAttribute('aria-invalid');
        return;
      }
      if (ui && ui.type === 'target-edit' && el.matches('[data-target-field]')) {
        ui.values[el.dataset.targetField] = el.value;
        ui.touched.add(el.dataset.targetField);
        ui.validation = app.validateTargets(parseTargets(ui.values));
        syncInPlace(dialog, renderTargetForm(ui), doc);
      }
    });
    main.addEventListener('change', (event) => {
      if (event.target.matches('[data-restore-file]')) onRestoreFile(event.target);
      else if (ui && ui.type === 'serving-form' && event.target.matches('[data-srv="approximate"]')) ui.values.approximate = event.target.checked;
      else if (ui && ui.type === 'custom-food' && event.target.matches('[data-cf]')) {
        ui.values[event.target.dataset.cf] = event.target.value;
        ui.touched.add(event.target.dataset.cf);
        syncFoodForm();
      }
    });

    main.addEventListener('click', (event) => {
      const el = event.target.closest('[data-action]');
      if (!el || !main.contains(el)) return;
      // A Settings control used beside an open pane (wide screens) would replace an unsaved form: ask first.
      if (dialog.open && !dialog.contains(el) && !guardLeave(() => { if (el.isConnected) el.click(); })) return;
      try {
        switch (el.dataset.action) {
          case 'close': if (beforeLeave()) host.close(); break;
          case 'retry-save': app.retryPersistence(); break;

          /* targets */
          case 'edit-targets': {
            const dayType = el.dataset.type;
            const original = app.getCurrentTargets(dayType);
            const values = Object.fromEntries(FIELDS.map(([key]) => [key, String(original[key])]));
            show({ type: 'target-edit', dayType, original, values, touched: new Set(), validation: app.validateTargets(parseTargets(values)) });
            break;
          }
          case 'target-save': {
            const parsed = parseTargets(ui.values);
            ui.validation = app.validateTargets(parsed);
            if (!ui.validation.valid || !formDirty(ui)) { FIELDS.forEach(([key]) => ui.touched.add(key)); syncInPlace(dialog, renderTargetForm(ui), doc); break; }
            show({ type: 'target-confirm', dayType: ui.dayType, parsed, form: ui });
            break;
          }
          case 'target-confirm': {
            const { dayType, parsed } = ui;
            app.updateCurrentTargets(dayType, parsed); // validated again by the domain; past days keep their snapshots
            render();
            announce(`${DAY_TYPE_LABELS[dayType]} targets updated. Days already set up keep their targets.`);
            const preview = app.previewApplyCurrentTargetsToToday();
            if (preview.exists && preview.dayType === dayType && preview.applies) show({ type: 'apply-today', dayType, preview });
            else { host.returnFocusTo(body.querySelector(`[data-action="edit-targets"][data-type="${dayType}"]`)); host.close(); }
            break;
          }
          case 'apply-today': {
            const { dayType } = ui;
            app.applyCurrentTargetsToToday();
            announce(`Today now uses your current ${DAY_TYPE_LABELS[dayType]} targets. Logged food didn’t change.`);
            host.returnFocusTo(body.querySelector(`[data-action="edit-targets"][data-type="${dayType}"]`));
            host.close();
            break;
          }
          case 'keep-editing': backToForm(ui.form); break;
          case 'discard':
            if (ui.proceed) {
              const proceed = ui.proceed;
              dialog.addEventListener('close', () => win.setTimeout(proceed, 0), { once: true });
              host.close();
            } else if (ui.type === 'discard-food' && ui.form.type === 'serving-form') {
              backToDetail(ui.form.food.id, ui.form.servingId ? `[data-action="fd-serving-edit"][data-serving="${ui.form.servingId}"]` : null);
            } else if (ui.type === 'discard-food' && ui.form.mode === 'edit') openFoodDetail(ui.form.foodId);
            else host.close();
            break;

          /* My foods · Favourites · Foods not suggested */
          case 'food-detail': foodOrigin = el.closest('[data-list]') ? el.closest('[data-list]').dataset.list : null; openFoodDetail(el.dataset.food); break;
          case 'new-food': {
            const values = { name: '', category: '', state: '', brand: '', protein: '', carbs: '', fat: '', aliases: '' };
            openFoodForm({ type: 'custom-food', mode: 'create-settings', initial: { ...values }, values, touched: new Set() });
            break;
          }
          case 'fd-favorite': refreshFoodDetail(foodActions.setFavorite(ui.food, !ui.isFavorite)); break;
          case 'fd-suggest': refreshFoodDetail(foodActions.setNotSuggested(ui.food, !ui.isDisliked)); break;
          case 'fd-edit': {
            const food = app.getFood(ui.food.id);
            if (!food) { openFoodDetail(ui.food.id); break; }
            const values = customFoodValues(food);
            openFoodForm({ type: 'custom-food', mode: 'edit', foodId: food.id, initial: { ...values }, values, touched: new Set() });
            break;
          }
          case 'cf-save': {
            ui.validation = validateCustomFoodForm(app, ui);
            if (!ui.validation.valid) { syncFoodForm(); break; } // Save is disabled while invalid; a guard only
            const food = ui.mode === 'edit'
              ? foodActions.updateCustomFood(ui.foodId, customFoodPatch(ui.values))
              : app.createCustomFood(customFoodInput(ui.values));
            foodsNote = null;
            render();
            if (ui.mode !== 'edit') foodOrigin = 'my-foods';
            openFoodDetail(food.id, 'Saved.'); // §7.4: the detail of the Food just saved
            break;
          }
          case 'fd-delete': show({ type: 'food-delete', food: ui.food, meals: foodUsageMeals(app, ui.food.id), servingCount: app.getServings(ui.food.id).length }); break;
          /* Servings on Food detail (C7): each control names its serving by ID; one that's gone changes nothing. */
          case 'fd-serving-add': openDetailServingForm('add'); break;
          case 'fd-serving-edit': {
            const serving = currentServing(ui.food.id, el.dataset.serving);
            if (!serving) { servingGone(ui.food.id); break; }
            openDetailServingForm('edit', serving);
            break;
          }
          case 'fd-serving-default': {
            const serving = currentServing(ui.food.id, el.dataset.serving);
            if (!serving) { servingGone(ui.food.id); break; }
            refreshFoodDetail(foodActions.makeDefaultServing(ui.food, serving).message);
            const target = dialog.querySelector(`[data-action="fd-serving-edit"][data-serving="${serving.id}"]`);
            if (target) target.focus();
            break;
          }
          case 'fd-serving-delete': {
            const serving = currentServing(ui.food.id, el.dataset.serving);
            if (!serving) { servingGone(ui.food.id); break; }
            show({ type: 'serving-delete', food: ui.food, serving, servings: app.getServings(ui.food.id) });
            break;
          }
          case 'fd-serving-delete-confirm': deleteServingConfirmed(); break;
          case 'srv-save': if (ui.type === 'serving-form') saveServingFromDetail(); break;
          case 'fd-delete-confirm': {
            foodsNote = foodActions.deleteCustomFood(ui.food);
            ui = null;
            render();
            host.returnFocusTo(body.querySelector('#my-foods-title'));
            host.close();
            break;
          }
          case 'unfavorite-meal': {
            const meal = app.getMeal(el.dataset.meal);
            const list = `[data-list="${el.closest('ul').dataset.list}"]`;
            const i = indexIn(el);
            app.setFavoriteMeal(el.dataset.meal, false);
            removedFrom(list, i, 'favourites-title', `${meal ? meal.name : 'Meal'} removed from favourites.`);
            break;
          }
          case 'unfavorite-food': {
            const food = app.getFood(el.dataset.food);
            const i = indexIn(el);
            app.setFavoriteFood(el.dataset.food, false);
            removedFrom('[data-list="fav-foods"]', i, 'favourites-title', `${food ? food.name : 'Food'} removed from favourites.`);
            break;
          }
          case 'suggest-again': {
            const food = app.getFood(el.dataset.food);
            const i = indexIn(el);
            app.setDislikedFood(el.dataset.food, false);
            removedFrom('[data-list="not-suggested"]', i, 'not-suggested-title', `${food ? food.name : 'Food'} can be suggested again.`);
            break;
          }

          /* backup */
          case 'backup': show({ type: 'backup', summary: app.validateBackup(app.exportUserData()).summary, note: '' }); break;
          case 'backup-download':
            try {
              services.downloadBackup(app);
              render();
              announce('Backup downloaded.');
              host.returnFocusTo(body.querySelector('[data-action="backup"]'));
              host.close();
            } catch {
              ui.note = 'The backup couldn’t be downloaded. Nothing was changed. Try again, or check your browser’s download settings.';
              draw();
            }
            break;

          /* earlier-format copies (§11.3): read-only downloads, no lastBackupAt */
          case 'download-older-backup': {
            const c = copies && copies.copies && copies.copies[Number(el.dataset.copy)];
            try {
              if (!c || !c.older || !c.older.valid) throw new Error('no valid older-format backup');
              services.downloadOlderFormatBackup(app, c.older.backup);
              copiesNote('Older-format backup downloaded.');
            } catch {
              copiesNote('The older-format backup couldn’t be downloaded. Nothing was changed.');
            }
            break;
          }
          case 'download-raw-archive': {
            const c = copies && copies.copies && copies.copies[Number(el.dataset.copy)];
            try {
              if (!c || c.kind !== 'archive') throw new Error('no stored archive');
              services.downloadRawArchive(c);
              copiesNote('Raw migration archive downloaded.');
            } catch {
              copiesNote('The raw migration archive couldn’t be downloaded. Nothing was changed.');
            }
            break;
          }

          /* restore */
          case 'restore': { const input = body.querySelector('[data-restore-file]'); if (input) input.click(); break; }
          case 'download-current':
            try { services.downloadBackup(app); ui.note = 'Current data downloaded.'; } catch { ui.note = 'The current data couldn’t be downloaded. Nothing was changed.'; }
            draw();
            dialog.querySelector('[data-action="download-current"]').focus();
            break;
          case 'restore-confirm': {
            const { text } = ui;
            try {
              const { restored, servingIds } = app.restoreUserData(text); // validated again, then one atomic replacement
              resetSession(); // no pre-restore screen state (search text, meal tray, handoffs) survives
              foodsNote = null; // nor a message about foods from before the restore
              const servings = servingIdsText(servingIds, 'result');
              restore = { tone: 'status', message: `Restored. ${backupSummaryText(restored)}.${servings ? ` ${servings}` : ''}` };
            } catch (e) {
              restore = { tone: 'error', message: restoreErrorMessage(e && e.code), code: e && e.code, errors: (e && e.details) || [] };
            }
            ui = null;
            render();
            host.returnFocusTo(body.querySelector('[data-restore-message]').firstElementChild ? body.querySelector('[data-action="restore"]') : null);
            host.close();
            break;
          }
          default: break;
        }
      } catch (e) {
        // A serving deleted elsewhere while its form or dialog was open: Food detail as it is now (C7).
        if (e && e.code === 'SERVING_NOT_FOUND' && ui && ['food-detail', 'serving-form', 'serving-delete'].includes(ui.type)) { servingGone(ui.food.id); return; }
        showDialogError(e);
      }
    });

    render();
    loadCopies();
    return false;
  },

  /** Asked by the shell before a route change (§3.2): false keeps Settings while "Discard changes?" asks. */
  leaveGuard(proceed) {
    return this._leaveGuard ? this._leaveGuard(proceed) : true;
  },

  unmount() {
    this._leaveGuard = null;
    if (this._cleanup) { this._cleanup(); this._cleanup = null; }
  }
};
