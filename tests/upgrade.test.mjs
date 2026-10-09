/*
 * upgrade.test.mjs — V3 Slice 1 · C2: the user-data format version and the V1 → V2 upgrade chain.
 *
 * Covers the pure domain step only (src/domain/upgrade.js). Nothing here touches storage,
 * IndexedDB, archives or servings; the C1 synthetic fixture is read, never written.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { ROOT, stripComments, FORBIDDEN_NUTRITION, scanLegacy, LEGACY_CODE_PATTERNS, macroArithmeticInSource } from './helpers.mjs';
import {
  DomainError, createDataLayer, createMemoryAdapter, USER_COLLECTIONS,
  USER_DATA_FORMAT_VERSION, USER_DATA_COLLECTIONS, upgradeUserData
} from '../src/domain/index.js';
import { makeSchemaValidator } from '../src/domain/schema-validator.js';
import { WRITABLE_COLLECTIONS } from '../src/domain/store.js';
import { USER_COLLECTION_NAMES } from '../src/browser/browser-adapter.js';
import { createFileAdapter } from '../src/node/file-adapter.js';

const FIXTURE_DIR = path.join(ROOT, 'tests', 'fixtures', 'v1');
const readFixture = (name) => JSON.parse(fs.readFileSync(path.join(FIXTURE_DIR, name), 'utf8'));
const V1_BACKUP = readFixture('backup.json');
const V1_STORE = readFixture('store-record.json');
const V1_SOURCES = [['backup.json', V1_BACKUP.data], ['store-record.json', V1_STORE.data]];
const SEED = createFileAdapter(ROOT).load(); // read-only: canonical data
const V1_KEYS = ['targets', 'customFoods', 'savedMeals', 'days', 'preferences'];
const V2_KEYS = [...V1_KEYS, 'userFoodData'];
const EMPTY_USER_FOOD_DATA = { foods: [], retiredServingIds: [] };

const throwsCode = (fn, code) => assert.throws(fn, (e) => e instanceof DomainError && e.code === code, `expected DomainError ${code}`);
const fresh = (v) => JSON.parse(JSON.stringify(v));

function deepFreeze(v) {
  if (v !== null && typeof v === 'object' && !Object.isFrozen(v)) {
    Object.freeze(v);
    for (const k of Object.keys(v)) deepFreeze(v[k]);
  }
  return v;
}

function objectsIn(v, out = new Set()) {
  if (v !== null && typeof v === 'object') {
    out.add(v);
    for (const k of Object.keys(v)) objectsIn(v[k], out);
  }
  return out;
}

function makeLayer() {
  let t = Date.parse('2026-09-24T12:00:00Z');
  let n = 0;
  return createDataLayer({ adapter: createMemoryAdapter(SEED), today: () => '2026-09-24', clock: () => new Date((t += 60000)), newId: () => `t${String(++n).padStart(4, '0')}` });
}

test('C2 — the current user-data format is version 2 and each version declares its collections', () => {
  assert.equal(USER_DATA_FORMAT_VERSION, 2);
  assert.deepEqual([...USER_DATA_COLLECTIONS[1]], V1_KEYS);
  assert.deepEqual([...USER_DATA_COLLECTIONS[2]], V2_KEYS);
  assert.deepEqual(Object.keys(USER_DATA_COLLECTIONS), ['1', '2'], 'one entry per supported version, no gaps');
  assert.deepEqual([...USER_DATA_COLLECTIONS[1]], [...USER_COLLECTIONS], 'version 1 is exactly the collections the current backup carries');
  assert.deepEqual([...USER_DATA_COLLECTIONS[1]], [...WRITABLE_COLLECTIONS], 'version 1 is exactly the store\'s writable collections, in the same order');
  assert.deepEqual([...USER_DATA_COLLECTIONS[1]], [...USER_COLLECTION_NAMES], 'version 1 is exactly what the browser store record holds');
  assert.deepEqual(Object.keys(V1_BACKUP.data), V1_KEYS, 'the C1 backup fixture holds the version 1 collections');
  assert.deepEqual(Object.keys(V1_STORE.data), V1_KEYS, 'the C1 store-record fixture holds the version 1 collections');
  assert.ok(Object.isFrozen(USER_DATA_COLLECTIONS) && Object.isFrozen(USER_DATA_COLLECTIONS[1]) && Object.isFrozen(USER_DATA_COLLECTIONS[2]));
});

test('C2 — every supported version upgrades to the current version through the chain', () => {
  for (let v = 1; v <= USER_DATA_FORMAT_VERSION; v += 1) {
    const input = v === 1 ? fresh(V1_BACKUP.data) : { ...fresh(V1_BACKUP.data), userFoodData: fresh(EMPTY_USER_FOOD_DATA) };
    const out = upgradeUserData(input, v);
    assert.deepEqual(Object.keys(out), V2_KEYS, `from version ${v}`);
  }
});

test('C2 — V1 → V2 on the C1 fixture: canonical order, the five collections carried over exactly, userFoodData added empty', () => {
  for (const [name, data] of V1_SOURCES) {
    const out = upgradeUserData(data, 1);
    assert.deepEqual(Object.keys(out), V2_KEYS, name);
    for (const c of V1_KEYS) {
      assert.deepEqual(out[c], data[c], `${name}: ${c}`);
      assert.equal(JSON.stringify(out[c]), JSON.stringify(data[c]), `${name}: ${c} is byte-identical, nested key order included`);
    }
    assert.deepEqual(out.userFoodData, EMPTY_USER_FOOD_DATA, name);
    assert.deepEqual(Object.keys(out.userFoodData), ['foods', 'retiredServingIds'], name);
  }
});

test('C2 — targets, preferences and every meal-instance snapshot survive the upgrade', () => {
  const data = V1_BACKUP.data;
  const out = upgradeUserData(data, 1);
  assert.deepEqual(out.targets, data.targets);
  assert.deepEqual(out.preferences, data.preferences);
  assert.equal(out.customFoods.length, data.customFoods.length);
  assert.equal(out.savedMeals.length, data.savedMeals.length);
  assert.equal(out.days.length, data.days.length);
  const instances = (d) => d.days.flatMap((day) => day.mealInstances.map((mi) => [day.date, mi]));
  const before = instances(data);
  const after = instances(out);
  assert.ok(before.length > 0, 'the fixture holds meal instances');
  assert.equal(after.length, before.length);
  before.forEach(([date, mi], i) => {
    assert.equal(after[i][0], date);
    assert.deepEqual(after[i][1], mi, `meal instance ${i} on ${date} is unchanged, snapshot included`);
  });
  assert.equal(FORBIDDEN_NUTRITION.test(JSON.stringify(out)), false, 'no forbidden nutrition terms appear in the output');
});

test('C2 — the upgrade is deterministic: same output on repeat calls and whatever the input key order', () => {
  const a = JSON.stringify(upgradeUserData(V1_BACKUP.data, 1));
  for (let i = 0; i < 5; i += 1) assert.equal(JSON.stringify(upgradeUserData(V1_BACKUP.data, 1)), a);
  const reordered = Object.fromEntries([...V1_KEYS].reverse().map((c) => [c, fresh(V1_BACKUP.data[c])]));
  assert.deepEqual(Object.keys(reordered), [...V1_KEYS].reverse());
  assert.equal(JSON.stringify(upgradeUserData(reordered, 1)), a, 'top-level order is canonical, not inherited');
  assert.equal(JSON.stringify(upgradeUserData(V1_STORE.data, 1)), a, 'the store record and the backup hold the same data, so they upgrade identically');
});

test('C2 — the upgrade never changes its input and returns a fully independent copy', () => {
  const input = deepFreeze(fresh(V1_BACKUP.data));
  const snapshot = JSON.stringify(input);
  const out = upgradeUserData(input, 1); // a frozen input would throw on any write attempt
  assert.equal(JSON.stringify(input), snapshot);
  assert.equal('userFoodData' in input, false);
  const inputObjects = objectsIn(input);
  const shared = [...objectsIn(out)].filter((o) => inputObjects.has(o));
  assert.deepEqual(shared, [], 'the output shares no object or array with the input');
  out.targets.lift.protein = 1;
  out.days[0].mealInstances.length = 0;
  assert.equal(JSON.stringify(input), snapshot, 'changing the output cannot reach the input');
});

test('C2 — version 2 input is checked and returned as an equal copy; upgrading the result again is idempotent', () => {
  const v2 = upgradeUserData(V1_BACKUP.data, 1);
  const again = upgradeUserData(deepFreeze(fresh(v2)), 2);
  assert.deepEqual(again, v2);
  assert.equal(JSON.stringify(again), JSON.stringify(v2));
  assert.notEqual(again, v2);
  // Deliberately opaque entries: C2 checks only the userFoodData container; what a food entry
  // holds is validated by the C3 schema, so nothing here models or endorses a serving shape.
  const populated = { ...fresh(v2), userFoodData: { foods: [{ opaque: 'entry' }, 'any JSON value'], retiredServingIds: ['opaque_id'] } };
  assert.deepEqual(upgradeUserData(populated, 2).userFoodData, populated.userFoodData, 'userFoodData contents are carried through untouched (only its container shape is checked here)');
});

test('C2 — unsupported versions are rejected with USER_DATA_VERSION_UNSUPPORTED and the input is untouched', () => {
  for (const v of [0, -1, 3, 99, '1', '2', 1.5, null, undefined, NaN, Infinity, true, [1], { v: 1 }]) {
    const input = deepFreeze(fresh(V1_BACKUP.data));
    const snapshot = JSON.stringify(input);
    throwsCode(() => upgradeUserData(input, v), 'USER_DATA_VERSION_UNSUPPORTED');
    assert.equal(JSON.stringify(input), snapshot, `version ${String(v)}`);
  }
  throwsCode(() => upgradeUserData(V1_BACKUP.data), 'USER_DATA_VERSION_UNSUPPORTED');
});

test('C2 — malformed user data is rejected with USER_DATA_INVALID, with details, and the input is untouched', () => {
  const base = () => fresh(V1_BACKUP.data);
  const v2base = () => ({ ...base(), userFoodData: fresh(EMPTY_USER_FOOD_DATA) });
  const without = (k) => { const d = base(); delete d[k]; return d; };
  const sparse = () => { const d = base(); const arr = [d.customFoods[0]]; arr[2] = d.customFoods[1]; d.customFoods = arr; return d; };
  const cases = [
    ['null', 1, () => null],
    ['an array', 1, () => [base()]],
    ['a string', 1, () => JSON.stringify(base())],
    ['a class instance', 1, () => Object.assign(new (class X {})(), base())],
    ...V1_KEYS.map((k) => [`missing ${k}`, 1, () => without(k)]),
    ['an unexpected collection', 1, () => ({ ...base(), extra: [] })],
    ['userFoodData declared as version 1', 1, () => v2base()],
    ['targets as an array', 1, () => ({ ...base(), targets: [] })],
    ['customFoods as an object', 1, () => ({ ...base(), customFoods: {} })],
    ['savedMeals as null', 1, () => ({ ...base(), savedMeals: null })],
    ['days as a string', 1, () => ({ ...base(), days: 'days' })],
    ['preferences as an array', 1, () => ({ ...base(), preferences: [] })],
    ['nested NaN', 1, () => { const d = base(); d.targets.lift.protein = NaN; return d; }],
    ['nested Infinity', 1, () => { const d = base(); d.days[0].mealInstances[0].quantity = Infinity; return d; }],
    ['nested -Infinity', 1, () => { const d = base(); d.customFoods[0].nutrition.carbs = -Infinity; return d; }],
    ['nested undefined', 1, () => { const d = base(); d.preferences.appPreferences = undefined; return d; }],
    ['a nested function', 1, () => { const d = base(); d.savedMeals[0].name = () => 'x'; return d; }],
    ['a nested Date', 1, () => { const d = base(); d.days[0].updatedAt = new Date(0); return d; }],
    ['a nested Map', 1, () => { const d = base(); d.preferences.mealPreferences = new Map(); return d; }],
    ['a sparse array', 1, () => sparse()],
    ['missing userFoodData', 2, () => base()],
    ['userFoodData as an array', 2, () => ({ ...base(), userFoodData: [] })],
    ['userFoodData.foods missing', 2, () => ({ ...base(), userFoodData: { retiredServingIds: [] } })],
    ['userFoodData.retiredServingIds missing', 2, () => ({ ...base(), userFoodData: { foods: [] } })],
    ['userFoodData.foods as an object', 2, () => ({ ...base(), userFoodData: { foods: {}, retiredServingIds: [] } })],
    ['userFoodData with an extra field', 2, () => ({ ...base(), userFoodData: { foods: [], retiredServingIds: [], extra: 1 } })],
    ['NaN inside userFoodData', 2, () => ({ ...base(), userFoodData: { foods: [{ grams: NaN }], retiredServingIds: [] } })]
  ];
  for (const [what, version, make] of cases) {
    const input = make();
    const before = typeof input === 'object' && input !== null ? deepFreeze(input) : input;
    const clone = structuredCloneOrSame(before);
    assert.throws(() => upgradeUserData(before, version), (e) => {
      assert.ok(e instanceof DomainError, `${what}: a DomainError`);
      assert.equal(e.code, 'USER_DATA_INVALID', `${what}: code`);
      assert.ok(Array.isArray(e.details) && e.details.length > 0 && e.details.every((s) => typeof s === 'string'), `${what}: details list the problems`);
      return true;
    }, what);
    if (clone !== NO_CLONE) assert.ok(isDeepStrictEqual(structuredCloneOrSame(before), clone), `${what}: input unchanged`);
  }
});

const NO_CLONE = Symbol('no clone');
function structuredCloneOrSame(v) {
  // Compared clone-to-clone, so a class prototype dropped by cloning does not count as a change.
  // Functions cannot be cloned; for those cases the frozen input is the guard.
  try { return structuredClone(v); } catch { return NO_CLONE; }
}

test('C2 — the data carries no version of its own: an envelope or an embedded version field is rejected, never reconciled', () => {
  for (const [what, version, input] of [
    ['the whole C1 backup document', 1, V1_BACKUP],
    ['the whole C1 store record', 1, V1_STORE],
    ['data with formatVersion 2 declared as version 1', 1, { ...fresh(V1_BACKUP.data), formatVersion: 2 }],
    ['data with version 1 declared as version 2', 2, { ...fresh(V1_BACKUP.data), userFoodData: fresh(EMPTY_USER_FOOD_DATA), version: 1 }]
  ]) {
    const frozen = deepFreeze(fresh(input));
    assert.throws(() => upgradeUserData(frozen, version), (e) => e instanceof DomainError && e.code === 'USER_DATA_INVALID' && e.details.some((d) => /unexpected collection/.test(d)), what);
  }
});

test('C2 — error details are useful but bounded, and the message names the first problems', () => {
  const manyKeys = { ...fresh(V1_BACKUP.data), ...Object.fromEntries(Array.from({ length: 500 }, (_, i) => [`extra${i}`, i])) };
  const manyBadNumbers = { ...fresh(V1_BACKUP.data), customFoods: Array.from({ length: 500 }, () => ({ n: NaN })) };
  for (const input of [manyKeys, manyBadNumbers]) {
    assert.throws(() => upgradeUserData(input, 1), (e) => {
      assert.equal(e.code, 'USER_DATA_INVALID');
      assert.ok(e.details.length > 0 && e.details.length <= 20, `details capped (got ${e.details.length})`);
      assert.ok(e.message.includes(e.details[0]), 'the message carries the first problem');
      return true;
    });
  }
  assert.throws(() => upgradeUserData(V1_BACKUP.data, 3), (e) => e.code === 'USER_DATA_VERSION_UNSUPPORTED' && /version 3/.test(e.message) && e.details === undefined);
});

test('C2 — failures leave no external trace: no globals added, and repeated failures do not affect a later success', () => {
  const globalsBefore = Object.getOwnPropertyNames(globalThis).sort();
  for (let i = 0; i < 3; i += 1) {
    throwsCode(() => upgradeUserData({ ...fresh(V1_BACKUP.data), extra: 1 }, 1), 'USER_DATA_INVALID');
    throwsCode(() => upgradeUserData(fresh(V1_BACKUP.data), 7), 'USER_DATA_VERSION_UNSUPPORTED');
  }
  assert.deepEqual(Object.getOwnPropertyNames(globalThis).sort(), globalsBefore);
  assert.equal(JSON.stringify(upgradeUserData(V1_BACKUP.data, 1)), JSON.stringify(upgradeUserData(fresh(V1_BACKUP.data), 1)));
});

test('C2 — the upgraded collections validate against the current schemas and pass the current backup checks', () => {
  const out = upgradeUserData(V1_BACKUP.data, 1);
  const validate = makeSchemaValidator(SEED.schemas);
  assert.deepEqual(validate(out.targets, 'targets.schema.json', 'targets'), []);
  assert.deepEqual(validate(out.preferences, 'preferences.schema.json', 'preferences'), []);
  out.customFoods.forEach((f, i) => assert.deepEqual(validate(f, 'food.schema.json', `customFoods[${i}]`), []));
  out.savedMeals.forEach((m, i) => assert.deepEqual(validate(m, 'meal.schema.json', `savedMeals[${i}]`), []));
  out.days.forEach((d, i) => assert.deepEqual(validate(d, 'day.schema.json', `days[${i}]`), []));
  // The full store check (schemas plus cross-references) through the current data layer, in memory only.
  const data = Object.fromEntries(V1_KEYS.map((c) => [c, out[c]]));
  const result = makeLayer().validateBackup({ format: V1_BACKUP.format, formatVersion: V1_BACKUP.formatVersion, exportedAt: V1_BACKUP.exportedAt, data });
  assert.equal(result.valid, true, result.errors.join('; '));
  // userFoodData has no schema file yet; its container shape is checked by upgradeUserData itself.
  assert.deepEqual(upgradeUserData(out, 2).userFoodData, EMPTY_USER_FOOD_DATA);
});

test('C2 — upgrade.js is pure: no I/O, clock, randomness or platform storage; no legacy identifiers or macro arithmetic', () => {
  const file = path.join(ROOT, 'src', 'domain', 'upgrade.js');
  const src = fs.readFileSync(file, 'utf8');
  const code = stripComments(src);
  for (const banned of [/\bimport\s*\(/, /from\s+['"]node:/, /\bfs\b/, /\bfetch\b/, /indexedDB/, /localStorage/, /sessionStorage/, /\bDate\b/, /Math\.random/, /\bcrypto\b/, /\bprocess\b/, /performance\.now/]) {
    assert.equal(banned.test(code), false, `upgrade.js must not use ${banned}`);
  }
  const imports = [...code.matchAll(/from\s+['"]([^'"]+)['"]/g)].map((m) => m[1]);
  assert.deepEqual(imports, ['./util.js'], 'upgrade.js imports only the domain util');
  assert.deepEqual(scanLegacy(['src/domain/upgrade.js'], LEGACY_CODE_PATTERNS), []);
  assert.deepEqual(macroArithmeticInSource(src, 'src/domain/upgrade.js'), []);
  assert.equal(FORBIDDEN_NUTRITION.test(src), false);
});
