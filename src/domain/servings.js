/*
 * servings.js — named servings: an alternate way to enter an amount (V3 Slice 1 · C6).
 *
 * Grams stay canonical. A serving is a user-managed definition — a label and its weight in
 * grams — kept in userFoodData next to the Food it belongs to (by foodId). Core Food and
 * Custom Food records are never changed to add one. Logging still records grams: the
 * serving is resolved to a canonical gram quantity (macros.servingQuantity) before preview,
 * logging or the meal tray see it.
 *
 *   getServings(foodId)                        the Food's servings, in order; the first is the default
 *   createServing(foodId, { label, grams, approximate })
 *                                              one new serving, appended, in one commit
 *   resolveAmount(foodId, amount)              { quantity, unit: 'g', text, rounded, serving }
 *       amount: { quantity }                    grams, passed through as given
 *            or { servingId, count }            a serving × a count typed as text (parseServingCount)
 *   parseServingCount(text)                    { n, d } (positive BigInts, lowest terms) or null
 *   isUnfinishedServingCount(text)             true while a count is still being typed ("1.", "1/", "1 1/", "0")
 *   parseServingGrams(text)                    a serving weight typed as text → a number, or null
 *   updateServing(foodId, servingId, patch)    change label / grams / approximate; same ID, place, createdAt
 *   deleteServing(foodId, servingId)           remove it and retire its ID, in one commit
 *   setDefaultServing(foodId, servingId)       move it to the front (the default); nothing else changes
 *
 * Deleting a Custom Food retires its serving IDs (foods.js deleteCustomFood). Serving IDs, live
 * and retired, are never reused: a new ID is drawn until it is unused, a bounded number of
 * times, and an ID never changes. Every change is one commit; a rejected one writes nothing.
 */

import { DomainError, clone } from './util.js';
import { decimalPlaces, servingQuantity } from './macros.js';

/** The quick-pick counts, in order, as the text they put in the count field. */
export const SERVING_COUNT_QUICK_PICKS = Object.freeze(['1/4', '1/2', '3/4', '1', '2']);
/** Most decimal places a new serving's weight may have (the canonical quantity is to 0.01 g). */
export const SERVING_GRAMS_MAX_DECIMALS = 2;
/** How many fresh IDs createServing draws before giving up. */
export const SERVING_ID_ATTEMPTS = 5;

// The same rules store.js enforces on every commit; repeated here so a bad input is reported
// as a serving problem with a field, not as a failed write.
const SERVING_ID = /^srv_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const RESERVED_LABELS = new Set(['g', 'gram', 'grams']);
const labelKey = (label) => label.trim().toLowerCase();
const COUNT_MAX_LENGTH = 24;

const gcd = (a, b) => { while (b) [a, b] = [b, a % b]; return a; };
function fraction(n, d) {
  if (n <= 0n || d <= 0n) return null;
  const g = gcd(n, d);
  return { n: n / g, d: d / g };
}

/**
 * A serving count typed by the user → an exact fraction, or null.
 * Accepted (surrounding spaces ignored):
 *   whole numbers      2
 *   decimals           1.5   .5   1,5   ,5   (a decimal comma, as in the grams field)
 *   simple fractions   1/2   3/4
 *   mixed numbers      1 1/2 (whole, one or more spaces, a proper fraction; 0 1/2 is ½)
 * Rejected: blank, zero, negative or signed numbers, stacked fractions (1/2/3), a zero
 * denominator, exponents (1e2), Infinity / NaN, hex, any other text — and an unfinished
 * entry such as "1." or "1/" (isUnfinishedServingCount), so it can never be logged as typed.
 */
export function parseServingCount(text) {
  const t = String(text == null ? '' : text).trim();
  if (!t || t.length > COUNT_MAX_LENGTH) return null;
  let m = /^(\d+)\s+(\d+)\/(\d+)$/.exec(t);
  if (m) {
    const [w, a, b] = [BigInt(m[1]), BigInt(m[2]), BigInt(m[3])];
    if (b === 0n || a === 0n || a >= b) return null;
    return fraction(w * b + a, b);
  }
  m = /^(\d+)\/(\d+)$/.exec(t);
  if (m) {
    const [a, b] = [BigInt(m[1]), BigInt(m[2])];
    return b === 0n ? null : fraction(a, b);
  }
  m = /^(\d*)(?:[.,](\d+))?$/.exec(t);
  if (m && (m[1] || m[2])) {
    const frac = m[2] || '';
    return fraction(BigInt((m[1] || '0') + frac), 10n ** BigInt(frac.length));
  }
  return null;
}

