/*
 * shell.js — the V2 app shell: header, primary navigation, main region, and routing.
 *
 * Contract: V2_UI_CONTRACT.md §2 (information architecture), §3 (navigation), §4.8 (save
 * status), §13.1 (start-up states), §14 (accessibility), §15 (visual direction).
 *
 * The shell holds no screen logic and no nutrition logic. It decides which destination is
 * showing, renders the frame around it, and reflects the data layer's save status. Screens
 * are placeholders until their own slices are built.
 *
 * Routing is hash-based (#/today, #/log, …) so it works on any static host without server
 * rewrites, survives a refresh, and never reloads the page.
 */

/** Primary navigation, in the approved order (A-03). */
export const PRIMARY_DESTINATIONS = Object.freeze([
  Object.freeze({ id: 'today', label: 'Today', href: '#/today' }),
  Object.freeze({ id: 'log', label: 'Log', href: '#/log' }),
  Object.freeze({ id: 'meals', label: 'Meals', href: '#/meals' }),
  Object.freeze({ id: 'progress', label: 'Progress', href: '#/progress' })
]);

/** Secondary destination, reached from the header (I-02). */
export const SETTINGS_DESTINATION = Object.freeze({ id: 'settings', label: 'Settings', href: '#/settings' });

/** The launch screen, and the fallback for anything unrecognised (A-03). */
export const DEFAULT_DESTINATION = 'today';

const ALL = [...PRIMARY_DESTINATIONS, SETTINGS_DESTINATION];
const BY_ID = new Map(ALL.map((d) => [d.id, d]));

export const APP_NAME = 'Macro Tracker';

/**
 * Resolve a location hash to a destination.
 * Returns { id, known } — unknown or malformed hashes fall back to Today with known: false.
 * Query parts (e.g. "#/today?date=…", used by later slices) are ignored here.
 */
export function resolveRoute(hash) {
  const raw = typeof hash === 'string' ? hash : '';
  const match = /^#\/([a-z]+)(?:[?/].*)?$/.exec(raw);
  if (match && BY_ID.has(match[1])) return { id: match[1], known: true };
  return { id: DEFAULT_DESTINATION, known: raw === '' || raw === '#' || raw === '#/' };
}

export function destination(id) {
  return BY_ID.get(id) || BY_ID.get(DEFAULT_DESTINATION);
}

export function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/* ---------------- save status (§4.8) ---------------- */

/**
 * What the header indicator shows for a persistence status from the data layer.
 * Returns { state, text, hidden }. Hidden before the first save (first run, §12) and when
 * there is no data layer yet.
 */
export function persistenceView(status) {
  if (!status) return { state: 'none', text: '', hidden: true };
  switch (status.state) {
    case 'saving': return { state: 'saving', text: 'Saving…', hidden: false };
    case 'error': return { state: 'error', text: 'Not saved', hidden: false };
    case 'conflict': return { state: 'conflict', text: isArchiveConflict(status) ? 'Saving paused' : 'Changed elsewhere', hidden: false };
    case 'saved': return { state: 'saved', text: 'Saved', hidden: !status.lastSavedAt };
    default: return { state: 'none', text: '', hidden: true };
  }
}

/* ---------------- start-up states (§13.1) ---------------- */

/** Blocking start-up messages by domain error code. Recovery actions arrive with the Backup/Restore slice. */
export function startupErrorView(code) {
  switch (code) {
    case 'STORAGE_UNAVAILABLE':
      return {
        title: "This browser can't save your data",
        body: "This browser isn't letting the app save your data (this can happen in a private window). Open the app in a normal browser window to use it."
      };
    case 'DATA_INVALID':
    case 'STORED_DATA_UNRECOGNIZED':
      return {
        title: "Your saved data couldn't be opened",
        body: 'Your saved data couldn’t be opened, so nothing has been changed or deleted.'
      };
    default:
      return {
        title: "The app couldn't start",
        body: 'Something went wrong while opening your data. Nothing has been changed. Reload to try again.'
      };
  }
}

/* ---------------- recovery, backup and save-error views (§4.8, §11, §13.1) ---------------- */

/** Start-up errors the user can recover from here: the stored record exists but can't be opened. */
export const RECOVERABLE_CODES = Object.freeze(['DATA_INVALID', 'STORED_DATA_UNRECOGNIZED']);

/**
 * The save was refused because a different pre-upgrade copy is already stored (C3/C4): a
 * blocking conflict, but not "another tab saved" — reloading doesn't resolve it.
 */
export const isArchiveConflict = (status) => !!status && status.state === 'conflict' && status.code === 'STORAGE_ARCHIVE_CONFLICT';

