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

/* ---------------- source scanning: code only, never labels ---------------- */

/** Script-like files: the whole file is code. */
const SCRIPT_EXT = /\.(m?js|cjs|jsx|ts|tsx|mts|cts)$/;
/** Markup files: only <script> blocks and {expression} / {{ expression }} bindings are code. */
const MARKUP_EXT = /\.(html?|vue|svelte)$/;
/** Stylesheets: only calc() expressions can compute anything. */
const STYLE_EXT = /\.css$/;
/** Files that can contain executable logic (scanned for arithmetic and legacy identifiers). */
export const isCode = (f) => SCRIPT_EXT.test(f) || MARKUP_EXT.test(f) || STYLE_EXT.test(f);
/** Binary assets are the only runtime files not scanned for forbidden terms. */
export const isBinary = (f) => /\.(png|jpe?g|gif|webp|avif|ico|bmp|woff2?|ttf|otf|eot|pdf|mp3|mp4|webm|wasm|zip|gz)$/i.test(f);

/**
 * JavaScript/TypeScript source with comments removed and the TEXT of every string removed
 * ('…', "…", and the literal parts of `…`), keeping ${…} expressions. Regex literals are
 * blanked. So copy, labels, class names, aria text and import paths can never look like
 * arithmetic, while real expressions — including those inside template literals — remain.
 */
export function codeOnly(src) {
  let out = '';
  let i = 0;
  const n = src.length;
  let lastSignificant = '';
  const regexCanStart = () => lastSignificant === '' || /[(,=:[!&|?{};+\-*%<>~^]$/.test(lastSignificant) || /\b(return|typeof|case|in|of|delete|void|throw|new)$/.test(out.trimEnd());
  function readTemplate() { // i is just past the opening backtick
    out += '`';
    while (i < n) {
      const c = src[i];
      if (c === '\\') { i += 2; continue; }
      if (c === '`') { i++; out += '`'; return; }
      if (c === '$' && src[i + 1] === '{') {
        out += '${';
        i += 2;
        let depth = 1;
        const start = i;
        // find the matching brace, skipping nested strings/templates
        while (i < n && depth > 0) {
          const d = src[i];
          if (d === '{') depth++;
          else if (d === '}') { depth--; if (depth === 0) break; }
          else if (d === '"' || d === "'" || d === '`') { const q = d; i++; while (i < n && src[i] !== q) { if (src[i] === '\\') i++; i++; } }
          i++;
        }
        out += codeOnly(src.slice(start, i));
        out += '}';
        i++;
        continue;
      }
      if (c === '\n') out += '\n';
      i++;
    }
  }
  while (i < n) {
    const c = src[i];
    const next = src[i + 1];
    if (c === '/' && next === '/') { while (i < n && src[i] !== '\n') i++; continue; }
    if (c === '/' && next === '*') { const end = src.indexOf('*/', i + 2); const chunk = src.slice(i, end < 0 ? n : end + 2); out += chunk.replace(/[^\n]/g, ''); i = end < 0 ? n : end + 2; continue; }
    if (c === '"' || c === "'") {
      i++;
      while (i < n && src[i] !== c && src[i] !== '\n') { if (src[i] === '\\') i++; i++; }
      i++;
      out += c + c;
      lastSignificant = c;
      continue;
    }
    if (c === '`') { i++; readTemplate(); lastSignificant = '`'; continue; }
    if (c === '/' && regexCanStart()) {
      let j2 = i + 1;
      let inClass = false;
      while (j2 < n && src[j2] !== '\n') {
        if (src[j2] === '\\') { j2 += 2; continue; }
        if (src[j2] === '[') inClass = true;
        else if (src[j2] === ']') inClass = false;
        else if (src[j2] === '/' && !inClass) break;
        j2++;
      }
      if (j2 < n && src[j2] === '/') {
        j2++;
        while (j2 < n && /[a-z]/i.test(src[j2])) j2++;
        out += '/regex/';
        i = j2;
        lastSignificant = '/';
        continue;
      }
    }
    out += c;
    if (!/\s/.test(c)) lastSignificant = c;
    i++;
  }
  return out;
}

/** JSX/TSX: drop text between tags (<th>Protein / Carbs</th>) — it is copy, not code. */
const stripJsxText = (code) => code.replace(/(<\/?[A-Za-z][^<>{}]*>)([^<>{}]*)(?=<)/g, '$1');

/** The executable parts of a markup file: <script> bodies plus {…} / {{…}} bindings. */
function markupCode(src) {
  const parts = [];
  const withoutComments = src.replace(/<!--[\s\S]*?-->/g, '');
  for (const m of withoutComments.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)) parts.push(codeOnly(m[1]));
  const markup = withoutComments.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '').replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '');
  for (const m of markup.matchAll(/\{\{([\s\S]*?)\}\}|\{([^{}]*)\}/g)) parts.push(codeOnly(m[1] !== undefined ? m[1] : m[2]));
  return parts.join('\n');
}

/** The code of a source file, by extension (see codeOnly / markupCode). */
export function executableCode(src, file) {
  if (MARKUP_EXT.test(file)) return markupCode(src);
  const code = codeOnly(src);
  return /\.(jsx|tsx)$/.test(file) ? stripJsxText(code) : code;
}