/**
 * True for a count that is part-way typed towards an accepted one: a number ending in its
 * decimal separator ("1.", "0,", "."), a fraction without its denominator ("1/"), or a mixed
 * number without its fraction ("1 1", "1 1/"), or a lone 0 (on its way to "0.5" or "0 1/2").
 * parseServingCount rejects all of these, so none of them is ever an amount: the screen shows
 * no error while the user is still typing, nothing can be logged, and pressing Log or Add to a
 * meal shows the count message.
 */
export function isUnfinishedServingCount(text) {
  const t = String(text == null ? '' : text).trim();
  return t.length <= COUNT_MAX_LENGTH && /^(?:\d*[.,]|\d+\/|\d+\s+\d+\/?|0)$/.test(t);
}

/**
 * A serving weight typed into the Add a serving form → a number, or null. Digits with an
 * optional decimal part (45, 45.5, 45,5, .5); surrounding spaces ignored. Anything else —
 * "45." (unfinished), "1e2", "0x10", "Infinity", signs, text — is null, which createServing
 * reports as INVALID_SERVING_GRAMS. Whether it's above 0 with at most 2 decimal places is
 * createServing's check.
 */
export function parseServingGrams(text) {
  const t = String(text == null ? '' : text).trim();
  if (!/^(?:\d+(?:[.,]\d+)?|[.,]\d+)$/.test(t)) return null;
  return Number(t.replace(',', '.'));
}

