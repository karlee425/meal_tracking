'use strict';
/*
 * validate.js — Prompt 1 validation gates for the V2 data migration.
 *
 *   node migration/validate.js        validate the files on disk; exit 1 if any gate fails
 *
 * migrate.js also calls validateBundle() on its in-memory output before writing
 * anything, so a failing migration never reaches disk.
 *
 * Every gate is blocking. Non-blocking warnings and manual-review items are
 * produced by migrate.js and recorded in migration/migration-report.json.
 *
 * JSON Schema checking uses the small subset validator below (no dependencies).
 * It supports exactly the keywords the six V2 schemas use and throws on any
 * keyword it does not know, so a schema change can never be silently ignored.
 */

const fs = require('fs');
const path = require('path');
const { calculateMealMacros } = require('./macro-calc');

const ROOT = path.resolve(__dirname, '..');
const rel = (p) => path.join(ROOT, p);
const readJSON = (p) => JSON.parse(fs.readFileSync(rel(p), 'utf8'));

// Files that existed before V2. They stay in place as migration inputs (decision 10)
// and are excluded from the "V2 runtime" scans. Prompt 3 removes their runtime role.
const LEGACY_FILES = [
  'README.md', 'close-the-carbs.html', 'fibre.json', 'foods.json', 'gen-bank-docs.js',
  'ingredient-name-map.json', 'ingredients-flat.json', 'live-settings-doc.json',
  'meal-bank.html', 'meal-options.json', 'portion-bounds.json', 'recost.js',
  'targets.json', 'yields.json'
];

const CANONICAL_JSON = [
  'data/foods/core-foods.json',
  'data/meals/library-meals.json',
  'data/targets.json',
  'data/reference/yields.json',
  'data/reference/portion-bounds.json',
  'user-data/custom-foods.json',
  'user-data/saved-meals.json',
  'user-data/daily-logs.json',
  'user-data/preferences.json',
  'migration/migration-report.json',
  'migration/food-id-map.json',
  'migration/meal-id-map.json'
];

/* ------------------------------------------------------------------ */
/* Minimal JSON Schema (draft 2020-12 subset) validator                */
/* ------------------------------------------------------------------ */

const KNOWN_KEYWORDS = new Set([
  '$schema', '$id', 'title', '$defs', 'type', 'enum', 'const', 'required', 'properties',
  'additionalProperties', 'items', 'minItems', 'minLength', 'minimum', 'exclusiveMinimum',
  '$ref', 'format'
]);

function typeOf(v) {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  if (typeof v === 'number') return Number.isInteger(v) ? 'integer' : 'number';
  return typeof v;
}
function typeMatches(v, t) {
  const actual = typeOf(v);
  if (t === 'number') return actual === 'number' || actual === 'integer';
  return actual === t;
}

