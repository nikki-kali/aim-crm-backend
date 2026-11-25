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
  // WIP "New Jobs" is the current day only (no month total): value (count).
  const jobs = text.match(/New Jobs\s*:\s*(-?[\d,.]+)\s*\((\d+)\)/i)
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
    newJobs: jobs ? { value: num(jobs[1]), count: Number(jobs[2]) } : null,
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
      // Only the evening email holds the whole day's New Jobs.
      newJobs: p.newJobs,
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

// Report 12, "MTD Booked Daily Update": Elizabeth switched it to booking date
// on 2026-11-23 ("date (booked) >=MTD"), and on 2026-11-24 asked for the month's
// New Jobs to come from it. Its totals row as { value, count }, or null when the
// day's email is missing or still counts by arrival date.
const REPORT_12 = /^MTD Booked Daily Update/i
function report12MonthFor(messages, runDate) {
  const m = (messages || [])
    .filter((x) => x.date === runDate && REPORT_12.test(String(x.subject || '').trim()))
    .sort((a, b) => (b.internalDate || 0) - (a.internalDate || 0))[0]
  if (!m) return null
  // "date (booked) >=MTD" (23 Nov) or "month (booking)=MTD" (24 Nov, the same
  // filter as report 114). Both count by booking date.
  if (!/(?:date\s*\(\s*book(?:ed|ing)\s*\)\s*(?:>|&gt;)?=|month\s*\(\s*booking\s*\)\s*=)\s*MTD/i.test(textOf(m.html))) return null
  const table = parseTable(m.html || '')
  if (!table || table.rows.length < 2) return null
  const { headers, rows } = table
  const valueCol = headers.indexOf(findCol(headers, 'Sales Value (Total)'))
  const countCol = headers.indexOf(findCol(headers, 'Cases'))
  if (valueCol < 0) return null
  const total = rows[rows.length - 1]
  return { value: toNum(total[valueCol]), count: countCol >= 0 ? toNum(total[countCol]) : null }
}

// Report 12 is used only when it agrees with our booking-date copy of Report 10
// (report 114) to within 5%. Its first booked email (23 Nov) read $776,081 for
// the month against $153,038 in report 114, and that must never reach leadership.
// Otherwise report 114 is shown, labelled as such. Report 114 sums Sales Value
// (Product) while Report 12 sums Sales Value (Total) (Elizabeth, 2026-11-25), so
// the two differ slightly (about $130 on 23 Nov); Report 12 is the figure to match.
const REPORT_12_TOLERANCE = 0.05
// When that evening's report 114 is missing (24 Nov: schedule 51 did not send),
// Report 12 is checked against the most recent earlier report 114 of the same
// month instead: it may only be higher by one day's bookings at most.
const MAX_DAY_GROWTH = (prior) => Math.max(prior * 0.15, 25000)
function newJobsMonth(report12, report114, prior114 = null) {
  if (report12 && report114 && report114.value > 0
    && Math.abs(report12.value - report114.value) / report114.value <= REPORT_12_TOLERANCE) {
    return { month: { ...report12, source: 'report12' }, report12Rejected: false }
  }
  if (report12 && !report114 && prior114 && prior114.value > 0
    && report12.value >= prior114.value && report12.value - prior114.value <= MAX_DAY_GROWTH(prior114.value)
    && (report12.count === null || prior114.count === null || report12.count >= prior114.count)) {
    return { month: { ...report12, source: 'report12' }, report12Rejected: false }
  }
  return { month: report114 ? { ...report114, source: 'report114' } : null, report12Rejected: Boolean(report12) }
}

const round2 = (n) => Math.round(n * 100) / 100

// True when no weekday comes before runDate in its month.
function isFirstBusinessDayOfMonth(runDate) {
  const d = new Date(`${runDate}T12:00:00Z`)
  for (let day = 1; day < d.getUTCDate(); day++) {
    const wd = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), day)).getUTCDay()
    if (wd !== 0 && wd !== 6) return false
  }
  return true
}