/** The format of a raw migration archive (browser-adapter.js STORE_ARCHIVE_FORMAT). The shell imports nothing, so it is named here. */
const RAW_ARCHIVE_FORMAT = 'macro-tracker-store-archive';
/** Whether a chosen file's text is a raw migration archive (so restore can say so). Reads only. */
export function isRawMigrationArchiveText(text) {
  try {
    const doc = JSON.parse(text);
    return !!doc && typeof doc === 'object' && doc.format === RAW_ARCHIVE_FORMAT;
  } catch {
    return false;
  }
}
export const RAW_ARCHIVE_RESTORE_MESSAGE = 'This file is a raw migration archive, not a backup, so it can’t be restored. Choose a backup file instead.';
/** The restore error message for a chosen file: a raw migration archive is named as such; otherwise by code. */
export function restoreFileErrorMessage(code, text) {
  return code === 'BACKUP_INCOMPATIBLE' && isRawMigrationArchiveText(text) ? RAW_ARCHIVE_RESTORE_MESSAGE : restoreErrorMessage(code);
}

/** §11.2 / §13.3: what a failed restore or recovery means, by domain code. Nothing is changed in any of them. */
export function restoreErrorMessage(code) {
  switch (code) {
    case 'BACKUP_UNREADABLE': return 'This file isn’t a backup this app can read.';
    case 'BACKUP_INCOMPATIBLE': return 'This backup is from a different or newer version of the app and can’t be restored here.';
    case 'BACKUP_INVALID': return 'This backup has problems, so it wasn’t restored. Your current data is untouched.';
    case 'STORAGE_CONFLICT': return 'The app changed in another tab. Close other tabs and try again.';
    case 'STORAGE_UNAVAILABLE': return 'This browser isn’t letting the app save right now, so nothing was replaced. Try again in a normal browser window.';
    default: return 'Something went wrong. Nothing was changed.';
  }
}

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
/** "3 logged days · 7 logged meals · 2 saved meals · 2 of your foods" from validateBackup's summary. */
export function backupSummaryText(summary) {
  return [plural(summary.days, 'logged day', 'logged days'), plural(summary.mealInstances, 'logged meal', 'logged meals'), plural(summary.savedMeals, 'saved meal', 'saved meals'), `${summary.customFoods} of your foods`].join(' · ');
}

/** A backup's exportedAt in local time, or a neutral fallback. */
export function exportedAtText(iso) {
  const d = typeof iso === 'string' ? new Date(iso) : null;
  if (!d || Number.isNaN(d.getTime())) return 'an unknown date';
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(d);
}

/** A "Details" disclosure for codes and technical messages (§13: never in the main text). */
export function detailsDisclosure(code, errors = []) {
  if (!code && !errors.length) return '';
  const items = errors.slice(0, 5).map((e) => `<li>${escapeHtml(e)}</li>`).join('');
  return `<details class="error-details"><summary>Details</summary>${code ? `<p><code>${escapeHtml(code)}</code></p>` : ''}${items ? `<ul>${items}</ul>` : ''}</details>`;
}

/** §4.8: the persistent banner while saving is failing. Empty otherwise. */
export function saveBannerView(status, note = '') {
  if (!status || status.state !== 'error') return '';
  const low = /quota|space|full/i.test(String(status.error || '')) ? ' Your device may be low on storage.' : '';
  return `<div class="save-banner" role="alert">
<p>Your latest changes aren’t saved on this device yet. They’re still here, but will be lost if you close the app.${low}</p>
<div class="sheet-actions"><button type="button" class="button" data-shell-action="retry">Try again</button><button type="button" class="button" data-shell-action="download-backup">Download a backup</button></div>
${note ? `<p class="save-banner-note">${escapeHtml(note)}</p>` : ''}
</div>`;
}

/* ---------------- archive conflict (C4): saving paused, three separate downloads ---------------- */

/**
 * The pre-upgrade copy the archive-conflict dialog can offer, from the earlier-format copies
 * model (formatCopiesModel: loading | error | ready). This tab's pending pre-upgrade copy is the
 * one meant; it is offered only when its older-format backup validated. The differing stored
 * archive is never offered in its place. Without a pending copy, a valid archived original is.
 */
export function preUpgradeOffer(copies) {
  if (!copies || copies.state === 'loading') return { available: false, hint: 'Checking for the pre-upgrade copy…', copy: null, details: '' };
  if (copies.state === 'error') return { available: false, hint: 'The earlier copies couldn’t be read, so the pre-upgrade copy can’t be offered.', copy: null, details: detailsDisclosure(copies.code, copies.errors || []) };
  const pending = copies.copies.find((c) => c.kind === 'pending');
  const candidate = pending || copies.copies.find((c) => c.kind === 'archive' && c.older && c.older.valid) || null;
  if (candidate && candidate.older && candidate.older.valid) return { available: true, hint: 'A backup the earlier version of the app can restore.', copy: candidate, details: '' };
  if (!candidate) return { available: false, hint: 'No pre-upgrade copy is available on this device.', copy: null, details: '' };
  return { available: false, hint: 'An older-format backup can’t be made from the pre-upgrade copy.', copy: null, details: detailsDisclosure(candidate.older && candidate.older.code, (candidate.older && candidate.older.errors) || candidate.problems || []) };
}

