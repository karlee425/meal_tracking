/*
 * download.js — hand the user a text file to save (a backup, the raw stored record, or an
 * earlier-format copy: the older-format backup or a raw migration archive).
 * A local download only: nothing leaves the device and nothing is written to storage here
 * (only the ordinary backup records lastBackupAt, through the data layer).
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

/* ---------------- earlier-format copies (§11.3) — read-only downloads ---------------- */

/**
 * The older-format backup as a file: `backup` is olderFormatBackup()'s result, the version-1
 * data from immediately before the upgrade. The exact text to be saved is validated again and
 * must be a valid format-1 backup, or nothing is offered (throws { code, errors }). Named
 * macro-tracker-older-format-backup-YYYY-MM-DD.json after the date the data was saved.
 */
export function olderFormatBackupFile(app, backup) {
  const text = JSON.stringify(backup, null, 2);
  const check = app.validateBackup(text);
  if (!check.valid || check.formatVersion !== 1) {
    const e = new Error('the older-format backup did not validate, so it was not offered');
    e.code = check.code || 'BACKUP_INVALID';
    e.errors = check.errors;
    throw e;
  }
  const day = typeof backup.exportedAt === 'string' && /^\d{4}-\d{2}-\d{2}/.test(backup.exportedAt) ? backup.exportedAt.slice(0, 10) : localStamp();
  return { filename: `macro-tracker-older-format-backup-${day}.json`, text, summary: check.summary };
}

/** Offer the older-format backup. Read-only: nothing is written, and lastBackupAt is not updated. */
export function downloadOlderFormatBackup(doc, app, backup) {
  const file = olderFormatBackupFile(app, backup);
  downloadText(doc, file.filename, file.text);
  return file;
}

/**
 * A stored migration archive as a file, exactly as stored (its wrapper metadata included) —
 * not a backup, and never restorable. Only an archive that JSON can carry exactly is offered.
 * Named macro-tracker-raw-migration-archive-format-1-r24-YYYY-MM-DD.json (download date).
 */
export function rawArchiveFile(copy, date = new Date()) {
  if (!copy || copy.kind !== 'archive' || typeof copy.key !== 'string') throw Object.assign(new Error('not a stored migration archive'), { code: 'NOT_AN_ARCHIVE' });
  if (!copy.exactJson) throw Object.assign(new Error('the archive can’t be written to a file exactly as stored'), { code: 'ARCHIVE_NOT_EXACT' });
  const text = JSON.stringify(copy.archive, null, 2);
  const name = copy.key.replace(/^user-data:/, '').replace('@', '-'); // e.g. format-1-r24
  return { filename: `macro-tracker-raw-migration-archive-${name}-${localStamp(date)}.json`, text };
}

/** Offer one raw migration archive. Read-only. */
export function downloadRawArchive(doc, copy) {
  const file = rawArchiveFile(copy);
  downloadText(doc, file.filename, file.text);
  return file;
}

/**
 * Offer every stored migration archive in `copies` (already read with listFormatCopies), one
 * file each. Read-only, and never throws: each archive gets its own outcome, so a refused
 * download is never reported as a read failure and a partial result is reported as partial.
 * Returns { found, results: [{ key, outcome: 'downloaded' | 'not-exact' | 'refused', error? }] }:
 *   not-exact  JSON can't carry the archive faithfully, so it was not offered
 *   refused    the browser didn't start the download
 */
export function downloadRawArchives(doc, copies) {
  const results = [];
  for (const c of (copies || []).filter((x) => x.kind === 'archive')) {
    if (!c.exactJson) { results.push({ key: c.key, outcome: 'not-exact' }); continue; }
    try {
      downloadRawArchive(doc, c);
      results.push({ key: c.key, outcome: 'downloaded' });
    } catch (e) {
      results.push({ key: c.key, outcome: 'refused', error: (e && e.message) || String(e) });
    }
  }
  return { found: results.length, results };
}
