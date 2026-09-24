'use strict';
/*
 * migrate.js — Prompt 1: legacy repo files → canonical V2 data.
 *
 *   node migration/migrate.js           generate, validate, then write
 *   node migration/migrate.js --check   generate in memory and compare with the files on disk;
 *                                       exit 1 if anything generated would change (no writes)
 *
 * Deterministic: output depends only on the source files and migration-decisions.json.
 * No timestamps, no randomness, source order preserved, stable JSON formatting.
 *
 * Safe to re-run:
 *   - data/ and migration/ outputs are generated and are rewritten identically.
 *   - user-data/ files are NEVER overwritten. They are seeded only when missing.
 *   - Legacy source files are only read (decision 10).
 *
 * Fails (exit 1, nothing written) on any blocking error or failed validation gate.
 * Non-blocking warnings and manual-review items go into migration/migration-report.json.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const vm = require('vm');
const { calculateMealMacros, round1, MACROS } = require('./macro-calc');
const { validateBundle, slug } = require('./validate');

const ROOT = path.resolve(__dirname, '..');
const rel = (p) => path.join(ROOT, p);
const readText = (p) => fs.readFileSync(rel(p), 'utf8');
const readJSON = (p) => JSON.parse(readText(p));
const toJSON = (v) => JSON.stringify(v, null, 2) + '\n';
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

const SOURCE_FILES = [
  'foods.json', 'meal-options.json', 'targets.json', 'live-settings-doc.json', 'yields.json',
  'portion-bounds.json', 'meal-bank.html', 'ingredient-name-map.json', 'ingredients-flat.json'
];

const KNOWN_FOOD_KEYS = new Set(['n', 'p', 'f', 'c', 'cat', 't', 'swap', 'y', 'yk', 'carb', 'fat', 'brandy', 'step']);
const KNOWN_CUSTOM_KEYS = new Set(['n', 'p', 'f', 'c', 'cat', 't', 'carb', 'fat', 'looked']);
const KNOWN_MEAL_KEYS = new Set(['id', 'slot', 'name', 'lane', 'p', 'f', 'c', 'wt', 'min', 'batch', 'base', 'ing', 'steps', 'store', 'note', 'native', 'isnew']);
const MEAL_TYPES = new Set(['breakfast', 'lunch', 'snack', 'dinner']);
const NATIVE_DAY_TYPE = { lift: 'lift', rest: 'rest', long: 'long_run' };
const TOLERANCE = 0.05; // same threshold recost.js used for "drift"
const EPSILON = 1e-9;

const DEFAULT_PREFERENCES = {
  favoriteFoods: [],
  favoriteMeals: [],
  dislikedFoods: [],
  mealPreferences: { preferredMealSize: 'moderate', preferQuickMeals: false },
  coachingPreferences: { recommendSavedMealsFirst: true, considerVariety: true },
  appPreferences: {}
};

function run() {
  const blocking = [];
  const warnings = [];
  const manualReview = [];

  /* ---------------- read sources ---------------- */
  const sourceText = {};
  for (const f of SOURCE_FILES) sourceText[f] = readText(f);
  const srcFoods = JSON.parse(sourceText['foods.json']);
  const srcMeals = JSON.parse(sourceText['meal-options.json']);
  const srcTargets = JSON.parse(sourceText['targets.json']);
  const live = JSON.parse(sourceText['live-settings-doc.json']);
  const nameMapFile = JSON.parse(sourceText['ingredient-name-map.json']);
  const flat = JSON.parse(sourceText['ingredients-flat.json']);
  const yields = JSON.parse(sourceText['yields.json']);
  const bounds = JSON.parse(sourceText['portion-bounds.json']);
  const decisions = readJSON('migration/migration-decisions.json');
  const html = sourceText['meal-bank.html'];

  /* ---------------- CTC_FOOD (migration-only alias map) ---------------- */
  const ctcLine = html.split('\n').find((l) => l.startsWith('var CTC_FOOD = {'));
  if (!ctcLine) throw new Error('meal-bank.html: CTC_FOOD not found');
  const ctcLiteral = ctcLine.slice('var CTC_FOOD = '.length).replace(/;\s*$/, '');
  const CTC_FOOD = JSON.parse(ctcLiteral);
  const ctcPairs = [...ctcLiteral.matchAll(/"([^"]+)":"([^"]+)"/g)].map((m) => [m[1], m[2]]);
  const ctcDupKeys = [];
  {
    const seen = {};
    for (const [k, v] of ctcPairs) {
      if (k in seen) ctcDupKeys.push({ key: k, sameTarget: seen[k] === v });
      seen[k] = v;
    }
  }
  const ctcDiffersFromNameMap = JSON.stringify(Object.entries(CTC_FOOD).sort()) !== JSON.stringify(Object.entries(nameMapFile).sort());
  if (ctcDiffersFromNameMap) warnings.push({ code: 'CTC_FOOD_NAME_MAP_DIFFER', detail: 'meal-bank.html CTC_FOOD and ingredient-name-map.json differ; CTC_FOOD was used (migration-spec.md).' });
  if (ctcDupKeys.length) warnings.push({ code: 'CTC_FOOD_DUPLICATE_KEYS', detail: `CTC_FOOD literal repeats ${ctcDupKeys.length} keys`, keys: ctcDupKeys });

  // Evidence only: the embedded M array should equal meal-options.json (it is discarded either way).
  let embeddedMMatches = null;
  try {
    const a = html.indexOf('var TARGET = {');
    const b = html.indexOf('var byId={};');
    const ctx = vm.runInNewContext(html.slice(a, b) + '\n;({M:M})', {}, { timeout: 2000 });
    embeddedMMatches = JSON.stringify(ctx.M) === JSON.stringify(srcMeals);
  } catch (e) {
    embeddedMMatches = `could not evaluate: ${e.message}`;
  }
  if (embeddedMMatches !== true) warnings.push({ code: 'EMBEDDED_M_DIFFERS', detail: `meal-bank.html M vs meal-options.json: ${embeddedMMatches}` });

  /* ---------------- Foods ---------------- */
  const coreFoods = [];
  const foodIdByName = new Map(); // exact legacy name -> id
  const foodIdByLowerName = new Map();
  const inferredStates = [];
  const explicitStates = [];
  const stateRules = decisions.foodState;

  function resolveState(name, category, isCustom) {
    const lower = name.toLowerCase();
    if (!isCustom) {
      for (const r of stateRules.explicitNamePatterns) {
        if (new RegExp(r.pattern, 'i').test(lower)) return { state: r.state, inferred: false, basis: `name matches /${r.pattern}/` };
      }
    }
    if (stateRules.inferredByName[name]) {
      const o = stateRules.inferredByName[name];
      return { state: o.state, inferred: true, basis: o.basis, review: !!o.review };
    }
    if (stateRules.inferredByCategory[category]) {
      const review = stateRules.reviewCategories[category];
      return { state: stateRules.inferredByCategory[category], inferred: true, basis: `category "${category}" default`, review: !!review, reviewReason: review };
    }
    return null;
  }

  // aliases: bank wordings that CTC_FOOD maps to each food name
  const aliasesByFoodName = {};
  for (const [wording, foodName] of Object.entries(CTC_FOOD)) (aliasesByFoodName[foodName] = aliasesByFoodName[foodName] || []).push(wording);

  for (const s of srcFoods) {
    for (const k of Object.keys(s)) if (!KNOWN_FOOD_KEYS.has(k)) warnings.push({ code: 'UNKNOWN_FOOD_FLAG', detail: `${s.n}: legacy key "${k}" not carried` });
    const id = `food_core_${slug(s.n)}`;
    if (foodIdByName.has(s.n) || coreFoods.some((f) => f.id === id)) { blocking.push({ code: 'DUPLICATE_FOOD_ID', detail: `${s.n} -> ${id}` }); continue; }
    foodIdByName.set(s.n, id);
    foodIdByLowerName.set(s.n.toLowerCase(), id);
  }

  for (const s of srcFoods) {
    const id = foodIdByName.get(s.n);
    if (!id) continue;
    const st = resolveState(s.n, s.cat, false);
    if (!st) { blocking.push({ code: 'NO_STATE_RULE', detail: `${s.n} (category ${s.cat})` }); continue; }
    (st.inferred ? inferredStates : explicitStates).push({ foodId: id, name: s.n, state: st.state, basis: st.basis, ...(st.review ? { review: true } : {}) });

    const metadata = { editable: false, active: true };
    if (s.y !== undefined) metadata.yieldFactor = s.y;
    if (s.yk !== undefined) metadata.yieldKey = s.yk;
    if (s.step !== undefined) metadata.portionStep = s.step;
    if (s.carb) metadata.macroRole = 'carb';
    if (s.fat) metadata.macroRole = 'fat';
    if (s.brandy) metadata.branded = true;
    if (s.swap !== undefined) {
      const target = foodIdByLowerName.get(String(s.swap).toLowerCase());
      if (target && target !== id) metadata.swapFoodId = target;
      else {
        metadata.legacySwap = s.swap;
        manualReview.push({
          code: target === id ? 'SELF_SWAP_REFERENCE' : 'BROKEN_SWAP_REFERENCE',
          foodId: id,
          detail: target === id
            ? `"${s.n}" lists itself as its swap; kept as metadata.legacySwap, no swapFoodId`
            : `"${s.n}" swaps to "${s.swap}", which is not a Food; kept as metadata.legacySwap, not repaired`
        });
      }
    }
    if (st.inferred) metadata.stateInferred = true;

    const aliases = [s.n.toLowerCase(), ...(aliasesByFoodName[s.n] || []).slice().sort()].filter((v, i, a) => a.indexOf(v) === i);
    coreFoods.push({
      id,
      name: s.n,
      source: 'core',
      category: s.cat,
      brand: decisions.brandByFoodName[s.n] || null,
      state: st.state,
      nutrition: { basis: '100g', protein: s.p, carbs: s.c, fat: s.f },
      measurement: { canonicalUnit: 'g', servingSize: 100, servingUnit: 'g' },
      tags: s.t.slice(),
      aliases,
      metadata
    });
  }

  // Source-data anomalies preserved as-is
  {
    const tagCount = {};
    const catCount = {};
    srcFoods.forEach((f) => { f.t.forEach((t) => (tagCount[t] = (tagCount[t] || 0) + 1)); catCount[f.cat] = (catCount[f.cat] || 0) + 1; });
    for (const [t, n] of Object.entries(tagCount)) if (n === 1) warnings.push({ code: 'SINGLE_USE_TAG', detail: `tag "${t}" used by one food only (${srcFoods.find((f) => f.t.includes(t)).n}); preserved as-is` });
    for (const [c, n] of Object.entries(catCount)) if (n === 1) warnings.push({ code: 'SINGLE_USE_CATEGORY', detail: `category "${c}" used by one food only (${srcFoods.find((f) => f.cat === c).n}); preserved as-is` });
    for (const c of Object.keys(catCount)) if (!bounds[c]) warnings.push({ code: 'CATEGORY_WITHOUT_PORTION_BOUNDS', detail: `category "${c}" has no entry in portion-bounds.json` });
  }

  /* ---------------- Custom Foods ---------------- */
  const customFoods = [];
  for (const s of live.customFoods || []) {
    for (const k of Object.keys(s)) if (!KNOWN_CUSTOM_KEYS.has(k)) warnings.push({ code: 'UNKNOWN_CUSTOM_FOOD_FLAG', detail: `${s.n}: legacy key "${k}" not carried` });
    const id = `food_custom_${slug(s.n)}`;
    const st = resolveState(s.n, s.cat, true);
    if (!st) { blocking.push({ code: 'NO_STATE_RULE', detail: `custom ${s.n}` }); continue; }
    (st.inferred ? inferredStates : explicitStates).push({ foodId: id, name: s.n, state: st.state, basis: st.basis, ...(st.review ? { review: true } : {}) });
    const metadata = { editable: true, active: true };
    if (s.carb) metadata.macroRole = 'carb';
    if (s.fat) metadata.macroRole = 'fat';
    if (s.looked) metadata.legacyLookedUp = true;
    if (st.inferred) metadata.stateInferred = true;
    customFoods.push({
      id,
      name: s.n,
      source: 'custom',
      category: s.cat,
      brand: decisions.brandByFoodName[s.n] || null,
      state: st.state,
      nutrition: { basis: '100g', protein: s.p, carbs: s.c, fat: s.f },
      measurement: { canonicalUnit: 'g', servingSize: 100, servingUnit: 'g' },
      tags: s.t.slice(),
      aliases: [s.n.toLowerCase()],
      metadata
    });
  }

  const foodsById = new Map([...coreFoods, ...customFoods].map((f) => [f.id, f]));

  /* ---------------- Library Meals ---------------- */
  const libraryMeals = [];
  const mealIdMap = {};
  const unresolved = [];
  const ambiguous = [];
  const garnishes = [];
  const discrepancies = [];
  const maxAbs = { protein: 0, carbs: 0, fat: 0 };
  const ingredientWordings = {};
  let ingredientLinesTotal = 0;
  let structuredLines = 0;
  let nativeDefaulted = 0;
  const approvedGarnish = new Set(decisions.garnishLines.map((g) => `${g.mealId}|${g.text}`));

  function resolveWording(name) {
    const mapped = CTC_FOOD[name];
    const direct = foodIdByLowerName.get(name);
    if (mapped !== undefined) {
      const id = foodIdByName.get(mapped);
      if (!id) return { error: `CTC_FOOD maps "${name}" to "${mapped}", which is not in foods.json` };
      if (direct && direct !== id) ambiguous.push({ wording: name, ctcFood: id, exactNameFood: direct });
      return { foodId: id, via: 'CTC_FOOD' };
    }
    if (direct) return { foodId: direct, via: 'exact-name' };
    return { error: 'no CTC_FOOD entry and no Food with this exact name' };
  }

  for (const s of srcMeals) {
    for (const k of Object.keys(s)) if (!KNOWN_MEAL_KEYS.has(k)) warnings.push({ code: 'UNKNOWN_MEAL_FIELD', detail: `${s.id}: legacy key "${k}" not carried` });
    const mealErrors = [];
    if (!MEAL_TYPES.has(s.slot)) mealErrors.push(`slot "${s.slot}" is not a V2 mealType`);
    const ingredients = [];
    const labels = {};
    const mealGarnishes = [];
    const lineRecords = [];

    const parts = s.ing.split(';').map((x) => x.trim()).filter(Boolean);
    for (const line of parts) {
      ingredientLinesTotal++;
      const m = line.match(/^(.+?)\s+([\d.]+)\s*(g|ml)$/); // identical to meal-bank.html parseIng
      if (!m) {
        const text = line.toLowerCase();
        if (approvedGarnish.has(`${s.id}|${text}`)) {
          const r = resolveWording(text);
          const g = { text, ...(r.foodId ? { foodId: r.foodId } : {}), note: 'No quantity in source; not included in macro calculation.' };
          mealGarnishes.push(g);
          garnishes.push({ mealId: s.id, ...g });
          lineRecords.push({ line, kind: 'garnish', ...(r.foodId ? { foodId: r.foodId, resolvedVia: r.via } : {}) });
        } else {
          mealErrors.push(`unquantified line "${line}" is not an approved garnish`);
          unresolved.push({ mealId: s.id, line, reason: 'no quantity/unit and not an approved garnish' });
        }
        continue;
      }
      const name = m[1].trim().toLowerCase();
      const qty = parseFloat(m[2]);
      const unit = m[3];
      if (unit !== 'g') { mealErrors.push(`"${line}" uses ${unit}; no silent unit conversion`); continue; }
      if (!(qty > 0)) { mealErrors.push(`"${line}" has quantity ${qty}`); continue; }
      const r = resolveWording(name);
      if (r.error) {
        mealErrors.push(`"${line}": ${r.error}`);
        unresolved.push({ mealId: s.id, line, reason: r.error });
        continue;
      }
      if (ingredients.some((i) => i.foodId === r.foodId)) {
        manualReview.push({ code: 'SAME_FOOD_TWICE_IN_MEAL', mealId: s.id, detail: `${r.foodId} appears on more than one line; lines kept separate, not merged` });
      }
      ingredients.push({ foodId: r.foodId, quantity: qty, unit: 'g' });
      structuredLines++;
      ingredientWordings[name] = r.foodId;
      const food = foodsById.get(r.foodId);
      if (name !== food.name.toLowerCase()) labels[r.foodId] = labels[r.foodId] ? `${labels[r.foodId]}; ${name}` : name;
      lineRecords.push({ line, kind: 'ingredient', wording: name, quantity: qty, unit: 'g', foodId: r.foodId, resolvedVia: r.via });
    }

    if (mealErrors.length) {
      blocking.push({ code: 'MEAL_NOT_MIGRATED', mealId: s.id, errors: mealErrors });
      continue;
    }

    const id = `meal_library_${s.id}`;
    const metadata = { legacyId: s.id, lane: s.lane };
    if (s.native !== undefined) {
      if (!NATIVE_DAY_TYPE[s.native]) { blocking.push({ code: 'UNKNOWN_NATIVE_DAY_TYPE', mealId: s.id, detail: s.native }); continue; }
      metadata.nativeDayType = NATIVE_DAY_TYPE[s.native];
    } else {
      metadata.nativeDayType = 'lift'; // documented legacy semantics: absent native means a lifting day
      nativeDefaulted++;
    }
    metadata.weightDescription = s.wt;
    metadata.prepMinutes = s.min;
    metadata.batchSize = s.batch;
    metadata.base = s.base;
    metadata.steps = s.steps.slice();
    metadata.storage = s.store;
    metadata.notes = s.note;
    if (Object.keys(labels).length) metadata.ingredientLabels = labels;
    if (mealGarnishes.length) metadata.garnishes = mealGarnishes;
    if (s.isnew) metadata.isNew = true;
    if (decisions.retiredLibraryMeals.includes(s.id)) metadata.retired = true;

    const meal = { id, name: s.name, source: 'library', mealType: s.slot, ingredients, favorite: false, metadata };

    // legacy p/f/c are validation evidence only
    const calc = calculateMealMacros(meal, (fid) => foodsById.get(fid)).totals;
    const legacy = { protein: s.p, carbs: s.c, fat: s.f };
    const diff = {};
    let flagged = false;
    for (const k of MACROS) {
      const raw = calc[k] - legacy[k];
      if (Math.abs(raw) > maxAbs[k]) maxAbs[k] = Math.abs(raw);
      diff[k] = round1(raw);
      // Legacy figures are rounded to 0.1 g, so a legacy value is consistent when it is
      // within half a rounding step of the unrounded calculation. EPSILON absorbs binary
      // floating-point error (e.g. an exact 19.55 computed as 19.5499999…).
      if (Math.abs(raw) > TOLERANCE + EPSILON) flagged = true;
    }
    if (flagged) {
      discrepancies.push({ mealId: s.id, legacy, calculated: { protein: round1(calc.protein), carbs: round1(calc.carbs), fat: round1(calc.fat) }, difference: diff });
    }

    libraryMeals.push(meal);
    mealIdMap[s.id] = { id, name: s.name, ingredientLines: lineRecords };
  }
  for (const k of MACROS) maxAbs[k] = Math.round(maxAbs[k] * 1000) / 1000;
  for (const a of ambiguous) warnings.push({ code: 'AMBIGUOUS_INGREDIENT_WORDING', detail: `"${a.wording}": CTC_FOOD -> ${a.ctcFood}, exact name -> ${a.exactNameFood}; CTC_FOOD used` });

  // Cross-check the parse against the pre-parsed ingredients-flat.json
  {
    const mine = [];
    for (const [lid, rec] of Object.entries(mealIdMap)) for (const l of rec.ingredientLines) {
      const fname = l.foodId ? foodsById.get(l.foodId).name : null;
      mine.push(`${lid}|${l.kind === 'garnish' ? l.line.toLowerCase() : l.wording}|${l.kind === 'garnish' ? 0 : l.quantity}|${fname}`);
    }
    const theirs = flat.map((r) => `${r.option}|${r.ingredient}|${r.grams}|${r.food}`);
    if (JSON.stringify(mine) !== JSON.stringify(theirs)) {
      const onlyMine = mine.filter((x) => !theirs.includes(x));
      const onlyTheirs = theirs.filter((x) => !mine.includes(x));
      warnings.push({ code: 'FLAT_INGREDIENTS_DIFFER', detail: 'Parsed ingredients differ from ingredients-flat.json', onlyInMigration: onlyMine, onlyInFlatFile: onlyTheirs });
    }
  }

  // Retired meals: cross-check against the live-settings duplicate (evidence only, not a source)
  const liveMeals = (live.bank && live.bank.meals) || [];
  const liveIds = new Set(liveMeals.map((m) => m.id));
  {
    const absentFromLive = srcMeals.map((m) => m.id).filter((id) => !liveIds.has(id)).sort();
    const approved = [...decisions.retiredLibraryMeals].sort();
    if (JSON.stringify(absentFromLive) !== JSON.stringify(approved)) {
      warnings.push({ code: 'RETIRED_EVIDENCE_MISMATCH', detail: `approved retired ${approved.join(',')} but meals absent from live bank are ${absentFromLive.join(',')}` });
    }
  }
  const liveDuplicateComparison = [];
  for (const lm of liveMeals) {
    const s = srcMeals.find((m) => m.id === lm.id);
    if (!s) { liveDuplicateComparison.push({ id: lm.id, difference: 'not in meal-options.json' }); continue; }
    const d = [];
    if (lm.n !== s.name) d.push('name');
    if (lm.p !== s.p || lm.f !== s.f || lm.c !== s.c) d.push('stored p/f/c');
    if (d.length) liveDuplicateComparison.push({ id: lm.id, differs: d });
  }

  /* ---------------- Targets ---------------- */
  const daily = srcTargets.daily;
  const targets = {
    lift: { protein: daily.lift.p, carbs: daily.lift.c, fat: daily.lift.f },
    long_run: { protein: daily.long.p, carbs: daily.long.c, fat: daily.long.f },
    rest: { protein: daily.rest.p, carbs: daily.rest.c, fat: daily.rest.f }
  };
  if (JSON.stringify(targets) !== JSON.stringify(decisions.approvedTargets)) {
    blocking.push({ code: 'TARGETS_DIFFER_FROM_APPROVED', detail: { source: targets, approved: decisions.approvedTargets } });
  }

  /* ---------------- Source-data conflicts (preserved, reported) ---------------- */
  const normYieldName = (n) => n.toLowerCase().replace(/,/g, '').replace(/\s+/g, ' ').trim();
  const yieldConflicts = [];
  const yieldRowsWithoutFood = [];
  const yieldRowsForFoodsWithoutFactor = [];
  for (const [key, factor, method, flagged] of yields.factors) {
    const matches = srcFoods.filter((f) => normYieldName(f.n) === key || normYieldName(f.n).replace(/ raw$/, '') === key);
    if (!matches.length) { yieldRowsWithoutFood.push(key); continue; }
    for (const f of matches) {
      if (f.y === undefined) yieldRowsForFoodsWithoutFactor.push({ foodId: foodIdByName.get(f.n), yieldsKey: key, yieldsFactor: factor });
      else if (f.y !== factor) {
        yieldConflicts.push({
          foodId: foodIdByName.get(f.n), foodName: f.n,
          foodsJsonFactor: f.y, yieldsJsonKey: key, yieldsJsonFactor: factor, yieldsJsonMethod: method,
          ...(flagged ? { yieldsJsonFlaggedUnmeasured: true } : {})
        });
      }
    }
  }
  const foodsWithFactorButNoYieldRow = srcFoods
    .filter((f) => f.y !== undefined && !yields.factors.some(([k]) => normYieldName(f.n) === k || normYieldName(f.n).replace(/ raw$/, '') === k))
    .map((f) => foodIdByName.get(f.n));
  if (yieldConflicts.length) manualReview.push({ code: 'YIELD_CONFLICTS', detail: `${yieldConflicts.length} foods have a different factor in foods.json and yields.json; both preserved (Food metadata keeps foods.json, data/reference/yields.json keeps yields.json)` });

  const oatsCore = coreFoods.find((f) => f.name === 'Oats overnight packet');
  const oatsCustom = customFoods.filter((f) => /oats overnight/i.test(f.name));
  const oatsMeals = libraryMeals.filter((m) => m.ingredients.some((i) => oatsCore && i.foodId === oatsCore.id)).map((m) => m.metadata.legacyId);
  const oatsOvernight = {
    detail: 'Built-in packet row and the two hand-entered Custom Foods disagree; all three kept as separate Foods, nothing merged or substituted.',
    foods: [oatsCore, ...oatsCustom].filter(Boolean).map((f) => ({ foodId: f.id, name: f.name, source: f.source, per100g: { protein: f.nutrition.protein, carbs: f.nutrition.carbs, fat: f.nutrition.fat } })),
    libraryMealsUsingCoreRow: oatsMeals
  };
  manualReview.push({ code: 'OATS_OVERNIGHT_DISCREPANCY', detail: `Core packet row vs two Custom Foods; used by ${oatsMeals.join(', ') || 'no meal'}` });

  for (const s of inferredStates.filter((x) => x.review)) {
    manualReview.push({ code: 'FOOD_STATE_REVIEW', foodId: s.foodId, detail: `state "${s.state}" inferred (${s.basis})` });
  }
  for (const d of discrepancies) manualReview.push({ code: 'LEGACY_MACRO_DISCREPANCY', mealId: d.mealId, detail: d.difference });
  for (const issue of decisions.knownAuditIssuesCarriedForward) manualReview.push({ code: 'NUTRITION_AUDIT_ISSUE_NOT_RESOLVED', detail: issue });

  /* ---------------- user-data seeds (never overwrite) ---------------- */
  const seeds = {
    'user-data/custom-foods.json': customFoods,
    'user-data/saved-meals.json': [],
    'user-data/daily-logs.json': [],
    'user-data/preferences.json': DEFAULT_PREFERENCES
  };

  /* ---------------- ID maps ---------------- */
  const foodIdMap = {
    coreFoods: Object.fromEntries(srcFoods.map((f) => [f.n, foodIdByName.get(f.n)])),
    customFoods: Object.fromEntries(customFoods.map((f) => [f.name, f.id])),
    ingredientWordings: Object.fromEntries(Object.keys(ingredientWordings).sort().map((k) => [k, ingredientWordings[k]]))
  };

  /* ---------------- assemble generated files ---------------- */
  const generated = {
    'data/foods/core-foods.json': toJSON(coreFoods),
    'data/meals/library-meals.json': toJSON(libraryMeals),
    'data/targets.json': toJSON(targets),
    'data/reference/yields.json': sourceText['yields.json'],
    'data/reference/portion-bounds.json': sourceText['portion-bounds.json'],
    'migration/food-id-map.json': toJSON(foodIdMap),
    'migration/meal-id-map.json': toJSON(mealIdMap)
  };

  // Effective user-data: existing files win; seeds only fill gaps.
  const userData = {};
  const userDataStatus = {};
  for (const [p, seed] of Object.entries(seeds)) {
    const seedText = toJSON(seed);
    // The report records only whether the file equals the seed, so it stays identical
    // between a first run (seeded) and a re-run (kept). The action is printed to the console.
    if (fs.existsSync(rel(p))) {
      const text = readText(p);
      userData[p] = { text, write: false };
      userDataStatus[p] = { neverOverwritten: true, matchesMigrationSeed: text === seedText };
    } else {
      userData[p] = { text: seedText, write: true };
      userDataStatus[p] = { neverOverwritten: true, matchesMigrationSeed: true };
    }
  }

  const report = {
    reportVersion: 1,
    status: 'pending',
    sourceFiles: Object.fromEntries(SOURCE_FILES.map((f) => [f, { sha256: sha256(sourceText[f]) }])),
    sourceCounts: {
      'foods.json': srcFoods.length,
      'meal-options.json': srcMeals.length,
      'live-settings-doc.json#bank.meals': liveMeals.length,
      'live-settings-doc.json#customFoods': (live.customFoods || []).length,
      ingredientLines: ingredientLinesTotal
    },
    destinationCounts: {
      coreFoods: coreFoods.length,
      libraryMeals: libraryMeals.length,
      retiredLibraryMeals: libraryMeals.filter((m) => m.metadata.retired).length,
      customFoods: customFoods.length,
      structuredIngredientLines: structuredLines,
      garnishLines: garnishes.length,
      savedMeals: 0,
      dailyLogs: 0
    },
    targets,
    duplicateMealSource: {
      source: 'live-settings-doc.json#bank.meals',
      disposition: 'discarded as duplicate; not migrated',
      meals: liveMeals.length,
      idsInMealOptionsOnly: srcMeals.map((m) => m.id).filter((id) => !liveIds.has(id)),
      embeddedMealBankArrayMatchesMealOptions: embeddedMMatches,
      recordsDifferingFromMealOptions: liveDuplicateComparison
    },
    duplicateMealIds: srcMeals.map((m) => m.id).filter((id, i, a) => a.indexOf(id) !== i),
    unresolvedIngredients: unresolved,
    ambiguousIngredients: ambiguous,
    garnishes,
    legacyMacroComparison: {
      method: 'unrounded calculated P/C/F vs legacy meal p/f/c (which are rounded to 0.1 g); flagged when the difference exceeds 0.05 g, i.e. the legacy value is not a correct rounding of the calculation',
      mealsCompared: libraryMeals.length,
      discrepancies,
      maxAbsoluteUnroundedDifference: maxAbs
    },
    foodStates: {
      explicit: explicitStates.length,
      inferred: inferredStates.length,
      inferredDetail: inferredStates
    },
    nativeDayType: { defaultedToLift: nativeDefaulted, note: 'meal-options.json omits native for lifting-day meals (README: absent means a lifting day)' },
    sourceDataConflicts: {
      yieldConflicts,
      yieldReferenceNotes: { yieldRowsWithoutFood, yieldRowsForFoodsWithoutFactor, foodsWithFactorButNoYieldRow },
      oatsOvernight,
      swapReferences: manualReview.filter((x) => x.code === 'BROKEN_SWAP_REFERENCE' || x.code === 'SELF_SWAP_REFERENCE')
    },
    generatedFoodIds: coreFoods.map((f) => f.id),
    customFoodIds: customFoods.map((f) => f.id),
    generatedMealIds: libraryMeals.map((m) => m.id),
    userData: userDataStatus,
    notMigrated: [
      { source: 'live-settings-doc.json#bank.meals', reason: 'duplicate of meal-options.json' },
      { source: 'live-settings-doc.json#measured', reason: 'empty object; no preference found' },
      { source: 'live-settings-doc.json#yields', reason: 'empty object; yield references live in data/reference/yields.json' },
      { source: 'live-settings-doc.json#updatedAt', reason: 'storage bookkeeping' },
      { source: 'Close the Carbs hosted days/<date> logs', reason: 'not imported (decision 11); not in this repository' },
      { source: 'targets.json#perSlot', reason: 'not an authoritative V2 target (decision 14)' },
      { source: 'targets.json#nightSnack', reason: 'not an authoritative V2 target (decision 14)' },
      { source: 'targets.json#carbShiftByDayType', reason: 'not an authoritative V2 target (decision 14)' },
      { source: 'meal-options.json p/f/c', reason: 'legacy totals are validation evidence only' },
      { source: 'meal-bank.html M, CTC_FOOD, TARGET, SLOT_TARGET, SHIFT, SHIFT_FOOD, DAYS, NIGHT, FIBRE/SOLUBLE/FERMENTABLE tables', reason: 'embedded legacy data; CTC_FOOD used once as the alias map' },
      { source: 'fibre.json', reason: 'V2 is protein/carbs/fat only; no fibre dimension' },
      { source: 'ingredient-name-map.json, ingredients-flat.json', reason: 'cross-check evidence only' },
      { source: 'close-the-carbs.html, meal-bank.html, recost.js, gen-bank-docs.js, README.md', reason: 'legacy app/tools; left in place (decision 10), replaced in later prompts' }
    ],
    warnings,
    manualReview,
    blockingErrors: blocking,
    validation: null
  };

  return { generated, userData, report, seeds, blocking };
}

