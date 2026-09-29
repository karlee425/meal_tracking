/*
 * progress.test.mjs — V2 UI Slice 5: the Progress screen (V2_UI_CONTRACT.md §9).
 * Pure renderers over the domain's getProgress result; the DOM wiring is exercised in a real
 * browser (see the slice report).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, macroArithmeticInSource, FORBIDDEN_NUTRITION, domainImportsBypassingIndex } from './helpers.mjs';
import { createDataLayer, createMemoryAdapter, macros } from '../src/domain/index.js';
import { createFileAdapter } from '../src/node/file-adapter.js';
import { formatDate } from '../app/today.js';
import { resetSession, session } from '../app/session.js';
import {
  PROGRESS_PERIODS, STATUS_LABELS, progressPeriod, progressMacro, progressModel, dayTypeMix, loggedDayCount,
  renderProgress, renderProgressTop, renderCoverage, renderAverages, renderReached, renderTrend, renderDayList,
  renderNothingLogged, progressScreen
} from '../app/progress.js';

const TODAY = '2026-09-27';
const SEED = createFileAdapter(ROOT).load();
const ago = (n) => { const d = new Date(Date.UTC(2026, 8, 27 - n)); return d.toISOString().slice(0, 10); };

function setup() {
  resetSession();
  const inner = createMemoryAdapter(SEED);
  const writes = [];
  const adapter = { load: () => inner.load(), save: (c, d) => inner.save(c, d), saveMany: (ch) => { writes.push(Object.keys(ch)); inner.saveMany(ch); } };
  let t = Date.parse(`${TODAY}T12:00:00Z`);
  const app = createDataLayer({ adapter, today: () => TODAY, clock: () => new Date((t += 60000)) });
  return { app, writes };
}
const text = (html) => html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ');
const whole = (x) => macros.roundMacros(x, 0);
function logDay(app, date, type, items, done) {
  app.createDay(date, type);
  for (const [slot, foodId, q] of items) app.logFood({ date, mealSlot: slot, foodId, quantity: q });
  if (done) app.setDayLoggingComplete(date, true);
}
/** Four logged days in the last 7 (3 Done, 1 not marked done), one Day with nothing logged, two older days. */
function history(app) {
  logDay(app, ago(1), 'lift', [['breakfast', 'food_core_fage_0_greek_yogurt', 700], ['lunch', 'food_core_banana', 300]], true);
  logDay(app, ago(2), 'rest', [['lunch', 'food_core_banana', 200]], false);
  logDay(app, ago(3), 'long_run', [['dinner', 'food_core_fage_0_greek_yogurt', 1800], ['lunch', 'food_core_rolled_oats_dry', 350]], true);
  app.createDay(ago(4), 'rest'); // a Day with nothing logged: "Nothing logged", never zero
  logDay(app, ago(5), 'lift', [['breakfast', 'food_core_rolled_oats_dry', 200]], true);
  logDay(app, ago(9), 'rest', [['lunch', 'food_core_banana', 150]], true);
  logDay(app, ago(20), 'lift', [['lunch', 'food_core_banana', 100]], false);
}
/** Words Progress never shows (§9.4). */
const JUDGMENT = /\b(score|grade|compliance|adherence|missed|failed|failure|fail|good day|bad day|success|streak|best|worst|rank|excess|should)\b/i;

/* ---------------- route and periods ---------------- */

test('Progress — the route is built and registered with the shell', () => {
  const main = fs.readFileSync(path.join(ROOT, 'app/main.js'), 'utf8');
  assert.match(main, /import \{ progressScreen \} from '\.\/progress\.js';/);
  assert.match(main, /progress: progressScreen/);
  assert.equal(typeof progressScreen.mount, 'function');
  const { app } = setup();
  const html = renderProgressTop(progressModel(app, { period: 7 }), { period: 7 });
  assert.match(html, /<h1 id="screen-title"[^>]*>Progress<\/h1>/);
  assert.match(html, /Based on logged meals\. Days with nothing logged aren’t counted as zero\./, 'basis line always visible');
});

