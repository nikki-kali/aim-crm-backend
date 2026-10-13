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
  const codeCol = findCol(headers, 'Customer Code') || findCol(headers, 'Code')
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
    const iso = String(obj[firstCol] || '').trim().slice(0, 10)
    if (!/^\d{4}-\d{2}-\d{2}$/.test(iso) || iso > runDate) continue
    const doctor = {
      code: codeCol ? String(obj[codeCol] || '').trim() : '',
      name: nameCol ? String(obj[nameCol] || '').trim() : '',
      firstCase: iso,
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

const pickEmail = (messages, re) => messages.find((m) => re.test(String(m.subject || '').trim()))

// Builds { totals, extras } for runDate from that day's Evident emails, or
// null when the day's report isn't usable yet (the daily booked and billed
// emails, or any month-to-date source, haven't arrived). A figure whose email
// is missing is left out (shown as N/A), never zero.
function buildEvidentDay(messages, runDate) {
  const day = (messages || []).filter((m) => !m.date || m.date === runDate)
  const agg = parseAndAggregate(day, { runDate })
  const has = (label) => !agg.missing.includes(label)
  const lmBooked = pickEmail(day, /^Last Month vs MTD Booked/i)
  const lmBilled = pickEmail(day, /^Last Month vs MTD Billed/i)
  const booked = lmBooked ? parseLastMonthVsMtd(lmBooked.html, runDate, 'booked') : null
  const billed = lmBilled ? parseLastMonthVsMtd(lmBilled.html, runDate, 'billed') : null

  const mtdBooked = booked && booked.current
    ? { company: booked.current.value, count: booked.current.count, ...booked.current.byRep }
    : has('MTD Booked Daily Update') && agg.companyMtdBookedByRep ? { company: agg.companyMtdBooked, count: null, ...agg.companyMtdBookedByRep } : null
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
  return { totals, extras }
}

module.exports = { buildEvidentDay, parseLastMonthVsMtd, parseNewDoctors, dailyCustomersFrom, monthIndexFromCell }
