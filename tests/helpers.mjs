// Test helpers: a throwaway copy of the canonical data, a deterministic clock and IDs.
// Tests never touch the repository's real data/ or user-data/ files.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDataLayer } from '../src/domain/index.js';
import { createFileAdapter } from '../src/node/file-adapter.js';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Copy data/ and user-data/ into a temp dir; returns its path. */
export function tempRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mt-domain-'));
  fs.cpSync(path.join(ROOT, 'data'), path.join(dir, 'data'), { recursive: true });
  fs.cpSync(path.join(ROOT, 'user-data'), path.join(dir, 'user-data'), { recursive: true });
  return dir;
}

/** A data layer over a temp copy, with a clock that advances one minute per call. */
export function makeApp(dir = tempRepo()) {
  let t = Date.parse('2026-09-24T12:00:00Z');
  let n = 0;
  const app = createDataLayer({
    adapter: createFileAdapter(dir),
    clock: () => new Date((t += 60000)),
    newId: () => `t${String(++n).padStart(4, '0')}`
  });
  return { app, dir, reopen: () => makeApp(dir).app };
}

export const readJSON = (dir, p) => JSON.parse(fs.readFileSync(path.join(dir, p), 'utf8'));
export const readText = (dir, p) => fs.readFileSync(path.join(dir, p), 'utf8');
export const cleanup = (dir) => fs.rmSync(dir, { recursive: true, force: true });

/** Independent P/C/F sum used only to cross-check the calculator in tests. */
export function expectedTotals(meal, foodsById) {
  const t = { protein: 0, carbs: 0, fat: 0 };
  for (const i of meal.ingredients) for (const m of ['protein', 'carbs', 'fat']) t[m] += (i.quantity / 100) * foodsById[i.foodId].nutrition[m];
  return t;
}

export const close = (a, b, eps = 1e-9) => Math.abs(a - b) <= eps;
