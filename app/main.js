/*
 * main.js — browser entry point. Mounts the shell, then opens the data layer through the
 * approved browser contract (src/browser/app-data.js). Navigation works immediately; the
 * shell shows "Opening your data…" until the data layer is ready, or a blocking message if
 * it can't open (§13.1).
 */

import { openBrowserDataLayer } from '../src/browser/app-data.js';
import { createShell } from './shell.js';

const shell = createShell({ root: document.getElementById('app'), win: window, doc: document });
shell.start();

openBrowserDataLayer()
  .then(({ app }) => shell.setDataLayer(app))
  .catch((error) => shell.showStartupError(error));
