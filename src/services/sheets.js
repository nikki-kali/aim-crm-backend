const { google } = require('googleapis')

const SHEET_RANGE = 'Sheet1!A:D'
const HEADER_ROW = ['Email', 'Status', 'Source', 'Date']

function getSheetsClient() {
  const auth = new google.auth.JWT({
    email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
    key: (process.env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY || '').replace(/\\n/g, '\n'),
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  })
  return google.sheets({ version: 'v4', auth })
}

// Upserts a subscriber row by email — the sheet is a current-status roster
// (one row per person, Status flips between Subscribed/Unsubscribed), not an
// append-only event log. Writes the header row on first use if the sheet is
// still empty.
async function upsertSubscriberRow({ email, status, source }) {
  const spreadsheetId = process.env.GOOGLE_SHEETS_SPREADSHEET_ID
  if (!spreadsheetId || !process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL) return

  const sheets = getSheetsClient()
  const { data } = await sheets.spreadsheets.values.get({ spreadsheetId, range: SHEET_RANGE })
  const rows = data.values || []

  if (rows.length === 0) {
    await sheets.spreadsheets.values.append({
      spreadsheetId,
      range: SHEET_RANGE,
      valueInputOption: 'RAW',
      requestBody: { values: [HEADER_ROW] },
    })
  }

  const dataRows = rows.length === 0 ? [] : rows.slice(1)
  const rowIndex = dataRows.findIndex((row) => (row[0] || '').toLowerCase() === email.toLowerCase())
  const date = new Date().toISOString()
  const values = [[email, status, source || 'website', date]]

  if (rowIndex === -1) {
    await sheets.spreadsheets.values.append({
      spreadsheetId,
      range: SHEET_RANGE,
      valueInputOption: 'RAW',
      requestBody: { values },
    })
  } else {
    const sheetRowNumber = rowIndex + 2 // +1 for header, +1 for 1-based rows
    await sheets.spreadsheets.values.update({
      spreadsheetId,
      range: `Sheet1!A${sheetRowNumber}:D${sheetRowNumber}`,
      valueInputOption: 'RAW',
      requestBody: { values },
    })
  }
}

// Appends one row to a log-style sheet (one row per event), writing the
// header first if the sheet is empty. Used for trade-show offer redemptions:
// the sheet is shared with the team, so it reads as a plain list. Returns
// false when the sheet isn't configured, so callers can skip quietly.
//
// Two ways to reach the sheet:
//  - webhook (preferred): an Apps Script web app bound to the sheet, running
//    as the sheet's owner (media@). No service account or Google Cloud key,
//    and the sheet never has to be shared outside the AIM workspace. The
//    script checks the shared secret and appends the row itself. See
//    docs/gnydm-redemptions-sheet-apps-script.gs.
//  - service account: the Sheets API with GOOGLE_SERVICE_ACCOUNT_EMAIL/KEY.
async function appendLogRow({ spreadsheetId, webhookUrl, webhookSecret, tab = 'Sheet1', header, row }) {
  if (webhookUrl) {
    if (!webhookSecret) return false
    const res = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ secret: webhookSecret, tab, header, row }),
      redirect: 'follow',
    })
    const text = await res.text()
    let ok = false
    try { ok = JSON.parse(text).ok === true } catch { ok = false }
    if (!res.ok || !ok) throw new Error(`sheet webhook rejected the row (HTTP ${res.status})`)
    return true
  }
  if (!spreadsheetId || !process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL) return false
  const sheets = getSheetsClient()
  const range = `${tab}!A:A`
  const { data } = await sheets.spreadsheets.values.get({ spreadsheetId, range })
  const values = (data.values || []).length === 0 ? [header, row] : [row]
  await sheets.spreadsheets.values.append({
    spreadsheetId,
    range,
    valueInputOption: 'RAW',
    insertDataOption: 'INSERT_ROWS',
    requestBody: { values },
  })
  return true
}

module.exports = { upsertSubscriberRow, appendLogRow }
