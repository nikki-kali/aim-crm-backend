// The lab's headline numbers for the Leadership Dashboard, as Ben reads them
// each morning (Elizabeth, 2026-11-11): Receipts, New Jobs, Work in progress
// (In Lab by due month, On Hold) and Invoiced, with Debtors on top. Totals
// only. Never Reports 12 or 13, which count every case that comes in,
// returns included.
//
// Sources, all scheduled Evident emails to media@:
// - "This Month" (Evident's standard Case Reports > This Month, the KPI page):
//   Receipts, Invoiced, Debtors, In Lab, On Hold. Body, e.g.:
//     This Month - 11 Nov 2026
//     Receipts: 0 (0) = 52,011       today's value (today's count) = month
//     Invoices: 0 (0) = 53,441
//     Debtors Total: 319,381 ...
//     On Hold: 1,225 (20)
//     In Lab: 63,563+1,361 (558)     due this month + due next month (count)
//   Its own "New Jobs" line counts only the current day so far, so it is not
//   used. Schedule 49 sends it at 04:00 Evident time (5 AM New York), which
//   holds the month through the day before; a 22:00 send holds the whole day.
// - "Booked Today - AIM CRM" (report 113, schedule 50) and "Booked This Month
//   - AIM CRM" (report 114, schedule 51), 22:00 Evident time: New Jobs by
//   booking date, the same figure as Report 10. Rows per sales rep plus a
//   totals row; only the totals row is read.
const { parseTable, findCol, toNum } = require('./parseEvident')
const { parseDebtors } = require('./debtors')

const MON = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']

