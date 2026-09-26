/*
 * days.js — logging. Days own their target snapshot; Meal Instances are historical snapshots.
 *
 *   Meal (Library/Saved) or a single Food
 *     → calculate with the current Foods (macros.js)
 *     → Meal Instance snapshot: Food IDs, Food names, quantities, units, per-ingredient
 *       P/C/F, totals, meal name, slot, source meal ID, loggedAt
 *     → stored in the Day
 *
 * After logging, a Meal Instance never reads from Foods or Meals again, so later edits to
 * (or deletion of) a Food, a Saved Meal or current targets cannot change it.
 * Days are created when needed; nothing here invents history.
 *
 * Day completeness is the user's explicit declaration (loggingComplete), never inferred
 * from which slots hold food: a missing slot is "not logged", and no slot is required.
 *
 * Target context: a Day's targetSnapshot changes only by an explicit action —
 *   updateDayType               correcting the type; the snapshot it replaces is kept in
 *                               priorTargetSnapshots and restored if the type is chosen again
 *   applyCurrentTargetsToToday  today only, on request
 * Changing current targets never touches an existing Day.
 */

import { DomainError, clone, assertDate, assertDayType, assertMealSlot } from './util.js';
import { MEAL_SLOTS } from './constants.js';
import { calculateMealMacros, rescaleSnapshotIngredient, sumMacros, pickMacros, zeroMacros, targetStatus, MACROS } from './macros.js';