test('Progress — 7 / 14 / 30 days ending today, straight from getProgress; 7 by default, remembered', () => {
  const { app } = setup();
  assert.deepEqual([...PROGRESS_PERIODS], [7, 14, 30]);
  assert.equal(progressPeriod({ period: null }), 7);
  assert.equal(progressPeriod({ period: 30 }), 30);
  assert.equal(progressPeriod({ period: 5 }), 7, 'only the three periods');
  assert.equal(progressMacro({}), 'protein');
  assert.deepEqual(session.progress, { period: null, macro: null, endDate: null, custom: null });
  for (const period of PROGRESS_PERIODS) {
    const p = progressModel(app, { period });
    assert.deepEqual(p, app.getProgress({ period, endDate: TODAY }), 'the domain result, unchanged');
    assert.equal(p.period.endDate, TODAY);
    assert.equal(p.daily.length, period);
    const top = renderProgressTop(p, { period });
    assert.match(top, new RegExp(`data-period="${period}" aria-pressed="true">${period} days`));
    assert.equal((top.match(/aria-pressed="true"/g) || []).length, 1, 'one selected period');
    assert.match(top, new RegExp(`Last ${period} days · ${formatDate(p.period.startDate)} – ${formatDate(TODAY)}`));
  }
  const src = fs.readFileSync(path.join(ROOT, 'app/progress.js'), 'utf8');
  // G12: ◀ ▶ move dates only with the domain's own addDays (re-exported by src/domain/index.js);
  // the window's length is the domain's period.days. The UI has no date arithmetic of its own.
  assert.ok(!/new Date|Date\.|setDate|getTime|getUTC|86400/.test(src), 'no second date calculation in the UI');
});

/* ---------------- empty and few days ---------------- */

test('Progress — nothing logged in the range: a neutral message and Go to Today; no charts, averages or zero lines', () => {
  const { app, writes } = setup();
  const p = progressModel(app, { period: 7 });
  assert.equal(loggedDayCount(p), 0);
  const html = renderProgress(p, { period: 7, macro: 'protein' });
  assert.match(text(html), new RegExp(`Nothing logged between ${formatDate(ago(6))} and ${formatDate(TODAY)}\\.`));
  assert.match(html, /<a class="button" href="#\/today">Go to Today<\/a>/);
  assert.ok(!/trend-chart|average-number|Reached on|coverage-strip|0 g/.test(html));
  assert.ok(!JUDGMENT.test(text(html)));
  assert.equal(writes.length, 0, 'Progress never writes');
});

test('Progress — 1–2 logged days: coverage, averages and days show; the trend waits', () => {
  const { app } = setup();
  logDay(app, ago(1), 'lift', [['lunch', 'food_core_banana', 100]], true);
  logDay(app, ago(2), 'rest', [['lunch', 'food_core_banana', 100]], false);
  const html = renderProgress(progressModel(app, { period: 7 }), { period: 7, macro: 'protein' });
  assert.match(html, /The trend appears once a few days are logged\./);
  assert.ok(!/trend-chart/.test(html));
  assert.match(html, /class="coverage-strip"/);
  assert.match(html, /class="day-list"/);
});

test('Progress — only days not marked done: the Done-day average is hidden with its explanation', () => {
  const { app } = setup();
  logDay(app, ago(1), 'lift', [['lunch', 'food_core_banana', 100]], false);
  const html = renderAverages(progressModel(app, { period: 7 }));
  assert.match(text(html), /No days marked done in this range yet\./);
  assert.ok(!/average-primary/.test(html));
  assert.match(html, /All logged days: <span class="nowrap">\d+ g<\/span>/);
});

/* ---------------- counts and wording ---------------- */