export function createServingsApi(ctx) {
  const { store } = ctx;
  const userFoodData = () => store.get('userFoodData');
  const recordFor = (foodId) => userFoodData().foods.find((r) => r.foodId === foodId) || null;

  function foodOrThrow(foodId) {
    const food = ctx.lookupFood(foodId);
    if (!food) throw new DomainError('FOOD_NOT_FOUND', `no Food ${foodId}`);
    return food;
  }

  /**
   * Every problem with a serving as it would be stored for this Food: [{ field, code, message }].
   *   selfId       the serving being edited (its own label is not a duplicate of itself)
   *   storedGrams  its weight as stored: kept unchanged, it isn't re-checked against the 2-decimal
   *                limit (a restored weight may have more places); a changed weight always is
   */
  function servingProblems(foodId, input, { selfId = null, storedGrams } = {}) {
    const errors = [];
    const label = typeof input.label === 'string' ? input.label.trim() : '';
    if (!label) errors.push({ field: 'label', code: 'SERVING_LABEL_REQUIRED', message: 'a serving needs a name' });
    else if (RESERVED_LABELS.has(labelKey(label))) errors.push({ field: 'label', code: 'SERVING_LABEL_RESERVED', message: `"${label}" is reserved for grams` });
    else {
      const record = recordFor(foodId);
      if (record && record.servings.some((s) => s.id !== selfId && labelKey(s.label) === labelKey(label))) {
        errors.push({ field: 'label', code: 'SERVING_LABEL_DUPLICATE', message: `this Food already has a serving named "${label}"` });
      }
    }
    const places = selfId !== null && input.grams === storedGrams ? 0 : decimalPlaces(input.grams);
    if (places === null) errors.push({ field: 'grams', code: 'INVALID_SERVING_GRAMS', message: 'grams must be a number above 0' });
    else if (places > SERVING_GRAMS_MAX_DECIMALS) errors.push({ field: 'grams', code: 'INVALID_SERVING_GRAMS', message: `grams may have at most ${SERVING_GRAMS_MAX_DECIMALS} decimal places` });
    if (input.approximate !== undefined && typeof input.approximate !== 'boolean') {
      errors.push({ field: 'approximate', code: 'INVALID_ARGUMENT', message: 'approximate must be true or false' });
    }
    return errors;
  }

  /** A serving ID not used by any live or retired serving; SERVING_ID_UNAVAILABLE after SERVING_ID_ATTEMPTS draws. */
  function newServingId() {
    const ufd = userFoodData();
    const taken = new Set(ufd.retiredServingIds);
    for (const r of ufd.foods) for (const s of r.servings) taken.add(s.id);
    for (let i = 0; i < SERVING_ID_ATTEMPTS; i++) {
      const id = `srv_${ctx.newUuid()}`;
      if (SERVING_ID.test(id) && !taken.has(id)) return id;
    }
    throw new DomainError('SERVING_ID_UNAVAILABLE', `no unused serving ID after ${SERVING_ID_ATTEMPTS} attempts`);
  }

  /** The Food's serving record and the serving, or the domain error for whichever is missing. */
  function servingOrThrow(foodId, servingId) {
    foodOrThrow(foodId);
    const record = recordFor(foodId);
    const serving = record ? record.servings.find((s) => s.id === servingId) : null;
    if (!serving) throw new DomainError('SERVING_NOT_FOUND', `no serving ${servingId} for ${foodId}`);
    return { record, serving };
  }

  return {
    /** The Food's servings in their stored order (copies). [] when it has none or the Food doesn't exist. */
    getServings(foodId) {
      if (!ctx.lookupFood(foodId)) return [];
      const record = recordFor(foodId);
      return record ? clone(record.servings) : [];
    },

    /**
     * Add a serving to a Core or Custom Food. Stored in userFoodData only (the Food record is
     * not touched); appended after the Food's existing servings, so the default stays first.
     * Throws FOOD_NOT_FOUND, INVALID_SERVING (details: [{ field, code, message }] with
     * SERVING_LABEL_REQUIRED · SERVING_LABEL_RESERVED · SERVING_LABEL_DUPLICATE ·
     * INVALID_SERVING_GRAMS · INVALID_ARGUMENT) or SERVING_ID_UNAVAILABLE. Nothing is written
     * unless the whole serving is valid. Returns the stored serving.
     */
    createServing(foodId, input = {}) {
      foodOrThrow(foodId);
      const errors = servingProblems(foodId, input || {});
      if (errors.length) throw new DomainError('INVALID_SERVING', errors.map((e) => e.message).join('; '), errors);
      const now = ctx.now();
      const serving = { id: newServingId(), label: input.label.trim(), grams: input.grams, approximate: input.approximate === true, createdAt: now, updatedAt: now };
      const next = clone(userFoodData());
      const record = next.foods.find((r) => r.foodId === foodId);
      if (record) record.servings.push(serving);
      else next.foods.push({ foodId, servings: [serving] });
      store.commit({ userFoodData: next });
      return clone(serving);
    },

    /**
     * Change a serving's label, grams and/or approximate flag. A field left out (or undefined)
     * keeps its value. The ID, its place in the list and createdAt never change; updatedAt is
     * now (the injected clock). The same rules as createServing, except that its own label is
     * not a duplicate (a case-only rename is fine) and an unchanged stored weight isn't held to
     * the 2-decimal limit. Throws FOOD_NOT_FOUND, SERVING_NOT_FOUND, IMMUTABLE_ID (an id in the
     * patch that isn't this one) or INVALID_SERVING (details as for createServing); nothing is
     * written unless the change is valid. Returns the stored serving.
     */
    updateServing(foodId, servingId, patch = {}) {
      const { serving } = servingOrThrow(foodId, servingId);
      const p = patch || {};
      if (p.id !== undefined && p.id !== servingId) throw new DomainError('IMMUTABLE_ID', 'serving IDs never change');
      const merged = {
        label: p.label !== undefined ? p.label : serving.label,
        grams: p.grams !== undefined ? p.grams : serving.grams,
        approximate: p.approximate !== undefined ? p.approximate : serving.approximate
      };
      const errors = servingProblems(foodId, merged, { selfId: servingId, storedGrams: serving.grams });
      if (errors.length) throw new DomainError('INVALID_SERVING', errors.map((e) => e.message).join('; '), errors);
      const updated = { id: serving.id, label: merged.label.trim(), grams: merged.grams, approximate: merged.approximate === true, createdAt: serving.createdAt, updatedAt: ctx.now() };
      const next = clone(userFoodData());
      const record = next.foods.find((r) => r.foodId === foodId);
      record.servings = record.servings.map((s) => (s.id === servingId ? updated : s));
      store.commit({ userFoodData: next });
      return clone(updated);
    },

    /**
     * Delete a serving: it leaves the Food's list and its ID is retired (never reused), in one
     * commit. Deleting the Food's last serving removes the Food's whole serving record in that
     * same commit. The Food itself is never touched, and meals already logged are unaffected
     * (they hold grams). Throws FOOD_NOT_FOUND or SERVING_NOT_FOUND without writing.
     * Returns { deletedServingId, remaining } — remaining: the Food's servings now, in order.
     */
    deleteServing(foodId, servingId) {
      servingOrThrow(foodId, servingId);
      const next = clone(userFoodData());
      const record = next.foods.find((r) => r.foodId === foodId);
      const remaining = record.servings.filter((s) => s.id !== servingId);
      next.foods = remaining.length
        ? next.foods.map((r) => (r.foodId === foodId ? { ...r, servings: remaining } : r))
        : next.foods.filter((r) => r.foodId !== foodId);
      if (!next.retiredServingIds.includes(servingId)) next.retiredServingIds.push(servingId);
      store.commit({ userFoodData: next });
      return { deletedServingId: servingId, remaining: clone(remaining) };
    },

    /**
     * Make a serving the Food's default by moving it to the front. Every serving keeps its ID,
     * definition and timestamps; the others keep their order. Already first: nothing is
     * written. Throws FOOD_NOT_FOUND or SERVING_NOT_FOUND without writing.
     * Returns { changed, servings } — servings: the Food's servings now, in order.
     */
    setDefaultServing(foodId, servingId) {
      const { record } = servingOrThrow(foodId, servingId);
      if (record.servings[0].id === servingId) return { changed: false, servings: clone(record.servings) };
      const next = clone(userFoodData());
      const target = next.foods.find((r) => r.foodId === foodId);
      const chosen = target.servings.find((s) => s.id === servingId);
      target.servings = [chosen, ...target.servings.filter((s) => s.id !== servingId)];
      store.commit({ userFoodData: next });
      return { changed: true, servings: clone(target.servings) };
    },

    /**
     * An amount as the canonical gram quantity every caller uses.
     *   { quantity }           grams as given (> 0, finite); text is String(quantity)
     *   { servingId, count }   count is the text typed (parseServingCount); the serving must be
     *                          one of this Food's servings now
     * Returns { quantity, unit: 'g', text, rounded, serving }, serving being
     * { id, label, grams, approximate } or null for grams.
     * Throws AMOUNT_AMBIGUOUS (neither or both forms), FOOD_NOT_FOUND, INVALID_QUANTITY,
     * SERVING_NOT_FOUND, INVALID_SERVING_COUNT, AMOUNT_TOO_SMALL (rounds to 0 g).
     */
    resolveAmount(foodId, amount = {}) {
      const a = amount || {};
      const grams = 'quantity' in a;
      const serving = 'servingId' in a || 'count' in a;
      if (grams === serving) throw new DomainError('AMOUNT_AMBIGUOUS', 'give either a quantity in grams or a serving and a count');
      foodOrThrow(foodId);
      if (grams) {
        const q = a.quantity;
        if (!(typeof q === 'number' && Number.isFinite(q) && q > 0)) throw new DomainError('INVALID_QUANTITY', `quantity must be > 0, got ${q}`);
        return { quantity: q, unit: 'g', text: String(q), rounded: false, serving: null };
      }
      const record = recordFor(foodId);
      const s = record ? record.servings.find((x) => x.id === a.servingId) : null;
      if (!s) throw new DomainError('SERVING_NOT_FOUND', `no serving ${a.servingId} for ${foodId}`);
      const count = parseServingCount(a.count);
      if (!count) throw new DomainError('INVALID_SERVING_COUNT', `not a serving count: ${JSON.stringify(a.count)}`);
      const r = servingQuantity(s.grams, count);
      if (r.centigrams > BigInt(Number.MAX_SAFE_INTEGER)) throw new DomainError('INVALID_SERVING_COUNT', 'that amount is too large');
      if (r.centigrams === 0n) throw new DomainError('AMOUNT_TOO_SMALL', 'the amount rounds to 0 g');
      return { quantity: r.quantity, unit: 'g', text: r.text, rounded: r.rounded, serving: { id: s.id, label: s.label, grams: s.grams, approximate: s.approximate } };
    }
  };
}
