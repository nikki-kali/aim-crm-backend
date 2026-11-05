/**
 * GNYDM 2026 scratch-card redemptions: every minute, pulls newly registered
 * practices from the AIM CRM backend and appends them to this sheet.
 *
 * Why pull instead of push: aimdentallab.com's Google Workspace doesn't allow
 * "Anyone" web apps, so the backend can't call into the sheet. This script
 * runs as the sheet's owner (media@) and calls out to the backend instead, so
 * no web app, no outside sharing and no admin change are needed.
 *
 * Set up once, signed in as media@aimdentallab.com:
 *  1. In the sheet: Extensions > Apps Script. Replace everything with this file. Save.
 *  2. Project Settings (gear) > Script Properties > Add property:
 *       SHARED_SECRET = the same value as GNYDM_2026_REDEMPTIONS_SHEET_SECRET on Render.
 *  3. Back in the editor, choose the function "setup" and click Run. Authorize as media@.
 *     This creates a trigger that runs "sync" every minute.
 * To stop syncing: run "stopSync".
 */

var BACKEND = 'https://aim-crm-backend.onrender.com/api/event-redemptions/export';
var EVENT = 'gnydm-2026';
var TAB = 'Sheet1';

function setup() {
  stopSync();
  ScriptApp.newTrigger('sync').timeBased().everyMinutes(1).create();
  sync();
}

function stopSync() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'sync') ScriptApp.deleteTrigger(t);
  });
}

function sync() {
  var props = PropertiesService.getScriptProperties();
  var secret = props.getProperty('SHARED_SECRET');
  if (!secret) throw new Error('Add SHARED_SECRET under Project Settings > Script Properties first.');

  var lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) return;
  try {
    var after = props.getProperty('CURSOR') || '';
    var url = BACKEND + '?event=' + encodeURIComponent(EVENT) + '&after=' + encodeURIComponent(after);
    var res = UrlFetchApp.fetch(url, { headers: { 'X-Sheet-Secret': secret }, muteHttpExceptions: true });
    if (res.getResponseCode() !== 200) {
      throw new Error('Backend answered ' + res.getResponseCode() + ': ' + res.getContentText().slice(0, 200));
    }
    var data = JSON.parse(res.getContentText());
    if (!data.rows || !data.rows.length) return;

    var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(TAB);
    if (sheet.getLastRow() === 0) {
      sheet.appendRow(data.header.map(safe_));
      sheet.getRange(1, 1, 1, data.header.length).setFontWeight('bold');
      sheet.setFrozenRows(1);
    }
    var values = data.rows.map(function (r) { return r.row.map(safe_); });
    sheet.getRange(sheet.getLastRow() + 1, 1, values.length, values[0].length).setValues(values);
    props.setProperty('CURSOR', data.rows[data.rows.length - 1].cursor);
  } finally {
    lock.releaseLock();
  }
}

// Values come from a public form. A value starting with = + - or @ would be
// run as a spreadsheet formula, so it is stored as plain text instead.
function safe_(v) {
  var s = v === null || v === undefined ? '' : String(v);
  return /^[=+\-@]/.test(s) ? "'" + s : s;
}