test('Progress — logged days, coverage and "Reached on n of m logged days" come from the domain', () => {
  const { app } = setup();
  history(app);
  const p = progressModel(app, { period: 7 });
  assert.deepEqual(p.counts, { complete: 3, partial: 1, noData: 3 });
  assert.equal(loggedDayCount(p), 4);
  const coverage = renderCoverage(p);
  assert.match(text(coverage), /Done 3 · Not marked done 1 · Nothing logged 3/);
  assert.equal((coverage.match(/class="strip-day"/g) || []).length, 7, 'every day in the range, by status');
  for (const d of p.daily) assert.ok(coverage.includes(`${formatDate(d.date)}: ${STATUS_LABELS[d.status]}`), 'each day labelled, not colour alone');
  const reached = renderReached(p);
  for (const key of macros.MACROS) assert.ok(text(reached).includes(`Reached on ${p.daysHit[key].hit} of 4 logged days`), key);
  assert.match(text(reached), /1 day not marked done\./);
  assert.ok(!/missed|undetermined/i.test(reached), 'the domain’s other tallies are never shown as words');
  assert.ok(!/%/.test(text(renderProgress(p, { period: 7, macro: 'protein' }))), 'no percentage or combined rate');
});

test('Progress — averages: Done days first with the average target, then all logged days, from the domain', () => {
  const { app } = setup();
  history(app);
  const p = progressModel(app, { period: 7 });
  const html = renderAverages(p);
  const a = whole(p.averages.completeDays.actual);
  const t = whole(p.averages.completeDays.target);
  const l = whole(p.averages.loggedDays.actual);
  for (const key of macros.MACROS) {
    assert.ok(html.includes(`<span class="average-number">${a[key]} g</span>`), `${key} Done-day average`);
    assert.ok(html.includes(`average target <span class="nowrap">${t[key]} g</span>`), `${key} average target`);
    assert.ok(html.includes(`All logged days: <span class="nowrap">${l[key]} g</span>`), `${key} logged-day average`);
  }
  assert.match(text(html), /On days marked done \(3\)\./);
  assert.match(text(html), /“All logged days” \(4, including days not marked done\) reflects logged meals only\./);
});

test('Progress — switching periods changes only what is shown', () => {
  const { app, writes } = setup();
  history(app);
  const before = JSON.stringify(app.listDays());
  const n = writes.length;
  const seven = progressModel(app, { period: 7 });
  const fourteen = progressModel(app, { period: 14 });
  const thirty = progressModel(app, { period: 30 });
  assert.deepEqual([loggedDayCount(seven), loggedDayCount(fourteen), loggedDayCount(thirty)], [4, 5, 6]);
  assert.match(text(renderCoverage(thirty)), /Done 4 · Not marked done 2 · Nothing logged 24/);
  assert.equal(JSON.stringify(app.listDays()), before);
  assert.equal(writes.length, n);
});

/* ---------------- day list, day types, history ---------------- */

test('Progress — logged days, newest first: date · day type · status · logged of target → Today on that date', () => {
  const { app } = setup();
  history(app);
  const p = progressModel(app, { period: 7 });
  const html = renderDayList(p);
  const dates = [...html.matchAll(/href="#\/today\?date=(\d{4}-\d{2}-\d{2})"/g)].map((m) => m[1]);
  assert.deepEqual(dates, [ago(1), ago(2), ago(3), ago(5)], 'logged days only, newest first; nothing-logged days are not listed');
  for (const d of p.daily.filter((x) => x.status !== 'no_data')) {
    const a = whole(d.actual);
    const t = whole(d.target);
    assert.ok(html.includes(`P ${a.protein} of ${t.protein} g · C ${a.carbs} of ${t.carbs} g · F ${a.fat} of ${t.fat} g`), d.date);
  }
  assert.match(html, /<span class="marker">Long Run<\/span>/);
  assert.match(html, /Not marked done/);
  assert.match(html, /aria-label="[^"]*Long Run, Done\. Protein \d+ of \d+ grams, Carbs \d+ of \d+ grams, Fat \d+ of \d+ grams\. Open on Today\."/);
  assert.equal(dayTypeMix(p), 'Lift 2 · Long Run 1 · Rest 1', 'counted over the logged days listed');
  assert.match(html, /Day types: Lift 2 · Long Run 1 · Rest 1/);
  const over = p.daily.find((d) => d.dayType === 'long_run');
  assert.ok(over.actual.protein > over.target.protein, 'fixture: above target');
  assert.ok(!/over|excess|too/i.test(text(html)), 'above target is just a number');
});

