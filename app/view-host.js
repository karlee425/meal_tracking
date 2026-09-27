/*
 * view-host.js — how a screen shows its sheets, panels and detail views (V2_UI_CONTRACT.md
 * §2.3, §3.1 / I-05). Shared by Log and Meals so both behave the same at every width.
 *
 * One <dialog> per screen. A screen names which of its surfaces are detail/editing "views";
 * everything else is a short choice (a confirmation, a name prompt, a day type…).
 *   wide     'pane'   — non-modal, in the right-hand pane beside the list (two panes)
 *   medium   'panel'  — views as a side panel; short choices stay centred dialogs
 *   compact  'pushed' — views full screen with a Back control and their own history entry,
 *                       so the browser's Back closes them; short choices are bottom sheets
 * Breakpoints are in em, so a larger text size counts as less room.
 */

import { escapeHtml } from './shell.js';

export const WIDE_QUERY = '(min-width: 64em)';
export const COMPACT_QUERY = '(max-width: 37.49em)';

/** 'compact' (< ~600 px) · 'medium' · 'wide' (≥ ~1024 px), with the stylesheet's breakpoints. */
export function widthClass(win) {
  const matches = (q) => !!(win && win.matchMedia && win.matchMedia(q).matches);
  if (matches(WIDE_QUERY)) return 'wide';
  return matches(COMPACT_QUERY) ? 'compact' : 'medium';
}

/** How a surface of the given type is shown at a width, given the screen's view types. */
export function presentationFor(type, width, viewTypes) {
  if (width === 'wide') return 'pane';
  if (!viewTypes.includes(type)) return 'sheet';
  return width === 'compact' ? 'pushed' : 'panel';
}

/** Header for a detail/editing view: a Back control when pushed full screen, Close otherwise (CSS picks one). */
export const viewHead = (title, subtitle = '') => `<header class="sheet-head view-head">
<button type="button" class="link-button view-back" data-action="close"><svg class="icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M15 5l-7 7 7 7"/></svg>Back</button>
<h2 id="sheet-title" class="sheet-title">${escapeHtml(title)}</h2>
${subtitle ? `<p class="sheet-subtitle">${escapeHtml(subtitle)}</p>` : ''}
<button type="button" class="icon-button view-close" data-action="close" aria-label="Close"><svg class="icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M6 6l12 12M18 6 6 18"/></svg></button>
</header>`;

/**
 * Update the [data-sync] parts of a form in place from freshly rendered HTML. In place, never
 * replaced: a field's change event fires on the same click that presses Save, and replacing
 * the button mid-click would swallow that click.
 */
export function syncInPlace(container, html, doc) {
  const tpl = doc.createElement('template');
  tpl.innerHTML = html;
  for (const el of tpl.content.querySelectorAll('[data-sync]')) {
    const current = container.querySelector(`[data-sync="${el.dataset.sync}"]`);
    if (!current) continue;
    for (const name of current.getAttributeNames()) if (!el.hasAttribute(name)) current.removeAttribute(name);
    for (const name of el.getAttributeNames()) current.setAttribute(name, el.getAttribute(name));
    if (current.innerHTML !== el.innerHTML) current.innerHTML = el.innerHTML;
  }
}

/**
 * Manage one screen's dialog.
 *   page           the element that becomes two panes on wide screens (gets .has-view)
 *   dialog         the screen's <dialog>
 *   viewTypes      which surface types are detail/editing views
 *   fallbackFocus  () => element to focus when nothing better is left after closing
 *   onClose        called when the dialog has closed, before focus returns
 *   beforeLeave    optional () => boolean, asked before Escape or the browser's Back closes the
 *                  surface; false keeps it open (e.g. "Discard changes?", or a picker stepping
 *                  back to the editor that opened it). Screens ask it for their own Close too.
 * Returns { open(type, draw, { startAtTitle }), close(), returnFocusTo(el), leave(nav), destroy() }.
 */
