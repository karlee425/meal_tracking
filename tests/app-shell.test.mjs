// UI slice 1 — app shell and navigation (app/). V2_UI_CONTRACT.md §2, §3, §4.8, §13.1, §14.
// Node has no DOM, so the shell's rendering is tested as HTML and its controller with a
// minimal fake window/root; the real-browser behaviour was checked separately.
// Run: node --test tests/

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, macroArithmeticInSource, domainImportsBypassingIndex, FORBIDDEN_NUTRITION, classesOf } from './helpers.mjs';
import {
  PRIMARY_DESTINATIONS, SETTINGS_DESTINATION, DEFAULT_DESTINATION, resolveRoute, renderApp, renderPlaceholder,
  persistenceView, startupErrorView, createShell, escapeHtml
} from '../app/shell.js';
import { createDataLayer, createMemoryAdapter } from '../src/domain/index.js';
import { createFileAdapter } from '../src/node/file-adapter.js';

const APP_FILES = fs.readdirSync(path.join(ROOT, 'app')).map((f) => `app/${f}`);
const ready = (route) => renderApp({ route, startup: 'ready', status: null });
const navLinks = (html) => [...html.matchAll(/<a class="nav-link" href="([^"]+)" data-destination="([a-z]+)"( aria-current="page")?>/g)].map((m) => ({ href: m[1], id: m[2], current: !!m[3] }));
const currentIds = (html) => [...html.matchAll(/data-destination="([a-z]+)" aria-current="page"/g)].map((m) => m[1]);

/** Minimal fake browser: a root whose innerHTML is a string, a window with hash + history + events. */
function fakeBrowser(hash = '') {
  const listeners = {};
  const focused = [];
  const statusEl = { textContent: '', hidden: true, attrs: {}, setAttribute(k, v) { this.attrs[k] = v; } };
  const timers = [];
  const win = {
    location: { hash },
    history: { replaced: [], replaceState(_s, _t, url) { this.replaced.push(url); win.location.hash = url; } },
    addEventListener(type, fn) { (listeners[type] ||= []).push(fn); },
    setTimeout(fn) { timers.push(fn); return timers.length; },
    clearTimeout(id) { timers[id - 1] = null; },
    fire(type) { for (const fn of listeners[type] || []) fn(); },
    go(next) { win.location.hash = next; win.fire('hashchange'); }
  };
  const root = {
    innerHTML: '',
    renders: 0,
    querySelector(sel) {
      if (sel === '#screen-title') return { focus: () => focused.push(sel) };
      if (sel === '.save-status') return statusEl;
      return null;
    }
  };
  let html = '';
  Object.defineProperty(root, 'innerHTML', { get: () => html, set: (v) => { html = v; root.renders += 1; } });
  const doc = { title: '', visibilityState: 'visible', addEventListener: () => {} };
  return { win, root, doc, focused, statusEl, timers };
}

/* ---------------- routes ---------------- */

test('Shell — the four primary destinations and Settings resolve; anything else falls back to Today', () => {
  assert.deepEqual(PRIMARY_DESTINATIONS.map((d) => d.id), ['today', 'log', 'meals', 'progress'], 'approved order (A-03)');
  assert.deepEqual(PRIMARY_DESTINATIONS.map((d) => d.label), ['Today', 'Log', 'Meals', 'Progress']);
  for (const d of [...PRIMARY_DESTINATIONS, SETTINGS_DESTINATION]) assert.deepEqual(resolveRoute(d.href), { id: d.id, known: true });
  assert.equal(DEFAULT_DESTINATION, 'today');
  for (const h of ['', '#', '#/']) assert.deepEqual(resolveRoute(h), { id: 'today', known: true }, `launch: ${JSON.stringify(h)}`);
  for (const h of ['#/coach', '#/Today', '#/today%20', '#settings', '#/../log', '#/<script>']) {
    assert.deepEqual(resolveRoute(h), { id: 'today', known: false }, `fallback: ${h}`);
  }
  for (const h of [undefined, null, 42]) assert.equal(resolveRoute(h).id, 'today', `no crash on ${String(h)}`);
  assert.deepEqual(resolveRoute('#/today?date=2026-09-24'), { id: 'today', known: true }, 'later slices can add a query');
});

/* ---------------- rendering ---------------- */

