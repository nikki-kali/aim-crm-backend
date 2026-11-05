// The day's figures built from Evident's own scheduled emails
// (support@evidentlabs.com), in the same shape the old "EviSmart Daily Sales
// Report" email produced (extractEviSmartTotals / extractEviSmartExtras), so
// the Leadership Dashboard, rep reports and WhatsApp post read it unchanged.
// User decision, 2026-10-13: the EviSmart email (pulled by a browser
// extension) stopped; Evident now emails every figure itself at 7 PM Eastern,
// for the day it is sent. Pure functions, no Gmail.
//
// Sources: daily booked/billed from "Daily Booking Report - Nadine" / "Daily
// Billed Report - Nadine"; month to date and last month from "Last Month vs
// MTD Booked/Billed" (sent Mon-Fri, so it also covers Fridays), falling back
// to "MTD Booked Daily Update" / "Daily MTD (Total) Billed" (Mon-Thu); new
// doctors from "New Doctors - James/William". Never reads the "Case Number"
// column: Evident puts patient names there.
const { parseAndAggregate, parseTable, findCol, rowToObj, toNum } = require('./parseEvident')
const { scannerDoctorRows } = require('./scannerDoctors')

const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december']

const monthIndexOf = (iso) => Number(iso.slice(5, 7)) - 1
const priorMonthIndex = (iso) => (monthIndexOf(iso) + 11) % 12
const capitalized = (i) => MONTHS[i][0].toUpperCase() + MONTHS[i].slice(1)

// Month index (0-11) a "Month" cell names: "2026-10", "10/2026", "October
// 2026", "Oct 2026" or "Oct". null for anything else (e.g. the total row).
function monthIndexFromCell(text) {
  const s = String(text || '').trim().toLowerCase()
  let m = s.match(/^(\d{4})[-/](\d{1,2})/)
  if (m) return Number(m[2]) - 1
  m = s.match(/^(\d{1,2})[-/](\d{4})/)
  if (m) return Number(m[1]) - 1
  const i = MONTHS.findIndex((name) => s.startsWith(name.slice(0, 3)))
  return i === -1 ? null : i
}

// Reads a "Last Month vs MTD Booked/Billed" email: one row per month (last
// month, then this month) plus a total row, which is ignored. Rows are told
// apart by the month they name, not by position. `kind` is 'booked' or
// 'billed'. Returns { last, current }, each { value, count, byRep } or null.
function parseLastMonthVsMtd(html, runDate, kind) {
  const table = parseTable(html || '')
  if (!table) return null
  const { headers, rows } = table
  const monthCol = findCol(headers, 'Month')
  const valueCol = kind === 'billed' ? findCol(headers, 'Total Billed') : findCol(headers, 'Sales Value (Total)')
  if (!monthCol || !valueCol) return null
  const countCol = findCol(headers, 'Cases (Total)')
  const naCol = findCol(headers, 'N/A')
  const jamesCol = findCol(headers, 'Delaney')
  const williamCol = findCol(headers, 'Alexander')
  const read = (obj) => ({
    value: toNum(obj[valueCol]),
    count: countCol ? toNum(obj[countCol]) : null,
    byRep: { na: naCol ? toNum(obj[naCol]) : 0, james: jamesCol ? toNum(obj[jamesCol]) : 0, william: williamCol ? toNum(obj[williamCol]) : 0 },
  })
  let last = null
  let current = null
  for (const row of rows) {
    const obj = rowToObj(headers, row)
    const i = monthIndexFromCell(obj[monthCol])
    if (i === monthIndexOf(runDate)) current = read(obj)
    else if (i === priorMonthIndex(runDate)) last = read(obj)
  }
  if (!last && !current) return null
  return { last, current }
}

// Evident's Customer cell is "CODE - Last, First" ("A1119 - Brand, Idelle",
// "A1301 - , Dr. KELLY J HWANG", "A1305 - IZZO,"). Shown as "Idelle Brand",
// "Dr. KELLY J HWANG", "IZZO".
function doctorDisplayName(cell) {
  const s = String(cell || '').trim().replace(/^[A-Z]{1,3}\d+\s*-\s*/, '')
  const [last, first] = s.split(/\s*,\s*/, 2).map((p) => (p || '').trim())
  if (first === undefined) return s
  if (!last) return first
  if (!first) return last
  return `${first} ${last}`
}