export function createDaysApi(ctx, { meals, targets }) {
  const { store } = ctx;

  const findDay = (date) => store.get('days').find((d) => d.date === date) || null;

  function saveDay(day) {
    const others = store.get('days').filter((d) => d.date !== day.date);
    const days = [...others, day].sort((a, b) => (a.date < b.date ? -1 : 1));
    store.commit({ days });
  }

  function newDay(date, dayType) {
    return { id: `day_${date}`, date, dayType, targetSnapshot: targets.createTargetSnapshot(dayType), loggingComplete: false, mealInstances: [] };
  }

  const sameMacros = (a, b) => MACROS.every((m) => a[m] === b[m]);

  /** Logged P/C/F of a list of Meal Instances (zero when empty). */
  const loggedOf = (instances) => (instances.length ? sumMacros(instances.map((mi) => mi.totals)) : zeroMacros());

  /** Where a set of instances stands against a target: { logged, remaining, reached, overBy }. */
  function standing(target, instances) {
    const logged = loggedOf(instances);
    return { logged, ...targetStatus(target, logged) };
  }

  /**
   * Calculate a Meal Instance from a Meal and/or an ingredient list without saving it.
   * Returns { source, name, calc } — calc is calculateMealMacros' result (never throws for
   * data problems); throws only for a Meal ID that does not exist.
   */
  function draftInstance({ mealId, ingredients, mealName }) {
    let source = null;
    if (mealId) {
      source = meals._findMeal(mealId);
      if (!source) throw new DomainError('MEAL_NOT_FOUND', `no Meal ${mealId}`);
    }
    if (ingredients !== undefined && !Array.isArray(ingredients)) throw new DomainError('INVALID_MEAL_INSTANCE', 'ingredients must be a list');
    (ingredients || []).forEach((i, k) => {
      if (i && typeof i.quantity === 'number' && !Number.isFinite(i.quantity)) throw new DomainError('INVALID_QUANTITY', `ingredient ${k}: quantity must be a finite number`);
    });
    const recipe = { id: mealId || 'ad-hoc', ingredients: ingredients ? clone(ingredients).map((i) => ({ unit: 'g', ...i })) : clone(source ? source.ingredients : []) };
    const calc = calculateMealMacros(recipe, ctx.lookupFood);
    const problems = calc.valid ? [] : (mealId ? meals._describe({ ...recipe, id: mealId, metadata: source.metadata }).problems : calc.problems);
    return { source, recipe, name: mealName || (source ? source.name : null), calc: { ...calc, problems } };
  }

  /**
   * Apply an edit to one Meal Instance and return the edited copy (nothing is saved).
   * An ingredient already in the snapshot is re-scaled from the snapshot's own values;
   * a new ingredient is calculated from the current Food.
   */
  function patchedInstance(mi, patch) {
    const out = clone(mi);
    if ('id' in patch && patch.id !== mi.id) throw new DomainError('IMMUTABLE_ID', 'Meal Instance IDs never change');
    if ('mealSlot' in patch) { assertMealSlot(patch.mealSlot); out.mealSlot = patch.mealSlot; }
    if ('mealName' in patch) {
      if (!patch.mealName) throw new DomainError('INVALID_MEAL_INSTANCE', 'mealName cannot be empty');
      out.mealName = patch.mealName;
    }
    if ('ingredients' in patch) {
      if (!Array.isArray(patch.ingredients) || !patch.ingredients.length) throw new DomainError('INVALID_MEAL_INSTANCE', 'a Meal Instance needs at least one ingredient');
      const unused = out.ingredients.slice();
      const next = patch.ingredients.map((ing, i) => {
        const unit = ing.unit === undefined ? 'g' : ing.unit;
        const k = unused.findIndex((s) => s.foodId === ing.foodId && s.unit === unit);
        if (k >= 0) {
          const [snap] = unused.splice(k, 1);
          if (!(typeof ing.quantity === 'number' && Number.isFinite(ing.quantity) && ing.quantity > 0)) throw new DomainError('INVALID_QUANTITY', `ingredient ${i}: quantity must be > 0`);
          return rescaleSnapshotIngredient(snap, ing.quantity);
        }
        const calc = calculateMealMacros({ id: mi.id, ingredients: [{ foodId: ing.foodId, quantity: ing.quantity, unit }] }, ctx.lookupFood);
        if (!calc.valid) throw new DomainError(calc.needsReplacement ? 'FOOD_NOT_FOUND' : 'MEAL_INVALID', `ingredient ${i}: ${calc.problems[0].message}`, calc.problems);
        return snapshotFrom(calc).ingredients[0];
      });
      out.ingredients = next;
      out.totals = sumMacros(next.map(pickMacros));
    }
    return out;
  }

  function newInstanceId() {
    const taken = new Set(store.get('days').flatMap((d) => d.mealInstances.map((mi) => mi.id)));
    let id;
    do { id = `mi_${ctx.newId()}`; } while (taken.has(id));
    return id;
  }

  /** Turn a successful calculation into snapshot ingredients + totals. */
  function snapshotFrom(calc) {
    const ingredients = calc.ingredients.map((i) => ({
      foodId: i.foodId, foodName: i.foodName, quantity: i.quantity, unit: i.unit, ...pickMacros(i)
    }));
    return { ingredients, totals: sumMacros(ingredients.map(pickMacros)) };
  }

  function dayForLogging(date, dayType) {
    assertDate(date);
    const existing = findDay(date);
    if (existing) return clone(existing);
    if (dayType === undefined) throw new DomainError('DAY_TYPE_REQUIRED', `no Day for ${date} yet; pass dayType (lift | long_run | rest) to create it`);
    assertDayType(dayType);
    return newDay(date, dayType);
  }

  function instanceOrThrow(day, instanceId) {
    const mi = day && day.mealInstances.find((x) => x.id === instanceId);
    if (!mi) throw new DomainError('MEAL_INSTANCE_NOT_FOUND', `no Meal Instance ${instanceId}${day ? ` on ${day.date}` : ''}`);
    return mi;
  }

  const api = {
    getDay(date) {
      assertDate(date);
      const d = findDay(date);
      return d ? clone(d) : null;
    },

    /** Days in an inclusive date range (or all Days), oldest first. */
    listDays({ startDate, endDate } = {}) {
      return clone(store.get('days').filter((d) => (!startDate || d.date >= startDate) && (!endDate || d.date <= endDate)));
    },

    /** Create an empty Day with a snapshot of the current targets for its day type. */
    createDay(date, dayType) {
      assertDate(date);
      assertDayType(dayType);
      if (findDay(date)) throw new DomainError('DAY_EXISTS', `a Day for ${date} already exists`);
      const day = newDay(date, dayType);
      saveDay(day);
      return clone(day);
    },

    /**
     * Correct a Day's type (today or any past Day). Logged Meal Instances are never touched.
     *   - same type as now: no-op, nothing is written
     *   - the snapshot being replaced is kept in priorTargetSnapshots[oldType]
     *   - if the Day has held the new type before, that earlier snapshot is restored
     *     (so Lift → Rest → Lift gives back exactly the original Lift targets)
     *   - otherwise the snapshot comes from the current targets for the new type
     * Use previewDayTypeChange to show the user which of these will happen.
     */
    updateDayType(date, dayType) {
      assertDate(date);
      assertDayType(dayType);
      const current = findDay(date);
      if (!current) throw new DomainError('DAY_NOT_FOUND', `no Day for ${date}`);
      if (current.dayType === dayType) return clone(current);
      const { to } = describeTypeChange(current, dayType);
      const prior = { ...clone(current.priorTargetSnapshots || {}), [current.dayType]: clone(current.targetSnapshot) };
      delete prior[dayType];
      const next = clone(current);
      next.dayType = dayType;
      next.targetSnapshot = to.target;
      next.priorTargetSnapshots = prior;
      saveDay(next);
      return clone(next);
    },

    /**
     * What updateDayType(date, dayType) would do, without doing it:
     * { date, noOp, from: { dayType, target }, to: { dayType, target, targetSource },
     *   before, after }  — targetSource is 'unchanged' | 'restored' | 'current';
     * before/after are the Day's standing (logged food is identical in both).
     */
    previewDayTypeChange(date, dayType) {
      assertDate(date);
      assertDayType(dayType);
      const current = findDay(date);
      if (!current) throw new DomainError('DAY_NOT_FOUND', `no Day for ${date}`);
      const { from, to } = describeTypeChange(current, dayType);
      return {
        date,
        noOp: to.targetSource === 'unchanged',
        from,
        to,
        before: standing(from.target, current.mealInstances),
        after: standing(to.target, current.mealInstances)
      };
    },

    /**
     * The local calendar date the data layer treats as today (YYYY-MM-DD, device time zone).
     */
    getToday() {
      return ctx.today();
    },

    /**
     * Explicitly re-take TODAY's target snapshot from the current targets for its day type.
     * Only today's Day can change this way; no other Day is touched. Logged food and the
     * day type are unchanged; current targets stay as they are. No-op (nothing written)
     * when today's snapshot already equals the current targets.
     */
    applyCurrentTargetsToToday() {
      const date = ctx.today();
      const current = findDay(date);
      if (!current) throw new DomainError('DAY_NOT_FOUND', `no Day for today (${date})`);
      const fresh = targets.createTargetSnapshot(current.dayType);
      if (sameMacros(fresh, current.targetSnapshot)) return clone(current);
      const next = clone(current);
      next.targetSnapshot = fresh;
      saveDay(next);
      return clone(next);
    },

    /** Delete a Day: its Meal Instances and target snapshot for that date only. */
    deleteDay(date) {
      assertDate(date);
      if (!findDay(date)) throw new DomainError('DAY_NOT_FOUND', `no Day for ${date}`);
      store.commit({ days: store.get('days').filter((d) => d.date !== date) });
      return { deletedDate: date };
    },

    /**
     * Log a Meal Instance.
     *   { date, mealSlot, mealId }                 log a Library or Saved Meal as it is now
     *   { date, mealSlot, mealId, ingredients }    log a modified version (the Meal is unchanged)
     *   { date, mealSlot, ingredients, mealName }  log ingredients with no source Meal
     * dayType is needed only when the Day does not exist yet. mealType never restricts the slot.
     */
    createMealInstance({ date, mealSlot, mealId, ingredients, mealName, dayType } = {}) {
      assertMealSlot(mealSlot);
      const day = dayForLogging(date, dayType);
      const { source, name, calc } = draftInstance({ mealId, ingredients, mealName });
      if (!calc.valid) {
        throw new DomainError(calc.needsReplacement ? 'MEAL_NEEDS_REPLACEMENT' : 'MEAL_INVALID', 'cannot log: some ingredients cannot be calculated', calc.problems);
      }
      if (!name) throw new DomainError('INVALID_MEAL_INSTANCE', 'mealName is required when logging without a Meal');
      const instance = {
        id: newInstanceId(),
        sourceMealId: source ? source.id : null,
        mealName: name,
        mealSlot,
        ...snapshotFrom(calc),
        loggedAt: ctx.now()
      };
      day.mealInstances.push(instance);
      saveDay(day);
      return clone(instance);
    },

    /** Log one Food directly, without a Saved Meal. The snapshot is the same shape. */
    logFood({ date, mealSlot, foodId, quantity, unit = 'g', mealName, dayType } = {}) {
      const food = ctx.lookupFood(foodId);
      if (!food) throw new DomainError('FOOD_NOT_FOUND', `no Food ${foodId}`);
      return api.createMealInstance({ date, mealSlot, dayType, mealName: mealName || food.name, ingredients: [{ foodId, quantity, unit }] });
    },

    /**
     * Edit one logged Meal Instance; nothing else changes (not the Saved Meal, not the Food).
     * Patch: { mealSlot, mealName, ingredients: [{ foodId, quantity, unit }] }.
     * An ingredient already in the snapshot is re-scaled from the snapshot's own values
     * (so it still works if the Food was later edited or deleted); a new ingredient is
     * calculated from the current Food.
     */
    updateMealInstance(date, instanceId, patch = {}) {
      assertDate(date);
      const day = clone(findDay(date));
      const mi = instanceOrThrow(day, instanceId);
      const next = patchedInstance(mi, patch);
      day.mealInstances = day.mealInstances.map((x) => (x.id === instanceId ? next : x));
      saveDay(day);
      return clone(next);
    },

    deleteMealInstance(date, instanceId) {
      assertDate(date);
      const day = clone(findDay(date));
      instanceOrThrow(day, instanceId);
      day.mealInstances = day.mealInstances.filter((x) => x.id !== instanceId);
      // "Done logging" needs something logged: removing the last meal reopens the Day.
      if (!day.mealInstances.length) day.loggingComplete = false;
      saveDay(day);
      return { deletedMealInstanceId: instanceId };
    },

    /* ---------------- day completeness (explicit, never inferred) ---------------- */

    /**
     * Mark a Day as done logging (true) or reopen it (false). This is the only thing that
     * makes a Day 'complete'; which slots hold food never does. A Day with nothing logged
     * cannot be marked done (NOTHING_LOGGED). Logged food is not touched.
     */
    setDayLoggingComplete(date, complete) {
      assertDate(date);
      if (typeof complete !== 'boolean') throw new DomainError('INVALID_ARGUMENT', 'complete must be true or false');
      const current = findDay(date);
      if (!current) throw new DomainError('DAY_NOT_FOUND', `no Day for ${date}`);
      if (complete && !current.mealInstances.length) throw new DomainError('NOTHING_LOGGED', `nothing is logged on ${date}; log food before marking the day done`);
      if (current.loggingComplete === complete) return clone(current);
      const next = clone(current);
      next.loggingComplete = complete;
      saveDay(next);
      return clone(next);
    },

    /* ---------------- previews: calculate without saving anything ---------------- */

    /**
     * What logging a Meal or a list of ingredients would do, without logging it.
     *   { mealId? , ingredients?, mealName?, date?, mealSlot?, dayType? }
     * Returns {
     *   valid, needsReplacement, problems, ingredients, totals (null when invalid),
     *   day: null | { date, dayType, targetSource: 'day_snapshot' | 'current', target,
     *                 before: { logged, remaining, reached, overBy },
     *                 after:  { logged, remaining, reached, overBy } | null },
     *   dayTypeRequired   true when date has no Day and no dayType was given
     * }
     * Never writes and never creates a Day.
     */
    previewMealInstance({ date, mealSlot, mealId, ingredients, mealName, dayType } = {}) {
      if (mealSlot !== undefined) assertMealSlot(mealSlot);
      const { calc, name } = draftInstance({ mealId, ingredients, mealName });
      const out = {
        mealName: name,
        valid: calc.valid,
        needsReplacement: calc.needsReplacement,
        problems: calc.problems,
        ingredients: calc.ingredients,
        totals: calc.totals,
        day: null,
        dayTypeRequired: false
      };
      if (date === undefined) return out;
      assertDate(date);
      const existing = findDay(date);
      let target; let resolvedType; let targetSource; let instances;
      if (existing) {
        target = existing.targetSnapshot; resolvedType = existing.dayType; targetSource = 'day_snapshot'; instances = existing.mealInstances;
      } else if (dayType !== undefined) {
        assertDayType(dayType);
        target = targets.createTargetSnapshot(dayType); resolvedType = dayType; targetSource = 'current'; instances = [];
      } else {
        out.dayTypeRequired = true;
        return out;
      }
      const before = standing(target, instances);
      const after = calc.valid ? standing(target, [...instances, { totals: calc.totals }]) : null;
      out.day = { date, dayType: resolvedType, targetSource, target: clone(target), before, after };
      return out;
    },

    /** Convenience: previewMealInstance for one Food and a quantity. */
    previewLogFood({ date, mealSlot, foodId, quantity, unit = 'g', dayType } = {}) {
      const food = ctx.lookupFood(foodId);
      if (!food) throw new DomainError('FOOD_NOT_FOUND', `no Food ${foodId}`);
      return api.previewMealInstance({ date, mealSlot, dayType, mealName: food.name, ingredients: [{ foodId, quantity, unit }] });
    },

    /**
     * What updateMealInstance(date, instanceId, patch) would produce, without saving.
     * Returns { instance, before, after } where before/after are the Day's standing.
     * Throws the same errors updateMealInstance would.
     */
    previewMealInstanceUpdate(date, instanceId, patch = {}) {
      assertDate(date);
      const day = findDay(date);
      const mi = instanceOrThrow(day, instanceId);
      const next = patchedInstance(mi, patch);
      const instancesAfter = day.mealInstances.map((x) => (x.id === instanceId ? next : x));
      return { instance: next, before: standing(day.targetSnapshot, day.mealInstances), after: standing(day.targetSnapshot, instancesAfter) };
    },

    /**
     * What Today needs, derived from the stored Day only:
     * target (the Day's snapshot), logged, remaining = target − logged, and which slots
     * have food. A slot with nothing logged is "not logged", never zero intake.
     */
    getDaySummary(date) {
      assertDate(date);
      const day = findDay(date);
      if (!day) return { date, exists: false, dayType: null, status: 'no_data', loggingComplete: false, target: null, logged: null, remaining: null, reached: null, overBy: null, progress: null, loggedSlots: [], unloggedSlots: MEAL_SLOTS.slice(), instanceCount: 0 };
      return summarize(day);
    },

    _summarize: summarize
  };

  /**
   * Status: 'no_data' (nothing logged — never zero intake), 'complete' (the user marked the
   * Day done logging), otherwise 'partial'. loggedSlots is information only: it never
   * decides the status.
   */
  function summarize(day) {
    const loggedSlots = MEAL_SLOTS.filter((s) => day.mealInstances.some((mi) => mi.mealSlot === s));
    const status = !day.mealInstances.length ? 'no_data' : day.loggingComplete === true ? 'complete' : 'partial';
    const logged = day.mealInstances.length ? loggedOf(day.mealInstances) : null;
    const st = targetStatus(day.targetSnapshot, logged || zeroMacros());
    return {
      date: day.date,
      exists: true,
      dayType: day.dayType,
      status,
      loggingComplete: day.loggingComplete === true,
      target: clone(day.targetSnapshot),
      logged,
      remaining: st.remaining,
      reached: st.reached,
      overBy: st.overBy,
      progress: st.progress,
      loggedSlots,
      unloggedSlots: MEAL_SLOTS.filter((s) => !loggedSlots.includes(s)),
      instanceCount: day.mealInstances.length
    };
  }

  /** from/to target context for a day-type change (see updateDayType). */
  function describeTypeChange(day, dayType) {
    const from = { dayType: day.dayType, target: clone(day.targetSnapshot) };
    if (day.dayType === dayType) return { from, to: { dayType, target: clone(day.targetSnapshot), targetSource: 'unchanged' } };
    const restored = day.priorTargetSnapshots && day.priorTargetSnapshots[dayType];
    return {
      from,
      to: restored
        ? { dayType, target: clone(restored), targetSource: 'restored' }
        : { dayType, target: targets.createTargetSnapshot(dayType), targetSource: 'current' }
    };
  }

  return api;
}