function textOf(html) {
  return String(html || '')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<(br|\/p|\/div|\/tr|\/h\d|\/li|\/td)[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/[*#]/g, '')
}

const num = (s) => Number(String(s).replace(/,/g, ''))

function isoFrom(day, mon, year) {
  const i = MON.indexOf(String(mon).slice(0, 3).toLowerCase())
  return i < 0 ? null : `${year}-${String(i + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`
}

// One "This Month" email as { reportDate, generatedHour, receipts, invoiced,
// inLab, onHold, debtors }, or null when it isn't one. reportDate is the
// email's own "This Month - DD Mon YYYY"; generatedHour is Evident's clock.
function parseThisMonth(html) {
  const text = textOf(html)
  const head = text.match(/This Month\s*-\s*(\d{1,2})\s+([A-Za-z]{3})[a-z]*\s+(\d{4})/)
  if (!head) return null
  const gen = text.match(/(\d{1,2})\s+[A-Za-z]{3}\s+\d{4}\s+(\d{1,2}):(\d{2})/)
  const account = (label) => {
    const m = text.match(new RegExp(`${label}\\s*:\\s*(-?[\\d,.]+)\\s*\\((\\d+)\\)\\s*=\\s*(-?[\\d,.]+)`, 'i'))
    return m ? { day: num(m[1]), dayCount: Number(m[2]), mtd: num(m[3]) } : null
  }
  const lab = text.match(/In Lab\s*:\s*(-?[\d,.]+)\s*\+\s*(-?[\d,.]+)\s*\((\d+)\)/i)
  const hold = text.match(/On Hold\s*:\s*(-?[\d,.]+)\s*\((\d+)\)/i)
  const receipts = account('Receipts')
  const invoiced = account('Invoices')
  if (!receipts && !invoiced && !lab && !hold) return null
  return {
    reportDate: isoFrom(head[1], head[2], head[3]),
    generatedHour: gen ? Number(gen[2]) : null,
    receipts,
    invoiced,
    inLab: lab ? { thisMonth: num(lab[1]), nextMonth: num(lab[2]), count: Number(lab[3]) } : null,
    onHold: hold ? { value: num(hold[1]), count: Number(hold[2]) } : null,
    debtors: parseDebtors(html),
  }
}

// An evening send (18:00 Evident time or later) holds the whole day.
const EVENING_HOUR = 18

// runDate's figures from the "This Month" emails:
// - an evening email for runDate gives the day and the month to date;
// - otherwise the next morning's email (same month) gives the month to date,
//   and the day is the change since runDate's own morning email.
// Work in progress and Debtors come from the same email as the month figures.
// null when neither is there.
function thisMonthFor(messages, runDate) {
  const parsed = (messages || [])
    .map((m) => ({ m, p: parseThisMonth(m.html) }))
    .filter((x) => x.p && x.p.reportDate)
    .sort((a, b) => (b.m.internalDate || 0) - (a.m.internalDate || 0))
  const month = runDate.slice(0, 7)
  const evening = parsed.find((x) => x.p.reportDate === runDate && x.p.generatedHour !== null && x.p.generatedHour >= EVENING_HOUR)
  if (evening) {
    const p = evening.p
    return {
      source: 'evening', reportDate: p.reportDate,
      receipts: p.receipts ? { day: p.receipts.day, mtd: p.receipts.mtd } : null,
      invoiced: p.invoiced ? { day: p.invoiced.day, mtd: p.invoiced.mtd } : null,
      inLab: p.inLab, onHold: p.onHold, debtors: p.debtors,
    }
  }
  // Earliest morning email after runDate that is still in runDate's month.
  const after = parsed
    .filter((x) => x.p.reportDate > runDate && x.p.reportDate.slice(0, 7) === month && (x.p.generatedHour === null || x.p.generatedHour < EVENING_HOUR))
    .sort((a, b) => (a.p.reportDate < b.p.reportDate ? -1 : a.p.reportDate > b.p.reportDate ? 1 : 0))[0]
  if (!after) return null
  const before = parsed.find((x) => x.p.reportDate === runDate && (x.p.generatedHour === null || x.p.generatedHour < EVENING_HOUR))
  const change = (key) => {
    const a = after.p[key]
    if (!a) return null
    const b = before && before.p[key]
    // runDate's own morning email holds the month through the day before; on
    // the 1st it is last month's, so the day is the month so far.
    const startOfMonth = runDate.slice(8) === '01'
    const day = startOfMonth ? a.mtd : b ? Math.round((a.mtd - b.mtd) * 100) / 100 : null
    return { day, mtd: a.mtd }
  }
  return {
    source: 'morning', reportDate: after.p.reportDate,
    receipts: change('receipts'), invoiced: change('invoiced'),
    inLab: after.p.inLab, onHold: after.p.onHold, debtors: after.p.debtors,
  }
}

const NEW_JOBS_TODAY = /^Booked Today\s*-\s*AIM CRM/i
const NEW_JOBS_MONTH = /^Booked This Month\s*-\s*AIM CRM/i

// Totals row of a "Booked Today/This Month - AIM CRM" email: { value, count }.
function parseNewJobsTotal(html) {
  const table = parseTable(html || '')
  if (!table || table.rows.length < 2) return null
  const { headers, rows } = table
  const valueCol = headers.indexOf(findCol(headers, 'Sales Value'))
  const countCol = headers.indexOf(findCol(headers, 'Cases'))
  if (valueCol < 0) return null
  const total = rows[rows.length - 1]
  return { value: toNum(total[valueCol]), count: countCol >= 0 ? toNum(total[countCol]) : null }
}

// runDate's New Jobs: the day and the month to date, each from that evening's
// email (sent on runDate, after the day's bookings). null parts are missing.
function newJobsFor(messages, runDate) {
  const pick = (re) => (messages || [])
    .filter((m) => m.date === runDate && re.test(String(m.subject || '').trim()))
    .sort((a, b) => (b.internalDate || 0) - (a.internalDate || 0))
    .map((m) => parseNewJobsTotal(m.html))
    .find(Boolean) || null
  const day = pick(NEW_JOBS_TODAY)
  const mtd = pick(NEW_JOBS_MONTH)
  return day || mtd ? { day, mtd } : null
}

// Everything the dashboard's top section shows, or null for a part that is
// missing (shown as N/A, never as zero).
function labTotalsFor({ thisMonthMessages = [], evidentMessages = [], runDate }) {
  const tm = thisMonthFor(thisMonthMessages, runDate)
  return {
    runDate,
    newJobs: newJobsFor(evidentMessages, runDate),
    receipts: tm ? tm.receipts : null,
    invoiced: tm ? tm.invoiced : null,
    inLab: tm ? tm.inLab : null,
    onHold: tm ? tm.onHold : null,
    thisMonthSource: tm ? tm.source : null,
  }
}

module.exports = { parseThisMonth, thisMonthFor, parseNewJobsTotal, newJobsFor, labTotalsFor, NEW_JOBS_TODAY, NEW_JOBS_MONTH }
