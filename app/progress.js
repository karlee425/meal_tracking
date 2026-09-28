/*
 * progress.js — the Progress screen (V2_UI_CONTRACT.md §9). Descriptive, not judgmental
 * (A-22): what was logged against each day's own targets, and nothing else.
 *
 * Everything comes from one domain call, getProgress({ period, endDate }) or
 * getProgress({ startDate, endDate }) for a Custom range (§9.1, A-21):
 * statuses (no_data / partial / complete), each day's stored target snapshot, the averages,
 * the per-macro "reached" tallies, the daily list and the trend series. The UI only rounds
 * for display, counts day types from daily[] (§9.2.8), and draws the trend with the domain's
 * gram values in the chart's own coordinates (the browser scales them).
 *
 * Never shown (§9.4): any number other than protein, carbs and fat in grams; any rating,
 * ranking or judgment of a day; and the words for the domain's non-"hit" values.
 */

import { macros, constants, addDays } from '../src/domain/index.js';
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

/**
 * The selected range (7 by default), remembered for the session (§3.2): 7 | 14 | 30, or
 * 'custom' once a Custom range has been chosen.
 */
export const progressPeriod = (state) => {
  if (state.period === 'custom' && state.custom && state.custom.startDate && state.custom.endDate) return 'custom';
  return PROGRESS_PERIODS.includes(state.period) ? state.period : 7;
};
export const progressMacro = (state) => (macros.MACROS.includes(state.macro) ? state.macro : 'protein');

/**
 * The getProgress options for the selected range (§9.2.1). A 7 / 14 / 30 window ends today by
 * default; after ◀ it ends on state.endDate (never later than today). A Custom range is its
 * own start and end.
 */
export function progressWindow(app, state) {
  const today = app.getToday();
  const period = progressPeriod(state);
  if (period === 'custom') return { startDate: state.custom.startDate, endDate: state.custom.endDate };
  return { period, endDate: state.endDate && state.endDate < today ? state.endDate : today };
}

/** The one place Progress reads the domain (§9.1). */
const readProgress = (app, options) => app.getProgress(options);

/** Progress for the selected range, straight from the domain (§9.1). */
export const progressModel = (app, state) => readProgress(app, progressWindow(app, state));

/** Whether the window ends before today, so ▶ can move it (never past today). */
export const canStepForward = (app, progress) => progress.period.endDate < app.getToday();

/**
 * ◀ ▶ (§9.2.1): the range moved by its own length (progress.period.days, from the domain),
 * never past today — a step that would pass today stops at a window ending today, the same
 * length. Returns the new { endDate, custom } for the session; nothing is stored.
 */
export function steppedRange(app, state, progress, direction) {
  const today = app.getToday();
  const length = progress.period.days;
  const moved = direction < 0 ? addDays(progress.period.startDate, -1) : addDays(progress.period.endDate, length);
  const endDate = moved < today ? moved : today;
  if (progressPeriod(state) === 'custom') return { endDate: null, custom: { startDate: addDays(endDate, 1 - length), endDate } };
  return { endDate: endDate === today ? null : endDate, custom: state.custom };
}

/** I-41: a Custom range is at most 90 days and ends today at the latest. */
export const CUSTOM_MAX_DAYS = 90;

/** Inline messages under the Custom range pickers (§9.2.1, §15: INVALID_DATE / INVALID_PERIOD inline under the picker). */
export const RANGE_MESSAGES = Object.freeze({
  START_REQUIRED: 'Choose a start date.',
  END_REQUIRED: 'Choose an end date.',
  INVALID_DATE: 'Enter real dates for the start and the end.',
  INVALID_PERIOD: 'The start date must be on or before the end date.',
  END_AFTER_TODAY: 'The end date can’t be after today.',
  TOO_LONG: `A custom range can be at most ${CUSTOM_MAX_DAYS} days.`
});

/**
 * Checks a Custom range. The domain decides whether the dates are real and in order
 * (getProgress throws INVALID_DATE / INVALID_PERIOD); the two I-41 limits are read from its
 * result (period.endDate against today, period.days against 90). Returns
 * { ok: true, progress } or { ok: false, code, fields: ['start'|'end', …], message }.
 */