// One-off exceptions to "counted in the month of the first booking", by
// customer code: the date the doctor counts as new from instead. A4159
// (A.R Assadian, William) first booked Fri 30 Oct 2026, but the team treats
// him as a November signing (user decision, 2026-11-03); he counts from the
// Mon 2 Nov report, so that day's post congratulates William.
const NEW_DOCTOR_COUNTED_FROM = { A4159: '2026-11-02' }

// "New Doctors - James/William": one row per doctor with First Booking
// (YYYY-MM-DD), Cases (Total) and Sales Value (Total), newest first. Returns
// the doctors whose first booking falls in runDate's month and in the month
// before, in the extractEviSmartExtras shape, or null if unreadable.
function parseNewDoctors(html, runDate) {
  const table = parseTable(html || '')
  if (!table) return null
  const { headers, rows } = table
  const firstCol = findCol(headers, 'First Booking')
  if (!firstCol) return null
  const codeCol = findCol(headers, 'Customer Code') || findCol(headers, 'Code') || headers.find((h) => /^ref$/i.test(h))
  const nameCol = headers.find((h) => /customer name|doctor|^customer$/i.test(h) && !/case number/i.test(h))
  const casesCol = findCol(headers, 'Cases (Total)')
  const thisMonth = runDate.slice(0, 7)
  const d = new Date(`${runDate.slice(0, 7)}-01T00:00:00Z`)
  d.setUTCMonth(d.getUTCMonth() - 1)
  const prevMonth = d.toISOString().slice(0, 7)
  const current = []
  const previous = []
  for (const row of rows) {
    const obj = rowToObj(headers, row)
    const firstBooking = String(obj[firstCol] || '').trim().slice(0, 10)
    const code = codeCol ? String(obj[codeCol] || '').trim() : ''
    const iso = NEW_DOCTOR_COUNTED_FROM[code] || firstBooking
    if (!/^\d{4}-\d{2}-\d{2}$/.test(iso) || iso > runDate) continue
    const doctor = {
      code,
      name: nameCol ? doctorDisplayName(obj[nameCol]) : '',
      firstCase: firstBooking,
      firstCaseIso: iso,
      cases: casesCol ? toNum(obj[casesCol]) : 0,
    }
    if (iso.startsWith(thisMonth)) current.push(doctor)
    else if (iso.startsWith(prevMonth)) previous.push(doctor)
  }
  return { current, previous }
}

// One row per customer for the dashboard's "Today's Booked Cases" table, from
// the Daily Booking Report's per-case rows (code, name and value only).
function dailyCustomersFrom(html) {
  const table = parseTable(html || '')
  if (!table || table.rows.length === 0) return []
  const { headers, rows } = table
  const codeCol = findCol(headers, 'Customer Code')
  const nameCol = findCol(headers, 'Customer Name')
  const valueCol = findCol(headers, 'Sales Value (Total)')
  const byCustomer = new Map()
  for (const row of rows.slice(0, -1)) { // last row is the totals row
    const obj = rowToObj(headers, row)
    const code = codeCol ? String(obj[codeCol] || '').trim() : ''
    const name = String(obj[nameCol] || '').trim()
    if (!code && !name) continue
    const key = code ? `${code} - ${name}` : name
    const c = byCustomer.get(key) || { name: key, count: 0, value: 0 }
    c.count += 1
    c.value = Math.round((c.value + toNum(obj[valueCol])) * 100) / 100
    byCustomer.set(key, c)
  }
  return [...byCustomer.values()].sort((a, b) => a.name.localeCompare(b.name))
}

// "Daily Arrivals by Day - AIM CRM" (Evident report 111, schedule 48): one
// row per ARRIVAL date from the start of last month, emailed 5:00 AM ET
// Mon-Sat. Booked figures come from it (user decision, 2026-11-04): Ben reads
// booked from Evident's Daily Activity Report (EviSmart #13), which counts by
// arrival date, while the 8 PM booking-date emails both used another date
// field and cut the day off early (2 Nov: $8,706.28 by booking vs $9,284.25
// by arrival vs $9,509.00 in #13; 3 Nov: $7,764.22 vs $10,558.63 vs
// $10,643.63).
const ARRIVALS_SUBJECT = /^Daily Arrivals by Day/i
const MONTH_ABBR = MONTHS.map((m) => m.slice(0, 3))