function makeSchemaValidator(schemasByFile) {
  function resolveRef(ref, rootSchema) {
    if (ref.startsWith('#/')) {
      return { schema: ref.slice(2).split('/').reduce((o, k) => o[k], rootSchema), root: rootSchema };
    }
    const target = schemasByFile[ref];
    if (!target) throw new Error(`schema $ref not found: ${ref}`);
    return { schema: target, root: target };
  }

  function check(value, schema, root, where, errors) {
    for (const k of Object.keys(schema)) {
      if (!KNOWN_KEYWORDS.has(k)) throw new Error(`schema keyword not supported by validator: ${k}`);
    }
    if (schema.$ref) {
      const r = resolveRef(schema.$ref, root);
      check(value, r.schema, r.root, where, errors);
      return;
    }
    if (schema.type !== undefined) {
      const types = Array.isArray(schema.type) ? schema.type : [schema.type];
      if (!types.some((t) => typeMatches(value, t))) {
        errors.push(`${where}: expected type ${types.join('|')}, got ${typeOf(value)}`);
        return;
      }
    }
    if (schema.enum && !schema.enum.some((e) => e === value)) {
      errors.push(`${where}: ${JSON.stringify(value)} not in enum ${JSON.stringify(schema.enum)}`);
    }
    if (schema.const !== undefined && value !== schema.const) {
      errors.push(`${where}: expected const ${JSON.stringify(schema.const)}`);
    }
    if (typeof value === 'string') {
      if (schema.minLength !== undefined && value.length < schema.minLength) errors.push(`${where}: shorter than minLength`);
      if (schema.format === 'date' && !/^\d{4}-\d{2}-\d{2}$/.test(value)) errors.push(`${where}: not a date`);
      if (schema.format === 'date-time' && !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/.test(value)) errors.push(`${where}: not a date-time`);
    }
    if (typeof value === 'number') {
      if (schema.minimum !== undefined && value < schema.minimum) errors.push(`${where}: below minimum ${schema.minimum}`);
      if (schema.exclusiveMinimum !== undefined && !(value > schema.exclusiveMinimum)) errors.push(`${where}: must be > ${schema.exclusiveMinimum}`);
    }
    if (Array.isArray(value)) {
      if (schema.minItems !== undefined && value.length < schema.minItems) errors.push(`${where}: fewer than ${schema.minItems} items`);
      if (schema.items) value.forEach((v, i) => check(v, schema.items, root, `${where}[${i}]`, errors));
    }
    if (typeOf(value) === 'object') {
      for (const r of schema.required || []) if (!(r in value)) errors.push(`${where}: missing required "${r}"`);
      const props = schema.properties || {};
      for (const [k, v] of Object.entries(value)) {
        if (props[k]) check(v, props[k], root, `${where}.${k}`, errors);
        else if (schema.additionalProperties === false) errors.push(`${where}: unexpected property "${k}"`);
      }
    }
  }

  return function validate(value, schemaFile, where) {
    const schema = schemasByFile[schemaFile];
    if (!schema) throw new Error(`unknown schema ${schemaFile}`);
    const errors = [];
    check(value, schema, schema, where, errors);
    return errors;
  };
}

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

const FORBIDDEN_NUTRITION = /calor|kcal|energy/i;

function scanForbidden(value, where, hits) {
  if (typeof value === 'string') {
    if (FORBIDDEN_NUTRITION.test(value)) hits.push(`${where}: value mentions a forbidden nutrition unit`);
  } else if (Array.isArray(value)) {
    value.forEach((v, i) => scanForbidden(v, `${where}[${i}]`, hits));
  } else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      if (FORBIDDEN_NUTRITION.test(k)) hits.push(`${where}: forbidden key "${k}"`);
      scanForbidden(v, `${where}.${k}`, hits);
    }
  }
}

const MEAL_MACRO_KEYS = new Set(['p', 'f', 'c', 'protein', 'carbs', 'fat', 'totals', 'macros', 'nutrition']);
function findMacroKeys(obj, where, hits) {
  if (Array.isArray(obj)) return obj.forEach((v, i) => findMacroKeys(v, `${where}[${i}]`, hits));
  if (!obj || typeof obj !== 'object') return;
  for (const [k, v] of Object.entries(obj)) {
    if (MEAL_MACRO_KEYS.has(k)) hits.push(`${where}.${k}`);
    findMacroKeys(v, `${where}.${k}`, hits);
  }
}

function slug(name) {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
}

