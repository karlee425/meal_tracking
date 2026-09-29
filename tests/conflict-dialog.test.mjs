/*
 * conflict-dialog.test.mjs — the "Changed elsewhere" dialog can't be dismissed (V2_UI_CONTRACT.md
 * §4.8, §13.2 "Another tab saved more recently": editing blocked until reload).
 *
 * The old failure: the dialog relied on preventing `cancel`, which Chromium stops allowing after
 * a couple of Escapes, so the third Escape closed it and unblocked the tab. The shell now stops
 * Escape before the browser's close watcher sees it and shows the dialog again if it is closed
 * while the conflict stands. These tests drive the shell with fakes; the real-browser sequence
 * (probe/conflict.mjs: fails on 40266db, passes here) is described in the audit report.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createShell } from '../app/shell.js';

function harness() {
  const rootListeners = [];
  const docListeners = [];
  const dialog = {
    open: false, innerHTML: '', shows: 0, closes: 0,
    matches: (sel) => sel === '[data-conflict]',
    showModal() { this.open = true; this.shows += 1; },
    close() { if (!this.open) return; this.open = false; this.closes += 1; for (const l of rootListeners) if (l.type === 'close') l.fn({ target: dialog }); }
  };
  const root = {
    innerHTML: '',
    querySelector: (sel) => (sel === '[data-conflict]' ? dialog : null),
    addEventListener(type, fn, capture) { rootListeners.push({ type, fn, capture }); }
  };
  const doc = { title: '', visibilityState: 'visible', addEventListener(type, fn, capture) { docListeners.push({ type, fn, capture }); } };
  const win = { location: { hash: '#/today', href: 'http://app/#/today' }, history: { replaceState() {}, pushState() {} }, addEventListener() {}, setTimeout: () => 0, clearTimeout() {} };
  const shell = createShell({ root, win, doc });
  shell.start();
  let listener = null;
  shell.setDataLayer({ getPersistenceStatus: () => ({ state: 'saved', lastSavedAt: 'x' }), onPersistenceChange: (fn) => { listener = fn; return () => {}; }, flushPersistence: () => Promise.resolve() });
  const keydown = (key) => {
    const e = { key, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; }, target: dialog };
    for (const l of docListeners) if (l.type === 'keydown' && l.capture) l.fn(e);
    return e;
  };
  return { dialog, emit: (s) => listener(s), keydown };
}

test('Conflict dialog — opens on conflict; Escape never reaches the browser while it is open', () => {
  const { dialog, emit, keydown } = harness();
  assert.equal(dialog.open, false);
  assert.equal(keydown('Escape').defaultPrevented, false, 'no dialog: Escape is left alone');
  emit({ state: 'conflict', lastSavedAt: 'x' });
  assert.equal(dialog.open, true);
  for (let i = 1; i <= 6; i++) assert.equal(keydown('Escape').defaultPrevented, true, `Escape ${i}`);
  assert.equal(keydown('Enter').defaultPrevented, false, 'other keys untouched');
  assert.equal(dialog.open, true);
});

test('Conflict dialog — closed anyway while the conflict stands, it is shown again; once resolved it closes for good', () => {
  const { dialog, emit } = harness();
  emit({ state: 'conflict', lastSavedAt: 'x' });
  dialog.close(); // e.g. a close request the browser wouldn't let be prevented
  assert.equal(dialog.open, true, 'shown again straight away');
  assert.equal(dialog.shows, 2);
  assert.match(dialog.innerHTML, /data-shell-action="reload"/, 'with its Reload and Download actions');
  emit({ state: 'saved', lastSavedAt: 'y' });
  assert.equal(dialog.open, false, 'no conflict: it closes and stays closed');
  assert.equal(dialog.shows, 2);
});
