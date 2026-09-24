/*
 * progress.js — Progress is derived, never stored.
 *
 * Computed from Days, their Meal Instances and each Day's own target snapshot.
 *
 * Every date in the period gets a status:
 *   no_data   no Day, or a Day with nothing logged — NOT zero intake; excluded from averages
 *   partial   food logged in some of the five slots
 *   complete  food logged in all five slots (breakfast, lunch, snack_afternoon, dinner, snack_night)
 *
 * Targets are floors. Per macro a Day is:
 *   hit           logged ≥ target (a partial Day can already be a hit — logging more only adds)
 *   missed        complete Day with logged < target
 *   undetermined  partial Day with logged < target (not counted as a miss)
 *
 * Averages of actual intake use complete Days only, so unlogged meals never pull an
 * average down. A separate "logged days" average is labelled as based on logged meals.
 * No scores, ratings, weight, body composition or performance measures.
 */

import { DomainError, dateRange, addDays, assertDate } from './util.js';
import { MACROS, averageMacros, meetsTarget } from './macros.js';

export const PERIODS = Object.freeze([7, 14, 30]);

export function createProgressApi(ctx, { days }) {
  const { store } = ctx;

  function resolvePeriod({ period, endDate, startDate } = {}) {
    if (startDate || (endDate && period === undefined)) {
      if (!startDate || !endDate) throw new DomainError('INVALID_PERIOD', 'a custom period needs startDate and endDate');
      return { startDate, endDate };
    }
    if (!endDate) throw new DomainError('INVALID_PERIOD', 'endDate is required');
    assertDate(endDate);
    if (!Number.isInteger(period) || period < 1) throw new DomainError('INVALID_PERIOD', `period must be a positive whole number of days (usually ${PERIODS.join(', ')})`);
    return { startDate: addDays(endDate, -(period - 1)), endDate };
  }

  /**
   * getProgress({ period: 7|14|30, endDate }) or getProgress({ startDate, endDate }).
   */
  function getProgress(options = {}) {
    const { startDate, endDate } = resolvePeriod(options);
    const dates = dateRange(startDate, endDate);
    const byDate = new Map(store.get('days').map((d) => [d.date, d]));

    const daily = dates.map((date) => {
      const day = byDate.get(date);
      if (!day) return { date, dayType: null, status: 'no_data', loggedSlots: [], actual: null, target: null, remaining: null, hit: null };
      const s = days._summarize(day);
      if (s.status === 'no_data') return { date, dayType: s.dayType, status: 'no_data', loggedSlots: [], actual: null, target: s.target, remaining: null, hit: null };
      const meets = meetsTarget(s.logged, s.target);
      const hit = {};
      for (const m of MACROS) hit[m] = meets[m] ? 'hit' : s.status === 'complete' ? 'missed' : 'undetermined';
      hit.all = MACROS.every((m) => hit[m] === 'hit') ? 'hit' : MACROS.some((m) => hit[m] === 'missed') ? 'missed' : 'undetermined';
      return { date, dayType: s.dayType, status: s.status, loggedSlots: s.loggedSlots, actual: s.logged, target: s.target, remaining: s.remaining, hit };
    });

    const complete = daily.filter((d) => d.status === 'complete');
    const logged = daily.filter((d) => d.status !== 'no_data');
    const tally = (key) => ({
      hit: logged.filter((d) => d.hit[key] === 'hit').length,
      missed: logged.filter((d) => d.hit[key] === 'missed').length,
      undetermined: logged.filter((d) => d.hit[key] === 'undetermined').length
    });

    return {
      period: { startDate, endDate, days: dates.length },
      basis: 'Logged meals only. Days with nothing logged are not counted as zero intake.',
      counts: {
        complete: complete.length,
        partial: daily.filter((d) => d.status === 'partial').length,
        noData: daily.filter((d) => d.status === 'no_data').length
      },
      averages: {
        completeDays: complete.length
          ? { days: complete.length, actual: averageMacros(complete.map((d) => d.actual)), target: averageMacros(complete.map((d) => d.target)) }
          : null,
        loggedDays: logged.length
          ? { days: logged.length, basis: 'includes partially logged days; reflects logged meals only', actual: averageMacros(logged.map((d) => d.actual)), target: averageMacros(logged.map((d) => d.target)) }
          : null
      },
      daysHit: { protein: tally('protein'), carbs: tally('carbs'), fat: tally('fat'), all: tally('all') },
      daily,
      trend: {
        dates,
        status: daily.map((d) => d.status),
        actual: Object.fromEntries(MACROS.map((m) => [m, daily.map((d) => (d.actual ? d.actual[m] : null))])),
        target: Object.fromEntries(MACROS.map((m) => [m, daily.map((d) => (d.target ? d.target[m] : null))]))
      }
    };
  }

  return { getProgress };
}