function listRepoFiles(dir = ROOT, prefix = '') {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === '.git' || e.name === 'node_modules') continue;
    const p = prefix ? `${prefix}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...listRepoFiles(path.join(dir, e.name), p));
    else out.push(p);
  }
  return out.sort();
}

function deepEqual(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

/* ------------------------------------------------------------------ */
/* Gates                                                               */
/* ------------------------------------------------------------------ */

/**
 * bundle: { files: { relPath: parsedJSON }, rawText: { relPath: string } }
 * Reads legacy sources and config from disk (read-only).
 */
function validateBundle(bundle) {
  const gates = [];
  const gate = (id, description, errors, info) => {
    gates.push({ id, description, passed: errors.length === 0, errors, ...(info ? { info } : {}) });
  };
  const F = bundle.files;
  const decisions = readJSON('migration/migration-decisions.json');
  const sourceMap = readJSON('migration/migration-source-map.json');
  const manifest = readJSON('migration/expected-output-manifest.json');
  const srcFoods = readJSON('foods.json');
  const srcMeals = readJSON('meal-options.json');
  const live = readJSON('live-settings-doc.json');

  const schemaFiles = fs.readdirSync(rel('data/schemas')).filter((f) => f.endsWith('.schema.json')).sort();
  const schemas = {};
  for (const f of schemaFiles) schemas[f] = readJSON(`data/schemas/${f}`);
  const validate = makeSchemaValidator(schemas);

  // G01 manifest
  {
    const errs = manifest.requiredFiles.filter((p) => !(p in F) && !fs.existsSync(rel(p))).map((p) => `missing ${p}`);
    const expectedSchemas = ['day', 'food', 'meal-instance', 'meal', 'preferences', 'targets'].map((n) => `${n}.schema.json`).sort();
    if (!deepEqual(schemaFiles, expectedSchemas)) errs.push(`schema set is ${schemaFiles.join(', ')}`);
    gate('G01', 'Every file in expected-output-manifest.json exists, and the six schemas are present', errs);
  }

  const core = F['data/foods/core-foods.json'];
  const custom = F['user-data/custom-foods.json'];
  const meals = F['data/meals/library-meals.json'];
  const targets = F['data/targets.json'];
  const saved = F['user-data/saved-meals.json'];
  const logs = F['user-data/daily-logs.json'];
  const prefs = F['user-data/preferences.json'];

  // G02 schema validation
  {
    const errs = [];
    core.forEach((x, i) => errs.push(...validate(x, 'food.schema.json', `core-foods[${i}]`)));
    custom.forEach((x, i) => errs.push(...validate(x, 'food.schema.json', `custom-foods[${i}]`)));
    meals.forEach((x, i) => errs.push(...validate(x, 'meal.schema.json', `library-meals[${i}]`)));
    if (!Array.isArray(saved)) errs.push('saved-meals is not an array');
    else saved.forEach((x, i) => errs.push(...validate(x, 'meal.schema.json', `saved-meals[${i}]`)));
    if (!Array.isArray(logs)) errs.push('daily-logs is not an array');
    else logs.forEach((x, i) => errs.push(...validate(x, 'day.schema.json', `daily-logs[${i}]`)));
    errs.push(...validate(targets, 'targets.schema.json', 'targets'));
    errs.push(...validate(prefs, 'preferences.schema.json', 'preferences'));
    gate('G02', 'Canonical data validates against the V2 JSON schemas', errs);
  }

  // G03 core food IDs
  const allFoods = new Map();
  {
    const errs = [];
    if (core.length !== srcFoods.length) errs.push(`core foods ${core.length} != source ${srcFoods.length}`);
    for (const f of core) {
      if (!/^food_core_[a-z0-9_]+$/.test(f.id)) errs.push(`bad id pattern ${f.id}`);
      if (f.source !== 'core') errs.push(`${f.id} source ${f.source}`);
      if (allFoods.has(f.id)) errs.push(`duplicate id ${f.id}`);
      allFoods.set(f.id, f);
    }
    for (const s of srcFoods) {
      const id = `food_core_${slug(s.n)}`;
      const f = allFoods.get(id);
      if (!f) { errs.push(`source food "${s.n}" has no core food ${id}`); continue; }
      if (f.name !== s.n) errs.push(`${id} name changed`);
      if (f.nutrition.protein !== s.p || f.nutrition.carbs !== s.c || f.nutrition.fat !== s.f) errs.push(`${id} nutrition differs from source`);
    }
    gate('G03', 'Every Core Food has a unique, identity-derived stable ID and unchanged source nutrition', errs);
  }

  // G04 custom foods
  {
    const errs = [];
    const want = ['food_custom_oats_overnight', 'food_custom_oats_overnight_brand'];
    for (const id of want) if (!custom.some((f) => f.id === id)) errs.push(`missing ${id}`);
    if ((live.customFoods || []).length !== want.length) errs.push(`source has ${(live.customFoods || []).length} custom foods`);
    for (const f of custom) {
      if (f.source !== 'custom') errs.push(`${f.id} source ${f.source}`);
      if (allFoods.has(f.id)) errs.push(`custom id collides: ${f.id}`);
      allFoods.set(f.id, f);
    }
    for (const s of live.customFoods || []) {
      const f = custom.find((x) => x.id === `food_custom_${slug(s.n)}`);
      if (f && (f.nutrition.protein !== s.p || f.nutrition.carbs !== s.c || f.nutrition.fat !== s.f)) errs.push(`${f.id} nutrition differs from source`);
    }
    gate('G04', 'Both Custom Foods are represented with source values preserved', errs);
  }

  // G05 library meals represented, from meal-options.json only
  {
    const errs = [];
    const srcIds = srcMeals.map((m) => m.id);
    const gotLegacy = meals.map((m) => (m.metadata || {}).legacyId);
    if (meals.length !== srcMeals.length) errs.push(`library meals ${meals.length} != source ${srcMeals.length}`);
    for (const id of srcIds) if (!gotLegacy.includes(id)) errs.push(`source meal ${id} missing`);
    const seen = new Set();
    for (const m of meals) {
      if (seen.has(m.id)) errs.push(`duplicate meal id ${m.id}`);
      seen.add(m.id);
      const lid = (m.metadata || {}).legacyId;
      if (m.id !== `meal_library_${lid}`) errs.push(`${m.id} does not derive from legacy id ${lid}`);
      const s = srcMeals.find((x) => x.id === lid);
      if (!s) errs.push(`${m.id} has no meal-options.json source (duplicate source used?)`);
      else if (s.name !== m.name || s.slot !== m.mealType) errs.push(`${m.id} name/mealType differ from meal-options.json`);
      if (m.source !== 'library') errs.push(`${m.id} source ${m.source}`);
    }
    const liveIds = new Set(((live.bank || {}).meals || []).map((m) => m.id));
    const onlyInOptions = srcIds.filter((id) => !liveIds.has(id));
    gate('G05', 'All meal-options.json meals are represented once; the live-settings duplicate is not a source', errs,
      { sourceMeals: srcIds.length, duplicateSourceMeals: liveIds.size, presentOnlyInMealOptions: onlyInOptions });
  }

  // G06 ingredients resolve, quantities > 0, unit g
  {
    const errs = [];
    let lines = 0;
    for (const m of meals) {
      for (const ing of m.ingredients) {
        lines++;
        if (!allFoods.has(ing.foodId)) errs.push(`${m.id}: unresolved ${ing.foodId}`);
        if (!(ing.quantity > 0)) errs.push(`${m.id}: quantity ${ing.quantity} for ${ing.foodId}`);
        if (ing.unit !== 'g') errs.push(`${m.id}: unit ${ing.unit}`);
      }
      for (const g of (m.metadata || {}).garnishes || []) {
        if (g.foodId && !allFoods.has(g.foodId)) errs.push(`${m.id}: garnish ${g.foodId} unresolved`);
      }
    }
    for (const f of core) {
      if (f.metadata.swapFoodId && !allFoods.has(f.metadata.swapFoodId)) errs.push(`${f.id}: swapFoodId ${f.metadata.swapFoodId} unresolved`);
    }
    gate('G06', 'Every ingredient, garnish and swap reference resolves to an existing Food ID; quantities > 0 g', errs, { structuredIngredientLines: lines });
  }

  // G07 no authoritative meal macros
  {
    const hits = [];
    meals.forEach((m) => findMacroKeys(m, m.id, hits));
    (Array.isArray(saved) ? saved : []).forEach((m) => findMacroKeys(m, m.id, hits));
    gate('G07', 'No Library or Saved Meal stores P/C/F totals', hits);
  }

  // G08 every meal calculates through the shared formula
  {
    const errs = [];
    for (const m of meals) {
      try { calculateMealMacros(m, (id) => allFoods.get(id)); } catch (e) { errs.push(e.message); }
    }
    gate('G08', 'Every Library Meal calculates through migration/macro-calc.js', errs);
  }

  // G09 targets
  {
    const errs = [];
    if (!deepEqual(targets, decisions.approvedTargets)) errs.push(`targets ${JSON.stringify(targets)} != approved ${JSON.stringify(decisions.approvedTargets)}`);
    if (!deepEqual(targets, sourceMap.targetValues)) errs.push('targets differ from migration-source-map.json targetValues');
    const src = readJSON('targets.json').daily;
    const legacyAsCanonical = {
      lift: { protein: src.lift.p, carbs: src.lift.c, fat: src.lift.f },
      long_run: { protein: src.long.p, carbs: src.long.c, fat: src.long.f },
      rest: { protein: src.rest.p, carbs: src.rest.c, fat: src.rest.f }
    };
    if (!deepEqual(targets, legacyAsCanonical)) errs.push('targets differ from legacy targets.json daily values');
    const bad = [];
    const walk = (o, w) => { if (o && typeof o === 'object') for (const [k, v] of Object.entries(o)) { if (['p', 'f', 'c', 'perSlot', 'nightSnack', 'carbShiftByDayType', 'daily', 'long'].includes(k)) bad.push(`${w}.${k}`); walk(v, `${w}.${k}`); } };
    walk(targets, 'targets');
    errs.push(...bad.map((b) => `legacy key ${b}`));
    gate('G09', 'Targets are exactly Lift 150/293/70, Long Run 150/343/70, Rest 150/218/70 (P/C/F), daily only, no legacy keys', errs);
  }

  // G10 forbidden nutrition unit scan
  {
    const hits = [];
    for (const p of CANONICAL_JSON) if (p in F) scanForbidden(F[p], p, hits);
    scanForbidden(decisions, 'migration/migration-decisions.json', hits);
    for (const s of schemaFiles) scanForbidden(schemas[s], `data/schemas/${s}`, hits);
    gate('G10', 'No forbidden nutrition-unit key or value anywhere in canonical data, schemas or migration outputs', hits);
  }

  // G11 no fabricated history
  {
    const errs = [];
    if (bundle.seeds) {
      if (!deepEqual(bundle.seeds['user-data/daily-logs.json'], [])) errs.push('daily-logs seed is not empty');
      if (!deepEqual(bundle.seeds['user-data/saved-meals.json'], [])) errs.push('saved-meals seed is not empty');
    }
    gate('G11', 'The migration generates no Days, Meal Instances or Saved Meals', errs,
      { dailyLogsOnDisk: Array.isArray(logs) ? logs.length : null, savedMealsOnDisk: Array.isArray(saved) ? saved.length : null });
  }

  // G12 no V2 runtime file depends on legacy duplicates
  {
    const errs = [];
    const legacyHolding = [];
    const patterns = [/live-settings-doc/, /CTC_FOOD/, /\bvar M\s*=/, /SLOT_TARGET/, /carbShiftByDayType/];
    const files = [...new Set([...listRepoFiles(), ...Object.keys(bundle.rawText || {})])].sort();
    for (const p of files) {
      if (!/\.(js|mjs|cjs|html|json)$/.test(p)) continue;
      const text = p in (bundle.rawText || {}) ? bundle.rawText[p] : fs.readFileSync(rel(p), 'utf8');
      const found = patterns.filter((re) => re.test(text)).map((re) => re.source);
      if (!found.length) continue;
      if (LEGACY_FILES.includes(p)) legacyHolding.push(`${p}: ${found.join(', ')}`);
      else if (p.startsWith('migration/')) continue; // migration tooling legitimately reads legacy inputs
      else errs.push(`${p}: ${found.join(', ')}`);
    }
    gate('G12', 'No V2 runtime or canonical data file references live-settings-doc, CTC_FOOD, the M array, SLOT_TARGET or carbShiftByDayType', errs,
      { legacyInputsStillContaining: legacyHolding, note: 'Legacy inputs stay in place until Prompt 3 removes them as runtime dependencies.' });
  }

  // G13 retired meals
  {
    const got = meals.filter((m) => (m.metadata || {}).retired === true).map((m) => m.metadata.legacyId).sort();
    const want = [...decisions.retiredLibraryMeals].sort();
    gate('G13', 'Exactly the approved meals carry metadata.retired: true', deepEqual(got, want) ? [] : [`retired ${got.join(',')} != approved ${want.join(',')}`]);
  }

  // G14 garnishes
  {
    const got = [];
    for (const m of meals) for (const g of (m.metadata || {}).garnishes || []) got.push(`${m.metadata.legacyId}|${g.text}`);
    const want = decisions.garnishLines.map((g) => `${g.mealId}|${g.text}`);
    gate('G14', 'Only the approved unquantified lines are stored as garnishes', deepEqual(got.sort(), want.sort()) ? [] : [`garnishes ${got.join(',')} != approved ${want.join(',')}`]);
  }

  // G15 reference data copied verbatim
  {
    const errs = [];
    for (const [dst, src] of [['data/reference/yields.json', 'yields.json'], ['data/reference/portion-bounds.json', 'portion-bounds.json']]) {
      const a = dst in (bundle.rawText || {}) ? bundle.rawText[dst] : fs.readFileSync(rel(dst), 'utf8');
      if (a !== fs.readFileSync(rel(src), 'utf8')) errs.push(`${dst} is not a byte-identical copy of ${src}`);
    }
    gate('G15', 'Reference data (yields, portion bounds) is copied unchanged', errs);
  }

  // G16 source counts match the V2 package's observed counts
  {
    const c = sourceMap.counts;
    const errs = [];
    if (srcFoods.length !== c.coreFoodsSource) errs.push(`foods.json ${srcFoods.length} != ${c.coreFoodsSource}`);
    if (srcMeals.length !== c.libraryMealsSource) errs.push(`meal-options.json ${srcMeals.length} != ${c.libraryMealsSource}`);
    if (live.bank.meals.length !== c.duplicateLiveSettingsMeals) errs.push(`bank.meals ${live.bank.meals.length} != ${c.duplicateLiveSettingsMeals}`);
    if (live.customFoods.length !== c.customFoodsSource) errs.push(`customFoods ${live.customFoods.length} != ${c.customFoodsSource}`);
    gate('G16', 'Source counts equal the counts recorded in migration-source-map.json', errs);
  }

  return { passed: gates.every((g) => g.passed), gates };
}

function loadBundleFromDisk() {
  const files = {};
  const rawText = {};
  for (const p of CANONICAL_JSON) {
    if (!fs.existsSync(rel(p))) continue;
    rawText[p] = fs.readFileSync(rel(p), 'utf8');
    files[p] = JSON.parse(rawText[p]);
  }
  return { files, rawText };
}

module.exports = { validateBundle, loadBundleFromDisk, makeSchemaValidator, slug, LEGACY_FILES, CANONICAL_JSON };

if (require.main === module) {
  let result;
  try {
    const bundle = loadBundleFromDisk();
    const missing = CANONICAL_JSON.filter((p) => !(p in bundle.files));
    if (missing.length) {
      console.error('Missing canonical files (run node migration/migrate.js first):\n  ' + missing.join('\n  '));
      process.exit(1);
    }
    result = validateBundle(bundle);
  } catch (e) {
    console.error('VALIDATION ERROR: ' + e.message);
    process.exit(1);
  }
  for (const g of result.gates) {
    console.log(`${g.passed ? 'PASS' : 'FAIL'}  ${g.id}  ${g.description}`);
    for (const e of g.errors.slice(0, 20)) console.log(`        - ${e}`);
    if (g.errors.length > 20) console.log(`        … ${g.errors.length - 20} more`);
  }
  console.log(result.passed ? `\nAll ${result.gates.length} gates passed.` : '\nVALIDATION FAILED');
  process.exit(result.passed ? 0 : 1);
}
