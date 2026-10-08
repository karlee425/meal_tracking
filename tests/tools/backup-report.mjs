#!/usr/bin/env node
/*
 * backup-report.mjs — read-only checker for the C1 frozen V1 reference and for V1-format
 * backups / store records.
 *
 *   node tests/tools/backup-report.mjs [verify] [--root <dir>] [--git]
 *       Checks tests/fixtures/v1/manifest.json against the files under <dir> (default: this
 *       repository): every frozen file's SHA-256 and Git blob ID, the two synthetic exceptions'
 *       pinned hashes (and that they differ from the originals), that the reference directory
 *       holds exactly the manifest's files, and the generated fixtures' hashes and shape.
 *       --git also checks each pinned blob ID against the frozen commit in the local Git object
 *       database (git rev-parse / ls-tree only; no network).
 *
 *   node tests/tools/backup-report.mjs report <file>
 *       Counts and SHA-256 hashes for one V1 backup or V1 store record. A file inside this
 *       repository is refused unless it is one of the manifest's synthetic fixtures, so real
 *       backups are kept out of the public repository.
 *
 * Never writes, repairs or deletes anything and never uses the network. Output is counts,
 * dates and hashes only: no food, meal or ingredient names and no nutrition or target values.
 * Exit codes: 0 OK · 1 integrity or format failure · 2 usage / refused input.
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const MANIFEST_REL = 'tests/fixtures/v1/manifest.json';
const BACKUP_FORMAT = 'macro-tracker-v2-backup';
const STORE_FORMAT = 'macro-tracker-v2-store';
const COLLECTIONS = ['targets', 'customFoods', 'savedMeals', 'days', 'preferences'];

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const gitBlobId = (buf) => crypto.createHash('sha1').update(Buffer.concat([Buffer.from(`blob ${buf.length}\0`), buf])).digest('hex');
/** JSON with object keys sorted at every level, so equal data always hashes the same. */
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
  return JSON.stringify(value);
}
const hashOf = (value) => sha256(Buffer.from(canonical(value)));

function listFiles(dir, base = dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...listFiles(p, base));
    else out.push(path.relative(base, p).split(path.sep).join('/'));
  }
  return out.sort();
}

/** The user data inside a V1 backup or V1 store record, or a list of problems. */
export function v1DataOf(doc) {
  const problems = [];
  if (!doc || typeof doc !== 'object') return { problems: ['not a JSON object'] };
  let kind;
  if (doc.format === BACKUP_FORMAT) {
    kind = 'v1-backup';
    if (doc.formatVersion !== 1) problems.push(`backup formatVersion is ${JSON.stringify(doc.formatVersion)}, expected 1`);
  } else if (doc.format === STORE_FORMAT) {
    kind = 'v1-store-record';
    if (doc.version !== 1) problems.push(`store record version is ${JSON.stringify(doc.version)}, expected 1`);
  } else {
    return { problems: [`unrecognised format ${JSON.stringify(doc.format)}`] };
  }
  const data = doc.data;
  if (!data || typeof data !== 'object' || Array.isArray(data)) problems.push('data is missing');
  else {
    const keys = Object.keys(data).sort();
    if (canonical(keys) !== canonical([...COLLECTIONS].sort())) problems.push(`data holds ${keys.join(', ')}; expected exactly ${COLLECTIONS.join(', ')}`);
  }
  return { kind, data, problems };
}