// The day's New Jobs from the same 8 PM Report 12 run as the month (Elizabeth,
// 2026-11-25: "use Report 12 for the daily figure too", so the headline and the
// totals come from one run): tonight's month to date minus the previous Report 12
// email's month to date in the same month. On the month's first business day the
// day is the month so far. null when the previous email is missing, does not count
// by booking date, or did not agree with report 114 (the caller then falls back).
function report12DayFor(messages, runDate, month) {
  if (!month || month.source !== 'report12') return null
  if (isFirstBusinessDayOfMonth(runDate)) return { value: month.value, count: month.count, source: 'report12' }
  const earlier = (messages || [])
    .filter((m) => m.date && m.date < runDate && m.date.slice(0, 7) === runDate.slice(0, 7) && REPORT_12.test(String(m.subject || '').trim()))
    .map((m) => m.date)
    .sort()
  const prevDate = earlier[earlier.length - 1]
  if (!prevDate) return null
  const prevBooked = newJobsFor(messages, prevDate)
  const prev = newJobsMonth(report12MonthFor(messages, prevDate), prevBooked && prevBooked.mtd).month
  if (!prev || prev.source !== 'report12') return null
  const value = round2(month.value - prev.value)
  const count = month.count !== null && prev.count !== null ? month.count - prev.count : null
  if (value < 0 || (count !== null && count < 0)) return null
  return { value, count, source: 'report12' }
}

// The latest report 114 month to date before runDate, in runDate's month.
function prior114For(messages, runDate) {
  const dates = (messages || [])
    .filter((m) => m.date && m.date < runDate && m.date.slice(0, 7) === runDate.slice(0, 7) && NEW_JOBS_MONTH.test(String(m.subject || '').trim()))
    .map((m) => m.date)
    .sort()
  const prev = dates[dates.length - 1]
  // A stale baseline is no check at all: at most 4 days back (Friday's for Monday).
  if (!prev || (Date.parse(`${runDate}T00:00:00Z`) - Date.parse(`${prev}T00:00:00Z`)) / 86400000 > 4) return null
  const b = newJobsFor(messages, prev)
  return b && b.mtd ? b.mtd : null
}

// Everything the dashboard's top section shows, or null for a part that is
// missing (shown as N/A, never as zero).
function labTotalsFor({ thisMonthMessages = [], evidentMessages = [], runDate }) {
  const tm = thisMonthFor(thisMonthMessages, runDate)
  // New Jobs counted by BOOKING date (Ben via Elizabeth, 2026-11-24):
  // - the month to date from Report 12 (MTD Booked), checked against report 114;
  // - the day from the same Report 12 run (report12DayFor); only when that
  //   can't be worked out, Report 10's booked cases for the day (report 113) or
  //   the This Month report's WIP New Jobs line.
  const booked = newJobsFor(evidentMessages, runDate)
  const { month, report12Rejected } = newJobsMonth(report12MonthFor(evidentMessages, runDate), booked && booked.mtd, booked && booked.mtd ? null : prior114For(evidentMessages, runDate))
  const tag = (x, source) => (x ? { ...x, source } : null)
  const day = report12DayFor(evidentMessages, runDate, month)
    || tag(booked && booked.day, 'report10')
    || tag(tm && tm.newJobs, 'thisMonth')
  return {
    runDate,
    newJobs: day || month ? { day, mtd: month } : null,
    report12Rejected,
    receipts: tm ? tm.receipts : null,
    invoiced: tm ? tm.invoiced : null,
    inLab: tm ? tm.inLab : null,
    onHold: tm ? tm.onHold : null,
    thisMonthSource: tm ? tm.source : null,
  }
}

module.exports = { parseThisMonth, thisMonthFor, parseNewJobsTotal, newJobsFor, labTotalsFor, report12MonthFor, report12DayFor, newJobsMonth, NEW_JOBS_TODAY, NEW_JOBS_MONTH }