test('Progress — each day keeps its own day type and stored targets; current target changes don’t rewrite history', () => {
  const { app } = setup();
  history(app);
  const before = progressModel(app, { period: 30 });
  const liftDay = before.daily.find((d) => d.date === ago(1));
  assert.equal(liftDay.dayType, 'lift');
  assert.deepEqual(liftDay.target, app.getDay(ago(1)).targetSnapshot, 'the Day’s snapshot, not current targets');
  app.updateCurrentTargets('lift', { carbs: 400, protein: 170 });
  app.updateCurrentTargets('rest', { fat: 90 });
  const after = progressModel(app, { period: 30 });
  assert.deepEqual(after.daily, before.daily, 'history unchanged');
  assert.deepEqual(after.averages, before.averages);
  assert.equal(renderProgress(after, { period: 30, macro: 'carbs' }), renderProgress(before, { period: 30, macro: 'carbs' }));
  assert.ok(!/of 400 g/.test(renderDayList(after)));
  // Changing a past day's type uses the domain's stored context; nothing is inferred from weekdays.
  app.updateDayType(ago(2), 'long_run');
  assert.equal(progressModel(app, { period: 7 }).daily.find((d) => d.date === ago(2)).dayType, 'long_run');
});

test('Progress — editing or deleting a Saved Meal or Food doesn’t rewrite logged history', () => {
  const { app } = setup();
  const food = app.createCustomFood({ name: 'Test granola', category: 'cereal', state: 'dry', nutrition: { protein: 10, carbs: 60, fat: 15 } });
  const meal = app.createSavedMeal({ name: 'Granola bowl', mealType: 'breakfast', ingredients: [{ foodId: food.id, quantity: 80 }, { foodId: 'food_core_fage_0_greek_yogurt', quantity: 200 }] });
  app.createDay(ago(1), 'lift');
  app.createMealInstance({ date: ago(1), mealSlot: 'breakfast', mealId: meal.id });
  app.setDayLoggingComplete(ago(1), true);
  const before = progressModel(app, { period: 7 });
  app.updateSavedMeal(meal.id, { ingredients: [{ foodId: 'food_core_banana', quantity: 500 }] });
  app.updateCustomFood(food.id, { nutrition: { protein: 90, carbs: 0, fat: 0 } });
  app.deleteSavedMeal(meal.id);
  app.deleteCustomFood(food.id);
  assert.deepEqual(progressModel(app, { period: 7 }), before);
});

test('Progress — days with nothing logged are gaps and "Nothing logged", never zero or a failure', () => {
  const { app } = setup();
  history(app);
  const p = progressModel(app, { period: 7 });
  assert.equal(p.daily.find((d) => d.date === ago(4)).status, 'no_data', 'a Day with a type but no food');
  assert.equal(p.averages.loggedDays.days, 4, 'excluded from averages (the domain)');
  const trend = renderTrend(p, { macro: 'protein' });
  const pathD = (cls) => trend.match(new RegExp(`class="${cls}" d="([^"]*)"`))[1];
  const actualPath = pathD('trend-actual');
  assert.ok(!/ 0 H| 0$/.test(actualPath), 'no zero points');
  // Logged: 5 days ago, then 3–1 days ago; the Day with nothing logged (4 days ago) breaks the line.
  assert.equal((actualPath.match(/M /g) || []).length, 2, 'the line breaks where nothing was logged');
  assert.equal((trend.match(/trend-marker is-done/g) || []).length, 3, 'Done: solid marker');
  assert.equal((trend.match(/trend-marker is-open/g) || []).length, 1, 'not marked done: hollow marker');
  const html = renderProgress(p, { period: 7, macro: 'protein' });
  assert.ok(!JUDGMENT.test(text(html)), 'no judgment anywhere');
  assert.match(text(html), /Nothing logged 3/);
});