// "2026-11-02", "11/2/2026", "11/2/26", "2 Nov 2026", "2 Nov 26", "Nov 2, 2026"
// as YYYY-MM-DD; null for anything else (the total row, blanks).
function isoFromCell(text) {
  const s = String(text || '').trim()
  const pad = (n) => String(n).padStart(2, '0')
  const year = (y) => (String(y).length === 2 ? `20${y}` : String(y))
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/)
  if (m) return `${m[1]}-${pad(m[2])}-${pad(m[3])}`
  m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/)
  if (m) return `${year(m[3])}-${pad(m[1])}-${pad(m[2])}`
  m = s.match(/^(\d{1,2})\s+([A-Za-z]{3})[A-Za-z]*\.?\s+(\d{2}|\d{4})$/)
  if (m && MONTH_ABBR.includes(m[2].toLowerCase())) return `${year(m[3])}-${pad(MONTH_ABBR.indexOf(m[2].toLowerCase()) + 1)}-${pad(m[1])}`
  m = s.match(/^([A-Za-z]{3})[A-Za-z]*\.?\s+(\d{1,2}),?\s+(\d{2}|\d{4})$/)
  if (m && MONTH_ABBR.includes(m[1].toLowerCase())) return `${year(m[3])}-${pad(MONTH_ABBR.indexOf(m[1].toLowerCase()) + 1)}-${pad(m[2])}`
  return null
}

// Rows of a "Daily Arrivals by Day" email: [{ date, count, value, byRep }].
// The date may sit under "Date (Arrival)" or in the first (Ref) column, so
// each row takes the first cell that reads as a date.
function parseArrivalsByDay(html) {
  const table = parseTable(html || '')
  if (!table) return null
  const { headers, rows } = table
  const valueCol = findCol(headers, 'Sales Value (Total)')
  if (!valueCol) return null
  const countCol = findCol(headers, 'Cases (Total)')
  const naCol = findCol(headers, 'N/A')
  const jamesCol = findCol(headers, 'Delaney')
  const williamCol = findCol(headers, 'Alexander')
  const out = []
  for (const row of rows) {
    const obj = rowToObj(headers, row)
    const date = row.map(isoFromCell).find(Boolean)
    if (!date) continue
    out.push({
      date,
      count: countCol ? toNum(obj[countCol]) : null,
      value: toNum(obj[valueCol]),
      byRep: { na: naCol ? toNum(obj[naCol]) : 0, james: jamesCol ? toNum(obj[jamesCol]) : 0, william: williamCol ? toNum(obj[williamCol]) : 0 },
    })
  }
  return out
}

const round2 = (n) => Math.round(n * 100) / 100

// runDate's booked figures from the newest arrivals email sent AFTER runDate
// (so the day is complete) that has a row for it: the day itself and the
// month to date. null when no such email has arrived; callers then keep the
// booking-date figures.
function arrivalsFor(messages, runDate) {
  const candidates = (messages || [])
    .filter((m) => ARRIVALS_SUBJECT.test(String(m.subject || '').trim()) && m.date && m.date > runDate)
    .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0))
  for (const m of candidates) {
    const rows = parseArrivalsByDay(m.html)
    const day = rows && rows.find((r) => r.date === runDate)
    if (!day) continue
    const month = rows.filter((r) => r.date.slice(0, 7) === runDate.slice(0, 7) && r.date <= runDate)
    const sum = (f) => round2(month.reduce((t, r) => t + (f(r) || 0), 0))
    return {
      daily: { count: day.count, value: day.value, byRep: day.byRep },
      mtd: {
        count: month.every((r) => r.count !== null) ? month.reduce((t, r) => t + r.count, 0) : null,
        value: sum((r) => r.value),
        byRep: { na: sum((r) => r.byRep.na), james: sum((r) => r.byRep.james), william: sum((r) => r.byRep.william) },
      },
    }
  }
  return null
}

const pickEmail = (messages, re) => messages.find((m) => re.test(String(m.subject || '').trim()))

