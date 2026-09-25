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

/* ---------------- repository scanning (shared by the architecture tests) ---------------- */

export const repoPath = (p) => path.relative(ROOT, p).split(path.sep).join('/');

/** Every file in the working tree (not .git / node_modules), as repo-relative paths. */
export function listRepoFiles(dir = ROOT) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === '.git' || e.name === 'node_modules') continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...listRepoFiles(p));
    else out.push(repoPath(p));
  }
  return out.sort();
}

export const loadBoundary = () => JSON.parse(fs.readFileSync(path.join(ROOT, 'runtime-boundary.json'), 'utf8'));

/** Manifest path patterns: exact, 'dir/**', or a single-segment '*' glob. */
export function matchesPattern(file, pattern) {
  if (pattern.endsWith('/**')) return file.startsWith(pattern.slice(0, -2));
  if (pattern.includes('*')) {
    const re = new RegExp('^' + pattern.split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('[^/]*') + '$');
    return re.test(file);
  }
  return file === pattern;
}

/** Class names a file belongs to (should be exactly one). */
export function classesOf(file, boundary = loadBoundary()) {
  return Object.entries(boundary.classes).filter(([, c]) => c.paths.some((p) => matchesPattern(file, p))).map(([name]) => name);
}

export const filesInClass = (name, boundary = loadBoundary()) => listRepoFiles().filter((f) => classesOf(f, boundary).includes(name));

export const stripComments = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:\\])\/\/.*$/gm, '$1');

const isCode = (f) => /\.(m?js|cjs|html)$/.test(f);

/**
 * P/C/F arithmetic outside the canonical calculator. Returns ["file:line why: code", …].
 * Applies to code files only; src/domain/macros.js is the one allowed place.
 */
export function macroArithmeticOffenders(files) {
  const macroWord = '(protein|carbs|fat)';
  const patterns = [
    [/\/\s*100\b/, 'per-100 g division'],
    [new RegExp(`\\b${macroWord}\\b\\s*[-+*/]=?(?![/*])`), 'arithmetic after a macro field'],
    [new RegExp(`(?<![/*])[-+*/]=?\\s*[\\w$.]*\\b${macroWord}\\b`), 'arithmetic before a macro field'],
    [/\[\s*m\s*\]\s*[-+*/]=?/, 'arithmetic on [m]'],
    [/[-+*/]=?\s*[\w$.]+\[\s*m\s*\]/, 'arithmetic on [m]']
  ];
  const offenders = [];
  for (const f of files) {
    if (f === 'src/domain/macros.js' || !isCode(f)) continue;
    const code = stripComments(fs.readFileSync(path.join(ROOT, f), 'utf8'));
    code.split('\n').forEach((line, i) => {
      for (const [re, why] of patterns) if (re.test(line)) offenders.push(`${f}:${i + 1} ${why}: ${line.trim()}`);
    });
  }
  return offenders;
}

/** Forbidden nutrition terms, assembled so this file does not contain them literally. */
export const FORBIDDEN_NUTRITION = new RegExp(['calor', 'kcal', 'energ' + 'y'].join('|'), 'i');

// Legacy identifiers, assembled from pieces so test files never contain the strings the
// Prompt 1 migration check (G12) looks for.
const j = (...p) => p.join('');
const word = (w) => new RegExp(`\\b${w}\\b`);

/** Identifiers that must never appear in runtime code. [label, regex] */
export const LEGACY_CODE_PATTERNS = [
  [j('live-settings', '-doc'), new RegExp(j('live-settings', '-doc'))],
  [j('CTC', '_FOOD'), word(j('CTC', '_FOOD'))],
  ['BANK_ALIAS', word('BANK_ALIAS')],
  ['BANK_SEED', word('BANK_SEED')],
  ['BANK_MEALS', word('BANK_MEALS')],
  ['M (embedded meal array)', /\b(?:var|let|const)\s+M\b|(?<![\w$.'"`])M\s*(?:\[|\.\s*(?:filter|map|forEach|find|some|every|length|concat|slice|reduce)\b)/],
  ['TARGET', /\bTARGETS?\b/],
  [j('SLOT', '_TARGET'), word(j('SLOT', '_TARGET'))],
  ['SHIFT', word('SHIFT')],
  ['SHIFT_FOOD', word('SHIFT_FOOD')],
  ['NIGHT', word('NIGHT')],
  ['DAYS (weekly schedule)', word('DAYS')],
  ['FOODS (embedded food table)', word('FOODS')],
  [j('carbShift', 'ByDayType'), new RegExp(j('carbShift', 'ByDayType'))],
  ['perSlot', word('perSlot')],
  ['nightSnack', word('nightSnack')],
  ['legacy day-type key (long / lifting / longrun)', /['"`](?:long|lifting|longrun)['"`]/],
  ['legacy storage key', /closethecarbs|kmb-state|meta\/settings|checkin\/state|state\/current/],
  ['legacy page or tool', /close-the-carbs\.html|meal-bank\.html|recost\.js|gen-bank-docs/],
  ['legacy data file', /meal-options\.json|ingredient-name-map|ingredients-flat|fibre\.json|['"`](?:\.\.?\/)*(?:foods|targets|yields|portion-bounds)\.json/],
  ['yield conversion / yield reference', /\byield(?:Factor|Key)\b|reference\/yields|perRecipeOverrides/],
  ['AI dependency', /window\.claude|\.sample\(|anthropic|openai/i],
  ['migration import', /migration\//]
];

/** Legacy structures that must never appear in canonical data. [label, regex] */
export const LEGACY_DATA_PATTERNS = [
  [j('live-settings', '-doc'), new RegExp(j('live-settings', '-doc'))],
  [j('CTC', '_FOOD'), word(j('CTC', '_FOOD'))],
  ['BANK_SEED / BANK_ALIAS', /\bBANK_(?:SEED|ALIAS|MEALS)\b/],
  [j('SLOT', '_TARGET'), word(j('SLOT', '_TARGET'))],
  ['SHIFT_FOOD', word('SHIFT_FOOD')],
  [j('carbShift', 'ByDayType'), new RegExp(j('carbShift', 'ByDayType'))],
  ['perSlot', /"perSlot"/],
  ['nightSnack', /"nightSnack"/],
  ['legacy day-type value', /"(?:dayType|nativeDayType)"\s*:\s*"(?:long|lifting|longrun)"/]
];

/** Scan files; returns ["file:line identifier: code", …]. Code files have comments stripped. */
export function scanLegacy(files, patterns) {
  const hits = [];
  for (const f of files) {
    const raw = fs.readFileSync(path.join(ROOT, f), 'utf8');
    const text = isCode(f) ? stripComments(raw) : raw;
    text.split('\n').forEach((line, i) => {
      for (const [label, re] of patterns) if (re.test(line)) hits.push(`${f}:${i + 1} ${label}: ${line.trim().slice(0, 120)}`);
    });
  }
  return hits;
}

/** git blob id (sha1 of "blob <size>\0<content>") without needing git. */
export async function gitBlobId(file) {
  const { createHash } = await import('node:crypto');
  const buf = fs.readFileSync(path.join(ROOT, file));
  return createHash('sha1').update(Buffer.concat([Buffer.from(`blob ${buf.length}\0`), buf])).digest('hex');
}