export function checkCustomRange(app, { startDate, endDate }) {
  const invalid = (code, fields) => ({ ok: false, code, fields, message: RANGE_MESSAGES[code] });
  if (!startDate) return invalid('START_REQUIRED', ['start']);
  if (!endDate) return invalid('END_REQUIRED', ['end']);
  let progress;
  try {
    progress = readProgress(app, { startDate, endDate });
  } catch (e) {
    if (e && e.code === 'INVALID_PERIOD') return invalid('INVALID_PERIOD', ['start', 'end']);
    if (e && e.code === 'INVALID_DATE') return invalid('INVALID_DATE', ['start', 'end']);
    throw e;
  }
  if (progress.period.endDate > app.getToday()) return invalid('END_AFTER_TODAY', ['end']);
  if (progress.period.days > CUSTOM_MAX_DAYS) return invalid('TOO_LONG', ['start', 'end']);
  return { ok: true, progress };
}

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

const dayCount = (n) => `${n} ${n === 1 ? 'day' : 'days'}`;

function periodSelector(period) {
  return `<div class="segment period-selector" role="group" aria-label="Range">
${PROGRESS_PERIODS.map((p) => `<button type="button" class="segment-button" data-action="period" data-period="${p}" aria-pressed="${p === period}">${p} days</button>`).join('\n')}
<button type="button" class="segment-button" data-action="period-custom" aria-pressed="${period === 'custom'}">Custom</button>
</div>`;
}

/** "Last 7 days · …" for a window ending today; otherwise the range's own length (from the domain). */
export function rangeLabel(progress, { period, endsToday }) {
  if (period !== 'custom' && endsToday) return `Last ${period} days · ${rangeText(progress)}`;
  return `${period === 'custom' ? 'Custom · ' : ''}${dayCount(progress.period.days)} · ${rangeText(progress)}`;
}

const chevron = (d) => `<svg class="icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="${d}"/></svg>`;

/** ◀ range ▶ — ▶ is unavailable (still focusable, aria-disabled) once the range ends today. */
function rangeNav(progress, { period, endsToday }) {
  const length = dayCount(progress.period.days);
  return `<div class="range-nav" role="group" aria-label="Move the range">
<button type="button" class="icon-button" data-action="range-prev" aria-label="Previous ${length}">${chevron('M15 5l-7 7 7 7')}</button>
<p class="progress-range" data-range>${escapeHtml(rangeLabel(progress, { period, endsToday }))}</p>
<button type="button" class="icon-button" data-action="range-next" aria-label="${endsToday ? `Next ${length}, not available: the range already ends today` : `Next ${length}`}"${endsToday ? ' aria-disabled="true"' : ''}>${chevron('M9 5l7 7-7 7')}</button>
</div>`;
}

/**
 * Custom start / end pickers (§9.2.1, I-41). draft: { startDate, endDate, check } — the values
 * being chosen and the last check, if any. "Show range" stays unavailable while the check fails;
 * Enter or a click re-checks (A-45).
 */
export function renderCustomRange({ startDate = '', endDate = '', check = null }, { today }) {
  const bad = (field) => !!(check && !check.ok && check.fields.includes(field));
  const input = (field, label, value) => `<div class="range-field">
<label class="field" for="range-${field}">${label}</label>
<input id="range-${field}" type="date" data-range-field="${field}" value="${escapeHtml(value || '')}" max="${today}" required aria-describedby="range-error range-hint"${bad(field) ? ' aria-invalid="true" data-invalid' : ''}>
</div>`;
  const invalid = !!(check && !check.ok);
  return `<section class="custom-range" aria-labelledby="custom-range-title" data-enter-scope>
<h2 id="custom-range-title" class="group-title">Custom range</h2>
<div class="range-fields">
${input('start', 'Start', startDate)}
${input('end', 'End', endDate)}
</div>
<p id="range-error" class="field-error" data-range-error${invalid ? ` data-code="${check.code}"` : ' hidden'}>${invalid ? escapeHtml(check.message) : ''}</p>
<p id="range-hint" class="hint">Up to ${CUSTOM_MAX_DAYS} days, ending today at the latest.</p>
<div class="sheet-actions"><button type="button" class="button primary" data-action="range-apply"${invalid ? ' disabled' : ''}>Show range</button></div>
</section>`;
}

