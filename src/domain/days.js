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
 */

import { DomainError, clone, assertDate, assertDayType, assertMealSlot } from './util.js';
import { MEAL_SLOTS } from './constants.js';
import { calculateMealMacros, rescaleSnapshotIngredient, sumMacros, subtractMacros, pickMacros, zeroMacros } from './macros.js';

export function createDaysApi(ctx, { meals, targets }) {
  const { store } = ctx;

  const findDay = (date) => store.get('days').find((d) => d.date === date) || null;

  function saveDay(day) {
    const others = store.get('days').filter((d) => d.date !== day.date);
    const days = [...others, day].sort((a, b) => (a.date < b.date ? -1 : 1));
    store.commit({ days });
  }

  function newDay(date, dayType) {
    return { id: `day_${date}`, date, dayType, targetSnapshot: targets.createTargetSnapshot(dayType), mealInstances: [] };
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
     * Change a Day's type. The target context changes (the snapshot is re-taken from the
     * current targets for the new type); logged Meal Instances are not touched.
     */
    updateDayType(date, dayType) {
      assertDate(date);
      assertDayType(dayType);
      const current = findDay(date);
      if (!current) throw new DomainError('DAY_NOT_FOUND', `no Day for ${date}`);
      const next = clone(current);
      next.dayType = dayType;
      next.targetSnapshot = targets.createTargetSnapshot(dayType);
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
      let source = null;
      if (mealId) {
        source = meals._findMeal(mealId);
        if (!source) throw new DomainError('MEAL_NOT_FOUND', `no Meal ${mealId}`);
      }
      const recipe = { id: mealId || 'ad-hoc', ingredients: ingredients ? clone(ingredients).map((i) => ({ unit: 'g', ...i })) : clone(source ? source.ingredients : []) };
      const calc = calculateMealMacros(recipe, ctx.lookupFood);
      if (!calc.valid) {
        throw new DomainError(calc.needsReplacement ? 'MEAL_NEEDS_REPLACEMENT' : 'MEAL_INVALID', 'cannot log: some ingredients cannot be calculated', mealId ? meals._describe({ ...recipe, id: mealId, metadata: source.metadata }).problems : calc.problems);
      }
      const name = mealName || (source ? source.name : null);
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
      if ('id' in patch && patch.id !== instanceId) throw new DomainError('IMMUTABLE_ID', 'Meal Instance IDs never change');
      if ('mealSlot' in patch) { assertMealSlot(patch.mealSlot); mi.mealSlot = patch.mealSlot; }
      if ('mealName' in patch) {
        if (!patch.mealName) throw new DomainError('INVALID_MEAL_INSTANCE', 'mealName cannot be empty');
        mi.mealName = patch.mealName;
      }
      if ('ingredients' in patch) {
        if (!Array.isArray(patch.ingredients) || !patch.ingredients.length) throw new DomainError('INVALID_MEAL_INSTANCE', 'a Meal Instance needs at least one ingredient');
        const unused = mi.ingredients.slice();
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
        mi.ingredients = next;
        mi.totals = sumMacros(next.map(pickMacros));
      }
      saveDay(day);
      return clone(mi);
    },

    deleteMealInstance(date, instanceId) {
      assertDate(date);
      const day = clone(findDay(date));
      instanceOrThrow(day, instanceId);
      day.mealInstances = day.mealInstances.filter((x) => x.id !== instanceId);
      saveDay(day);
      return { deletedMealInstanceId: instanceId };
    },

    /**
     * What Today needs, derived from the stored Day only:
     * target (the Day's snapshot), logged, remaining = target − logged, and which slots
     * have food. A slot with nothing logged is "not logged", never zero intake.
     */
    getDaySummary(date) {
      assertDate(date);
      const day = findDay(date);
      if (!day) return { date, exists: false, dayType: null, status: 'no_data', target: null, logged: null, remaining: null, loggedSlots: [], unloggedSlots: MEAL_SLOTS.slice(), instanceCount: 0 };
      return summarize(day);
    },

    _summarize: summarize
  };

  function summarize(day) {
    const loggedSlots = MEAL_SLOTS.filter((s) => day.mealInstances.some((mi) => mi.mealSlot === s));
    const status = !day.mealInstances.length ? 'no_data' : loggedSlots.length === MEAL_SLOTS.length ? 'complete' : 'partial';
    const logged = day.mealInstances.length ? sumMacros(day.mealInstances.map((mi) => mi.totals)) : null;
    return {
      date: day.date,
      exists: true,
      dayType: day.dayType,
      status,
      target: clone(day.targetSnapshot),
      logged,
      remaining: subtractMacros(day.targetSnapshot, logged || zeroMacros()),
      loggedSlots,
      unloggedSlots: MEAL_SLOTS.filter((s) => !loggedSlots.includes(s)),
      instanceCount: day.mealInstances.length
    };
  }

  return api;
}
