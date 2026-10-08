/*
 * generate.mjs — builds the synthetic V1 fixture by driving the FROZEN V1 app in
 * tests/fixtures/v1-app (byte copies of commit 936753b, see manifest.json).
 *
 * Pure: buildV1Fixture() returns { backup, storeRecord } and never writes a file.
 * build-reference.mjs is the only writer of the committed fixture files.
 *
 * Every value is synthetic. The frozen app starts from the synthetic seed exceptions
 * (user-data/custom-foods.json, data/targets.json); nothing here comes from a real backup,
 * real browser storage, real Custom Foods or real targets. Clock, today and IDs are injected,
 * and every change is flushed before the next one, so the output is byte-for-byte repeatable.
 */

import { openBrowserDataLayer } from '../v1-app/src/browser/app-data.js';
import { createMemorySnapshotStore } from '../v1-app/src/browser/memory-snapshot-store.js';

export const FIXTURE_TODAY = '2026-08-09';
const START_MS = Date.parse('2026-08-09T09:00:00.000Z');
const TEST_BAR = 'food_custom_synthetic_test_bar'; // from the synthetic seed

export async function buildV1Fixture() {
  let t = START_MS;
  let n = 0;
  const tick = () => new Date((t += 60_000));
  const snapshotStore = createMemorySnapshotStore();
  const { app } = await openBrowserDataLayer({
    snapshotStore,
    clock: () => tick(),
    now: () => tick().toISOString(),
    today: () => FIXTURE_TODAY,
    newId: () => `syn${String(++n).padStart(3, '0')}`
  });
  const step = async (fn) => { const result = fn(); await app.flushPersistence(); return result; };

  // Custom Foods (synthetic) and Saved Meals, including a Library copy.
  const fruit = await step(() => app.createCustomFood({ name: 'Synthetic Fruit Cup', category: 'fruit', state: 'prepared', nutrition: { protein: 1, carbs: 14, fat: 0.5 }, tags: ['synthetic'] }));
  const granola = await step(() => app.createCustomFood({ name: 'Synthetic Granola Mix', category: 'grain', state: 'dry', brand: 'Synthetic Brand', nutrition: { protein: 9, carbs: 62, fat: 14 }, tags: ['synthetic'] }));
  const bowl = await step(() => app.createSavedMeal({ name: 'Synthetic Breakfast Bowl', mealType: 'breakfast', ingredients: [
    { foodId: 'food_core_fage_0_greek_yogurt', quantity: 150 }, { foodId: fruit.id, quantity: 100 }, { foodId: granola.id, quantity: 40 }] }));
  const plate = await step(() => app.createSavedMeal({ name: 'Synthetic Snack Plate', mealType: 'snack', ingredients: [
    { foodId: TEST_BAR, quantity: 50 }, { foodId: fruit.id, quantity: 80 }] }));
  await step(() => app.createSavedMeal({ fromMealId: 'meal_library_D13', name: 'Synthetic copy of a Library dinner' }));

  // 2026-08-03 · lift · done: Saved Meal, single Food, Library Meal.
  await step(() => app.createMealInstance({ date: '2026-08-03', mealSlot: 'breakfast', mealId: bowl.id, dayType: 'lift' }));
  await step(() => app.logFood({ date: '2026-08-03', mealSlot: 'snack_afternoon', foodId: TEST_BAR, quantity: 60 }));
  await step(() => app.createMealInstance({ date: '2026-08-03', mealSlot: 'dinner', mealId: 'meal_library_D13' }));
  await step(() => app.setDayLoggingComplete('2026-08-03', true));

  // 2026-08-04 · rest, corrected to long_run (keeps the replaced snapshot) · in progress.
  await step(() => app.createMealInstance({ date: '2026-08-04', mealSlot: 'snack_afternoon', mealId: plate.id, dayType: 'rest' }));
  await step(() => app.updateDayType('2026-08-04', 'long_run'));

  // Current targets change: Days created from here on take the new lift snapshot.
  await step(() => app.updateCurrentTargets('lift', { protein: 115, carbs: 225, fat: 55 }));

  // 2026-08-05 · lift · done: ad-hoc meal, then edited (grams changed, ingredient added, renamed).
  const tray = await step(() => app.createMealInstance({ date: '2026-08-05', mealSlot: 'lunch', dayType: 'lift', mealName: 'Synthetic Tray Meal', ingredients: [
    { foodId: 'food_core_sourdough', quantity: 80 }, { foodId: fruit.id, quantity: 100 }] }));
  await step(() => app.logFood({ date: '2026-08-05', mealSlot: 'breakfast', foodId: granola.id, quantity: 45 }));
  await step(() => app.updateMealInstance('2026-08-05', tray.id, { mealName: 'Synthetic Tray Meal (edited)', ingredients: [
    { foodId: 'food_core_sourdough', quantity: 100 }, { foodId: fruit.id, quantity: 100 }, { foodId: TEST_BAR, quantity: 30 }] }));
  await step(() => app.setDayLoggingComplete('2026-08-05', true));

  // 2026-08-06 · long_run · in progress: a Library Meal with adjusted grams for this time.
  const d13 = app.getMeal('meal_library_D13');
  const adjusted = d13.ingredients.map((ing, k) => (k === 0 ? { ...ing, quantity: 130 } : ing));
  await step(() => app.createMealInstance({ date: '2026-08-06', mealSlot: 'dinner', dayType: 'long_run', mealId: 'meal_library_D13', ingredients: adjusted }));

  // 2026-08-07 · rest · an empty Day.
  await step(() => app.createDay('2026-08-07', 'rest'));

  // A Custom Food deleted after use: its Saved Meal needs a replacement; history keeps its snapshot.
  await step(() => app.deleteCustomFood(granola.id));

  // Preferences.
  await step(() => app.setFavoriteFood(TEST_BAR));
  await step(() => app.setDislikedFood('food_core_onion'));
  await step(() => app.setFavoriteMeal(plate.id));
  await step(() => app.setFavoriteMeal('meal_library_D13'));
  await step(() => app.updatePreferences({ appPreferences: { fixtureSource: 'synthetic' } }));

  const backup = app.exportUserData();
  await app.flushPersistence();
  return { backup, storeRecord: snapshotStore.peek() };
}