/** The stored migration archive(s) the dialog can offer: present, and savable exactly as a file. */
export function storedArchiveOffer(copies) {
  if (!copies || copies.state === 'loading') return { available: false, hint: 'Checking for the stored migration archive…' };
  if (copies.state === 'error') return { available: false, hint: 'The stored migration archive couldn’t be read.' };
  const archives = copies.copies.filter((c) => c.kind === 'archive');
  if (!archives.length) return { available: false, hint: 'No stored migration archive on this device.' };
  const exact = archives.filter((c) => c.exactJson).length;
  if (!exact) return { available: false, hint: 'The stored migration archive can’t be saved exactly as a file, so it isn’t offered.' };
  return { available: true, hint: exact === archives.length ? 'Not a backup; it can’t be restored.' : `Not a backup; it can’t be restored. ${archives.length - exact} of ${archives.length} can’t be saved exactly as a file and won’t be downloaded.` };
}

/**
 * The note for "Download the stored migration archive", from downloadRawArchives' per-archive
 * results. A refused download is reported as a download problem (never as a read failure), and
 * a partial result as partial.
 */
export function archiveDownloadMessage(result) {
  const found = (result && result.found) || 0;
  const results = (result && result.results) || [];
  if (!found) return 'There’s no stored migration archive on this device. Nothing was changed.';
  const count = (o) => results.filter((r) => r.outcome === o).length;
  const done = count('downloaded');
  const refused = count('refused');
  const notExact = count('not-exact');
  if (done === found) return found === 1 ? 'Stored migration archive downloaded. Saving is still paused.' : `All ${found} stored migration archives downloaded. Saving is still paused.`;
  if (found === 1 && refused === 1) return 'The stored migration archive couldn’t be downloaded: the browser didn’t start the download. Nothing was changed. Try again, or check your browser’s download settings.';
  if (found === 1 && notExact === 1) return 'The stored migration archive can’t be saved exactly as a file, so it wasn’t downloaded. Nothing was changed.';
  const parts = [`${done} of ${found} downloaded`];
  if (refused) parts.push(`${refused} couldn’t be downloaded (the browser didn’t start the download)`);
  if (notExact) parts.push(`${notExact} can’t be saved exactly as a file, so ${notExact === 1 ? 'it wasn’t' : 'they weren’t'} offered`);
  return `Stored migration archives: ${parts.join('; ')}. Nothing was changed.`;
}

const statusNote = (text) => (text ? `<p class="save-banner-note" role="status">${escapeHtml(text)}</p>` : '');

/**
 * §4.8 / §11.3: the archive-conflict dialog. Saving is paused; three separate downloads, each
 * with its own availability and its own result. No Reload, no retry; downloading doesn't
 * resolve the conflict. copies: the earlier-format copies model; notes: { current, preUpgrade, archive }.
 */
export function archiveConflictView({ copies = null, notes = {} } = {}) {
  const pre = preUpgradeOffer(copies);
  const raw = storedArchiveOffer(copies);
  return `<h2 id="conflict-title" class="sheet-title">Saving is paused</h2>
<p>Saving is paused to protect your earlier data. The original pre-upgrade copy differs from the copy now stored on this device. Nothing has been overwritten, and your changes in this tab are not being saved.</p>
<p>Download this tab’s current data, the pre-upgrade copy and the stored migration archive for safekeeping. Downloading them doesn’t resolve the conflict, and reloading will not resolve it either.</p>
<ul class="conflict-downloads">
<li><button type="button" class="button" data-shell-action="download-conflict">Download the tab’s current data</button> <span class="hint">Everything in this tab now, including changes that weren’t saved.</span>${statusNote(notes.current)}</li>
<li><button type="button" class="button" data-shell-action="download-preupgrade"${pre.available ? '' : ' disabled'} aria-describedby="conflict-pre-hint">Download the pre-upgrade copy (older-format backup)</button> <span id="conflict-pre-hint" class="hint">${escapeHtml(pre.hint)}</span>${pre.details}${statusNote(notes.preUpgrade)}</li>
<li><button type="button" class="button" data-shell-action="download-archive"${raw.available ? '' : ' disabled'} aria-describedby="conflict-archive-hint">Download the stored migration archive</button> <span id="conflict-archive-hint" class="hint">${escapeHtml(raw.hint)}</span>${statusNote(notes.archive)}</li>
</ul>`;
}

/**
 * §4.8: another tab saved more recently. Blocking until reload. An archive conflict (the
 * pre-upgrade copy already stored differs) gets archiveConflictView instead: saving is paused
 * to protect the earlier data, reloading won't resolve it, and it offers downloads only.
 */
export function conflictDialogView(note = '', status = null, archive = {}) {
  if (isArchiveConflict(status)) return archiveConflictView(archive);
  return `<h2 id="conflict-title" class="sheet-title">Changed elsewhere</h2>
<p>This app is open in another tab or window, and that one saved more recently. To avoid overwriting it, this tab can’t save.</p>
<p>Reloading opens the latest saved data. Changes made in this tab since then will be lost, so download them first if you need them.</p>
${note ? `<p class="save-banner-note" role="status">${escapeHtml(note)}</p>` : ''}
<div class="sheet-actions"><button type="button" class="button" data-shell-action="download-conflict">Download this tab’s data</button><button type="button" class="button primary" data-shell-action="reload">Reload</button></div>`;
}