test('Shell — landmarks, primary nav, secondary Settings and exactly one active destination', () => {
  for (const d of [...PRIMARY_DESTINATIONS, SETTINGS_DESTINATION]) {
    const html = ready(d.id);
    assert.equal((html.match(/<header /g) || []).length, 1, 'one header');
    assert.equal((html.match(/<nav class="primary-nav" aria-label="Primary">/g) || []).length, 1, 'one labelled nav landmark');
    assert.equal((html.match(/<main id="main"/g) || []).length, 1, 'one main');
    assert.match(html, /<a class="skip-link" href="#main">/);
    const links = navLinks(html);
    assert.deepEqual(links.map((l) => l.id), ['today', 'log', 'meals', 'progress'], 'the nav holds exactly the four primary destinations');
    assert.deepEqual(links.map((l) => l.href), ['#/today', '#/log', '#/meals', '#/progress']);
    assert.deepEqual(currentIds(html), [d.id], `${d.id}: exactly one aria-current`);
    const nav = html.slice(html.indexOf('<nav'), html.indexOf('</nav>'));
    assert.ok(!nav.includes('settings'), 'Settings is not in the primary nav');
    assert.match(html, /<a class="header-button" href="#\/settings" data-destination="settings"[^>]*>[\s\S]*?<span class="visually-hidden">Settings<\/span><\/a>/, 'Settings is a labelled header control');
    assert.match(html, new RegExp(`<h1 id="screen-title"[^>]*>${d.label}</h1>`), 'the screen heading names the destination');
    assert.equal((html.match(/<h1/g) || []).length, 1, 'one h1');
    assert.match(html, /data-slot="contextual-actions"/, 'a place for contextual actions');
    assert.ok(!/coach/i.test(html), 'Macro Coach is not a navigation destination');
  }
});

