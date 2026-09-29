/*
 * download.js — hand the user a text file to save (a backup, or the raw stored record).
 * A local download only: nothing leaves the device and nothing is written to storage here.
 */

/**
 * Offer `text` as a file named `filename`. Returns true once the browser has been asked to
 * download it; throws if the browser refuses (the caller says "couldn't be downloaded").
 */
export function downloadText(doc, filename, text, type = 'application/json') {
  const win = doc.defaultView;
  const url = win.URL.createObjectURL(new win.Blob([text], { type }));
  try {
    const a = doc.createElement('a');
    a.href = url;
    a.download = filename;
    a.hidden = true;
    doc.body.appendChild(a);
    a.click();
    a.remove();
    return true;
  } finally {
    win.setTimeout(() => win.URL.revokeObjectURL(url), 1000);
  }
}

/** The device's local date as YYYY-MM-DD, for a file name when no data layer is open. */
export function localStamp(date = new Date()) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

/**
 * The app's data as a backup file (§11.1): exportUserData() serialised, then the exact text
 * that will be saved is checked again with validateBackup, so nothing that serialises badly
 * (a non-finite number becomes null in JSON) can ever be handed out as a valid backup.
 * Returns { filename, text, summary, exportedAt }; throws { code: BACKUP_INVALID, errors } if
 * the text doesn't validate. Named macro-tracker-backup-YYYY-MM-DD.json (the local date).
 */
export function backupFile(app) {
  const docData = app.exportUserData();
  const text = JSON.stringify(docData, null, 2);
  const check = app.validateBackup(text);
  if (!check.valid) {
    const e = new Error('the backup did not validate, so it was not offered');
    e.code = check.code;
    e.errors = check.errors;
    throw e;
  }
  return { filename: `macro-tracker-backup-${app.getToday()}.json`, text, summary: check.summary, exportedAt: docData.exportedAt };
}

/** Offer a backup and remember when (appPreferences.lastBackupAt, §10.4). Throws if it couldn't be offered. */
export function downloadBackup(doc, app) {
  const file = backupFile(app);
  downloadText(doc, file.filename, file.text);
  app.updatePreferences({ appPreferences: { lastBackupAt: file.exportedAt } });
  return file;
}