/**
 * §13.1: recovery when stored data can't be opened. Download the stored record first; restore
 * from a backup (validated, previewed and confirmed before anything is replaced); or start over
 * (only after the download, behind a confirmation). Nothing happens automatically.
 */
export function renderRecovery(r) {
  const busy = r.busy ? ' disabled' : '';
  let step = '';
  if (r.stage === 'preview') {
    step = `<section class="recovery-step" aria-labelledby="recovery-step-title">
<h2 id="recovery-step-title" class="section-title" tabindex="-1">Restore this backup?</h2>
<p>Backup from ${escapeHtml(exportedAtText(r.exportedAt))}: ${escapeHtml(backupSummaryText(r.summary))}.</p>
<p>Restoring replaces the stored data that couldn’t be opened. It can’t be undone.</p>
<div class="sheet-actions"><button type="button" class="button" data-shell-action="recovery-cancel"${busy}>Cancel</button><button type="button" class="button danger" data-shell-action="recovery-restore"${busy}>Replace stored data</button></div>
</section>`;
  } else if (r.stage === 'confirm-fresh') {
    step = `<section class="recovery-step" aria-labelledby="recovery-step-title">
<h2 id="recovery-step-title" class="section-title" tabindex="-1">Start over with empty data?</h2>
<p>The stored data that couldn’t be opened will be replaced by a fresh start: the standard targets and no logged days. Keep the file you downloaded; it can’t be undone.</p>
<div class="sheet-actions"><button type="button" class="button" data-shell-action="recovery-cancel"${busy}>Cancel</button><button type="button" class="button danger" data-shell-action="recovery-fresh"${busy}>Start over</button></div>
</section>`;
  }
  return `<section class="recovery" aria-labelledby="recovery-title">
<h2 id="recovery-title" class="section-title">What you can do</h2>
<ol class="recovery-options">
<li><button type="button" class="button" data-shell-action="download-stored"${busy}>Download the stored data</button> <span class="hint">${r.downloaded ? 'Downloaded.' : 'Keeps a copy of it as a file, exactly as stored.'}</span></li>
<li><button type="button" class="button" data-shell-action="choose-backup"${busy}>Restore from a backup</button><input type="file" accept=".json,application/json" data-shell-file hidden tabindex="-1" aria-hidden="true"></li>
<li><button type="button" class="button" data-shell-action="start-fresh"${r.downloaded ? '' : ' disabled'}${busy} aria-describedby="fresh-hint">Start over with empty data</button> <span id="fresh-hint" class="hint">${r.downloaded ? 'Replaces the stored data with a fresh start.' : 'Available after you download the stored data.'}</span></li>
</ol>
${step}
<div class="recovery-message" role="${r.tone === 'error' ? 'alert' : 'status'}">${r.message ? `<p>${escapeHtml(r.message)}</p>${detailsDisclosure(r.code, r.errors)}` : ''}</div>
</section>`;
}

const freshRecovery = () => ({ downloaded: false, stage: 'idle', text: null, summary: null, exportedAt: null, message: '', tone: '', code: null, errors: [], busy: false });

/* ---------------- rendering ---------------- */

const ICONS = {
  today: '<path d="M4 7h16M8 3v4M16 3v4"/><rect x="4" y="5" width="16" height="15" rx="2"/>',
  log: '<path d="M12 5v14M5 12h14"/>',
  meals: '<path d="M4 6h16M4 12h16M4 18h10"/>',
  progress: '<path d="M4 19V11M10 19V5M16 19v-6M22 19H2"/>',
  settings: '<circle cx="12" cy="12" r="3.2"/><path d="M12 2.5l1.6 2.3 2.7-.8.6 2.8 2.8.6-.8 2.7 2.3 1.6-2.3 1.6.8 2.7-2.8.6-.6 2.8-2.7-.8L12 21.5l-1.6-2.3-2.7.8-.6-2.8-2.8-.6.8-2.7L2.5 12l2.3-1.6-.8-2.7 2.8-.6.6-2.8 2.7.8z"/>'
};
const icon = (id) => `<svg class="icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">${ICONS[id]}</svg>`;

const current = (on) => (on ? ' aria-current="page"' : '');

/** Placeholder content for a destination whose screen is not built yet. No data, no fake content. */
export function renderPlaceholder(id) {
  const d = destination(id);
  return `<h1 id="screen-title" class="screen-title" tabindex="-1">${escapeHtml(d.label)}</h1>
<p class="placeholder-note">This screen hasn't been built yet.</p>`;
}

function renderMain(state) {
  if (state.startup === 'loading') {
    return `<h1 id="screen-title" class="screen-title" tabindex="-1">${escapeHtml(destination(state.route).label)}</h1>
<p class="placeholder-note" role="status">Opening your data…</p>`;
  }
  if (state.startup === 'error') {
    const v = startupErrorView(state.errorCode);
    return `<section class="startup-error" role="alert" aria-labelledby="screen-title">
<h1 id="screen-title" class="screen-title" tabindex="-1">${escapeHtml(v.title)}</h1>
<p>${escapeHtml(v.body)}</p>
</section>${state.recoveryAvailable && RECOVERABLE_CODES.includes(state.errorCode) ? `\n${renderRecovery(state.recovery || freshRecovery())}` : ''}`;
  }
  return renderPlaceholder(state.route);
}