test('Shell — placeholders say what they are and contain no data or fake content', () => {
  for (const d of [...PRIMARY_DESTINATIONS, SETTINGS_DESTINATION]) {
    const html = renderPlaceholder(d.id);
    const text = html.replace(/<[^>]*>/g, ' ');
    assert.match(text, /hasn't been built yet/);
    assert.ok(!/\d/.test(text), `${d.id}: no numbers`);
    assert.ok(!/\b(protein|carbs|fat|grams?|target|remaining|meal)\b/i.test(text.replace(d.label, '')), `${d.id}: no pretend nutrition content`);
  }
  assert.match(renderPlaceholder('nope'), />Today</, 'unknown id renders the fallback');
});

test('Shell — start-up states: loading, and blocking errors by stable code', () => {
  const loading = renderApp({ route: 'meals', startup: 'loading' });
  assert.match(loading, /<main id="main"[^>]*aria-busy="true"/);
  assert.match(loading, /role="status">Opening your data/);
  assert.equal(navLinks(loading).length, 4, 'navigation works while loading');

  for (const code of ['STORAGE_UNAVAILABLE', 'DATA_INVALID', 'STORED_DATA_UNRECOGNIZED', undefined]) {
    const html = renderApp({ route: 'today', startup: 'error', errorCode: code });
    const v = startupErrorView(code);
    assert.match(html, /role="alert"/);
    assert.ok(html.includes(escapeHtml(v.title)));
    assert.ok(!html.includes('<nav'), 'blocking screen: no navigation');
    assert.ok(!html.includes('#/settings'), 'blocking screen: no settings');
  }
  assert.notEqual(startupErrorView('STORAGE_UNAVAILABLE').title, startupErrorView('DATA_INVALID').title);
  assert.equal(startupErrorView('DATA_INVALID').title, startupErrorView('STORED_DATA_UNRECOGNIZED').title);
});

test('Shell — the save indicator reflects the data layer status (§4.8)', () => {
  assert.deepEqual(persistenceView(null), { state: 'none', text: '', hidden: true });
  assert.equal(persistenceView({ state: 'saved', lastSavedAt: null }).hidden, true, 'hidden before the first save');
  assert.deepEqual(persistenceView({ state: 'saved', lastSavedAt: '2026-09-27T12:00:00Z' }), { state: 'saved', text: 'Saved', hidden: false });
  assert.equal(persistenceView({ state: 'saving' }).text, 'Saving…');
  assert.equal(persistenceView({ state: 'error' }).text, 'Not saved');
  assert.equal(persistenceView({ state: 'conflict' }).text, 'Changed elsewhere');
  const html = renderApp({ route: 'today', startup: 'ready', status: { state: 'error' } });
  assert.match(html, /<span class="save-status" data-state="error" role="status" aria-live="polite">Not saved<\/span>/);
});

/* ---------------- controller ---------------- */

test('Shell — navigation without reloads: every destination reachable, active state follows, unknown falls back', () => {
  const { win, root, doc, focused } = fakeBrowser('#/log');
  const shell = createShell({ root, win, doc });
  shell.start();
  assert.equal(shell.state.route, 'log', 'refresh on a route restores it');
  assert.deepEqual(currentIds(root.innerHTML), ['log']);
  assert.equal(focused.length, 0, 'no focus move on first load');
  assert.equal(doc.title, 'Log · Macro Tracker');

  for (const d of ['today', 'meals', 'progress', 'settings', 'log']) {
    win.go(`#/${d}`);
    assert.equal(shell.state.route, d);
    assert.deepEqual(currentIds(root.innerHTML), [d]);
    assert.match(root.innerHTML, new RegExp(`<h1 id="screen-title"[^>]*>${d === 'settings' ? 'Settings' : d[0].toUpperCase() + d.slice(1)}</h1>`));
  }
  assert.equal(focused.length, 5, 'focus moves to the new heading on each navigation');

  win.go('#/coach');
  assert.equal(shell.state.route, 'today');
  assert.deepEqual(win.history.replaced, ['#/today'], 'unknown route replaced (no extra history entry)');
  assert.deepEqual(currentIds(root.innerHTML), ['today']);
  assert.equal(win.history.replaced.length, 1);
});

test('Shell — connects to the data layer without doing any of its work', async () => {
  const { win, root, doc, statusEl, timers } = fakeBrowser('#/progress');
  const shell = createShell({ root, win, doc });
  shell.start();
  assert.equal(shell.state.startup, 'loading');

  let listener = null;
  let flushed = 0;
  const fakeApp = {
    getPersistenceStatus: () => ({ state: 'saved', lastSavedAt: null }),
    onPersistenceChange: (fn) => { listener = fn; return () => {}; },
    flushPersistence: () => { flushed += 1; return Promise.resolve(); }
  };
  shell.setDataLayer(fakeApp);
  assert.equal(shell.state.startup, 'ready');
  assert.match(root.innerHTML, /class="save-status"[^>]* hidden>/, 'first run: indicator hidden');

  const renders = root.renders;
  listener({ state: 'error', lastSavedAt: null });
  assert.equal(root.renders, renders, 'status changes do not re-render the screen');
  assert.equal(statusEl.textContent, 'Not saved');
  assert.equal(statusEl.hidden, false);

  listener({ state: 'saving' });
  assert.equal(statusEl.textContent, 'Not saved', '"Saving…" waits about a second');
  timers.at(-1)();
  assert.equal(statusEl.textContent, 'Saving…');
  listener({ state: 'saving' });
  listener({ state: 'saved', lastSavedAt: '2026-09-27T12:00:00Z' });
  assert.equal(timers.at(-1), null, 'a fast save cancels the pending "Saving…"');
  assert.equal(statusEl.textContent, 'Saved');

  win.fire('pagehide');
  assert.equal(flushed, 1, 'saves are flushed when the page is hidden');

  const failing = fakeBrowser('#/meals');
  const s2 = createShell(failing);
  s2.start();
  s2.showStartupError({ code: 'STORAGE_UNAVAILABLE' });
  assert.match(failing.root.innerHTML, /This browser can(?:'|&#39;)t save your data/);
  assert.equal(failing.focused.length, 1, 'focus moves to the blocking message');

  // With the real data layer (memory adapter): the shell reads status only.
  const real = createDataLayer({ adapter: createMemoryAdapter(createFileAdapter(ROOT).load()) });
  const s3 = createShell(fakeBrowser('#/today'));
  s3.start();
  s3.setDataLayer(real);
  assert.equal(s3.state.status.state, 'saved');
});

/* ---------------- architecture ---------------- */

test('Shell — no nutrition arithmetic, no forbidden terms, domain reached only through its entry points', () => {
  for (const f of APP_FILES) {
    const src = fs.readFileSync(path.join(ROOT, f), 'utf8');
    assert.deepEqual(macroArithmeticInSource(src, f), [], `${f}: no macro arithmetic`);
    assert.ok(!FORBIDDEN_NUTRITION.test(src), `${f}: no forbidden nutrition terms`);
    assert.deepEqual(domainImportsBypassingIndex(src), [], `${f}: domain only via src/domain/index.js`);
    assert.deepEqual(classesOf(f), ['runtime'], `${f} is classified as runtime, so the boundary tests scan it`);
  }
  const shellSrc = fs.readFileSync(path.join(ROOT, 'app/shell.js'), 'utf8');
  assert.ok(!/^import /m.test(shellSrc), 'the shell imports nothing: no domain logic inside it');
  const mainSrc = fs.readFileSync(path.join(ROOT, 'app/main.js'), 'utf8');
  assert.deepEqual([...mainSrc.matchAll(/from '([^']+)'/g)].map((m) => m[1]).sort(), ['../src/browser/app-data.js', './shell.js', './today.js'], 'data comes only through the browser contract; built screens are registered with the shell');
  assert.ok(!/localStorage|sessionStorage|indexedDB/.test(shellSrc + mainSrc), 'no second persistence mechanism');
});