// Builds { totals, extras } for runDate from that day's Evident emails, or
// null when the day's report isn't usable yet (the daily booked and billed
// emails, or any month-to-date source, haven't arrived). A figure whose email
// is missing is left out (shown as N/A), never zero. With a later "Daily
// Arrivals by Day" email in `arrivalsMessages`, booked (day, month to date,
// per rep) comes from it instead.
function buildEvidentDay(messages, runDate, arrivalsMessages = []) {
  const day = (messages || []).filter((m) => !m.date || m.date === runDate)
  const agg = parseAndAggregate(day, { runDate })
  const has = (label) => !agg.missing.includes(label)
  const lmBooked = pickEmail(day, /^Last Month vs MTD Booked/i)
  const lmBilled = pickEmail(day, /^Last Month vs MTD Billed/i)
  const booked = lmBooked ? parseLastMonthVsMtd(lmBooked.html, runDate, 'booked') : null
  const billed = lmBilled ? parseLastMonthVsMtd(lmBilled.html, runDate, 'billed') : null

  // "MTD Booked Daily Update" first: it is by arrival date since 2026-11-05,
  // while "Last Month vs MTD Booked (rolling)" is still by booking date.
  const mtdBooked = has('MTD Booked Daily Update') && agg.companyMtdBookedByRep
    ? { company: agg.companyMtdBooked, count: null, ...agg.companyMtdBookedByRep }
    : booked && booked.current ? { company: booked.current.value, count: booked.current.count, ...booked.current.byRep } : null
  const mtdBilled = billed && billed.current
    ? { company: billed.current.value, ...billed.current.byRep }
    : has('Daily MTD Total Billed') && agg.companyMtdBilledByRep ? { company: agg.companyMtdBilled, ...agg.companyMtdBilledByRep } : null

  if (!has('Daily Booking Report - Nadine') || !has('Daily Billed Report - Nadine') || (!mtdBooked && !mtdBilled)) return null

  const rep = (m) => (m ? { james: m.james, william: m.william, na: m.na, company: m.company } : null)
  const totals = {
    dailyBookedCount: agg.companyDailyBookedCount,
    dailyBookedValue: agg.companyDailyBooked,
    dailyBilledValue: agg.companyDailyBilled,
    mtdBookedCount: mtdBooked ? mtdBooked.count : null,
    mtdBookedValue: mtdBooked ? mtdBooked.company : 0,
    mtdBilledValue: mtdBilled ? mtdBilled.company : 0,
    ytdTotalSalesValue: 0,
    ytdBilledValue: 0,
    lastMonth: null,
    repMtd: mtdBooked && mtdBilled ? { booked: rep(mtdBooked), billed: rep(mtdBilled) } : null,
    dailyCustomers: dailyCustomersFrom((pickEmail(day, /^Daily Booking Report\s*-\s*Nadine/i) || {}).html),
    scannerDoctors: scannerDoctorRows(
      (pickEmail(day, /^MTD Booked Daily Update/i) || {}).html,
      (pickEmail(day, /^Daily Booking Report\s*-\s*Nadine/i) || {}).html,
    ),
    cumulativeAsOf: null,
    source: 'evident',
  }

  const lastMonth = booked && booked.last && billed && billed.last
    ? { monthName: capitalized(priorMonthIndex(runDate)), bookedCount: booked.last.count, booked: booked.last.value, billed: billed.last.value }
    : null
  const james = pickEmail(day, /^New Doctors\s*-\s*James/i)
  const william = pickEmail(day, /^New Doctors\s*-\s*William/i)
  const nj = james ? parseNewDoctors(james.html, runDate) : null
  const nw = william ? parseNewDoctors(william.html, runDate) : null
  const extras = {
    lastMonth,
    newDoctors: nj && nw ? { james: nj.current, william: nw.current } : null,
    newDoctorsPrevMonth: nj && nw ? { james: nj.previous, william: nw.previous } : null,
  }
  const arrivals = arrivalsFor(arrivalsMessages, runDate)
  if (arrivals) {
    totals.dailyBookedCount = arrivals.daily.count
    totals.dailyBookedValue = arrivals.daily.value
    totals.mtdBookedCount = arrivals.mtd.count
    totals.mtdBookedValue = arrivals.mtd.value
    if (mtdBilled) totals.repMtd = { booked: { ...arrivals.mtd.byRep, company: arrivals.mtd.value }, billed: rep(mtdBilled) }
    totals.bookedSource = 'arrivals'
  }
  return { totals, extras }
}

module.exports = { ARRIVALS_SUBJECT, isoFromCell, parseArrivalsByDay, arrivalsFor, NEW_DOCTOR_COUNTED_FROM, doctorDisplayName, buildEvidentDay, parseLastMonthVsMtd, parseNewDoctors, dailyCustomersFrom, monthIndexFromCell }
