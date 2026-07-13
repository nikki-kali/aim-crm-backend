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

module.exports = { upsertSubscriberRow }
