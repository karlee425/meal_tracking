/*
 * ui-g11-g15.test.mjs — V2 UI gaps G11–G15 (V2_UI_CONTRACT.md §3.2, §9.2.1, §10.1, §12, §14).
 *   G11  "Discard changes?" for Today's logged-meal editor and Log's new-food form
 *   G12  Progress: Custom range and ◀ ▶ window stepping (I-41)
 *   G13  persistent-storage request after the first save; Settings "Protected from automatic clean-up"
 *   G14  the one-time first-run welcome card (I-49)
 *   G15  keyboard shortcuts: "/", Enter, Escape (§14)
 * Node has no DOM: renderers are tested as HTML and controllers with small fakes; the real-browser
 * behaviour at 320 / 375 / 800 / 1280 and 200% text was checked separately (see the slice report).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, macroArithmeticInSource, FORBIDDEN_NUTRITION, domainImportsBypassingIndex } from './helpers.mjs';
import { createDataLayer, createMemoryAdapter, addDays } from '../src/domain/index.js';
import { createFileAdapter } from '../src/node/file-adapter.js';
import { createStorageProtection, isStoragePersisted } from '../src/browser/storage-protection.js';
import { createShell, handleShortcut, isEditable, confirmsOnEnter, SEARCH_SHORTCUT_ROUTES } from '../app/shell.js';
import { todayModel, renderToday, WELCOME_TEXT, editKey, editDirty, renderDiscardEdit, renderEditDialog, todayScreen } from '../app/today.js';
import { renderDiscardFood } from '../app/foods.js';
import { customFoodDirty, renderCustomFoodForm, logScreen } from '../app/log.js';
import { renderSettings, renderTargetForm, protectionText, settingsFoodsModel } from '../app/settings.js';
import { resetSession, session } from '../app/session.js';
import {
  progressPeriod, progressWindow, progressModel, canStepForward, steppedRange, checkCustomRange, CUSTOM_MAX_DAYS,
  RANGE_MESSAGES, renderProgressTop, renderCustomRange, rangeLabel
} from '../app/progress.js';

const TODAY = '2026-09-27';
const SEED = createFileAdapter(ROOT).load();
const text = (html) => html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

function setup({ status = { state: 'saved', lastSavedAt: null, error: null } } = {}) {
  resetSession();
  const inner = createMemoryAdapter(SEED);
  const writes = [];
  const current = { status };
  const adapter = {
    load: () => inner.load(),
    save: (c, d) => inner.save(c, d),
    saveMany: (ch) => { writes.push(Object.keys(ch)); inner.saveMany(ch); },
    status: () => current.status
  };
  let t = Date.parse(`${TODAY}T12:00:00Z`);
  const app = createDataLayer({ adapter, today: () => TODAY, clock: () => new Date((t += 60000)) });
  return { app, writes, current };
}

/* ======================= G11 — Discard changes? ======================= */

test('G11 — the logged-meal editor is dirty only when its name, slot or rows change', () => {
  const edit = { name: 'Oats bowl', slot: 'breakfast', rows: [{ foodId: 'a', text: '80' }, { foodId: 'b', text: '150' }] };
  edit.original = editKey(edit);
  assert.equal(editDirty(edit), false, 'untouched');
  assert.equal(editDirty({ ...edit, name: '  Oats bowl ' }), false, 'surrounding spaces are not a change');
  assert.equal(editDirty({ ...edit, name: 'Oat bowl' }), true, 'name');
  assert.equal(editDirty({ ...edit, slot: 'lunch' }), true, 'slot');
  assert.equal(editDirty({ ...edit, rows: [{ foodId: 'a', text: '85' }, { foodId: 'b', text: '150' }] }), true, 'grams');
  assert.equal(editDirty({ ...edit, rows: [{ foodId: 'a', text: '80' }] }), true, 'a row removed');
  assert.equal(editDirty({ ...edit, rows: [...edit.rows, { foodId: 'c', text: '' }] }), true, 'a row added');
  assert.equal(editDirty({ name: 'x', slot: 'lunch', rows: [] }), false, 'no original: nothing to compare, never asks');
});

