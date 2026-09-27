/*
 * session.js — UI state that lasts for this page session only (V2_UI_CONTRACT.md §3.2, §5).
 *
 * In memory, never persisted: the date last viewed on Today, Log's segment, search text and
 * meal builder tray (§5.5: "It isn't persisted across app restarts"), and one-shot handoffs
 * between screens (e.g. "highlight the meal just logged" when Log returns to Today).
 * Nothing here is user data; the data layer remains the only store.
 */

function fresh() {
  return {
    todayDate: null, // the date last viewed on Today (§5.2)
    log: {
      segment: null, // 'meals' | 'foods', remembered per session (§5.3)
      query: '',
      tray: [], // [{ foodId, text }] — the meal builder tray (§5.5)
      trayName: null, // the user's edit of the prefilled tray name, if any
      launchedFromToday: false, // true while Log sits on top of a Today history entry
      launchedFromMeals: false // true while Log sits on top of a Meals history entry
    },
    meals: {
      segment: null, // 'saved' | 'library', remembered per session (§6.1)
      query: '',
      type: 'all', // meal-type filter chip: 'all' or a meal type (filter only, never a slot rule)
      favorites: false // the Favourites chip
    },
    progress: {
      period: null, // 7 | 14 | 30, remembered per session (§3.2)
      macro: null // the trend's macro
    },
    handoff: null, // { date, highlightId?, openInstanceId?, message? } for Today to pick up once
    mealsHandoff: null // { confirmation } for Meals to show once, after "Log this meal"
  };
}

export const session = fresh();

/** Back to a clean session (tests; never called by the app). */
export function resetSession() {
  const next = fresh();
  for (const key of Object.keys(next)) session[key] = next[key];
}

/** The query part of a hash route ("#/log?date=…&slot=…") as a URLSearchParams. */
export function routeParams(hash) {
  const raw = typeof hash === 'string' ? hash : '';
  const i = raw.indexOf('?');
  return new URLSearchParams(i === -1 ? '' : raw.slice(i + 1));
}

/** A real calendar date in YYYY-MM-DD form. */
export function isIsoDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [y, m, d] = value.split('-').map(Number);
  const dt = new Date(y, m - 1, d);
  return dt.getFullYear() === y && dt.getMonth() === m - 1 && dt.getDate() === d;
}