const MACRO_WORD = '(protein|carbs|fat)';
/** Signatures of P/C/F arithmetic. [regex, why] */
export const MACRO_ARITHMETIC_PATTERNS = [
  [/\/\s*100\b/, 'per-100 g division'],
  [/\/\s*1e2\b/i, 'per-100 g division (1e2)'],
  [/\*\s*0?\.01\b/, 'per-100 g scaling (× 0.01)'],
  [new RegExp(`\\b${MACRO_WORD}\\b\\s*[-+*/]=?(?![/*])`), 'arithmetic after a macro field'],
  [new RegExp(`(?<![/*])[-+*/]=?\\s*[\\w$.]*\\b${MACRO_WORD}\\b`), 'arithmetic before a macro field'],
  [/\[\s*m\s*\]\s*[-+*/]=?/, 'arithmetic on [m]'],
  [/[-+*/]=?\s*[\w$.]+\[\s*m\s*\]/, 'arithmetic on [m]'],
  [/\bnutrition\b\s*(?:\.\s*[\w$]+|\[[^\]]*\])\s*[-+*/](?![/*])/, 'arithmetic on Food nutrition'],
  [/(?<![/*])[-+*/]\s*[\w$.]*\bnutrition\b\s*(?:\.\s*[\w$]+|\[[^\]]*\])/, 'arithmetic on Food nutrition']
];

/**
 * Stylesheets: selectors, class names and property names may say protein/carbs/fat freely;
 * what is forbidden is a calc() that does arithmetic with a macro-named value
 * (e.g. calc(var(--carbs) / var(--carbs-target) * 100%)). Bars use the domain's
 * targetStatus().progress instead, passed in as a neutral value (e.g. --fill).
 */
function cssArithmetic(src) {
  const code = src.replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, '')).replace(/"(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'/g, '""');
  const hits = [];
  const re = /calc\(/g;
  let m;
  while ((m = re.exec(code))) {
    let depth = 1;
    let i = m.index + 5;
    while (i < code.length && depth > 0) { if (code[i] === '(') depth++; else if (code[i] === ')') depth--; i++; }
    const expr = code.slice(m.index, i);
    const line = code.slice(0, m.index).split('\n').length;
    if (/--[\w-]*\b(protein|carbs|fat)\b/i.test(expr) || /\/\s*100\b/.test(expr)) hits.push(`${line} arithmetic on a macro value in CSS: ${expr}`);
  }
  return hits;
}

/** P/C/F arithmetic in one source text. Returns ["line why: code", …]. */
export function macroArithmeticInSource(src, file) {
  if (STYLE_EXT.test(file)) return cssArithmetic(src);
  const hits = [];
  executableCode(src, file).split('\n').forEach((line, i) => {
    for (const [re, why] of MACRO_ARITHMETIC_PATTERNS) if (re.test(line)) hits.push(`${i + 1} ${why}: ${line.trim()}`);
  });
  return hits;
}

/**
 * P/C/F arithmetic outside the canonical calculator. Returns ["file:line why: code", …].
 * Applies to every code file (script and markup); src/domain/macros.js is the one allowed
 * place. Strings, copy and markup text are ignored; expressions are not.
 */
export function macroArithmeticOffenders(files) {
  const offenders = [];
  for (const f of files) {
    if (f === 'src/domain/macros.js' || !isCode(f)) continue;
    for (const hit of macroArithmeticInSource(fs.readFileSync(path.join(ROOT, f), 'utf8'), f)) offenders.push(`${f}:${hit}`);
  }
  return offenders;
}

/**
 * Imports of the domain from outside src/domain/ that bypass its public entry point.
 * Everything outside the domain (UI, adapters) reaches it only through src/domain/index.js,
 * which exports the calculator as `macros` — so screens call it rather than rebuild it.
 */
export function domainImportOffenders(files) {
  const offenders = [];
  for (const f of files) {
    if (f.startsWith('src/domain/') || !isCode(f)) continue;
    for (const spec of domainImportsBypassingIndex(fs.readFileSync(path.join(ROOT, f), 'utf8'))) offenders.push(`${f}: imports ${spec}`);
  }
  return offenders;
}

/** Import specifiers in one source text that reach into src/domain/ other than index.js. */
export function domainImportsBypassingIndex(src) {
  const out = [];
  for (const m of src.matchAll(/(?:\bfrom\s*|\bimport\s*\(?\s*)['"]([^'"]+)['"]/g)) {
    const spec = m[1];
    if (/(^|\/)domain\//.test(spec) && !/(^|\/)domain\/index\.js$/.test(spec)) out.push(spec);
  }
  return out;
}

/**
 * Forbidden nutrition terms, assembled so this file does not contain them literally. The
 * energy concept in any unit or wording; matched anywhere in a file, comments included.
 */
export const FORBIDDEN_NUTRITION = new RegExp(['calor', 'kcal', 'energ' + 'y', '\\bk' + 'j\\b', 'jou' + 'le'].join('|'), 'i');

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
