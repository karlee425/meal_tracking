/*
 * build-reference.mjs — (re)builds the C1 frozen V1 reference. The ONLY writer of C1 files.
 *
 *   node tests/fixtures/v1/build-reference.mjs --write
 *
 * 1. Copies every file under INCLUDED_PATHS byte-for-byte from the local Git object database at
 *    FROZEN_COMMIT (never from the working tree) into tests/fixtures/v1-app/<same path>.
 * 2. Writes the two synthetic seed exceptions instead of their originals (no real Custom Foods,
 *    no real targets); their original blob IDs are kept in the manifest for traceability.
 * 3. Runs generate.mjs (the frozen app) and writes backup.json and store-record.json.
 * 4. Writes manifest.json.
 *
 * Needs local git with FROZEN_COMMIT present. No network. Re-running produces identical files.
 * Tests never run this script; they only read what it produced.
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const FROZEN_COMMIT = '936753bd4bb07ff9a5047cc60c6271a6165a487b';
export const INCLUDED_PATHS = ['src', 'data/schemas', 'data/foods', 'data/meals', 'data/targets.json', 'user-data'];
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const REFERENCE_ROOT = 'tests/fixtures/v1-app';
const FIXTURE_DIR = 'tests/fixtures/v1';

const json = (value) => `${JSON.stringify(value, null, 2)}\n`;

/** Synthetic replacements: clearly fictional, valid against the frozen V1 schemas. */
export const SYNTHETIC = {
  'user-data/custom-foods.json': {
    reason: 'The original seed holds Custom Foods migrated from the user\'s own app. Replaced with one fictional food so no real food data is duplicated into test fixtures.',
    content: [{
      id: 'food_custom_synthetic_test_bar',
      name: 'Synthetic Test Bar',
      source: 'custom',
      category: 'snack',
      brand: 'Synthetic Brand',
      state: 'prepared',
      nutrition: { basis: '100g', protein: 20, carbs: 40, fat: 10 },
      measurement: { canonicalUnit: 'g', servingSize: 100, servingUnit: 'g' },
      tags: ['synthetic'],
      aliases: ['synthetic test bar'],
      metadata: { editable: true, active: true, synthetic: true }
    }]
  },
  'data/targets.json': {
    reason: 'The original seed holds the user\'s actual daily targets. Replaced with fictional whole-number targets so real targets are not duplicated into test fixtures.',
    content: {
      lift: { protein: 105, carbs: 205, fat: 45 },
      long_run: { protein: 105, carbs: 255, fat: 45 },
      rest: { protein: 105, carbs: 155, fat: 45 }
    }
  }
};

/** Not frozen, on purpose (documented in the manifest and README). */
export const EXCLUDED = [
  { path: 'app/**', reason: 'V1 UI. Old-app UI behaviour is checked in the real-browser rehearsal, not by these fixtures.' },
  { path: 'data/reference/**', reason: 'Reference tables the V1 runtime never reads.' },
  { path: 'migration/**', reason: 'Prompt 1 migration tooling; not part of the V1 runtime.' },
  { path: 'tests/**', reason: 'V1 tests; the current suite already covers the V2 baseline.' },
  { path: 'legacy reference files and root documents', reason: 'Retired pre-V2 files and specifications; not loaded by the V1 runtime.' }
];

export const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
export const gitBlobId = (buf) => crypto.createHash('sha1').update(Buffer.concat([Buffer.from(`blob ${buf.length}\0`), buf])).digest('hex');
const git = (args, opts = {}) => execFileSync('git', ['-C', ROOT, ...args], { maxBuffer: 64 * 1024 * 1024, ...opts });

function frozenTree() {
  const out = git(['ls-tree', '-r', '-z', '--full-tree', FROZEN_COMMIT, '--', ...INCLUDED_PATHS]).toString('utf8');
  return out.split('\0').filter(Boolean).map((line) => {
    const [meta, file] = line.split('\t');
    const [mode, type, blob] = meta.split(' ');
    if (type !== 'blob' || mode !== '100644') throw new Error(`unexpected entry ${line}`);
    return { path: file, blob };
  }).sort((a, b) => (a.path < b.path ? -1 : 1));
}

function writeFile(rel, buf) {
  const abs = path.join(ROOT, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, buf);
}

async function main() {
  if (!process.argv.includes('--write')) {
    console.error('Refusing to write without --write. This script (re)creates the committed C1 reference files.');
    process.exit(2);
  }
  const frozen = [];
  const synthetic = [];
  for (const { path: rel, blob } of frozenTree()) {
    if (SYNTHETIC[rel]) {
      const buf = Buffer.from(json(SYNTHETIC[rel].content));
      writeFile(`${REFERENCE_ROOT}/${rel}`, buf);
      synthetic.push({ path: rel, originalGitBlob: blob, gitBlob: gitBlobId(buf), sha256: sha256(buf), bytes: buf.length, reason: SYNTHETIC[rel].reason });
      continue;
    }
    const buf = git(['cat-file', 'blob', blob]);
    if (gitBlobId(buf) !== blob) throw new Error(`blob mismatch for ${rel}`);
    writeFile(`${REFERENCE_ROOT}/${rel}`, buf);
    frozen.push({ path: rel, gitBlob: blob, sha256: sha256(buf), bytes: buf.length });
  }
  for (const rel of Object.keys(SYNTHETIC)) if (!synthetic.some((s) => s.path === rel)) throw new Error(`${rel} is not in the frozen tree`);

  const { buildV1Fixture } = await import('./generate.mjs');
  const { backup, storeRecord } = await buildV1Fixture();
  const fixtures = [];
  for (const [name, kind, value] of [['backup.json', 'v1-backup', backup], ['store-record.json', 'v1-store-record', storeRecord]]) {
    const buf = Buffer.from(json(value));
    writeFile(`${FIXTURE_DIR}/${name}`, buf);
    fixtures.push({ path: `${FIXTURE_DIR}/${name}`, kind, sha256: sha256(buf), bytes: buf.length });
  }

  const manifest = {
    format: 'v1-frozen-reference-manifest',
    manifestVersion: 1,
    frozenCommit: FROZEN_COMMIT,
    referenceRoot: REFERENCE_ROOT,
    includedPaths: INCLUDED_PATHS,
    description: 'Files under referenceRoot are byte copies of frozenCommit (paths as in that commit), except the syntheticExceptions, which are fictional replacements. fixtures were generated by driving that frozen app with generate.mjs. All user data here is synthetic.',
    frozen,
    syntheticExceptions: synthetic,
    fixtures,
    excluded: EXCLUDED
  };
  writeFile(`${FIXTURE_DIR}/manifest.json`, Buffer.from(json(manifest)));
  console.log(`frozen ${frozen.length} · synthetic ${synthetic.length} · fixtures ${fixtures.length} · manifest written`);
}

// Run only when invoked directly, so importing this module never writes anything.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
