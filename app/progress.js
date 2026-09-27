/*
 * progress.js — the Progress screen (V2_UI_CONTRACT.md §9). Descriptive, not judgmental
 * (A-22): what was logged against each day's own targets, and nothing else.
 *
 * Everything comes from one domain call, getProgress({ period, endDate: getToday() }):
 * statuses (no_data / partial / complete), each day's stored target snapshot, the averages,
 * the per-macro "reached" tallies, the daily list and the trend series. The UI only rounds
 * for display, counts day types from daily[] (§9.2.8), and draws the trend with the domain's
 * gram values in the chart's own coordinates (the browser scales them).
 *
 * Never shown (§9.4): any number other than protein, carbs and fat in grams; any rating,
 * ranking or judgment of a day; and the words for the domain's non-"hit" values.
 */

import { macros, constants } from '../src/domain/index.js';
import { escapeHtml } from './shell.js';
import { DAY_TYPE_LABELS, formatDate } from './today.js';
import { session } from './session.js';

export const PROGRESS_PERIODS = Object.freeze([7, 14, 30]);
const MACRO_LABELS = Object.freeze({ protein: 'Protein', carbs: 'Carbs', fat: 'Fat' });
const MACRO_LETTERS = Object.freeze({ protein: 'P', carbs: 'C', fat: 'F' });
/** I-40 status labels. */
export const STATUS_LABELS = Object.freeze({ complete: 'Done', partial: 'Not marked done', no_data: 'Nothing logged' });
const whole = (values) => macros.roundMacros(values, 0);

/* ---------------- model ---------------- */

/** The selected period (7 by default), remembered for the session (§3.2). */
export const progressPeriod = (state) => (PROGRESS_PERIODS.includes(state.period) ? state.period : 7);
export const progressMacro = (state) => (macros.MACROS.includes(state.macro) ? state.macro : 'protein');

/** Progress for the window ending today, straight from the domain (§9.1). */
export const progressModel = (app, { period }) => app.getProgress({ period, endDate: app.getToday() });

/**
 * "Lift 4 · Long Run 1 · Rest 2", counted from daily[].dayType (§9.2.8) for the logged days it
 * sits beside in the day list; types with none are left out.
 */
export function dayTypeMix(progress) {
  const counts = Object.fromEntries(constants.DAY_TYPES.map((t) => [t, 0]));
  for (const d of progress.daily) if (d.dayType && d.status !== 'no_data') counts[d.dayType] += 1;
  return constants.DAY_TYPES.filter((t) => counts[t]).map((t) => `${DAY_TYPE_LABELS[t]} ${counts[t]}`).join(' · ');
}

/** How many days have food logged (Done + Not marked done), from the domain's own average basis. */
export const loggedDayCount = (progress) => (progress.averages.loggedDays ? progress.averages.loggedDays.days : 0);

/* ---------------- rendering ---------------- */

const rangeText = (progress) => `${formatDate(progress.period.startDate)} – ${formatDate(progress.period.endDate)}`;

function periodSelector(period) {
  return `<div class="segment period-selector" role="group" aria-label="Period">
${PROGRESS_PERIODS.map((p) => `<button type="button" class="segment-button" data-action="period" data-period="${p}" aria-pressed="${p === period}">${p} days</button>`).join('\n')}
</div>`;
}

/** Heading, period selector, range and the basis line (always visible, §9.2.2). */
export function renderProgressTop(progress, { period }) {
  return `<h1 id="screen-title" class="screen-title" tabindex="-1">Progress</h1>
${periodSelector(period)}
<p class="progress-range">Last ${period} days · ${escapeHtml(rangeText(progress))}</p>
<p class="basis-line">Based on logged meals. Days with nothing logged aren’t counted as zero.</p>`;
}

function statusShape(status) {
  return `<span class="status-shape" data-status="${status}" aria-hidden="true"></span>`;
}

/** §9.2.3: counts plus a strip of every day in the range, each with its status by shape and label. */
export function renderCoverage(progress) {
  const c = progress.counts;
  const strip = progress.daily.map((d) => `<li class="strip-day" data-status="${d.status}">
${statusShape(d.status)}<span class="strip-date" aria-hidden="true">${Number(d.date.slice(8))}</span><span class="visually-hidden">${escapeHtml(formatDate(d.date))}: ${STATUS_LABELS[d.status]}</span>
</li>`).join('\n');
  return `<section class="progress-section" aria-labelledby="coverage-title">
<h2 id="coverage-title" class="section-title">Logging</h2>
<p class="coverage-counts">${statusShape('complete')} Done ${c.complete} · ${statusShape('partial')} Not marked done ${c.partial} · ${statusShape('no_data')} Nothing logged ${c.noData}</p>
<ol class="coverage-strip" aria-label="Each day in this range">
${strip}
</ol>
</section>`;
}

