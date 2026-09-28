/*
 * main.js — browser entry point. Mounts the shell, then opens the data layer through the
 * approved browser contract (src/browser/app-data.js). Navigation works immediately; the
 * shell shows "Opening your data…" until the data layer is ready, or a blocking message if
 * it can't open (§13.1), with the recovery actions for stored data that can't be opened.
 */

import { openBrowserDataLayer, recoverStoredData, validateRecoveryBackup } from '../src/browser/app-data.js';
import { createShell } from './shell.js';
import { todayScreen } from './today.js';
import { logScreen } from './log.js';
import { mealsScreen } from './meals.js';
import { progressScreen } from './progress.js';
import { settingsScreen } from './settings.js';
import { downloadBackup, downloadText, localStamp } from './download.js';

// What the shell and screens may ask of the platform. Every data change still goes through
// the data layer; these only hand files to the user and run the explicit §13.1 recovery.
const services = {
  downloadBackup: (app) => downloadBackup(document, app),
  async downloadStoredRecord(error) {
    const record = await error.readStoredRecord();
    downloadText(document, `macro-tracker-stored-data-${localStamp()}.json`, JSON.stringify(record, null, 2));
  },
  validateRecoveryBackup: (text) => validateRecoveryBackup(text),
  recover: (options) => recoverStoredData(options).then(({ app }) => app),
  reload: () => window.location.reload()
};

const shell = createShell({
  root: document.getElementById('app'),
  win: window,
  doc: document,
  screens: { today: todayScreen, log: logScreen, meals: mealsScreen, progress: progressScreen, settings: settingsScreen },
  services
});
shell.start();

openBrowserDataLayer()
  .then(({ app }) => shell.setDataLayer(app))
  .catch((error) => shell.showStartupError(error));
