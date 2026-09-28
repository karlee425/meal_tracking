/*
 * settings.js — Settings (V2_UI_CONTRACT.md §10) with manual Backup / Restore (§11).
 *
 * Deliberately small: current targets (§10.2–10.3), data on this device (save status, last
 * backup, Download backup, Restore from backup) and About. Everything goes through the data
 * layer:
 *   targets   getAllCurrentTargets · validateTargets (a dry run) · updateCurrentTargets ·
 *             previewApplyCurrentTargetsToToday / applyCurrentTargetsToToday (today only, on request)
 *   backup    exportUserData → validateBackup (the text to be saved) → a local file
 *   restore   validateBackup (nothing changes) → preview → explicit confirm → restoreUserData
 *             (validated again, then one atomic replacement; any failure changes nothing)
 * There is no automatic backup, no sync and no reset here.
 */

import { BACKUP_FORMAT_VERSION, constants } from '../src/domain/index.js';
import { escapeHtml, restoreErrorMessage, backupSummaryText, exportedAtText, detailsDisclosure } from './shell.js';
import { DAY_TYPE_LABELS, dialogHead, errorSlot } from './today.js';
import { createViewHost, viewHead, syncInPlace } from './view-host.js';
import { resetSession } from './session.js';

/** The target form is an editing view; confirmations and the backup / restore sheets are short choices. */
export const SETTINGS_VIEW_TYPES = Object.freeze(['target-edit']);
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
    case 'conflict': return 'Changed in another tab or window. Reload to continue.';
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

/** The restore outcome line: an alert for problems (nothing changed), a status for success. */
export function restoreMessage(r) {
  if (!r) return '';
  return `<p>${escapeHtml(r.message)}</p>${r.tone === 'error' ? detailsDisclosure(r.code, r.errors) : ''}`;
}

function dataSection({ status, lastBackupAt, restore }) {
  return `<section class="settings-section" aria-labelledby="data-title">
<h2 id="data-title" class="section-title">Data on this device</h2>
<dl class="data-facts">
<div><dt>Save status</dt><dd><span data-save-status>${escapeHtml(saveStatusText(status))}</span>${status && status.state === 'error' ? ' <button type="button" class="link-button" data-action="retry-save">Try again</button>' : ''}</dd></div>
<div><dt>Last backup</dt><dd>${lastBackupAt ? escapeHtml(exportedAtText(lastBackupAt)) : 'Never'}</dd></div>
</dl>
<p class="section-note">A backup is a file you download and keep yourself. The app doesn’t back up automatically, and nothing leaves this device.</p>
<div class="sheet-actions">
<button type="button" class="button" data-action="backup">Download backup</button>
<button type="button" class="button" data-action="restore">Restore from backup</button>
<input type="file" accept=".json,application/json" data-restore-file hidden tabindex="-1" aria-hidden="true">
</div>
<div class="restore-message${restore && restore.tone === 'error' ? ' is-error' : ''}" data-restore-message role="${restore && restore.tone === 'error' ? 'alert' : 'status'}">${restoreMessage(restore)}</div>
</section>`;
}

function aboutSection() {
  return `<section class="settings-section" aria-labelledby="about-title">
<h2 id="about-title" class="section-title">About</h2>
<dl class="data-facts">
<div><dt>App</dt><dd>Macro Tracker (V2)</dd></div>
<div><dt>Data format version</dt><dd>${BACKUP_FORMAT_VERSION}</dd></div>
</dl>
<p class="section-note">Macros only: protein, carbs and fat, in grams.</p>
</section>`;
}

export function renderSettings({ targets, status, lastBackupAt, restore }) {
  return `<h1 id="screen-title" class="screen-title" tabindex="-1">Settings</h1>
${targetsSection(targets)}
${dataSection({ status, lastBackupAt, restore })}
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
<p id="tf-needs" class="hint" data-sync="tf-needs"${needs ? '' : ' hidden'}>${needs}</p>
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

/** The preview and confirmation before anything is replaced. Cancel has the focus. */
export function renderRestorePreview({ summary, current, exportedAt, note }) {
  return `${dialogHead('Restore this backup?')}
<p>Backup from ${escapeHtml(exportedAtText(exportedAt))}: ${escapeHtml(backupSummaryText(summary))}.</p>
<p class="hint">On this device now: ${escapeHtml(backupSummaryText(current))}.</p>
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
        restore
      });
    }
    // Keep the save-status line current without re-rendering (or moving focus).
    const unsubscribe = app.onPersistenceChange((status) => {
      const el = body.querySelector('[data-save-status]');
      if (el) el.textContent = saveStatusText(status);
    });

    const host = createViewHost({
      page, dialog, win, doc,
      viewTypes: SETTINGS_VIEW_TYPES,
      fallbackFocus: () => main.querySelector('#screen-title'),
      onClose: () => { ui = null; },
      beforeLeave
    });
    this._cleanup = () => { host.destroy(); if (typeof unsubscribe === 'function') unsubscribe(); };

    function draw() {
      if (!ui) return;
      switch (ui.type) {
        case 'target-edit': dialog.innerHTML = renderTargetForm(ui); break;
        case 'target-confirm': dialog.innerHTML = renderTargetConfirm(ui); break;
        case 'apply-today': dialog.innerHTML = renderApplyToday(ui); break;
        case 'discard': dialog.innerHTML = renderDiscardTargets(); break;
        case 'backup': dialog.innerHTML = renderBackupSheet(ui); break;
        case 'restore-preview': dialog.innerHTML = renderRestorePreview(ui); break;
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
      return true;
    }
    function showDialogError(e) {
      const el = dialog.querySelector('[data-error]');
      const text = e && e.code === 'INVALID_TARGETS' ? 'Targets need to be whole grams, 0 or more.' : 'That didn’t save. Nothing was changed.';
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
        setRestore({ tone: 'error', message: restoreErrorMessage(result.code), code: result.code, errors: result.errors });
        return;
      }
      setRestore(null);
      show({ type: 'restore-preview', text, summary: result.summary, current: app.validateBackup(app.exportUserData()).summary, exportedAt: JSON.parse(text).exportedAt, note: '' });
    }

    main.addEventListener('input', (event) => {
      const el = event.target;
      if (ui && ui.type === 'target-edit' && el.matches('[data-target-field]')) {
        ui.values[el.dataset.targetField] = el.value;
        ui.touched.add(el.dataset.targetField);
        ui.validation = app.validateTargets(parseTargets(ui.values));
        syncInPlace(dialog, renderTargetForm(ui), doc);
      }
    });
    main.addEventListener('change', (event) => {
      if (event.target.matches('[data-restore-file]')) onRestoreFile(event.target);
    });

    main.addEventListener('click', (event) => {
      const el = event.target.closest('[data-action]');
      if (!el || !main.contains(el)) return;
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
          case 'discard': host.close(); break;

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
              const { restored } = app.restoreUserData(text); // validated again, then one atomic replacement
              resetSession(); // no pre-restore screen state (search text, meal tray, handoffs) survives
              restore = { tone: 'status', message: `Restored. ${backupSummaryText(restored)}.` };
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
        showDialogError(e);
      }
    });

    render();
    return false;
  },

  unmount() {
    if (this._cleanup) { this._cleanup(); this._cleanup = null; }
  }
};
