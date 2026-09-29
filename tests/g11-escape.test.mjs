/*
 * g11-escape.test.mjs — G11 (V2_UI_CONTRACT.md §3.2, I-01): "Discard changes?" on every Escape.
 *
 * Root cause of the old failure: a modal <dialog>'s Escape went through the browser's close
 * watcher, and in Chromium the `cancel` event stops being cancelable after it has been prevented
 * twice in a row — so dirty → Escape → Keep editing → edit → Escape closed the form without
 * asking. The shared view host now handles Escape on keydown (preventing its default, so the
 * close watcher never runs) and asks the screen's beforeLeave every time; a close request the
 * browser won't let be prevented re-shows the dialog as beforeLeave left it.
 *
 * These tests drive the view host with a fake dialog. They can't make a real browser's close
 * watcher misbehave; the exact failing sequence in Chromium is reproduced by the browser probe
 * (probe/esc.mjs: fails on fd98d99, passes here), described in the slice report.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from './helpers.mjs';
import { createViewHost, WIDE_QUERY, COMPACT_QUERY } from '../app/view-host.js';

function harness({ width = 375, dirty = () => true } = {}) {
  const events = { closes: 0, shows: 0, onClose: 0, asked: 0 };
  const focusable = { id: 'keep', focused: 0, focus() { this.focused += 1; } };
  const dialog = {
    open: false, modal: false, dataset: {}, innerHTML: '', listeners: {},
    showModal() { this.open = true; this.modal = true; events.shows += 1; },
    show() { this.open = true; this.modal = false; events.shows += 1; },
    close() { if (!this.open) return; this.open = false; events.closes += 1; this.fire('close', {}); },
    addEventListener(t, f) { (this.listeners[t] = this.listeners[t] || []).push(f); },
    fire(t, e) { for (const f of this.listeners[t] || []) f(e); return e; },
    querySelector: (sel) => (sel === '[data-autofocus]' ? focusable : null),
    contains: () => true
  };
  const win = { matchMedia: (q) => ({ matches: q === WIDE_QUERY ? width / 16 >= 64 : q === COMPACT_QUERY ? width / 16 <= 37.49 : false }), addEventListener() {}, removeEventListener() {}, location: { href: '#/today' }, history: { pushState() {}, back() {} } };
  const page = { classList: { add() {}, remove() {} } };
  const host = createViewHost({
    page, dialog, win, doc: { activeElement: null }, viewTypes: ['edit'], fallbackFocus: () => null,
    onClose() { events.onClose += 1; },
    beforeLeave() { events.asked += 1; return !dirty(); }
  });
  host.open('edit', () => {});
  return { host, dialog, events, focusable };
}
const key = (k, target = { matches: () => false }, more = {}) => ({ key: k, target, defaultPrevented: false, isComposing: false, preventDefault() { this.defaultPrevented = true; }, ...more });
const cancel = (cancelable) => ({ cancelable, defaultPrevented: false, preventDefault() { if (this.cancelable) this.defaultPrevented = true; } });

test('G11 Escape — a dirty modal form asks on every Escape, however many times (the old failing sequence)', () => {
  for (const width of [375, 800]) {
    const { dialog, events } = harness({ width });
    assert.equal(dialog.modal, true, `modal at ${width}px`);
    // dirty → Escape → (Keep editing) → edit → Escape → … : the screen's beforeLeave answers each time
    for (let i = 1; i <= 6; i++) {
      const e = dialog.fire('keydown', key('Escape'));
      assert.equal(e.defaultPrevented, true, `Escape ${i}: kept from the browser's close watcher`);
      assert.equal(events.asked, i, `Escape ${i}: "Discard changes?" is asked`);
      assert.equal(dialog.open, true, `Escape ${i}: the form stays open`);
    }
    assert.equal(events.closes, 0);
    assert.equal(events.onClose, 0, 'nothing was torn down');
  }
});

test('G11 Escape — a clean form (or Discard) closes on Escape as before', () => {
  let dirty = true;
  const { dialog, events } = harness({ dirty: () => dirty });
  dialog.fire('keydown', key('Escape'));
  assert.equal(dialog.open, true);
  dirty = false; // Discard, or nothing was changed
  dialog.fire('keydown', key('Escape'));
  assert.equal(dialog.open, false, 'closes');
  assert.equal(events.onClose, 1);
  const clean = harness({ dirty: () => false });
  clean.dialog.fire('keydown', key('Escape'));
  assert.equal(clean.dialog.open, false, 'a clean form closes on the first Escape, no question');
});

test('G11 Escape — the wide-screen pane is handled the same way', () => {
  const { dialog, events } = harness({ width: 1280 });
  assert.equal(dialog.modal, false, 'non-modal pane');
  for (let i = 1; i <= 3; i++) dialog.fire('keydown', key('Escape'));
  assert.equal(events.asked, 3);
  assert.equal(dialog.open, true);
});

test('G11 Escape — left alone: other keys, input-method composing, and a search field with text (Escape clears it first)', () => {
  const { dialog, events } = harness();
  const search = { matches: (sel) => sel === 'input[type="search"]', value: 'banana' };
  for (const e of [key('Enter'), key('Escape', undefined, { isComposing: true }), key('Escape', search), key('Escape', undefined, { defaultPrevented: true })]) {
    dialog.fire('keydown', e);
  }
  assert.equal(events.asked, 0);
  assert.equal(dialog.open, true);
  const empty = { matches: (sel) => sel === 'input[type="search"]', value: '' };
  dialog.fire('keydown', key('Escape', empty));
  assert.equal(events.asked, 1, 'an empty search field: Escape steps back as usual');
});

test('G11 Escape — a close request the browser won\'t let be prevented re-shows the dialog as the screen left it', () => {
  const { dialog, events, focusable } = harness();
  const ok = dialog.fire('cancel', cancel(true));
  assert.equal(ok.defaultPrevented, true, 'cancelable: prevented, as before');
  assert.equal(dialog.open, true);
  // Not cancelable (e.g. Chromium after repeated close requests): the browser closes it anyway…
  dialog.fire('cancel', cancel(false));
  dialog.close();
  assert.equal(dialog.open, true, '…and it is shown again straight away');
  assert.equal(dialog.modal, true);
  assert.equal(events.onClose, 0, 'no teardown: the "Discard changes?" beforeLeave drew is still there');
  assert.ok(focusable.focused >= 1, 'focus goes to its focused control (Keep editing)');
  // …and a normal close afterwards still closes.
  dialog.close();
  assert.equal(dialog.open, false);
  assert.equal(events.onClose, 1);
  // A clean form's cancel is not interfered with.
  const clean = harness({ dirty: () => false });
  const c = clean.dialog.fire('cancel', cancel(false));
  clean.dialog.close();
  assert.equal(c.defaultPrevented, false);
  assert.equal(clean.dialog.open, false);
});

test('G11 Escape — one guard: the view host asks each screen\'s own beforeLeave; no screen handles Escape itself', () => {
  const host = fs.readFileSync(path.join(ROOT, 'app/view-host.js'), 'utf8');
  assert.match(host, /dialog\.addEventListener\('keydown', \(event\) => \{\n\s*if \(event\.key !== 'Escape' \|\| !dialog\.open \|\| event\.defaultPrevented \|\| event\.isComposing\) return;/);
  assert.ok(!/\|\| modal\) return;/.test(host), 'modal dialogs are no longer left to the browser');
  for (const f of ['today.js', 'log.js', 'meals.js', 'settings.js']) {
    const src = fs.readFileSync(path.join(ROOT, 'app', f), 'utf8');
    assert.match(src, /createViewHost\(\{[\s\S]*?beforeLeave/, `${f}: its discard rules go through the shared host`);
    assert.ok(!/'Escape'/.test(src), `${f}: no screen-level Escape handling`);
  }
});
