// Doctors who received an intraoral scanner from AIM (Ben, 4 Nov 2026
// Reports Alignment Call): they have a commitment to send business daily.
//
// The list is Evident's Customer File filtered by the "Intraoral Scanner"
// tag, with each doctor's "Sales" field as the rep (checked 2026-11-05).
// Update it here when Ben gives a doctor a scanner or confirms a rep.
//
// Figures come from emails that already arrive every night, not from
// Report #112 (which has no rep column and no email schedule): month-to-date
// from "MTD Booked Daily Update" (by arrival date, the same filter #112 uses;
// on 4 Nov both totalled $1,513.49) and the day's cases from "Daily Booking
// Report - Nadine". Only customer codes and values are read, never the Case
// Number column.
const { parseTable, rowToObj, findCol, toNum } = require('./parseEvident')

const SCANNER_DOCTORS = [
  { code: 'A1304', name: 'Dr. Ehab Samaan', rep: 'William' },
  { code: 'A1298', name: 'Dr. Alberto Gonzalez', rep: 'William' },
  { code: 'A3101', name: 'Dr. Ronaldo Saldana', rep: 'William' },
  { code: 'A1202', name: 'Dr. Betzalel Krasnow', rep: null },
  { code: 'A1297', name: 'Ezra Medical Center', rep: null },
  { code: 'KH2216', name: 'Jodal Dental', rep: null },
  { code: 'KH2217', name: 'Dr. Abe Husney', rep: null },
  { code: 'KH2248', name: 'Adler Dental Group', rep: null },
]

// Customer code -> number value per column, from a table whose first column
// ("Ref") is the customer code. The last row is the totals row.
function valuesByCode(html, valueHeader) {
  const table = parseTable(html || '')
  if (!table || table.rows.length === 0) return null
  const { headers, rows } = table
  const refCol = headers[0]
  const valueCol = findCol(headers, valueHeader)
  const out = new Map()
  for (const row of rows.slice(0, -1)) {
    const obj = rowToObj(headers, row)
    const code = String(obj[refCol] || '').trim()
    if (code) out.set(code, (out.get(code) || 0) + toNum(obj[valueCol]))
  }
  return out
}

// Day's cases per customer code from the Daily Booking Report (one row per case).
function casesByCode(html) {
  const table = parseTable(html || '')
  if (!table) return null
  const { headers, rows } = table
  const codeCol = findCol(headers, 'Customer Code')
  const valueCol = findCol(headers, 'Sales Value (Total)')
  const out = new Map()
  if (!codeCol) return out
  for (const row of rows.slice(0, -1)) {
    const obj = rowToObj(headers, row)
    const code = String(obj[codeCol] || '').trim()
    if (!code) continue
    const c = out.get(code) || { count: 0, value: 0 }
    c.count += 1
    c.value = Math.round((c.value + toNum(obj[valueCol])) * 100) / 100
    out.set(code, c)
  }
  return out
}

// Rows for the dashboard, or null when the MTD email is missing.
function scannerDoctorRows(mtdHtml, dailyHtml, doctors = SCANNER_DOCTORS) {
  const mtd = valuesByCode(mtdHtml, 'Sales Value (Total)')
  if (!mtd) return null
  const today = casesByCode(dailyHtml) || new Map()
  return doctors
    .map((d) => {
      const t = today.get(d.code) || { count: 0, value: 0 }
      return { ...d, todayCases: t.count, todayValue: t.value, mtdValue: Math.round((mtd.get(d.code) || 0) * 100) / 100 }
    })
    .sort((a, b) => b.mtdValue - a.mtdValue || a.name.localeCompare(b.name))
}

module.exports = { SCANNER_DOCTORS, scannerDoctorRows }