test('Progress — the trend: one macro at a time, the domain’s grams in chart coordinates, with a text summary', () => {
  const { app } = setup();
  history(app);
  const p = progressModel(app, { period: 7 });
  const html = renderTrend(p, { macro: 'carbs' });
  assert.match(html, /data-action="trend-macro" data-macro="carbs" aria-pressed="true">Carbs/);
  assert.match(html, /<svg class="trend-chart" viewBox="0 0 7 [\d.]+" preserveAspectRatio="none" role="img" aria-labelledby="trend-summary"/);
  for (const [i, v] of p.trend.actual.carbs.entries()) if (v !== null) assert.ok(html.includes(`M ${i + 0.5} ${v} l 0 0`), 'marker at the domain value');
  assert.match(html, new RegExp(`<span id="trend-summary" class="visually-hidden">Carbs: logged grams and each day’s target for the 4 logged days in this range; days with nothing logged are gaps\\. Reached on ${p.daysHit.carbs.hit} of 4 logged days\\. The day list below has every value\\.</span>`));
  assert.match(html, /Logged<\/span>[\s\S]*Target<\/span>[\s\S]*Done<\/span>[\s\S]*Not marked done<\/span>/, 'legend with labels, not colour alone');
  assert.ok(!/gauge|ring|progress-ring/.test(html));
});

/* ---------------- language, architecture ---------------- */

test('Progress — descriptive copy only: no scores, grades, compliance, streaks or judgments in any state', () => {
  const { app } = setup();
  const empty = renderProgress(progressModel(app, { period: 30 }), { period: 30, macro: 'fat' });
  history(app);
  for (const period of PROGRESS_PERIODS) {
    for (const macro of macros.MACROS) assert.ok(!JUDGMENT.test(text(renderProgress(progressModel(app, { period }), { period, macro }))), `${period}/${macro}`);
  }
  assert.ok(!JUDGMENT.test(text(empty)));
  assert.ok(!JUDGMENT.test(text(renderNothingLogged(progressModel(app, { period: 7 })))));
  const src = fs.readFileSync(path.join(ROOT, 'app/progress.js'), 'utf8');
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  assert.ok(!/score|grade|compliance|adherence|streak|success|\bfail/i.test(code), 'none in the code either');
  assert.ok(!/getMacroCoachSuggestions|coach/i.test(code), 'Progress is not the Coach');
});

test('Progress — no macro arithmetic, no forbidden terms, no second store, domain via its entry point, read-only', () => {
  for (const f of ['app/progress.js', 'app/session.js', 'app/app.css']) {
    const src = fs.readFileSync(path.join(ROOT, f), 'utf8');
    assert.deepEqual(macroArithmeticInSource(src, f), [], f);
    assert.ok(!FORBIDDEN_NUTRITION.test(src), f);
    assert.deepEqual(domainImportsBypassingIndex(src), [], f);
  }
  const src = fs.readFileSync(path.join(ROOT, 'app/progress.js'), 'utf8');
  assert.deepEqual([...src.matchAll(/from '([^']+)'/g)].map((m) => m[1]).sort(), ['../src/domain/index.js', './session.js', './shell.js', './today.js']);
  assert.ok(!/localStorage|sessionStorage|indexedDB|\bfetch\(|import\(/.test(src), 'no second persistence mechanism');
  assert.ok(!/app\.(create|update|delete|set|log|apply|replace|duplicate)\w*\(/.test(src), 'Progress calls no write operation');
  assert.equal((src.match(/app\.getProgress\(/g) || []).length, 1, 'one domain source');
});