/**
 * The whole app frame as HTML for a shell state:
 *   { route, startup: 'loading' | 'ready' | 'error', errorCode?, status? }
 * Navigation is hidden on the blocking start-up error screen (§13.1).
 */
export function renderApp(state) {
  const status = persistenceView(state.status);
  const blocked = state.startup === 'error';
  const nav = blocked ? '' : `<nav class="primary-nav" aria-label="Primary">
<ul>
${PRIMARY_DESTINATIONS.map((d) => `<li><a class="nav-link" href="${d.href}" data-destination="${d.id}"${current(state.route === d.id)}>${icon(d.id)}<span class="nav-label">${escapeHtml(d.label)}</span></a></li>`).join('\n')}
</ul>
</nav>`;
  const settings = blocked ? '' : `<a class="header-button" href="${SETTINGS_DESTINATION.href}" data-destination="settings"${current(state.route === 'settings')}>${icon('settings')}<span class="visually-hidden">${SETTINGS_DESTINATION.label}</span></a>`;
  return `<a class="skip-link" href="#main">Skip to content</a>
<div class="app-frame${blocked ? ' is-blocked' : ''}">
<header class="app-header">
<span class="app-name">${APP_NAME}</span>
<div class="header-actions" data-slot="contextual-actions"></div>
<span class="save-status" data-state="${status.state}" role="status" aria-live="polite"${status.hidden ? ' hidden' : ''}>${escapeHtml(status.text)}</span>
${settings}
</header>
<div class="save-banner-slot" data-shell-banner>${blocked ? '' : saveBannerView(state.status, state.bannerNote)}</div>
${nav}
<main id="main" class="app-main" tabindex="-1"${state.startup === 'loading' ? ' aria-busy="true"' : ''}>
${renderMain(state)}
</main>
</div>
<dialog class="sheet conflict-dialog" data-conflict aria-labelledby="conflict-title"></dialog>`;
}

/* ---------------- keyboard shortcuts (§14) ---------------- */

/** Input types where Enter confirms the form (not buttons, lists, radios, checkboxes or files). */
const ENTER_TYPES = new Set(['', 'text', 'search', 'number', 'date', 'email', 'tel', 'url', 'password']);
/** Screens whose list has a search field that "/" focuses. */
export const SEARCH_SHORTCUT_ROUTES = Object.freeze(['log', 'meals']);

/** Whether keys pressed here are typing (or choosing from a list): "/" and Escape leave them alone. */
export function isEditable(el) {
  if (!el || !el.tagName) return false;
  const tag = String(el.tagName).toLowerCase();
  return tag === 'input' || tag === 'textarea' || tag === 'select' || el.isContentEditable === true;
}

/** An input where Enter confirms the form it's in. Textareas, buttons and links keep Enter's own meaning. */
export function confirmsOnEnter(el) {
  if (!el || !el.tagName || String(el.tagName).toLowerCase() !== 'input') return false;
  return ENTER_TYPES.has(String(el.getAttribute('type') || '').toLowerCase());
}

function modalOpen(doc) {
  try { return !!doc.querySelector('dialog:modal'); } catch { return !!doc.querySelector('dialog[open]'); }
}

/**
 * The keyboard shortcuts (§14), in one place:
 *   /       focuses the search field on Log and Meals — not while typing, not under a modal
 *   Enter   in a field of a sheet, dialog or [data-enter-scope] form: presses its primary action
 *           once; when that action is unavailable (the form is invalid) nothing is submitted and
 *           focus moves to the first invalid field (A-45). Never repeats while Enter is held.
 *   Escape  modal sheets and dialogs close themselves (the browser's cancel, routed through the
 *           screen's "Discard changes?" check); this only covers a wide-screen pane while focus
 *           is outside it, by handing it the same Escape the pane handles itself.
 * Returns what it did ('search' | 'confirm' | 'invalid' | 'escape') or null when it let the key be.
 */
export function handleShortcut(event, { route, doc, win }) {
  if (event.defaultPrevented || event.isComposing || event.keyCode === 229) return null;
  if (event.ctrlKey || event.metaKey || event.altKey) return null;
  const target = event.target;
  if (event.key === '/') {
    if (!SEARCH_SHORTCUT_ROUTES.includes(route) || isEditable(target) || modalOpen(doc)) return null;
    const search = doc.querySelector('#main [data-query]');
    if (!search) return null;
    event.preventDefault();
    search.focus();
    return 'search';
  }
  if (event.key === 'Enter') {
    if (event.shiftKey || !confirmsOnEnter(target)) return null;
    const scope = target.closest('[data-enter-scope], dialog[open]');
    if (!scope) return null;
    const primary = Array.from(scope.querySelectorAll('.sheet-actions .button.primary')).find((b) => !b.closest('[hidden]'));
    if (!primary) return null;
    event.preventDefault();
    if (event.repeat) return null; // held down: one confirmation only
    if (!primary.disabled) { primary.click(); return 'confirm'; }
    const named = scope.querySelector('[data-first-invalid]');
    const first = (named && scope.querySelector(`[id="${named.getAttribute('data-first-invalid')}"]`))
      || scope.querySelector('[data-invalid], [aria-invalid="true"]');
    if (first) first.focus();
    return 'invalid';
  }
  if (event.key === 'Escape') {
    if (modalOpen(doc)) return null;
    const pane = doc.querySelector('#main dialog[open]');
    if (!pane || pane.contains(target)) return null; // inside the pane, the view host handles it
    if (isEditable(target) && target.value) return null; // Escape clears a search field first
    event.preventDefault();
    pane.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    return 'escape';
  }
  return null;
}