function main() {
  const check = process.argv.includes('--check');
  const { generated, userData, report, seeds, blocking } = run();

  const files = {};
  const rawText = {};
  for (const [p, t] of Object.entries(generated)) { rawText[p] = t; files[p] = JSON.parse(t); }
  for (const [p, u] of Object.entries(userData)) { rawText[p] = u.text; files[p] = JSON.parse(u.text); }
  files['migration/migration-report.json'] = report; // placeholder for the manifest gate

  let validation;
  if (blocking.length) {
    validation = { passed: false, gates: [], skipped: 'blocking migration errors' };
  } else {
    validation = validateBundle({ files, rawText, seeds });
  }
  report.validation = validation;
  report.status = !blocking.length && validation.passed ? 'passed' : 'failed';
  const reportText = toJSON(report);
  if (/calor|kcal|energy/i.test(reportText)) {
    report.status = 'failed';
    blocking.push({ code: 'FORBIDDEN_TERM_IN_REPORT', detail: 'migration report contains a forbidden nutrition term' });
  }
  generated['migration/migration-report.json'] = toJSON(report);

  const summary = () => {
    console.log(`status: ${report.status}`);
    console.log(`core foods ${report.destinationCounts.coreFoods}, custom foods ${report.destinationCounts.customFoods}, library meals ${report.destinationCounts.libraryMeals} (${report.destinationCounts.retiredLibraryMeals} retired)`);
    console.log(`ingredient lines ${report.sourceCounts.ingredientLines}: ${report.destinationCounts.structuredIngredientLines} structured, ${report.destinationCounts.garnishLines} garnish`);
    console.log(`blocking ${blocking.length}, warnings ${report.warnings.length}, manual review ${report.manualReview.length}`);
    for (const g of validation.gates || []) console.log(`  ${g.passed ? 'PASS' : 'FAIL'} ${g.id} ${g.description}`);
  };

  if (report.status !== 'passed') {
    console.error('MIGRATION FAILED — nothing written.');
    for (const b of blocking) console.error('  BLOCKING', JSON.stringify(b));
    for (const g of (validation.gates || []).filter((x) => !x.passed)) console.error('  GATE', g.id, JSON.stringify(g.errors.slice(0, 10)));
    process.exit(1);
  }

  if (check) {
    const drift = Object.entries(generated).filter(([p, t]) => !fs.existsSync(rel(p)) || fs.readFileSync(rel(p), 'utf8') !== t).map(([p]) => p);
    summary();
    if (drift.length) { console.error('\nCHECK FAILED — generated output differs from disk:\n  ' + drift.join('\n  ')); process.exit(1); }
    console.log('\ncheck: every generated file on disk matches a fresh migration run');
    return;
  }

  for (const [p, t] of Object.entries(generated)) {
    fs.mkdirSync(path.dirname(rel(p)), { recursive: true });
    fs.writeFileSync(rel(p), t);
  }
  for (const [p, u] of Object.entries(userData)) {
    if (!u.write) { console.log(`user-data: kept existing ${p}`); continue; }
    fs.mkdirSync(path.dirname(rel(p)), { recursive: true });
    fs.writeFileSync(rel(p), u.text, { flag: 'wx' }); // wx: refuse to overwrite even under a race
    console.log(`user-data: seeded ${p}`);
  }
  summary();
}

main();