/** §9.2.4: Done-day averages first (with the average target), then all logged days, labelled. */
export function renderAverages(progress) {
  const done = progress.averages.completeDays;
  const logged = progress.averages.loggedDays;
  const doneActual = done ? whole(done.actual) : null;
  const doneTarget = done ? whole(done.target) : null;
  const loggedActual = logged ? whole(logged.actual) : null;
  const rows = macros.MACROS.map((key) => `<li class="macro-average" data-macro="${key}">
<p class="macro-name"><span class="macro-mark" aria-hidden="true">${MACRO_LETTERS[key]}</span>${MACRO_LABELS[key]}</p>
${done ? `<p class="average-primary"><span class="average-number">${doneActual[key]} g</span> <span class="hint">average target <span class="nowrap">${doneTarget[key]} g</span></span></p>` : ''}
${logged ? `<p class="average-secondary">All logged days: <span class="nowrap">${loggedActual[key]} g</span></p>` : ''}
</li>`).join('\n');
  return `<section class="progress-section" aria-labelledby="averages-title">
<h2 id="averages-title" class="section-title">Daily averages</h2>
${done
    ? `<p class="section-note">On days marked done (${done.days}). The target is averaged because it depends on each day’s type.</p>`
    : '<p class="section-note">No days marked done in this range yet.</p>'}
<ul class="progress-macros">
${rows}
</ul>
${logged ? `<p class="hint">“All logged days” (${logged.days}, including days not marked done) reflects logged meals only.</p>` : ''}
</section>`;
}

/** §9.2.5 / I-56: "Reached on {hit} of {logged} logged days" per macro. Nothing else is headlined. */
export function renderReached(progress) {
  const logged = loggedDayCount(progress);
  const items = macros.MACROS.map((key) => `<li data-macro="${key}"><span class="macro-mark" aria-hidden="true">${MACRO_LETTERS[key]}</span><span class="reached-label">${MACRO_LABELS[key]}</span> Reached on ${progress.daysHit[key].hit} of ${logged} logged days</li>`).join('\n');
  return `<section class="progress-section" aria-labelledby="reached-title">
<h2 id="reached-title" class="section-title">Target reached</h2>
<ul class="reached-list">
${items}
</ul>
${progress.counts.partial ? `<p class="hint">${progress.counts.partial} ${progress.counts.partial === 1 ? 'day' : 'days'} not marked done.</p>` : ''}
</section>`;
}

/**
 * §9.2.6: one macro, daily logged grams vs each day's target as stepped lines. Days with
 * nothing logged are gaps (never zero points); Done days get a solid marker, the others a
 * hollow one. The SVG uses the domain's grams as its own coordinates (x = day, y = grams);
 * the browser does the scaling. A text summary goes with it (§14).
 */
export function renderTrend(progress, { macro }) {
  const logged = loggedDayCount(progress);
  const switcher = `<div class="segment" role="group" aria-label="Trend for">
${macros.MACROS.map((key) => `<button type="button" class="segment-button" data-action="trend-macro" data-macro="${key}" aria-pressed="${key === macro}">${MACRO_LABELS[key]}</button>`).join('\n')}
</div>`;
  if (logged < 3) {
    return `<section class="progress-section" aria-labelledby="trend-title">
<h2 id="trend-title" class="section-title">Trend</h2>
<p class="section-note">The trend appears once a few days are logged.</p>
</section>`;
  }
  const actual = progress.trend.actual[macro];
  const target = progress.trend.target[macro];
  const status = progress.trend.status;
  const top = Math.max(1, ...actual.filter((v) => v !== null), ...target.filter((v) => v !== null));
  const steps = (values, onlyWhen) => {
    let d = '';
    let open = false;
    values.forEach((v, i) => {
      if (v === null || !onlyWhen(i)) { open = false; return; }
      d += open ? ` V ${v} H ${i + 1}` : ` M ${i} ${v} H ${i + 1}`;
      open = true;
    });
    return d.trim();
  };
  const targetPath = steps(target, (i) => status[i] !== 'no_data');
  const actualPath = steps(actual, (i) => status[i] !== 'no_data');
  // Zero-length round-capped strokes: dots that keep their shape however the chart is scaled.
  const markers = actual.map((v, i) => {
    if (v === null || status[i] === 'no_data') return '';
    const dot = `d="M ${i + 0.5} ${v} l 0 0"`;
    return status[i] === 'complete'
      ? `<path class="trend-marker is-done" ${dot}/>`
      : `<path class="trend-marker is-open" ${dot}/><path class="trend-marker-hole" ${dot}/>`;
  }).join('');
  const summary = `${MACRO_LABELS[macro]}: logged grams and each day’s target for the ${logged} logged days in this range; days with nothing logged are gaps. Reached on ${progress.daysHit[macro].hit} of ${logged} logged days. The day list below has every value.`;
  return `<section class="progress-section" aria-labelledby="trend-title">
<h2 id="trend-title" class="section-title">Trend</h2>
${switcher}
<figure class="trend" data-macro="${macro}">
<svg class="trend-chart" viewBox="0 0 ${progress.trend.dates.length} ${top}" preserveAspectRatio="none" role="img" aria-labelledby="trend-summary" focusable="false">
<g transform="matrix(1 0 0 -1 0 ${top})">
<path class="trend-target" d="${targetPath}"/>
<path class="trend-actual" d="${actualPath}"/>
${markers}
</g>
</svg>
<figcaption>
<span class="trend-legend"><span class="legend-line is-actual" aria-hidden="true"></span>Logged</span>
<span class="trend-legend"><span class="legend-line is-target" aria-hidden="true"></span>Target</span>
<span class="trend-legend">${statusShape('complete')}Done</span>
<span class="trend-legend">${statusShape('partial')}Not marked done</span>
<span class="trend-dates">${escapeHtml(formatDate(progress.period.startDate))} → ${escapeHtml(formatDate(progress.period.endDate))}</span>
<span id="trend-summary" class="visually-hidden">${escapeHtml(summary)}</span>
</figcaption>
</figure>
</section>`;
}