/** Counts and hashes only. Nothing here may print a name or a nutrition/target value. */
export function summarize(doc) {
  const { kind, data, problems } = v1DataOf(doc);
  if (problems.length) return { ok: false, problems };
  const days = data.days;
  const instances = days.flatMap((d) => d.mealInstances);
  const byType = {};
  for (const d of days) byType[d.dayType] = (byType[d.dayType] || 0) + 1;
  return {
    ok: true,
    kind,
    stamp: kind === 'v1-backup' ? `exportedAt ${doc.exportedAt}` : `revision ${doc.revision} · savedAt ${doc.savedAt}`,
    counts: {
      days: days.length,
      daysByType: byType,
      daysDone: days.filter((d) => d.loggingComplete).length,
      daysWithPriorTargets: days.filter((d) => d.priorTargetSnapshots && Object.keys(d.priorTargetSnapshots).length).length,
      loggedMeals: instances.length,
      loggedMealsFromAMeal: instances.filter((i) => i.sourceMealId).length,
      savedMeals: data.savedMeals.length,
      savedMealsNeedingReplacement: data.savedMeals.filter((m) => m.metadata && m.metadata.unresolvedFoods && Object.keys(m.metadata.unresolvedFoods).length).length,
      customFoods: data.customFoods.length,
      favoriteFoods: data.preferences.favoriteFoods.length,
      favoriteMeals: data.preferences.favoriteMeals.length,
      dislikedFoods: data.preferences.dislikedFoods.length
    },
    collectionHashes: Object.fromEntries(COLLECTIONS.map((c) => [c, hashOf(data[c])])),
    dataHash: hashOf(data),
    dayHashes: Object.fromEntries(days.map((d) => [d.date, hashOf(d)]))
  };
}

function printSummary(label, s) {
  console.log(`${label}: ${s.kind} · ${s.stamp}`);
  const c = s.counts;
  console.log(`  days ${c.days} (${Object.entries(c.daysByType).sort().map(([k, v]) => `${k} ${v}`).join(', ')}) · done ${c.daysDone} · with prior targets ${c.daysWithPriorTargets}`);
  console.log(`  logged meals ${c.loggedMeals} (from a meal ${c.loggedMealsFromAMeal}) · saved meals ${c.savedMeals} (needing replacement ${c.savedMealsNeedingReplacement}) · custom foods ${c.customFoods}`);
  console.log(`  favourites: foods ${c.favoriteFoods}, meals ${c.favoriteMeals} · not suggested ${c.dislikedFoods}`);
  for (const [k, v] of Object.entries(s.collectionHashes)) console.log(`  sha256 ${k.padEnd(11)} ${v}`);
  console.log(`  sha256 data        ${s.dataHash}`);
  for (const [k, v] of Object.entries(s.dayHashes)) console.log(`  sha256 day ${k} ${v}`);
}