test('G11 — "Discard changes?" copy: Keep editing (focused) · Discard, for the editor and for a new food', () => {
  const edit = renderDiscardEdit();
  assert.match(edit, /<h2 id="sheet-title"[^>]*>Discard changes\?<\/h2>/);
  assert.match(text(edit), /Your changes to this logged meal haven’t been saved\./);
  assert.match(edit, /data-action="keep-editing" data-autofocus>Keep editing</);
  assert.match(edit, /class="button danger" data-action="discard">Discard</);
  assert.match(text(renderDiscardFood({ created: true })), /This new food hasn’t been saved\./);
  assert.match(text(renderDiscardFood()), /Your changes to this food haven’t been saved\./, 'the edit wording is unchanged');
});

test('G11 — Log’s new-food form: prefilled from the search it is not dirty; any typed value is', () => {
  const values = { name: 'Zzq bar', category: '', state: '', brand: '', protein: '', carbs: '', fat: '', aliases: '' };
  const form = { values: { ...values }, initial: { ...values } };
  assert.equal(customFoodDirty(form), false, 'untouched: no question');
  form.values.category = 'snack';
  assert.equal(customFoodDirty(form), true);
  form.values.category = '';
  assert.equal(customFoodDirty(form), false, 'typed then cleared is the same as untouched');
  const src = read('app/log.js');
  assert.match(src, /openDialog\(\{ type: 'custom-food', values, initial: \{ \.\.\.values \}/, 'the new-food form records what it opened with');
  assert.match(read('app/today.js'), /type: 'custom-food', values, initial: \{ \.\.\.values \}/, 'so does the one opened from the editor’s picker');
});

test('G11 — Back, Close, Escape and navigating away all go through one check per screen; discarding writes nothing', () => {
  for (const [file, screen] of [['app/today.js', todayScreen], ['app/log.js', logScreen]]) {
    const src = read(file);
    assert.equal(typeof screen.leaveGuard, 'function', `${file}: the shell can ask before a route change`);
    assert.equal(screen.leaveGuard(() => {}), true, `${file}: not mounted → nothing to lose`);
    assert.match(src, /case 'close': if \(beforeLeave\(\)\) closeDialog\(\); break;/, `${file}: Close / Cancel / Back ask beforeLeave`);
    assert.match(src, /beforeLeave\n\s*\}\);/, `${file}: Escape and the browser's Back reach beforeLeave through the view host`);
    assert.match(src, /if \(dialog\.open && !dialog\.contains\(el\) && !guardLeave\(/, `${file}: a control beside an open pane asks first`);
    const start = src.indexOf('function discardChanges');
    const discard = src.slice(start, src.indexOf('\n    }\n', start));
    assert.ok(!/app\.|actions\.|foodActions\./.test(discard), `${file}: Discard calls no domain operation`);
  }
});

test('G11 — the shell holds a route change while the screen asks, then goes there after Discard', () => {
  const listeners = {};
  const pushed = [];
  let backs = 0;
  const win = {
    location: { hash: '#/today', get href() { return `http://app/${this.hash}`; } },
    history: {
      pushState(_s, _t, url) { pushed.push(url); win.location.hash = url.replace('http://app/', ''); },
      replaceState() {},
      back() { backs += 1; }
    },
    addEventListener(type, fn) { (listeners[type] ||= []).push(fn); },
    setTimeout: () => 0,
    clearTimeout() {},
    fire(type) { for (const fn of listeners[type] || []) fn(); }
  };
  const main = {};
  const root = { innerHTML: '', querySelector: (sel) => (sel === '#main' ? main : null) };
  const doc = { title: '', addEventListener() {} };
  let dirty = true;
  let proceed = null;
  const mounts = [];
  const screen = (id) => ({
    mount() { mounts.push(id); return false; },
    unmount() {},
    leaveGuard(next) { if (!dirty) return true; proceed = next; return false; }
  });
  const shell = createShell({ root, win, doc, screens: { today: screen('today'), log: screen('log') } });
  shell.start();
  shell.setDataLayer({ getPersistenceStatus: () => ({ state: 'saved', lastSavedAt: 'x' }), onPersistenceChange: () => () => {}, flushPersistence: () => Promise.resolve() });
  assert.deepEqual(mounts, ['today']);

  win.location.hash = '#/log';
  win.fire('hashchange');
  assert.deepEqual(mounts, ['today'], 'Today stays mounted while "Discard changes?" asks');
  assert.equal(shell.state.route, 'today');
  assert.deepEqual(pushed, ['http://app/#/today'], 'the address goes back to what is showing, as a new entry');
  assert.equal(typeof proceed, 'function');

  dirty = false; // Discard
  proceed();
  assert.equal(backs, 1, 'after Discard the shell steps back to where the user was going');
  win.location.hash = '#/log';
  win.fire('hashchange');
  assert.deepEqual(mounts, ['today', 'log']);
  assert.equal(shell.state.route, 'log');
});

/* ======================= G12 — Progress range ======================= */

test('G12 — 7 / 14 / 30 end today by default; ◀ ends a window the day before, ▶ never passes today', () => {
  const { app } = setup();
  assert.deepEqual(progressWindow(app, { period: 7 }), { period: 7, endDate: TODAY });
  assert.deepEqual(progressWindow(app, { period: 14, endDate: '2026-09-01' }), { period: 14, endDate: '2026-09-01' });
  assert.deepEqual(progressWindow(app, { period: 7, endDate: '2026-10-05' }), { period: 7, endDate: TODAY }, 'never past today');
  const now = progressModel(app, { period: 7 });
  assert.equal(canStepForward(app, now), false, '▶ unavailable at today');
  const back = steppedRange(app, { period: 7 }, now, -1);
  assert.deepEqual(back, { endDate: addDays(now.period.startDate, -1), custom: undefined });
  const older = progressModel(app, { period: 7, ...back });
  assert.equal(older.period.days, 7, 'the same length');
  assert.equal(older.period.endDate, '2026-09-20');
  assert.equal(canStepForward(app, older), true);
  assert.equal(steppedRange(app, { period: 7, ...back }, older, 1).endDate, null, '▶ back to "ends today"');
  const thirty = progressModel(app, { period: 30 });
  assert.equal(steppedRange(app, { period: 30 }, thirty, -1).endDate, addDays(TODAY, -30), 'moves by its own length');
});

test('G12 — a Custom range moves by its own length; ▶ stops at a window ending today, same length', () => {
  const { app } = setup();
  const state = { period: 'custom', custom: { startDate: '2026-09-10', endDate: '2026-09-17' } };
  assert.equal(progressPeriod(state), 'custom');
  assert.equal(progressPeriod({ period: 'custom', custom: null }), 7, 'no range chosen yet → the default');
  assert.deepEqual(progressWindow(app, state), { startDate: '2026-09-10', endDate: '2026-09-17' });
  const p = progressModel(app, state);
  assert.deepEqual(p, app.getProgress({ startDate: '2026-09-10', endDate: '2026-09-17' }), 'the domain result, unchanged');
  assert.deepEqual(steppedRange(app, state, p, -1).custom, { startDate: '2026-09-02', endDate: '2026-09-09' });
  assert.deepEqual(steppedRange(app, state, p, 1).custom, { startDate: '2026-09-18', endDate: '2026-09-25' });
  const late = { period: 'custom', custom: { startDate: '2026-09-18', endDate: '2026-09-25' } };
  assert.deepEqual(steppedRange(app, late, progressModel(app, late), 1).custom, { startDate: '2026-09-20', endDate: TODAY }, 'clipped at today');
});

test('G12 — Custom range checks: required, the domain’s INVALID_DATE / INVALID_PERIOD, end ≤ today, at most 90 days (I-41)', () => {
  const { app, writes } = setup();
  const code = (r) => checkCustomRange(app, r).code;
  assert.equal(code({ startDate: '', endDate: TODAY }), 'START_REQUIRED');
  assert.equal(code({ startDate: '2026-09-01', endDate: '' }), 'END_REQUIRED');
  assert.equal(code({ startDate: '2026-09-10', endDate: '2026-09-01' }), 'INVALID_PERIOD');
  assert.deepEqual(checkCustomRange(app, { startDate: '2026-09-10', endDate: '2026-09-01' }).fields, ['start', 'end']);
  assert.equal(code({ startDate: '2026-02-30', endDate: '2026-09-01' }), 'INVALID_DATE');
  assert.equal(code({ startDate: '2026-09-20', endDate: '2026-09-28' }), 'END_AFTER_TODAY');
  assert.deepEqual(checkCustomRange(app, { startDate: '2026-09-20', endDate: '2026-09-28' }).fields, ['end']);
  assert.equal(CUSTOM_MAX_DAYS, 90);
  assert.equal(code({ startDate: addDays(TODAY, -90), endDate: TODAY }), 'TOO_LONG', '91 days');
  const ok = checkCustomRange(app, { startDate: addDays(TODAY, -89), endDate: TODAY });
  assert.equal(ok.ok, true, '90 days');
  assert.equal(ok.progress.period.days, 90);
  assert.equal(checkCustomRange(app, { startDate: TODAY, endDate: TODAY }).ok, true, 'a single day');
  assert.equal(RANGE_MESSAGES.INVALID_PERIOD, 'The start date must be on or before the end date.');
  assert.equal(writes.length, 0, 'checking writes nothing');
});

test('G12 — range selector, ◀ range ▶ and the Custom pickers', () => {
  const { app } = setup();
  const now = progressModel(app, { period: 7 });
  const top = renderProgressTop(now, { period: 7, endsToday: true, today: TODAY });
  assert.match(top, /data-action="period-custom" aria-pressed="false">Custom</);
  assert.equal((top.match(/aria-pressed="true"/g) || []).length, 1);
  assert.match(top, /data-action="range-prev" aria-label="Previous 7 days"/);
  assert.match(top, /data-action="range-next" aria-label="Next 7 days, not available: the range already ends today" aria-disabled="true"/, 'still focusable, announced as unavailable');
  assert.match(top, /data-range>Last 7 days · /);
  assert.ok(!/range-start/.test(top), 'no pickers until Custom');
  const older = progressModel(app, { period: 7, endDate: '2026-09-20' });
  assert.equal(rangeLabel(older, { period: 7, endsToday: false }), `7 days · ${text(renderProgressTop(older, { period: 7, endsToday: false })).match(/7 days · (.+?) Based/)[1]}`);
  assert.ok(!/aria-disabled/.test(renderProgressTop(older, { period: 7, endsToday: false })));
  const custom = progressModel(app, { period: 'custom', custom: { startDate: '2026-09-10', endDate: '2026-09-17' } });
  const ctop = renderProgressTop(custom, { period: 'custom', endsToday: false, today: TODAY });
  assert.match(ctop, /data-action="period-custom" aria-pressed="true">Custom</);
  assert.match(ctop, /<input id="range-start" type="date" data-range-field="start" value="2026-09-10" max="2026-09-27" required aria-describedby="range-error range-hint">/);
  assert.match(ctop, /<label class="field" for="range-end">End<\/label>/);
  assert.match(ctop, /data-range>Custom · 8 days · /);
  assert.match(ctop, /data-enter-scope/, 'Enter in a picker confirms it (G15)');
  const bad = renderCustomRange({ startDate: '2026-09-17', endDate: '2026-09-10', check: checkCustomRange(app, { startDate: '2026-09-17', endDate: '2026-09-10' }) }, { today: TODAY });
  assert.match(bad, /id="range-start"[^>]* aria-invalid="true" data-invalid>/);
  assert.match(bad, /<p id="range-error" class="field-error" data-range-error data-code="INVALID_PERIOD">The start date must be on or before the end date\.<\/p>/, 'inline under the pickers');
  assert.match(bad, /data-action="range-apply" disabled>Show range</, 'unavailable while invalid (A-45)');
});

test('G12 — the range is session state only (§3.2), and Progress still writes nothing', () => {
  resetSession();
  assert.deepEqual(session.progress, { period: null, macro: null, endDate: null, custom: null });
  const src = read('app/progress.js');
  assert.ok(!/localStorage|sessionStorage|indexedDB/.test(src));
  assert.ok(!/app\.(create|update|delete|set|log|apply|replace|duplicate)\w*\(/.test(src));
});

/* ======================= G13 — persistent storage ======================= */

function fakeApp(status) {
  let listener = null;
  return {
    status,
    getPersistenceStatus() { return this.status; },
    onPersistenceChange(fn) { listener = fn; return () => { listener = null; }; },
    emit(next) { this.status = next; if (listener) listener(next); },
    listening: () => !!listener
  };
}
function fakeNav({ persisted = false, persist = true, throws = false } = {}) {
  const calls = { persisted: 0, persist: 0 };
  return {
    calls,
    storage: {
      persisted: async () => { calls.persisted += 1; if (throws) throw new Error('x'); return persisted; },
      persist: async () => { calls.persist += 1; if (throws) throw new Error('x'); return persist; }
    }
  };
}
const SAVED = { state: 'saved', lastSavedAt: '2026-09-27T12:00:00Z' };
const FIRST_RUN = { state: 'saved', lastSavedAt: null };

test('G13 — with saved data: asked once; granted → Yes, refused → Not granted', async () => {
  for (const [answer, expected] of [[true, 'granted'], [false, 'not-granted']]) {
    const nav = fakeNav({ persist: answer });
    const sp = createStorageProtection({ app: fakeApp(SAVED), nav });
    const seen = [];
    sp.onChange((s) => seen.push(s));
    await sp.start();
    assert.equal(sp.state(), expected);
    assert.equal(nav.calls.persist, 1, 'asked once');
    assert.deepEqual(seen, answer ? ['granted'] : []);
  }
  assert.equal(protectionText('granted'), 'Yes');
  assert.equal(protectionText('not-granted'), 'Not granted');
});

test('G13 — already protected: nothing is asked; unsupported or failing browsers are "Not granted", no errors', async () => {
  const kept = fakeNav({ persisted: true });
  const a = createStorageProtection({ app: fakeApp(SAVED), nav: kept });
  await a.start();
  assert.equal(a.state(), 'granted');
  assert.equal(kept.calls.persist, 0);
  for (const nav of [{}, { storage: {} }, undefined, null, fakeNav({ throws: true })]) {
    const sp = createStorageProtection({ app: fakeApp(SAVED), nav });
    await sp.start();
    assert.equal(sp.state(), 'not-granted');
  }
  assert.equal(await isStoragePersisted({}), false);
});

test('G13 — first run: nothing is asked until the first save, then once only', async () => {
  const app = fakeApp(FIRST_RUN);
  const nav = fakeNav({ persist: true });
  const sp = createStorageProtection({ app, nav });
  const started = sp.start();
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(nav.calls.persist, 0, 'not before anything is stored (§12 step 3)');
  assert.equal(sp.state(), 'not-granted');
  app.emit({ state: 'saving', lastSavedAt: null });
  assert.equal(nav.calls.persist, 0, 'a save in progress is not a save');
  app.emit({ state: 'saved', lastSavedAt: '2026-09-27T12:01:00Z' });
  await started;
  assert.equal(nav.calls.persist, 1);
  assert.equal(sp.state(), 'granted');
  assert.equal(app.listening(), false, 'stops watching once asked');
});

test('G13 — wired in main.js through the storage boundary; Settings shows the line; nothing stored in user data', () => {
  const main = read('app/main.js');
  assert.match(main, /import \{ createStorageProtection \} from '\.\.\/src\/browser\/storage-protection\.js';/);
  assert.match(main, /services\.storageProtection = createStorageProtection\(\{ app \}\)/);
  const src = read('src/browser/storage-protection.js');
  assert.match(src, /import \{ requestPersistentStorage \} from '\.\/browser-adapter\.js';/, 'the request goes through the storage boundary');
  assert.ok(!/localStorage|sessionStorage|indexedDB|app\.(create|update|set|save|import|apply)/.test(src.replace(/\/\*[\s\S]*?\*\//g, '')), 'records nothing anywhere');
  const { app } = setup();
  const settings = (protection) => renderSettings({ targets: app.getAllCurrentTargets(), status: SAVED, lastBackupAt: null, restore: null, foods: settingsFoodsModel(app), protection });
  assert.match(settings('granted'), /<dt>Protected from automatic clean-up<\/dt><dd><span data-storage-protection>Yes<\/span><\/dd>/);
  assert.match(settings('not-granted'), /<span data-storage-protection>Not granted<\/span>/);
  assert.match(settings(undefined), /<span data-storage-protection>Not granted<\/span>/, 'not asked yet');
  assert.ok(settings('granted').indexOf('Protected from automatic clean-up') < settings('granted').indexOf('Last backup'));
});

/* ======================= G14 — welcome card ======================= */

test('G14 — first run shows the welcome card once, above the day-type chooser, with the contract’s text', () => {
  const { app, writes } = setup();
  const model = todayModel(app);
  assert.equal(model.firstRun, true);
  const html = renderToday(model);
  assert.equal(WELCOME_TEXT, 'Log what you eat against three daily targets: protein, carbs and fat. Start with a meal from the Library or search for a food.');
  assert.match(html, new RegExp(`<section class="welcome-card" aria-label="Welcome" data-welcome>\\s*<p>${WELCOME_TEXT}</p>\\s*</section>`));
  assert.equal((html.match(/data-welcome/g) || []).length, 1);
  assert.ok(html.indexOf('data-welcome') < html.indexOf('data-action="choose-day-type"'), 'before the chooser');
  assert.equal(writes.length, 0, 'showing it creates nothing');
});

test('G14 — never again once anything is saved, on another day, or while a save is pending or failing', () => {
  const s = setup();
  s.current.status = SAVED;
  assert.equal(todayModel(s.app).firstRun, false, 'an existing user with stored data');
  assert.ok(!/data-welcome/.test(renderToday(todayModel(s.app))));
  const f = setup();
  assert.equal(todayModel(f.app, '2026-09-20').firstRun, false, 'only on today');
  f.app.createDay(TODAY, 'lift');
  assert.equal(todayModel(f.app).firstRun, false, 'gone after the first action');
  for (const status of [{ state: 'saving', lastSavedAt: null }, { state: 'error', lastSavedAt: null }]) {
    const e = setup({ status });
    assert.equal(todayModel(e.app).firstRun, false, status.state);
  }
});

/* ======================= G15 — keyboard shortcuts ======================= */

/** A tiny element: tag, attributes, children found by a selector function. */
function el(tag, attrs = {}, extra = {}) {
  const node = {
    tagName: tag.toUpperCase(),
    attrs,
    focused: 0,
    clicks: 0,
    disabled: false,
    value: '',
    getAttribute: (k) => (k in attrs ? attrs[k] : null),
    focus() { node.focused += 1; },
    click() { node.clicks += 1; },
    closest: () => null,
    ...extra
  };
  return node;
}
function key(k, target, more = {}) {
  return { key: k, target, defaultPrevented: false, isComposing: false, keyCode: 0, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, repeat: false, preventDefault() { this.defaultPrevented = true; }, ...more };
}
function docWith({ search = null, modal = false, pane = null } = {}) {
  return {
    querySelector(sel) {
      if (sel === 'dialog:modal') return modal ? {} : null;
      if (sel === '#main [data-query]') return search;
      if (sel === '#main dialog[open]') return pane;
      return null;
    }
  };
}
function formScope({ disabled = false, firstInvalid = null } = {}) {
  const primary = el('button', { class: 'button primary' });
  primary.disabled = disabled;
  primary.closest = () => null;
  const invalidField = el('input', { id: 'cf-category' });
  const scope = {
    querySelectorAll: (sel) => (sel === '.sheet-actions .button.primary' ? [primary] : []),
    querySelector: (sel) => {
      if (sel === '[data-first-invalid]') return firstInvalid ? { getAttribute: () => firstInvalid } : null;
      if (sel === `[id="${firstInvalid}"]`) return invalidField;
      return null;
    }
  };
  const input = el('input', { type: 'text' }, { closest: (sel) => (sel === '[data-enter-scope], dialog[open]' ? scope : null) });
  return { scope, primary, input, invalidField };
}

test('G15 — "/" focuses search on Log and Meals only; never while typing or under a modal', () => {
  assert.deepEqual([...SEARCH_SHORTCUT_ROUTES], ['log', 'meals']);
  const search = el('input', { type: 'search' });
  const body = el('body');
  for (const route of ['log', 'meals']) {
    const e = key('/', body);
    assert.equal(handleShortcut(e, { route, doc: docWith({ search }) }), 'search');
    assert.equal(e.defaultPrevented, true, 'the "/" is not typed into the field');
  }
  assert.equal(search.focused, 2);
  for (const route of ['today', 'progress', 'settings']) assert.equal(handleShortcut(key('/', body), { route, doc: docWith({ search }) }), null, route);
  const typing = key('/', el('input', { type: 'text' }));
  assert.equal(handleShortcut(typing, { route: 'log', doc: docWith({ search }) }), null);
  assert.equal(typing.defaultPrevented, false, 'typing "/" in a field types it');
  assert.equal(handleShortcut(key('/', el('textarea')), { route: 'log', doc: docWith({ search }) }), null);
  assert.equal(handleShortcut(key('/', body), { route: 'log', doc: docWith({ search, modal: true }) }), null, 'a modal sheet is open');
  assert.equal(handleShortcut(key('/', body, { ctrlKey: true }), { route: 'log', doc: docWith({ search }) }), null);
  assert.equal(handleShortcut(key('/', body, { isComposing: true }), { route: 'log', doc: docWith({ search }) }), null, 'input method composing');
  assert.equal(search.focused, 2);
});

test('G15 — Enter confirms the focused form once; while invalid it submits nothing and focuses the first invalid field', () => {
  const ok = formScope();
  const e = key('Enter', ok.input);
  assert.equal(handleShortcut(e, { route: 'log', doc: docWith() }), 'confirm');
  assert.equal(ok.primary.clicks, 1);
  assert.equal(e.defaultPrevented, true);
  const held = key('Enter', ok.input, { repeat: true });
  assert.equal(handleShortcut(held, { route: 'log', doc: docWith() }), null);
  assert.equal(ok.primary.clicks, 1, 'holding Enter never submits twice');
  assert.equal(held.defaultPrevented, true);
  const bad = formScope({ disabled: true, firstInvalid: 'cf-category' });
  assert.equal(handleShortcut(key('Enter', bad.input), { route: 'log', doc: docWith() }), 'invalid');
  assert.equal(bad.primary.clicks, 0, 'nothing submitted (A-45)');
  assert.equal(bad.invalidField.focused, 1);
  assert.equal(handleShortcut(key('Enter', ok.input, { shiftKey: true }), { route: 'log', doc: docWith() }), null);
  assert.equal(handleShortcut(key('Enter', ok.input, { isComposing: true }), { route: 'log', doc: docWith() }), null, 'confirming an input-method word is not a submit');
  assert.equal(ok.primary.clicks, 1);
});

test('G15 — Enter keeps its own meaning on buttons, links, lists, radios and outside forms', () => {
  assert.equal(confirmsOnEnter(el('input', { type: 'text' })), true);
  assert.equal(confirmsOnEnter(el('input', { type: 'date' })), true);
  assert.equal(confirmsOnEnter(el('input', {})), true);
  for (const node of [el('button'), el('a'), el('select'), el('textarea'), el('input', { type: 'radio' }), el('input', { type: 'checkbox' }), el('input', { type: 'file' })]) {
    assert.equal(confirmsOnEnter(node), false, node.tagName);
    const e = key('Enter', node);
    assert.equal(handleShortcut(e, { route: 'log', doc: docWith() }), null);
    assert.equal(e.defaultPrevented, false);
  }
  const loose = key('Enter', el('input', { type: 'search' })); // Log's list search: not in a sheet or form
  assert.equal(handleShortcut(loose, { route: 'log', doc: docWith() }), null);
  assert.equal(isEditable(el('select')), true);
  assert.equal(isEditable(el('div', {}, { isContentEditable: true })), true);
  assert.equal(isEditable(el('button')), false);
});

test('G15 — Escape: modal sheets close themselves; a wide-screen pane closes from outside it, after a search is cleared', () => {
  const dispatched = [];
  const win = { KeyboardEvent: class { constructor(type, init) { Object.assign(this, init, { type }); } } };
  const pane = { contains: (n) => n === inside, dispatchEvent: (ev) => { dispatched.push(ev); return true; } };
  const inside = el('button');
  assert.equal(handleShortcut(key('Escape', el('button')), { route: 'log', doc: docWith({ modal: true, pane }), win }), null, 'the browser’s cancel handles a modal');
  assert.equal(handleShortcut(key('Escape', inside), { route: 'log', doc: docWith({ pane }), win }), null, 'the view host handles Escape inside the pane');
  const search = el('input', { type: 'search' });
  search.value = 'banana';
  assert.equal(handleShortcut(key('Escape', search), { route: 'log', doc: docWith({ pane }), win }), null, 'clears the search first');
  const e = key('Escape', el('h1'));
  assert.equal(handleShortcut(e, { route: 'log', doc: docWith({ pane }), win }), 'escape');
  assert.equal(dispatched.length, 1);
  assert.equal(dispatched[0].key, 'Escape');
  assert.equal(e.defaultPrevented, true);
  assert.equal(handleShortcut(key('Escape', el('h1')), { route: 'log', doc: docWith(), win }), null, 'nothing open');
});

test('G15 — shortcuts live in one place, and the forms mark where an invalid submit puts focus', () => {
  const shell = read('app/shell.js');
  assert.match(shell, /doc\.addEventListener\?\.\('keydown', \(event\) => \{ if \(state\.startup === 'ready'\) handleShortcut\(event, \{ route: state\.route, doc, win \}\); \}\);/);
  for (const f of fs.readdirSync(path.join(ROOT, 'app')).filter((n) => n.endsWith('.js') && n !== 'shell.js')) {
    const src = read(`app/${f}`);
    assert.ok(!/'Enter'|"Enter"|key === '\/'/.test(src), `app/${f}: no screen-level Enter or "/" handling`);
  }
  const values = { name: 'Bar', category: '', state: '', brand: '', protein: '', carbs: '', fat: '', aliases: '' };
  const { app } = setup();
  const form = renderCustomFoodForm({ values, validation: app.validateCustomFood({ name: 'Bar', category: '', state: '', nutrition: { protein: null, carbs: null, fat: null } }), touched: new Set() });
  assert.match(form, /data-first-invalid="cf-category"/);
  const targets = renderTargetForm({ dayType: 'lift', values: { protein: '150', carbs: 'abc', fat: '70' }, original: { protein: 150, carbs: 293, fat: 70 }, validation: app.validateTargets({ protein: 150, carbs: Number.NaN, fat: 70 }), touched: new Set() });
  assert.match(targets, /data-first-invalid="tf-carbs"/);
  const edit = renderEditDialog({ instance: { mealSlot: 'lunch' }, date: TODAY, name: 'x', slot: 'lunch', rows: [{ foodId: 'a', foodName: 'A', text: '10' }], preview: null });
  assert.match(edit, /data-action="save-instance"/, 'the editor’s Save is its primary action');
});

/* ======================= architecture ======================= */

test('G11–G15 — no macro arithmetic, no forbidden terms, domain only through its entry point, no second store', () => {
  for (const f of ['app/shell.js', 'app/today.js', 'app/log.js', 'app/progress.js', 'app/session.js', 'app/settings.js', 'app/foods.js', 'app/main.js', 'app/app.css', 'src/browser/storage-protection.js']) {
    const src = read(f);
    assert.deepEqual(macroArithmeticInSource(src, f), [], f);
    assert.ok(!FORBIDDEN_NUTRITION.test(src), f);
    assert.deepEqual(domainImportsBypassingIndex(src), [], f);
  }
  for (const f of ['app/shell.js', 'app/today.js', 'app/log.js', 'app/progress.js', 'app/session.js', 'app/settings.js']) {
    assert.ok(!/localStorage|sessionStorage|indexedDB/.test(read(f)), `${f}: no second persistence store`);
  }
});