/** §9.2.7: logged days, newest first — date · day type · status · P / C / F logged vs target → Today. */
export function renderDayList(progress) {
  const days = progress.daily.filter((d) => d.status !== 'no_data').slice().reverse();
  const items = days.map((d) => {
    const a = whole(d.actual);
    const t = whole(d.target);
    const type = DAY_TYPE_LABELS[d.dayType];
    const values = macros.MACROS.map((key) => `${MACRO_LETTERS[key]} ${a[key]} of ${t[key]} g`).join(' · ');
    const speech = `${formatDate(d.date)}, ${type}, ${STATUS_LABELS[d.status]}. ${macros.MACROS.map((key) => `${MACRO_LABELS[key]} ${a[key]} of ${t[key]} grams`).join(', ')}. Open on Today.`;
    return `<li><a class="day-row" href="#/today?date=${d.date}" data-date="${d.date}" aria-label="${escapeHtml(speech)}">
<span class="day-row-head"><span class="meal-name">${escapeHtml(formatDate(d.date))}</span><span class="marker">${type}</span><span class="day-status-label">${statusShape(d.status)}${STATUS_LABELS[d.status]}</span></span>
<span class="meal-macros">${values}</span>
</a></li>`;
  }).join('\n');
  const mix = dayTypeMix(progress);
  return `<section class="progress-section" aria-labelledby="days-title">
<h2 id="days-title" class="section-title">Logged days</h2>
${mix ? `<p class="section-note">Day types: ${mix}</p>` : ''}
<ul class="day-list">
${items}
</ul>
</section>`;
}

/** §9.3: nothing logged in the range — no charts, averages or zero lines. */
export function renderNothingLogged(progress) {
  return `<section class="progress-section progress-empty" aria-labelledby="empty-title">
<h2 id="empty-title" class="section-title">Nothing logged yet in this range</h2>
<p>Nothing logged between ${escapeHtml(formatDate(progress.period.startDate))} and ${escapeHtml(formatDate(progress.period.endDate))}.</p>
<a class="button" href="#/today">Go to Today</a>
</section>`;
}

/** The whole body for a period. */
export function renderProgress(progress, { period, macro }) {
  const top = renderProgressTop(progress, { period });
  if (!loggedDayCount(progress)) return `${top}\n${renderNothingLogged(progress)}`;
  return `${top}
${renderCoverage(progress)}
${renderReached(progress)}
${renderAverages(progress)}
${renderTrend(progress, { macro })}
${renderDayList(progress)}`;
}

/* ---------------- DOM wiring ---------------- */

/** The Progress screen, mounted by the shell into <main>. Read-only: it never writes. */
export const progressScreen = {
  mount(main, { app }) {
    const state = session.progress;
    state.period = progressPeriod(state);
    state.macro = progressMacro(state);
    main.innerHTML = '<div class="progress-screen" data-progress-body></div><p class="visually-hidden" role="status" aria-live="polite" data-progress-status></p>';
    const body = main.querySelector('[data-progress-body]');
    const status = main.querySelector('[data-progress-status]');
    const render = () => {
      const progress = progressModel(app, state);
      body.innerHTML = renderProgress(progress, state);
      return progress;
    };

    main.addEventListener('click', (event) => {
      const el = event.target.closest('[data-action]');
      if (!el || !main.contains(el)) return;
      if (el.dataset.action === 'period') {
        state.period = Number(el.dataset.period);
        const progress = render();
        status.textContent = `Showing the last ${state.period} days: ${loggedDayCount(progress)} logged.`;
        body.querySelector(`[data-period="${state.period}"]`).focus();
      } else if (el.dataset.action === 'trend-macro') {
        state.macro = el.dataset.macro;
        render();
        body.querySelector(`[data-action="trend-macro"][data-macro="${state.macro}"]`).focus();
      }
    });
    render();
    return false;
  },
  unmount() {}
};