/* ---------------- controller ---------------- */

/**
 * Mount the shell.
 *   root     the element to render into
 *   win      the window (location.hash, history, events)
 *   doc      the document (title)
 *   screens  optional { [destinationId]: { mount(mainElement, { app, win, doc, services }), unmount() } }
 *            for destinations that are built; the rest show their placeholder. mount() may
 *            return true when it has placed focus itself (e.g. on a row it just highlighted),
 *            so the shell doesn't move focus to the heading over it. A screen may also have
 *            leaveGuard(proceed) → boolean: asked before any route change while it's mounted;
 *            false means it is asking "Discard changes?" (§3.2) and will call proceed() only
 *            after Discard, so the shell stays put until then.
 *   services optional, from main.js (the shell imports nothing):
 *            downloadBackup(app)          → offer the app's data as a backup file (throws if refused)
 *            downloadStoredRecord(error)  → Promise; offer the unopenable stored record as a file
 *            validateRecoveryBackup(text) → validateBackup result against the shipped app data
 *            recover({ backup } | { startFresh: true }) → Promise<app>; replaces the stored record
 *            reload()
 * Returns { start, setDataLayer, showStartupError, state }.
 */
export function createShell({ root, win, doc, screens = {}, services = {} }) {
  const state = { route: DEFAULT_DESTINATION, startup: 'loading', errorCode: null, status: null, recoveryAvailable: false, recovery: null, bannerNote: '' };
  // Archive conflict only: the earlier-format copies (read once, read-only) and each download's own result.
  let conflictCopies = null;
  const archiveNotes = { current: '', preUpgrade: '', archive: '' };
  let startupError = null;
  let app = null;
  let unsubscribe = null;
  let mounted = null;
  let shownHref = null; // the URL the mounted screen was rendered for
  const scrollByRoute = new Map(); // §3.2: each tab's scroll position, for this session (memory only)

  function render({ focusHeading = false, restoreScroll } = {}) {
    if (mounted) { mounted.unmount(); mounted = null; }
    root.innerHTML = renderApp(state);
    const screen = state.startup === 'ready' ? screens[state.route] : null;
    const main = screen ? root.querySelector('#main') : null;
    let focusPlaced = false;
    if (screen && main) { focusPlaced = screen.mount(main, { app, win, doc, services }) === true; mounted = screen; }
    shownHref = win.location.href;
    const label = state.startup === 'error' ? startupErrorView(state.errorCode).title : destination(state.route).label;
    doc.title = `${label} · ${APP_NAME}`;
    const restore = !focusPlaced && typeof restoreScroll === 'number' && restoreScroll > 0 && typeof win.scrollTo === 'function';
    if (focusHeading && !focusPlaced) {
      const heading = root.querySelector('#screen-title');
      if (heading) heading.focus(restore ? { preventScroll: true } : undefined);
    }
    if (restore) win.scrollTo(0, restoreScroll);
    syncConflict();
  }

  /** §4.8: the conflict dialog is modal while another tab owns the latest save. */
  function syncConflict(note = '') {
    const dialog = root.querySelector('[data-conflict]');
    if (!dialog || typeof dialog.showModal !== 'function') return;
    const conflict = state.startup === 'ready' && state.status && state.status.state === 'conflict';
    if (conflict) {
      if (isArchiveConflict(state.status) && !conflictCopies) loadConflictCopies();
      dialog.innerHTML = conflictDialogView(note, state.status, { copies: conflictCopies, notes: archiveNotes });
      if (!dialog.open) dialog.showModal();
    } else if (dialog.open) dialog.close();
  }

  /**
   * A route change while the mounted screen has unsaved edits (§3.2, I-01): the URL goes back to
   * what's showing (a new entry, so the destination stays one Back away) and nothing re-renders.
   * After Discard the screen calls proceed, which steps back to the destination.
   */
  function heldByScreen() {
    if (!mounted || typeof mounted.leaveGuard !== 'function' || shownHref === null || win.location.href === shownHref) return false;
    if (mounted.leaveGuard(() => win.history.back())) return false;
    win.history.pushState(null, '', shownHref);
    return true;
  }

  function syncRoute({ focusHeading }) {
    if (heldByScreen()) return;
    const { id, known } = resolveRoute(win.location.hash);
    if (!known) win.history.replaceState(null, '', destination(id).href); // unknown → Today, no reload, no extra history entry
    const changed = id !== state.route;
    // §3.2: switching tabs keeps each tab's scroll position. A deep link (a query) starts at the top.
    if (changed && typeof win.scrollY === 'number') scrollByRoute.set(state.route, win.scrollY);
    state.route = id;
    render({ focusHeading: focusHeading && changed, restoreScroll: changed && !win.location.hash.includes('?') ? scrollByRoute.get(id) : undefined });
  }

  function flush() {
    if (app) app.flushPersistence();
  }

  /** Update only the header indicator, so a save never re-renders (or steals focus from) the screen. */
  function updateStatus() {
    const el = root.querySelector('.save-status');
    if (!el) { render(); return; }
    const v = persistenceView(state.status);
    el.textContent = v.text;
    el.setAttribute('data-state', v.state);
    el.hidden = v.hidden;
    if (!state.status || state.status.state !== 'error') state.bannerNote = '';
    const banner = root.querySelector('[data-shell-banner]');
    if (banner) banner.innerHTML = saveBannerView(state.status, state.bannerNote);
    syncConflict();
  }

  /* ---- actions from the banner, the conflict dialog and the recovery screen ---- */
  function setRecovery(patch, focusSelector) {
    state.recovery = { ...(state.recovery || freshRecovery()), ...patch };
    render();
    const el = focusSelector && root.querySelector(focusSelector);
    if (el) el.focus();
  }
  function backupNow(where) {
    try {
      services.downloadBackup(app);
      return 'Backup downloaded.';
    } catch {
      return where === 'conflict'
        ? 'The data couldn’t be downloaded. Nothing was changed. Try again, or check your browser’s download settings.'
        : 'The backup couldn’t be downloaded. Nothing was changed. Try again, or check your browser’s download settings.';
    }
  }
  /*
   * Archive conflict: the earlier-format copies are read once, read-only, when the dialog opens
   * (stage 1: read). Each download then checks its own source (stage 2: can it be saved
   * exactly), starts the download (stage 3) and reports its own result (stage 4).
   */
  function loadConflictCopies() {
    if (typeof services.earlierCopies !== 'function') {
      conflictCopies = { state: 'error', code: null, errors: ['the earlier copies aren’t available here'] };
      return;
    }
    conflictCopies = { state: 'loading' };
    Promise.resolve()
      .then(() => services.earlierCopies(app))
      .then((model) => model, (e) => ({ state: 'error', code: (e && e.code) || null, errors: e && e.message ? [e.message] : [] }))
      .then((model) => { conflictCopies = model; syncConflict(); });
  }
  function currentDataNow() {
    try {
      services.downloadBackup(app);
      return 'This tab’s current data was downloaded. Saving is still paused.';
    } catch {
      return 'This tab’s current data couldn’t be downloaded. Nothing was changed. Try again, or check your browser’s download settings.';
    }
  }
  function preUpgradeNow() {
    const offer = preUpgradeOffer(conflictCopies);
    if (!offer.available) return offer.hint;
    try {
      services.downloadOlderFormatBackup(app, offer.copy.older.backup);
      return 'Pre-upgrade copy (older-format backup) downloaded. Saving is still paused.';
    } catch {
      return 'The pre-upgrade copy couldn’t be downloaded. Nothing was changed. Try again, or check your browser’s download settings.';
    }
  }
  function storedArchiveNow() {
    if (!conflictCopies || conflictCopies.state === 'loading') return 'Still checking for the stored migration archive. Nothing was downloaded.';
    if (conflictCopies.state === 'error') return 'The stored migration archive couldn’t be read, so nothing was downloaded. Nothing was changed.';
    if (typeof services.downloadRawArchives !== 'function') return 'The stored migration archive can’t be downloaded here. Nothing was changed.';
    return archiveDownloadMessage(services.downloadRawArchives(conflictCopies.copies));
  }
  async function onShellAction(action, el) {
    switch (action) {
      case 'retry': if (app) await app.retryPersistence(); break;
      case 'download-backup': {
        state.bannerNote = backupNow('banner');
        const banner = root.querySelector('[data-shell-banner]');
        if (banner) banner.innerHTML = saveBannerView(state.status, state.bannerNote);
        break;
      }
      case 'download-conflict':
        if (isArchiveConflict(state.status)) { archiveNotes.current = currentDataNow(); syncConflict(); } else syncConflict(backupNow('conflict'));
        break;
      case 'download-preupgrade': archiveNotes.preUpgrade = preUpgradeNow(); syncConflict(); break;
      case 'download-archive': archiveNotes.archive = storedArchiveNow(); syncConflict(); break;
      case 'reload': services.reload(); break;
      case 'download-stored':
        try {
          await services.downloadStoredRecord(startupError);
          setRecovery({ downloaded: true, message: 'The stored data was downloaded.', tone: 'status', code: null, errors: [] }, '[data-shell-action="start-fresh"]');
        } catch (e) {
          setRecovery({ message: 'The stored data couldn’t be downloaded. Nothing was changed.', tone: 'error', code: e && e.code, errors: [] });
        }
        break;
      case 'choose-backup': { const input = root.querySelector('[data-shell-file]'); if (input) input.click(); break; }
      case 'recovery-cancel': setRecovery({ stage: 'idle', text: null, summary: null, message: '' }, '[data-shell-action="choose-backup"]'); break;
      case 'start-fresh': if (state.recovery && state.recovery.downloaded) setRecovery({ stage: 'confirm-fresh', message: '' }, '[data-shell-action="recovery-cancel"]'); break;
      case 'recovery-restore':
      case 'recovery-fresh': {
        const options = action === 'recovery-fresh' ? { startFresh: true } : { backup: state.recovery.text };
        setRecovery({ busy: true, message: action === 'recovery-fresh' ? 'Starting over…' : 'Restoring…', tone: 'status' });
        try {
          const next = await services.recover(options);
          state.recovery = null;
          state.recoveryAvailable = false;
          startupError = null;
          this.setDataLayer(next);
        } catch (e) {
          setRecovery({ busy: false, stage: 'idle', text: null, message: restoreErrorMessage(e && e.code), tone: 'error', code: e && e.code, errors: (e && e.details) || [] }, '[data-shell-action="choose-backup"]');
        }
        break;
      }
      default: break;
    }
    return el;
  }
  async function onBackupFile(input) {
    const file = input.files && input.files[0];
    if (!file) return;
    let text;
    try { text = await file.text(); } catch { setRecovery({ message: restoreErrorMessage('BACKUP_UNREADABLE'), tone: 'error', code: 'BACKUP_UNREADABLE', errors: [] }); return; }
    const result = services.validateRecoveryBackup(text); // validated in full; nothing is written here
    if (!result.valid) {
      setRecovery({ stage: 'idle', message: restoreFileErrorMessage(result.code, text), tone: 'error', code: result.code, errors: result.errors }, '[data-shell-action="choose-backup"]');
      return;
    }
    const parsed = JSON.parse(text);
    setRecovery({ stage: 'preview', text, summary: result.summary, exportedAt: parsed.exportedAt, message: '', code: null, errors: [] }, '#recovery-step-title');
  }

  // "Saving…" only appears if a save takes longer than about a second (§4.8), to avoid flicker.
  let savingTimer = null;
  function onStatus(next) {
    if (savingTimer) { win.clearTimeout(savingTimer); savingTimer = null; }
    if (next.state === 'saving') {
      savingTimer = win.setTimeout(() => { savingTimer = null; state.status = next; updateStatus(); }, 1000);
      return;
    }
    state.status = next;
    updateStatus();
  }

  return {
    state,
    start() {
      const shell = this;
      root.addEventListener?.('click', (event) => {
        const el = event.target.closest && event.target.closest('[data-shell-action]');
        if (el && root.contains(el)) onShellAction.call(shell, el.dataset.shellAction, el);
      });
      root.addEventListener?.('change', (event) => { if (event.target.matches && event.target.matches('[data-shell-file]')) onBackupFile(event.target); });
      // The conflict dialog can't be dismissed: editing stays blocked until the tab reloads (§4.8).
      // Escape is stopped before the browser's close watcher sees it (Chromium stops letting its
      // `cancel` be prevented after a couple of Escapes), and if the dialog is closed anyway while
      // the conflict stands, it is shown again at once.
      root.addEventListener?.('cancel', (event) => { if (event.target.matches && event.target.matches('[data-conflict]')) event.preventDefault(); }, true);
      doc.addEventListener?.('keydown', (event) => {
        if (event.key !== 'Escape') return;
        const conflict = root.querySelector('[data-conflict]');
        if (conflict && conflict.open) event.preventDefault();
      }, true);
      root.addEventListener?.('close', (event) => { if (event.target.matches && event.target.matches('[data-conflict]')) syncConflict(); }, true);
      syncRoute({ focusHeading: false });
      win.addEventListener('hashchange', () => syncRoute({ focusHeading: true }));
      doc.addEventListener?.('keydown', (event) => { if (state.startup === 'ready') handleShortcut(event, { route: state.route, doc, win }); });
      win.addEventListener('pagehide', flush);
      doc.addEventListener?.('visibilitychange', () => { if (doc.visibilityState === 'hidden') flush(); });
    },
    /** Called once the data layer has opened. */
    setDataLayer(dataLayer) {
      app = dataLayer;
      state.startup = 'ready';
      state.status = app.getPersistenceStatus();
      if (unsubscribe) unsubscribe();
      unsubscribe = app.onPersistenceChange(onStatus);
      render();
    },
    /** Called if the data layer could not open. */
    showStartupError(error) {
      state.startup = 'error';
      state.errorCode = error && error.code ? error.code : null;
      startupError = error || null;
      // Recovery actions need the stored record and the recovery services (§13.1).
      state.recoveryAvailable = !!(error && typeof error.readStoredRecord === 'function' && services.recover && services.validateRecoveryBackup);
      state.recovery = freshRecovery();
      render({ focusHeading: true });
    }
  };
}