export function createViewHost({ page, dialog, win, doc, viewTypes, fallbackFocus, onClose, beforeLeave = null }) {
  let width = 'medium';
  let modal = true;
  let opener = null;
  let pendingFocus = null;
  // A full-screen view on compact screens gets its own history entry, so the browser's
  // Back closes it (like any pushed view) instead of leaving the screen.
  let viewEntry = false;
  let closingWithEntry = false; // the surface just closed while its view entry was still on top
  let skipPops = 0;
  let replaceAfterPop = null;
  const closeDialog = () => { if (dialog.open) dialog.close(); };
  const onPop = () => {
    if (replaceAfterPop) { const href = replaceAfterPop; replaceAfterPop = null; win.location.replace(href); return; }
    if (skipPops) { skipPops -= 1; return; }
    if (viewEntry) {
      // Browser Back on a pushed view: close it, unless the screen keeps it (then restore the entry).
      if (beforeLeave && !beforeLeave()) { win.history.pushState({ view: true }, '', win.location.href); return; }
      viewEntry = false;
      closeDialog();
    }
  };
  win.addEventListener('popstate', onPop);

  // Escape closes the non-modal pane too (modal dialogs get it from the browser).
  dialog.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape' || !dialog.open || modal) return;
    event.preventDefault();
    if (!beforeLeave || beforeLeave()) closeDialog();
  });
  dialog.addEventListener('cancel', (event) => { if (beforeLeave && !beforeLeave()) event.preventDefault(); });
  dialog.addEventListener('close', () => {
    closingWithEntry = viewEntry;
    viewEntry = false;
    page.classList.remove('has-view');
    delete dialog.dataset.present;
    dialog.innerHTML = '';
    if (onClose) onClose(); // may leave the screen, which then unwinds the view entry in one step
    if (closingWithEntry) { closingWithEntry = false; skipPops += 1; win.history.back(); }
    const target = pendingFocus && pendingFocus.isConnected ? pendingFocus
      : opener && opener.isConnected ? opener : fallbackFocus();
    opener = null;
    pendingFocus = null;
    if (target) target.focus();
  });

  return {
    /** Show a surface: draw() renders it into the dialog. A detail view can start at its title. */
    open(type, draw, { startAtTitle = false } = {}) {
      const wasOpen = dialog.open;
      if (!wasOpen) { opener = doc.activeElement; width = widthClass(win); }
      const present = presentationFor(type, width, viewTypes);
      dialog.dataset.present = present;
      draw();
      if (!wasOpen) {
        modal = present !== 'pane';
        if (modal) dialog.showModal();
        else { page.classList.add('has-view'); dialog.show(); } // wide: the right-hand pane
      }
      if (present === 'pushed' && !viewEntry) { win.history.pushState({ view: true }, '', win.location.href); viewEntry = true; }
      // A read-only detail view starts at its title (and top); forms start at their first field.
      const auto = dialog.querySelector('[data-autofocus]')
        || (startAtTitle ? null : dialog.querySelector('input:not([type=radio]):not([type=checkbox]), select, .sheet-actions .button.primary:not([disabled])'))
        || dialog.querySelector('#sheet-title');
      if (auto) { if (auto.id === 'sheet-title') auto.setAttribute('tabindex', '-1'); auto.focus(); }
    },
    close: closeDialog,
    /** Where focus goes when the open surface closes (instead of what opened it). */
    returnFocusTo(el) { pendingFocus = el; },
    /**
     * Leave the screen: { method: 'back' } | { method: 'replace', href } | { method: 'push', href }.
     * A pushed view's history entry sits on top of the screen's, so it is unwound too (for
     * 'push', the new screen takes the view entry's place).
     */
    leave(nav) {
      const hadViewEntry = viewEntry || closingWithEntry;
      viewEntry = false;
      closingWithEntry = false;
      closeDialog();
      if (nav.method === 'back') win.history.go(hadViewEntry ? -2 : -1);
      else if (nav.method === 'push') { if (hadViewEntry) win.location.replace(nav.href); else win.location.hash = nav.href; }
      else if (hadViewEntry) { replaceAfterPop = nav.href; win.history.back(); }
      else win.location.replace(nav.href);
    },
    destroy() { win.removeEventListener('popstate', onPop); }
  };
}
