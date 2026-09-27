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
    case 'conflict': return { state: 'conflict', text: 'Changed elsewhere', hidden: false };
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
</section>`;
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
${nav}
<main id="main" class="app-main" tabindex="-1"${state.startup === 'loading' ? ' aria-busy="true"' : ''}>
${renderMain(state)}
</main>
</div>`;
}

/* ---------------- controller ---------------- */

/**
 * Mount the shell.
 *   root   the element to render into
 *   win    the window (location.hash, history, events)
 *   doc    the document (title)
 * Returns { start, setDataLayer, showStartupError, state }.
 */
export function createShell({ root, win, doc }) {
  const state = { route: DEFAULT_DESTINATION, startup: 'loading', errorCode: null, status: null };
  let app = null;
  let unsubscribe = null;

  function render({ focusHeading = false } = {}) {
    root.innerHTML = renderApp(state);
    const label = state.startup === 'error' ? startupErrorView(state.errorCode).title : destination(state.route).label;
    doc.title = `${label} · ${APP_NAME}`;
    if (focusHeading) {
      const heading = root.querySelector('#screen-title');
      if (heading) heading.focus();
    }
  }

  function syncRoute({ focusHeading }) {
    const { id, known } = resolveRoute(win.location.hash);
    if (!known) win.history.replaceState(null, '', destination(id).href); // unknown → Today, no reload, no extra history entry
    const changed = id !== state.route;
    state.route = id;
    render({ focusHeading: focusHeading && changed });
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
      syncRoute({ focusHeading: false });
      win.addEventListener('hashchange', () => syncRoute({ focusHeading: true }));
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
      render({ focusHeading: true });
    }
  };
}