function verify(root, { useGit }) {
  const failures = [];
  const fail = (msg) => failures.push(msg);
  let manifest;
  try { manifest = JSON.parse(fs.readFileSync(path.join(root, MANIFEST_REL), 'utf8')); } catch (e) {
    console.log(`FAIL manifest unreadable: ${MANIFEST_REL} (${e.code || e.name})`);
    return 1;
  }
  if (manifest.format !== 'v1-frozen-reference-manifest' || manifest.manifestVersion !== 1) fail('manifest format/version not recognised');
  if (!/^[0-9a-f]{40}$/.test(manifest.frozenCommit || '')) fail('manifest frozenCommit is not a full commit hash');
  const refRoot = path.join(root, manifest.referenceRoot || '');
  const entries = [...(manifest.frozen || []).map((e) => ({ ...e, kind: 'frozen' })), ...(manifest.syntheticExceptions || []).map((e) => ({ ...e, kind: 'synthetic' }))];
  const listed = entries.map((e) => e.path);
  if (new Set(listed).size !== listed.length) fail('a reference path is listed more than once');

  let present = [];
  try { present = listFiles(refRoot); } catch { fail(`reference directory missing: ${manifest.referenceRoot}`); }
  for (const p of present) if (!listed.includes(p)) fail(`unexpected file in reference: ${p}`);

  for (const e of entries) {
    const abs = path.join(refRoot, e.path);
    if (!fs.existsSync(abs)) { fail(`missing ${e.kind} file: ${e.path}`); continue; }
    const buf = fs.readFileSync(abs);
    if (sha256(buf) !== e.sha256) fail(`${e.kind} file changed (sha256): ${e.path}`);
    if (gitBlobId(buf) !== e.gitBlob) fail(`${e.kind} file changed (git blob): ${e.path}`);
    if (e.kind === 'synthetic' && e.gitBlob === e.originalGitBlob) fail(`synthetic exception is identical to the original: ${e.path}`);
  }

  if (useGit) {
    const git = (args) => execFileSync('git', ['-C', root, ...args], { stdio: ['ignore', 'pipe', 'ignore'] }).toString('utf8');
    try {
      const tree = git(['ls-tree', '-r', '--name-only', '--full-tree', manifest.frozenCommit, '--', ...manifest.includedPaths]).split('\n').filter(Boolean).sort();
      if (canonical(tree) !== canonical([...listed].sort())) fail('manifest file list differs from the frozen commit\'s files under includedPaths');
      for (const e of entries) {
        const blob = git(['rev-parse', '--verify', '--quiet', `${manifest.frozenCommit}:${e.path}`]).trim();
        const expected = e.kind === 'frozen' ? e.gitBlob : e.originalGitBlob;
        if (blob !== expected) fail(`pinned blob differs from the frozen commit: ${e.path}`);
      }
    } catch {
      fail(`git check failed: frozen commit ${manifest.frozenCommit} is not available in the local repository`);
    }
  }

  const summaries = [];
  for (const f of manifest.fixtures || []) {
    const abs = path.join(root, f.path);
    if (!fs.existsSync(abs)) { fail(`missing fixture: ${f.path}`); continue; }
    const buf = fs.readFileSync(abs);
    if (sha256(buf) !== f.sha256) fail(`fixture changed (sha256): ${f.path}`);
    let doc;
    try { doc = JSON.parse(buf.toString('utf8')); } catch { fail(`fixture is not valid JSON: ${f.path}`); continue; }
    const s = summarize(doc);
    if (!s.ok) { for (const p of s.problems) fail(`fixture ${f.path}: ${p}`); continue; }
    if (s.kind !== f.kind) fail(`fixture ${f.path} is a ${s.kind}, manifest says ${f.kind}`);
    summaries.push([f.path, s]);
  }
  const dataHashes = new Set(summaries.map(([, s]) => s.dataHash));
  if (summaries.length > 1 && dataHashes.size !== 1) fail('the fixtures do not hold the same user data');

  console.log(`V1 frozen reference · commit ${manifest.frozenCommit}`);
  console.log(`  frozen files ${(manifest.frozen || []).length} · synthetic exceptions ${(manifest.syntheticExceptions || []).length} · fixtures ${(manifest.fixtures || []).length}${useGit ? ' · git cross-check on' : ''}`);
  for (const [p, s] of summaries) printSummary(p, s);
  if (failures.length) {
    for (const f of failures) console.log(`FAIL ${f}`);
    console.log(`RESULT: FAIL (${failures.length} problem${failures.length === 1 ? '' : 's'})`);
    return 1;
  }
  console.log('RESULT: OK');
  return 0;
}

function report(file) {
  const abs = path.resolve(file);
  const rel = path.relative(REPO_ROOT, abs);
  const insideRepo = rel && !rel.startsWith('..') && !path.isAbsolute(rel);
  if (insideRepo) {
    let allowed = [];
    try { allowed = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, MANIFEST_REL), 'utf8')).fixtures.map((f) => f.path); } catch { /* none */ }
    if (!allowed.includes(rel.split(path.sep).join('/'))) {
      console.log('REFUSED: this file is inside the repository and is not a synthetic C1 fixture. Keep real backups outside the repository.');
      return 2;
    }
  }
  let doc;
  try { doc = JSON.parse(fs.readFileSync(abs, 'utf8')); } catch (e) {
    console.log(`FAIL unreadable JSON (${e.code || e.name})`);
    return 1;
  }
  const s = summarize(doc);
  if (!s.ok) { for (const p of s.problems) console.log(`FAIL ${p}`); return 1; }
  printSummary(path.basename(abs), s);
  return 0;
}

function main(argv) {
  const args = argv.slice(2);
  const mode = args[0] && !args[0].startsWith('--') ? args.shift() : 'verify';
  if (mode === 'verify') {
    let root = REPO_ROOT;
    let useGit = false;
    for (let i = 0; i < args.length; i += 1) {
      if (args[i] === '--git') useGit = true;
      else if (args[i] === '--root' && args[i + 1]) root = path.resolve(args[(i += 1)]);
      else { console.log(`usage: unknown option ${args[i]}`); return 2; }
    }
    return verify(root, { useGit });
  }
  if (mode === 'report' && args.length === 1) return report(args[0]);
  console.log('usage: backup-report.mjs [verify] [--root <dir>] [--git] | report <file>');
  return 2;
}

// Run only when invoked directly; importing this module has no side effects.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = main(process.argv);
