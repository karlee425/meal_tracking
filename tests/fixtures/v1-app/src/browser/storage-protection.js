/*
 * storage-protection.js — asking the browser to keep this app's stored data (V2_UI_CONTRACT.md
 * §10.1, §12 step 3, I-51).
 *
 * The app's data lives in the browser's storage (IndexedDB via browser-adapter.js); nothing
 * here stores anything. This only asks the browser to protect that storage from automatic
 * clean-up (`navigator.storage.persist()`, through requestPersistentStorage) and reports the
 * browser's answer:
 *   - checked without asking on start (`navigator.storage.persisted()`, no prompt)
 *   - asked once, after the first save: at once when this device already has saved data, or
 *     when the first save completes; at most once per app session (the browser remembers its
 *     own decision, so nothing is recorded in the user's data)
 *   - 'granted' only when the browser says so; unsupported, refused or failed is 'not-granted'
 * The app works the same either way; this never blocks or delays anything.
 */

import { requestPersistentStorage } from './browser-adapter.js';

/** Whether the browser already protects this site's storage. Never prompts; false when unknown. */
export async function isStoragePersisted(nav = globalThis.navigator) {
  try {
    if (nav && nav.storage && typeof nav.storage.persisted === 'function') return (await nav.storage.persisted()) === true;
  } catch { /* not available */ }
  return false;
}

/**
 * createStorageProtection({ app, nav }) → { state(), onChange(listener) → unsubscribe, start(), whenSettled() }
 *   state(): 'granted' | 'not-granted'
 *   start(): check, then ask once after the first save (see above). Safe to call once per app.
 */
export function createStorageProtection({ app, nav = globalThis.navigator }) {
  let current = 'not-granted';
  let asked = false;
  let stopWatching = null;
  let pending = Promise.resolve();
  const listeners = new Set();
  const set = (next) => {
    if (next === current) return;
    current = next;
    for (const fn of listeners) fn(current);
  };
  const saved = (status) => !!(status && status.state === 'saved' && status.lastSavedAt);

  async function askOnce() {
    if (asked) return;
    asked = true;
    if (stopWatching) { stopWatching(); stopWatching = null; }
    if (await isStoragePersisted(nav)) { set('granted'); return; }
    set((await requestPersistentStorage(nav)) === true ? 'granted' : 'not-granted');
  }

  return {
    state: () => current,
    onChange(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    /** Resolves once the start-up check and any request made so far have finished (tests, probes). */
    whenSettled: () => pending,
    start() {
      pending = (async () => {
        if (await isStoragePersisted(nav)) set('granted');
        if (saved(app.getPersistenceStatus())) { await askOnce(); return; }
        // First run: nothing is stored yet, so nothing is asked until the first save (§12 step 3).
        await new Promise((resolve) => {
          const off = app.onPersistenceChange((status) => {
            if (!saved(status)) return;
            resolve(askOnce());
          });
          stopWatching = typeof off === 'function' ? off : null;
        });
      })();
      pending.catch(() => {});
      return pending;
    }
  };
}