/** Heading, range selector, ◀ range ▶, Custom pickers when chosen, and the basis line (always visible, §9.2.2). */
export function renderProgressTop(progress, { period, endsToday = true, draft = null, today = progress.period.endDate }) {
  return `<h1 id="screen-title" class="screen-title" tabindex="-1">Progress</h1>
${periodSelector(period)}
${period === 'custom' ? renderCustomRange(draft || progress.period, { today }) : ''}
${rangeNav(progress, { period, endsToday })}
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

/** The whole body for a range. */
export function renderProgress(progress, { period, macro, endsToday = true, draft = null, today }) {
  const top = renderProgressTop(progress, { period, endsToday, draft, today });
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
    let draft = null; // Custom pickers being edited: { startDate, endDate, check }
    main.innerHTML = '<div class="progress-screen" data-progress-body></div><p class="visually-hidden" role="status" aria-live="polite" data-progress-status></p>';
    const body = main.querySelector('[data-progress-body]');
    const status = main.querySelector('[data-progress-status]');
    let current = null;
    const render = () => {
      current = progressModel(app, state);
      body.innerHTML = renderProgress(current, { ...state, endsToday: !canStepForward(app, current), draft, today: app.getToday() });
      return current;
    };
    const announce = (progress) => {
      const what = state.period !== 'custom' && !canStepForward(app, progress)
        ? `the last ${state.period} days, ${rangeText(progress)}`
        : `${dayCount(progress.period.days)}, ${rangeText(progress)}`;
      status.textContent = `Showing ${what}: ${loggedDayCount(progress)} logged.`;
    };
    const focus = (selector) => { const el = body.querySelector(selector); if (el) el.focus(); };
    const pickerValues = () => ({
      startDate: body.querySelector('[data-range-field="start"]')?.value || '',
      endDate: body.querySelector('[data-range-field="end"]')?.value || ''
    });
    /** Updates the pickers' messages and "Show range" in place, so focus and typing are undisturbed. */
    const showCheck = (check) => {
      for (const field of ['start', 'end']) {
        const input = body.querySelector(`[data-range-field="${field}"]`);
        const bad = !check.ok && check.fields.includes(field);
        input.toggleAttribute('data-invalid', bad);
        if (bad) input.setAttribute('aria-invalid', 'true'); else input.removeAttribute('aria-invalid');
      }
      const error = body.querySelector('[data-range-error]');
      error.hidden = check.ok;
      error.textContent = check.ok ? '' : check.message;
      if (check.ok) error.removeAttribute('data-code'); else error.dataset.code = check.code;
      body.querySelector('[data-action="range-apply"]').disabled = !check.ok;
    };

    const onInput = (event) => {
      if (!event.target.matches('[data-range-field]')) return;
      const values = pickerValues();
      draft = { ...values, check: checkCustomRange(app, values) };
      showCheck(draft.check);
    };
    main.addEventListener('input', onInput);
    main.addEventListener('change', onInput);

    main.addEventListener('click', (event) => {
      const el = event.target.closest('[data-action]');
      if (!el || !main.contains(el)) return;
      const action = el.dataset.action;
      if (action === 'period') {
        state.period = Number(el.dataset.period);
        state.endDate = null; // a 7 / 14 / 30 window ends today by default
        draft = null;
        announce(render());
        focus(`[data-period="${state.period}"]`);
      } else if (action === 'period-custom') {
        if (state.period !== 'custom') {
          // Start from the range on screen; the pickers change it from there.
          state.custom = { startDate: current.period.startDate, endDate: current.period.endDate };
          state.period = 'custom';
          draft = null;
          render();
          status.textContent = 'Choose a start and an end date, then Show range.';
        }
        focus('[data-range-field="start"]');
      } else if (action === 'range-apply') {
        // Submitting re-checks (A-45): nothing changes while the range is invalid.
        const values = pickerValues();
        const check = checkCustomRange(app, values);
        if (!check.ok) {
          draft = { ...values, check };
          showCheck(check);
          focus('[data-range-field][data-invalid]');
          return;
        }
        state.custom = { startDate: check.progress.period.startDate, endDate: check.progress.period.endDate };
        draft = null;
        announce(render());
        focus('[data-action="range-apply"]');
      } else if (action === 'range-prev' || action === 'range-next') {
        if (el.getAttribute('aria-disabled') === 'true') {
          status.textContent = 'The range already ends today.';
          return;
        }
        Object.assign(state, steppedRange(app, state, current, action === 'range-prev' ? -1 : 1));
        draft = null;
        announce(render());
        focus(`[data-action="${action}"]`);
      } else if (action === 'trend-macro') {
        state.macro = el.dataset.macro;
        render();
        focus(`[data-action="trend-macro"][data-macro="${state.macro}"]`);
      }
    });
    render();
    return false;
  },
  unmount() {}
};
