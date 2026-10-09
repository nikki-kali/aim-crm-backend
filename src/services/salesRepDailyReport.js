const db = require('../config/db')
const { sendEmail, salesRepDailyReportEmail } = require('./email')
const { fetchEvidentEmailsInRange, fetchEviSmartEmails } = require('./evidentReport/gmailFetch')
const { extractDailyBookedCustomerNames, extractBookingRows, extractBilledRows, parseTable, rowToObj, extractRepColumns, pickEviSmartMessageForDate, extractEviSmartExtras } = require('./evidentReport/parseEvident')
const { computeProgress } = require('./goalProgress')
const { APPROVER_EMAIL, createApprovalToken, buildApproveUrl, injectApprovalBanner } = require('./reportApproval')
const { renderGoalBarsGif } = require('./goalBarGifRenderer')
const { checkBookedMtd, previousWeekday, sameMonth } = require('./evidentReport/bookedMtdGuard')
const { countEviSmartNewDoctors } = require('./evidentReport/eviSmartPrimary')

// Recipients are the two real AIM reps by email, not a role query — role
// IN ('staff','sales_rep') would also catch Yoel Klein and the TEST
// ACCOUNT, both sales_rep but neither a real AIM rep for this report. See
// docs/superpowers/specs/2026-09-15-sales-rep-daily-and-leadership-report-design.md.
const DAILY_REPORT_REP_EMAILS = ['james@aimdentallab.com', 'williama@aimdentallab.com']
// Yoel is cc'd on both reps' emails for visibility, not sent his own
// personalized report for his own KH doctors.
const REPORT_CC = ['yoel@khdentallab.com', 'execassistant@aimdentallab.com', 'ben@aimdentallab.com']

// Maps a rep's CRM email to the key parseEvident.js groups per-rep Evident
// figures under (derived from each report's own "Delaney, James" /
// "Alexander, WIlliam" column headers) — same two reps as
// DAILY_REPORT_REP_EMAILS, just keyed the other way for this lookup.
const EVIDENT_REP_KEY_BY_EMAIL = { 'james@aimdentallab.com': 'james', 'williama@aimdentallab.com': 'william' }

// The exact EXPECTED label parseEvident.js uses for each rep's daily
// report — used throughout this file to fetch/filter that rep's own
// "Daily Booked Cases" emails.
const EVIDENT_DAILY_BOOKED_LABEL_BY_REP_KEY = {
  james: "Daily Booked Cases - James' Doctors",
  william: "Daily Booked Cases - William's Doctors",
}

// Every rep's monthly sales target (user instruction, 2026-09-26).
const MONTHLY_SALES_TARGET = 30000

// First and last day, plus the "September 2026" label, of the calendar
// month `dateStr` (YYYY-MM-DD) falls in.
function monthWindow(dateStr) {
  const [y, m] = dateStr.split('-').map(Number)
  const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate()
  const mm = String(m).padStart(2, '0')
  const monthName = new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' })
  return { start: `${y}-${mm}-01`, end: `${y}-${mm}-${String(lastDay).padStart(2, '0')}`, monthName }
}

// The rep's monthly sales progress for the bar in their daily report: the
// same calculation as the Leadership Dashboard's per-rep goal (real case
// value for the rep's own doctors, via goalProgress.js's computeProgress).
// Uses the rep's existing monthly_revenue goal row when one covers the
// date, otherwise falls back to the $30,000 calendar-month default so the
// bar keeps working when a new month starts without someone creating a
// goal. Best-effort: any failure returns null and the report still sends
// without the bar rather than blocking on it.
async function computeMonthlySalesGoal(repEmail, dateStr) {
  try {
    const { rows: [rep] } = await db.query(`SELECT id FROM users WHERE email=$1`, [repEmail])
    if (!rep) return null
    const { rows: [existing] } = await db.query(
      `SELECT * FROM goals WHERE rep_id=$1 AND metric='monthly_revenue' AND period_start <= $2 AND period_end >= $2 ORDER BY created_at DESC LIMIT 1`,
      [rep.id, dateStr]
    )
    if (existing) return await computeProgress(existing)
    const { start, end, monthName } = monthWindow(dateStr)
    return await computeProgress({
      rep_id: rep.id, metric: 'monthly_revenue', target: MONTHLY_SALES_TARGET,
      period_start: start, period_end: end, title: `$30K Monthly Sales - ${monthName}`,
    })
  } catch (err) {
    console.error(`[sales-rep-daily-report] failed to compute monthly sales goal for ${repEmail}:`, err.message)
    return null
  }
}

// Monthly Sales = BILLED (invoiced) for the month — Elizabeth, 2026-10-02:
// "sales should always use billed... booked just means we've secured the
// business." Taken straight from Evident's own per-rep MTD emails (billed:
// "Daily MTD Total Billed", matches EviSmart Report #40; booked: "MTD Booked
// Daily Update", matches Report #12), never summed from CRM case dates — a
// case booked in September but billed Oct 1 is created in the CRM on Oct 1
// (real case #6252), which made that sum misattribute months.
const MTD_SUBJECT = { billed: /^Daily MTD Total Billed/i, booked: /^MTD Booked Daily Update/i }
const MTD_QUERY = { billed: 'Daily MTD Total Billed', booked: 'MTD Booked Daily Update' }

// Picks the latest MTD email of `kind` dated on or before `dateStr` in the
// same calendar month, and returns its per-rep totals. Pure, so the month
// boundary is testable without Gmail.
function pickMtdByRepAsOf(messages, dateStr, kind = 'billed') {
  const monthStart = `${dateStr.slice(0, 7)}-01`
  const candidates = messages
    .filter((m) => MTD_SUBJECT[kind].test(m.subject || '') && m.date >= monthStart && m.date <= dateStr)
    .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0))
  for (const m of candidates) {
    const t = parseTable(m.html || '')
    if (!t || t.rows.length === 0) continue
    const byRep = extractRepColumns(t.headers, rowToObj(t.headers, t.rows[t.rows.length - 1]))
    if (byRep) return byRep
  }
  return null
}

const gmailDate = (dateStr, addDays) => {
  const d = new Date(`${dateStr}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + addDays)
  return d.toISOString().slice(0, 10).replace(/-/g, '/')
}

// Short-lived cache: every rep (and the WhatsApp post's "last month" line)
// asks about the same date, and each Gmail fetch is throttled per message.
// Expires so a later re-run the same day still sees a newer email.
const mtdCache = new Map()
const MTD_CACHE_MS = 10 * 60 * 1000

// Which source to trust for a month-to-date figure, best first: the Evident
// email dated for the report day itself, then EviSmart's by-rep table for
// that day (same #12/#40 reports), and only then an OLDER Evident email in
// the same month (a stale last resort). Found 2026-10-06: when Evident
// skipped a day's MTD emails the older one was used silently.
function pickMtdSource({ exact, eviSmart, older }) {
  return exact || eviSmart || older || null
}

// Total across every rep plus N/A, for the plausibility check.
const byRepTotal = (byRep) => (byRep ? byRep.na + byRep.james + byRep.william : null)

// Evident's "MTD Booked Daily Update" once reported $485,192 for a month that
// had booked about $44,000 (2026-10-08). Returns true when `exact` (today's
// per-rep reading) fits the previous day's reading plus today's bookings.
// Pure so it is testable without Gmail.
function acceptBookedByRep({ exact, prev, dailyBooked }) {
  if (!exact) return false
  return checkBookedMtd({ mtd: byRepTotal(exact), prevMtd: byRepTotal(prev), dailyBooked }).ok
}

// Total booked that day from the Daily Booking Report's own rows, or null.
async function dailyBookedTotalFor(dateStr) {
  const msgs = await fetchEvidentEmailsInRange(`subject:"Daily Booking Report - Nadine" after:${gmailDate(dateStr, -1)} before:${gmailDate(dateStr, 2)}`)
  const m = msgs.find((x) => x.date === dateStr)
  if (!m) return null
  return Math.round(extractBookingRows(m.html).reduce((s, r) => s + (r.value || 0), 0) * 100) / 100
}

// EviSmart's report for the day (totals and extra tables), cached briefly:
// every rep and the WhatsApp post ask about the same day.
const eviSmartDayCache = new Map()
function eviSmartDayFor(dateStr) {
  const hit = eviSmartDayCache.get(dateStr)
  if (hit && Date.now() - hit.at < MTD_CACHE_MS) return hit.promise
  const promise = fetchEviSmartEmails().then((msgs) => {
    const found = pickEviSmartMessageForDate(msgs, dateStr)
    return { totals: found ? found.totals : null, extras: found ? extractEviSmartExtras(found.message.html) : null }
  })
  eviSmartDayCache.set(dateStr, { at: Date.now(), promise })
  promise.catch(() => eviSmartDayCache.delete(dateStr))
  return promise
}

async function eviSmartRepMtdFor(dateStr, kind) {
  const { totals } = await eviSmartDayFor(dateStr)
  const rep = totals && totals.repMtd && totals.repMtd[kind === 'billed' ? 'billed' : 'booked']
  return rep ? { na: rep.na, james: rep.james, william: rep.william } : null
}

async function fetchMtdByRepAsOf(dateStr, kind) {
  const cacheKey = `${kind}|${dateStr}`
  const hit = mtdCache.get(cacheKey)
  if (hit && Date.now() - hit.at < MTD_CACHE_MS) return hit.promise
  const monthStart = `${dateStr.slice(0, 7)}-01`
  const promise = (async () => {
    // EviSmart first (user decision, 2026-10-09); Evident only without it.
    try {
      const fromEviSmart = await eviSmartRepMtdFor(dateStr, kind)
      if (fromEviSmart) return fromEviSmart
    } catch (err) { console.error('[sales-rep-daily-report] EviSmart by-rep lookup failed:', err.message) }
    return fetchEvidentEmailsInRange(
      `subject:"${MTD_QUERY[kind]}" after:${gmailDate(monthStart, -1)} before:${gmailDate(dateStr, 2)}`
    )
  })().then(async (msgs) => {
    if (!Array.isArray(msgs)) return msgs
    let exact = pickMtdByRepAsOf(msgs.filter((m) => m.date === dateStr), dateStr, kind)
    let rejected = false
    if (exact && kind === 'booked') {
      const prevDate = previousWeekday(dateStr)
      const prev = sameMonth(prevDate, dateStr) ? pickMtdByRepAsOf(msgs.filter((m) => m.date === prevDate), prevDate, 'booked') : null
      let dailyBooked = null
      try { dailyBooked = await dailyBookedTotalFor(dateStr) } catch (err) { console.error('[sales-rep-daily-report] daily booked lookup failed:', err.message) }
      if (!acceptBookedByRep({ exact, prev, dailyBooked })) {
        console.warn(`[sales-rep-daily-report] Evident MTD Booked for ${dateStr} looks wrong (company total ${byRepTotal(exact)}, previous ${byRepTotal(prev)}, day booked ${dailyBooked}); not using it`)
        exact = null
        rejected = true
      }
    }
    if (exact) return exact
    let eviSmart = null
    try { eviSmart = await eviSmartRepMtdFor(dateStr, kind) } catch (err) { console.error('[sales-rep-daily-report] EviSmart by-rep fallback failed:', err.message) }
    // A rejected reading must not be replaced by an older email either.
    return pickMtdSource({ exact, eviSmart, older: eviSmart || rejected ? null : pickMtdByRepAsOf(msgs, dateStr, kind) })
  })
  mtdCache.set(cacheKey, { at: Date.now(), promise })
  promise.catch(() => mtdCache.delete(cacheKey))
  return promise
}

// The rep's real month-to-date total (billed by default) for dateStr's
// month, or null when Evident's email isn't available (callers show "—",
// never a guess).
async function evidentMtdForRep(repEmail, dateStr, kind = 'billed') {
  const key = EVIDENT_REP_KEY_BY_EMAIL[repEmail]
  if (!key) return null
  try {
    const byRep = await fetchMtdByRepAsOf(dateStr, kind)
    return byRep ? byRep[key] : null
  } catch (err) {
    console.error(`[sales-rep-daily-report] failed to fetch Evident MTD ${kind} for ${repEmail} as of ${dateStr}:`, err.message)
    return null
  }
}

// Company month-to-date total (every rep plus N/A) from the same email.
async function evidentMtdCompanyTotal(dateStr, kind) {
  try {
    const byRep = await fetchMtdByRepAsOf(dateStr, kind)
    return byRep ? Math.round((byRep.na + byRep.james + byRep.william) * 100) / 100 : null
  } catch (err) {
    console.error(`[sales-rep-daily-report] failed to fetch Evident company MTD ${kind} as of ${dateStr}:`, err.message)
    return null
  }
}

function lastDayOfPriorMonth(dateStr) {
  const [y, m] = dateStr.split('-').map(Number)
  const d = new Date(Date.UTC(y, m - 1, 0))
  return d.toISOString().slice(0, 10)
}

function applySalesFromEvidentMtd(goal, mtdValue) {
  if (!goal || mtdValue === null || mtdValue === undefined) return null
  const target = Number(goal.target)
  const pct = target > 0 ? Math.min(Math.round((mtdValue / target) * 100), 100) : 0
  return { ...goal, current_value: mtdValue, progress_pct: pct }
}

// Calendar-month fallback new-doctors targets — only used when a rep has no
// real per-month new_doctors goal row covering the date (see
// computeMonthlyDoctorsGoal below). Was the ONLY source until 2026-09-28,
// when it was found to silently override each rep's real Operation Final
// Push target (James 18/17/15 and William 12/10/8 across Oct/Nov/Dec, not
// one flat number) — now just the same-shape fallback computeMonthlySalesGoal
// already had for monthly_revenue.
const MONTHLY_NEW_DOCTOR_TARGETS = {
  'james@aimdentallab.com': 16,
  'williama@aimdentallab.com': 12,
}

// New doctors this month for the bar: mirrors computeMonthlySalesGoal
// exactly — prefers the rep's own existing new_doctors goal row for the
// date (so real per-rep, per-month targets from Operation Final Push are
// used once entered), falling back to the flat MONTHLY_NEW_DOCTOR_TARGETS
// default only when no such row exists yet. Best-effort: null on any
// failure, same as the sales bar.
// New doctors for the month: EviSmart's "New doctors by rep" table (doctors
// whose first case falls this month) replaces the CRM-based count whenever
// the day's EviSmart report has that table (user decision, 2026-10-09).
async function withEviSmartNewDoctors(progress, repEmail, dateStr) {
  if (!progress) return progress
  try {
    const key = EVIDENT_REP_KEY_BY_EMAIL[repEmail]
    const { extras } = await eviSmartDayFor(dateStr)
    const list = key && extras && extras.newDoctors && extras.newDoctors[key]
    if (!list) return progress
    const target = Number(progress.target)
    return { ...progress, current_value: list.length, progress_pct: target > 0 ? Math.min(Math.round((list.length / target) * 100), 100) : 0 }
  } catch (err) {
    console.error('[sales-rep-daily-report] EviSmart new doctors lookup failed, using the CRM count:', err.message)
    return progress
  }
}

// Names of this month's new doctors or practices for a rep, from the same
// EviSmart table the count uses; null when the day's report has no such table
// or cannot be read (callers then show no names rather than guess).
async function eviSmartNewDoctorNamesForRep(repEmail, dateStr) {
  try {
    const key = EVIDENT_REP_KEY_BY_EMAIL[repEmail]
    const { extras } = await eviSmartDayFor(dateStr)
    const list = key && extras && extras.newDoctors && extras.newDoctors[key]
    return list ? list.map((d) => d.name) : null
  } catch (err) {
    console.error('[sales-rep-daily-report] EviSmart new doctor names lookup failed:', err.message)
    return null
  }
}

async function computeMonthlyDoctorsGoal(repEmail, dateStr) {
  return withEviSmartNewDoctors(await computeMonthlyDoctorsGoalFromCrm(repEmail, dateStr), repEmail, dateStr)
}

async function computeMonthlyDoctorsGoalFromCrm(repEmail, dateStr) {
  try {
    const { rows: [rep] } = await db.query(`SELECT id FROM users WHERE email=$1`, [repEmail])
    if (!rep) return null
    const { rows: [existing] } = await db.query(
      `SELECT * FROM goals WHERE rep_id=$1 AND metric='new_doctors' AND period_start <= $2 AND period_end >= $2 ORDER BY created_at DESC LIMIT 1`,
      [rep.id, dateStr]
    )
    if (existing) return await computeProgress(existing)
    const target = MONTHLY_NEW_DOCTOR_TARGETS[repEmail]
    if (!target) return null
    const { start, end, monthName } = monthWindow(dateStr)
    return await computeProgress({
      rep_id: rep.id, metric: 'new_doctors', target,
      period_start: start, period_end: end, title: `New Doctors - ${monthName}`,
    })
  } catch (err) {
    console.error(`[sales-rep-daily-report] failed to compute monthly doctors goal for ${repEmail}:`, err.message)
    return null
  }
}

// Weekdays (Mon-Fri) left in dateStr's month AFTER dateStr, for the "days
// left" line. Holidays aren't subtracted; it's a friendly countdown, not
// a payroll figure.
function businessDaysLeftInMonth(dateStr) {
  const { end } = monthWindow(dateStr)
  let count = 0
  const cur = new Date(`${dateStr}T00:00:00Z`)
  const last = new Date(`${end}T00:00:00Z`)
  for (cur.setUTCDate(cur.getUTCDate() + 1); cur <= last; cur.setUTCDate(cur.getUTCDate() + 1)) {
    const dow = cur.getUTCDay()
    if (dow !== 0 && dow !== 6) count += 1
  }
  return count
}

// Doctor names Evident shows this rep booked a case for THIS WEEK
// (Monday through dateStr), straight from their own "Daily Booked Cases"
// emails — used to keep "Submitted" status in the Active Doctors List
// consistent with reality. Without this, a doctor can show "Not
// Submitted" despite a real booking earlier this week:
// computeDailyDoctorStatus checks the CRM's own `cases` table, which only
// reflects whatever was last imported via cases.js's import-evident route
// — a manual/separate step, not yet wired to run automatically the
// moment Evident sends a booking (the larger "automated CRM sync"
// feature this pipeline is still building toward). Widened from "today
// only" to "this week" 2026-09-17, after a real case (William's Dr.
// Alberto Gonzalez, booked Monday) showed "Not Submitted" on a later day
// in the same week despite genuinely being active — a same-day-only
// check was too narrow for what "Submitted" should mean here. Same
// week-range fetch pattern used for the booked-doctor names.
// Best-effort: a Gmail hiccup returns an empty set, so the report still
// renders using CRM data alone.
async function fetchRepBookedDoctorNamesThisWeek(repEmail, dateStr) {
  const repKey = EVIDENT_REP_KEY_BY_EMAIL[repEmail]
  if (!repKey) return new Set()
  try {
    const weekStart = mondayOfWeekEastern(dateStr)
    const days = daysBetween(weekStart, dateStr)
    const label = EVIDENT_DAILY_BOOKED_LABEL_BY_REP_KEY[repKey]
    const messages = await fetchEvidentEmailsInRange(`subject:"${label}" newer_than:8d`)

    const names = new Set()
    for (const msg of messages) {
      if (!days.includes(msg.date)) continue
      for (const name of extractDailyBookedCustomerNames(msg.html)) {
        names.add(normalizeDoctorName(name))
      }
    }
    return names
  } catch (err) {
    console.error(`[sales-rep-daily-report] failed to fetch this week's booked doctor names for ${repEmail}:`, err.message)
    return new Set()
  }
}

// This rep's real Daily Booked/Billed (count + $) for exactly `dateStr`,
// filtered out of the COMPANY-WIDE "Daily Booking Report - Nadine" /
// "Daily Billed Report - Nadine" emails (evidentReport/parseEvident.js's
// extractBookingRows/extractBilledRows) by matching each row's customer
// name against doctors this rep owns in the CRM (clients.assigned_to),
// the same client_name<->doctor_name join clientRevenue.js already uses
// company-wide. Originally filtered by each row's own Salesperson column
// instead, but real data showed that column populated on only ~2 of every
// ~90-120 rows (checked across 6 real days, 2026-09-30) — CRM ownership is
// the reliable signal, matching how countNewDoctorsOnDate below already
// resolves rep ownership for this same report. Best-effort: any failure
// (Gmail hiccup, no email that day, no repId) returns nulls rather than a
// fabricated $0, matching this file's other best-effort Evident lookups.
// Cases billed = rows actually invoiced (Total Billed > 0). Evident's Daily
// Billed Report also lists rows with a Sales Value but a blank Total Billed;
// those are not billed yet and used to be counted ("5 cases billed $0.00").
function summarizeBilledRows(rows) {
  const billed = rows.filter((r) => r.billedValue > 0)
  return { count: billed.length, value: billed.reduce((sum, r) => sum + r.billedValue, 0) }
}

async function computeRepDailyEvidentStats(repEmail, dateStr, repId) {
  const empty = { dailyBookedCount: null, dailyBookedValue: null, dailyBilledCount: null, dailyBilledValue: null }
  if (!repId) return empty
  try {
    const { rows: ownedDoctors } = await db.query(`SELECT doctor_name FROM clients WHERE assigned_to = $1`, [repId])
    const ownedNames = new Set(ownedDoctors.map((r) => normalizeDoctorName(r.doctor_name)))
    if (ownedNames.size === 0) return empty

    const [bookingMessages, billedMessages] = await Promise.all([
      fetchEvidentEmailsInRange(`subject:"Daily Booking Report - Nadine" newer_than:5d`),
      fetchEvidentEmailsInRange(`subject:"Daily Billed Report - Nadine" newer_than:5d`),
    ])
    const bookingMsg = bookingMessages.find((m) => m.date === dateStr)
    const billedMsg = billedMessages.find((m) => m.date === dateStr)
    const bookingRows = bookingMsg
      ? extractBookingRows(bookingMsg.html).filter((r) => ownedNames.has(normalizeDoctorName(r.customerName)))
      : null
    const billedRows = billedMsg
      ? extractBilledRows(billedMsg.html).filter((r) => ownedNames.has(normalizeDoctorName(r.customerName)))
      : null
    return {
      dailyBookedCount: bookingRows ? bookingRows.length : null,
      dailyBookedValue: bookingRows ? bookingRows.reduce((sum, r) => sum + r.value, 0) : null,
      dailyBilledCount: billedRows ? summarizeBilledRows(billedRows).count : null,
      dailyBilledValue: billedRows ? summarizeBilledRows(billedRows).value : null,
    }
  } catch (err) {
    console.error(`[sales-rep-daily-report] failed to fetch daily booked/billed for ${repEmail}:`, err.message)
    return empty
  }
}

// How many of this rep's doctors sent their real FIRST-EVER case on
// exactly `dateStr` — matched by the earliest case date per doctor, not
// by when the client row was created (that can lag the real first case
// by days when a client is auto-created after the fact; see the
// Suite 905 Dental discrepancy found 2026-09-29). Real DB query, not an
// Evident email, since this is exactly what the CRM's own cases/clients
// join already answers accurately for any rep.
async function countNewDoctorsOnDate(repId, dateStr) {
  const { rows: [r] } = await db.query(
    `SELECT COUNT(*) AS n FROM (
       SELECT cl.doctor_name, MIN(c.created_at::date) AS first_case
       FROM clients cl JOIN cases c ON c.client_name = cl.doctor_name
       WHERE cl.assigned_to = $1
       GROUP BY cl.doctor_name
     ) x WHERE first_case = $2::date`,
    [repId, dateStr]
  )
  return Number(r.n)
}

// Same first-case-date logic as countNewDoctorsOnDate, but returns the
// real doctor/practice names instead of just a count — backs the
// WhatsApp team post's "won today" line (Ben's request, 2026-10-01).
async function listNewDoctorNamesOnDate(repId, dateStr) {
  const { rows } = await db.query(
    `SELECT doctor_name FROM (
       SELECT cl.doctor_name, MIN(c.created_at::date) AS first_case
       FROM clients cl JOIN cases c ON c.client_name = cl.doctor_name
       WHERE cl.assigned_to = $1
       GROUP BY cl.doctor_name
     ) x WHERE first_case = $2::date
     ORDER BY doctor_name`,
    [repId, dateStr]
  )
  return rows.map((r) => r.doctor_name)
}

// Same first-case-date logic as countNewDoctorsOnDate above, but summed
// across the whole week (Monday through dateStr) rather than one day —
// feeds the "Today" cards' weekly new-doctors pacing line (user request,
// 2026-09-30).
async function countNewDoctorsThisWeek(repId, dateStr) {
  const weekStart = mondayOfWeekEastern(dateStr)
  const { rows: [r] } = await db.query(
    `SELECT COUNT(*) AS n FROM (
       SELECT cl.doctor_name, MIN(c.created_at::date) AS first_case
       FROM clients cl JOIN cases c ON c.client_name = cl.doctor_name
       WHERE cl.assigned_to = $1
       GROUP BY cl.doctor_name
     ) x WHERE first_case BETWEEN $2::date AND $3::date`,
    [repId, weekStart, dateStr]
  )
  return Number(r.n)
}

// Same Monday-through-dateStr window as countNewDoctorsThisWeek above, but
// returns the real doctor/practice names instead of a count — backs the
// WhatsApp team post's "acquired this week" line (user request,
// 2026-10-02).
async function listNewDoctorNamesThisWeek(repId, dateStr) {
  const weekStart = mondayOfWeekEastern(dateStr)
  const { rows } = await db.query(
    `SELECT doctor_name FROM (
       SELECT cl.doctor_name, MIN(c.created_at::date) AS first_case
       FROM clients cl JOIN cases c ON c.client_name = cl.doctor_name
       WHERE cl.assigned_to = $1
       GROUP BY cl.doctor_name
     ) x WHERE first_case BETWEEN $2::date AND $3::date
     ORDER BY doctor_name`,
    [repId, weekStart, dateStr]
  )
  return rows.map((r) => r.doctor_name)
}

// Rough weekly pace for a monthly new-doctors target: the month's target
// spread evenly across its calendar weeks (Math.ceil so a partial week at
// the target's tail still counts as a full week to hit, e.g. an 18-doctor
// target in a 5-week month paces to 4/week, not 3.6). Not payroll-grade,
// just enough to give a rep a "doctors left this week" number to aim at.
function weeksInMonth(dateStr) {
  const { end } = monthWindow(dateStr)
  const lastDay = Number(end.split('-')[2])
  return Math.ceil(lastDay / 7)
}

// Returns the last COMPLETED business day before now, in America/New_York
// — NOT literally "today" (user correction, 2026-09-23, same real bug
// already fixed in evidentReport/index.js: this report arrives in the
// inbox each morning covering the PRIOR day's real activity — doctors who
// submitted "this week" — so a report generated/sent Wednesday morning
// needs Tuesday's date, not Wednesday's). Steps back one calendar day,
// then skips weekends, matching evidentReport/index.js's
// lastBusinessDayEasternDateString() logic — duplicated here rather than
// shared, matching this codebase's convention of each report file owning
// its own small ET-date helper (see mediaCleanup.js/socialTokenRefresh.js
// each owning their own cron setup too). 'en-CA' reliably formats as
// YYYY-MM-DD.
function lastBusinessDayEasternDateString() {
  const todayStr = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' })
  const d = new Date(`${todayStr}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() - 1)
  while (d.getUTCDay() === 0 || d.getUTCDay() === 6) {
    d.setUTCDate(d.getUTCDate() - 1)
  }
  return d.toISOString().slice(0, 10)
}

// Monday of the week containing dateStr (both 'YYYY-MM-DD'), computed
// with Date.UTC so the result doesn't depend on the server process's own
// local timezone — pure calendar-day arithmetic, not a real moment in time.
function mondayOfWeekEastern(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number)
  const date = new Date(Date.UTC(y, m - 1, d))
  const day = date.getUTCDay()
  const diff = day === 0 ? 6 : day - 1
  date.setUTCDate(date.getUTCDate() - diff)
  return date.toISOString().slice(0, 10)
}

// "Submitted a case this week" (Monday through dateStr, in progress) —
// widened from a strict "today only" check 2026-09-17, after checking a
// real case: a doctor can genuinely submit on, say, Monday and then sit
// untouched in a report that only asks "did they submit TODAY", getting
// nudged to be "reached out to" despite already being active this week.
// Matches weeklyRepReport.js's/cases.js's existing client<->case
// attribution: cases have no assigned_to or client_id of their own,
// matched by cl.doctor_name = c.client_name.
//
// The date boundary is a plain `created_at::date` range rather than an
// `AT TIME ZONE` window. Two reasons: (1) `$2::date AT TIME ZONE
// 'America/New_York'` doesn't resolve to the overload its shape suggests —
// it resolves to `timezone(text, timestamptz)`, which treats the date as
// already being UTC midnight and re-offsets it, producing a window shifted
// by several hours from true ET midnight (proven against this live DB: for
// '2026-09-09' it produced a [2026-09-08 20:00Z, 2026-09-09 20:00Z) window
// instead of true ET midnight-to-midnight). (2) Evident-imported cases —
// the dominant source of case-creation volume (see cases.js's
// import-evident) — have `created_at` stored as UTC midnight of Evident's
// own business date (`new Date(row.first_arrival).toISOString()`), not a
// real-time timestamp, so a wall-clock ET window isn't even the right tool
// here: a plain date-range cast is. This also matches the existing
// `::date` convention already used elsewhere in this codebase for the same
// kind of check (weeklyRepReport.js's cold-lead query, goals.js's
// computeProgress).
// Doctors and prospects split into three sections (user request,
// 2026-09-29, replacing one combined "reach out" list): a client counts
// as "dormant" once 30+ days have passed since their most recent case
// (threshold confirmed by the user) — DORMANT_DAYS below, not a magic
// number inlined into the query. "Prospect" is now driven directly by
// last_case_date IS NULL (a real doctor with zero cases ever) rather
// than the old notes-marker heuristic (`notes ILIKE '%No case sent yet
// at import%'`), which only caught doctors imported with that exact
// marker and would have missed a genuine zero-case doctor added any
// other way. A doctor who submitted this week always has a last_case_date
// inside the current week, so submitted/dormant/prospect stay mutually
// exclusive by construction — no separate exclusion logic needed.
const DORMANT_DAYS = 30

async function computeDailyDoctorStatus(repId, dateStr) {
  const weekStart = mondayOfWeekEastern(dateStr)
  const { rows } = await db.query(
    `SELECT cl.doctor_name, cl.clinic_name, lc.last_case_date,
      (lc.last_case_date IS NULL) AS first_case_pending,
      (lc.last_case_date IS NOT NULL AND lc.last_case_date < $3::date - $4::int) AS dormant,
      EXISTS (
        SELECT 1 FROM cases c
        WHERE c.client_name = cl.doctor_name
          AND c.created_at::date >= $2::date AND c.created_at::date <= $3::date
      ) AS submitted_this_week
     FROM clients cl
     LEFT JOIN LATERAL (
       SELECT MAX(c2.created_at::date) AS last_case_date
       FROM cases c2 WHERE c2.client_name = cl.doctor_name
     ) lc ON true
     WHERE cl.assigned_to = $1
     ORDER BY cl.doctor_name`,
    [repId, weekStart, dateStr, DORMANT_DAYS]
  )
  const doctors = rows.map(r => ({
    doctor_name: r.doctor_name,
    clinic_name: r.clinic_name,
    submitted_this_week: r.submitted_this_week,
    first_case_pending: r.first_case_pending,
    dormant: r.dormant,
  }))
  const submittedCount = doctors.filter(d => d.submitted_this_week).length
  return {
    doctors,
    totalCount: doctors.length,
    submittedCount,
    notSubmittedCount: doctors.length - submittedCount,
  }
}

function normalizeDoctorName(name) {
  return (name || '').toLowerCase().replace(/[.,]/g, '').replace(/\s+/g, ' ').trim()
}

// Every 'YYYY-MM-DD' from startStr through endStr, inclusive.
function daysBetween(startStr, endStr) {
  const days = []
  let cur = startStr
  while (cur <= endStr) {
    days.push(cur)
    const [y, m, d] = cur.split('-').map(Number)
    const date = new Date(Date.UTC(y, m - 1, d))
    date.setUTCDate(date.getUTCDate() + 1)
    cur = date.toISOString().slice(0, 10)
  }
  return days
}

async function buildDailyReportHtml(repName, repEmail, dateStr, status, { test = false, repId = null } = {}) {
  const dateLabel = new Date(`${dateStr}T12:00:00`).toLocaleDateString('en-US', {
    weekday: 'long', month: 'long', day: 'numeric', year: 'numeric',
  })
  const salesGoal = applySalesFromEvidentMtd(
    await computeMonthlySalesGoal(repEmail, dateStr),
    await evidentMtdForRep(repEmail, dateStr, 'billed')
  )
  const doctorsGoal = await computeMonthlyDoctorsGoal(repEmail, dateStr)
  const daysLeft = businessDaysLeftInMonth(dateStr)

  // Today's real cards (user request, 2026-09-30): booked/billed cases +
  // value for exactly `dateStr`, plus new doctors today paced against a
  // weekly target derived from the monthly new-doctors goal — not the
  // monthly running total the bars above already show.
  const dailyEvident = await computeRepDailyEvidentStats(repEmail, dateStr, repId)
  let dailyNewDoctors = repId ? await countNewDoctorsOnDate(repId, dateStr) : null
  let doctorsThisWeek = repId ? await countNewDoctorsThisWeek(repId, dateStr) : null
  // EviSmart's "New doctors by rep" table is the source when the day's report
  // has it (user decision, 2026-10-09); the CRM counts above are the fallback.
  try {
    const { extras } = await eviSmartDayFor(dateStr)
    const fromEviSmart = countEviSmartNewDoctors(extras, EVIDENT_REP_KEY_BY_EMAIL[repEmail], dateStr, mondayOfWeekEastern(dateStr))
    if (fromEviSmart) { dailyNewDoctors = fromEviSmart.today; doctorsThisWeek = fromEviSmart.week }
  } catch (err) {
    console.error('[sales-rep-daily-report] EviSmart new doctors (today/week) lookup failed, using the CRM counts:', err.message)
  }
  const weeklyDoctorsTarget = doctorsGoal ? Math.ceil(doctorsGoal.target / weeksInMonth(dateStr)) : null
  const doctorsLeftForWeeklyGoal =
    weeklyDoctorsTarget !== null && doctorsThisWeek !== null ? Math.max(weeklyDoctorsTarget - doctorsThisWeek, 0) : null
  const dailyStats = { ...dailyEvident, dailyNewDoctors, doctorsThisWeek, weeklyDoctorsTarget, doctorsLeftForWeeklyGoal }

  // Animated bars (user request, 2026-09-28), re-enabled 2026-09-30 for
  // the final leadership sign-off send ahead of the October 1 rollout —
  // best-effort: renderGoalBarsGif never throws, so a Chrome/encoding/
  // upload failure just means barsGifUrl stays null and
  // salesRepDailyReportEmailRedesigned falls back to its existing static
  // bars, same report either way, never a blocked or broken send.
  const barsGifUrl = await renderGoalBarsGif({ salesGoal, doctorsGoal, casesGoal: null, repEmail, dateStr })

  // Enrich the CRM-sourced doctor list with live Evident data: a doctor
  // counts as submitted this week if EITHER the CRM has a case dated this
  // week OR Evident's own live emails show a booking this week — see
  // fetchRepBookedDoctorNamesThisWeek's comment for why the CRM alone can
  // lag behind what actually happened.
  const liveBookedNames = await fetchRepBookedDoctorNamesThisWeek(repEmail, dateStr)
  const doctors = status.doctors.map((d) => {
    const submitted_this_week = d.submitted_this_week || liveBookedNames.has(normalizeDoctorName(d.doctor_name))
    // A live Evident booking this week means they're not actually
    // dormant anymore even though the CRM's own case row hasn't landed
    // yet — same reasoning as the submitted_this_week override above.
    return { ...d, submitted_this_week, dormant: d.dormant && !submitted_this_week }
  })
  const submittedCount = doctors.filter((d) => d.submitted_this_week).length
  const enrichedStatus = { ...status, doctors, submittedCount, notSubmittedCount: doctors.length - submittedCount }

  const html = salesRepDailyReportEmail({ repName, dateLabel, dateStr, ...enrichedStatus, test, salesGoal, doctorsGoal, daysLeft, barsGifUrl, dailyStats })
  return { html, dateLabel }
}

// Sends one rep's daily report. `to`/`cc` overrides exist for the
// admin-triggered test send (routes/reports.js) — omit both to send to the
// rep's own address, cc'd to Yoel, exactly as the weekday automated job
// does. `test: true` prepends a "TEST" subject marker and banner, same
// convention as every other report in this codebase. Always bcc'd to
// media@aimdentallab.com, per standing rule (matches every other
// leadership-facing/sales-rep report email in this codebase).
async function sendRepDailyReport(rep, { to, cc = REPORT_CC, test = false, dateStr = lastBusinessDayEasternDateString() } = {}) {
  const status = await computeDailyDoctorStatus(rep.id, dateStr)
  const { html, dateLabel } = await buildDailyReportHtml(rep.name || rep.email, rep.email, dateStr, status, { test, repId: rep.id })
  await sendEmail({
    to: to || rep.email,
    ...(cc?.length ? { cc } : {}),
    bcc: ['media@aimdentallab.com'],
    subject: `${test ? 'TEST — ' : ''}Daily Sales Report — ${rep.name || rep.email} — ${dateLabel}`,
    html,
  })
  return { status }
}

// Builds this rep's report (live data, no send to the rep) and emails it
// to APPROVER_EMAIL with an "Approve & Send" button. Clicking it hits
// routes/reports.js's public GET /approve, which calls sendRepDailyReport
// above for the actual real send — so approving always re-fetches fresh
// live data at send time rather than replaying this preview's snapshot,
// same principle as sendEvidentReportForApproval. No duplicate guard here
// (a fresh preview is harmless and repeatable); sendRepDailyReport itself
// has none either, so a double-approval-click is what the token's
// single-use consumption in routes/reports.js guards against instead.
async function sendRepDailyReportForApproval(rep, dateStr = lastBusinessDayEasternDateString()) {
  const status = await computeDailyDoctorStatus(rep.id, dateStr)
  const { html, dateLabel } = await buildDailyReportHtml(rep.name || rep.email, rep.email, dateStr, status, { repId: rep.id })

  const token = await createApprovalToken({ reportType: 'sales-rep-daily-report', repId: rep.id, reportDate: dateStr })
  const approveUrl = buildApproveUrl(token)
  const bannered = injectApprovalBanner(html, { reportLabel: `${rep.name || rep.email}'s Daily Sales Report`, approveUrl })

  const subject = `Approve? — Daily Sales Report — ${rep.name || rep.email} — ${dateLabel}`
  await sendEmail({ to: [APPROVER_EMAIL], subject, html: bannered })
  return { subject, approveUrl }
}

// Weekday-morning automated send (jobs/salesRepDailyReport.js) — James and
// William only. Sends each rep's preview to APPROVER_EMAIL with its own
// "Approve & Send" button (sendRepDailyReportForApproval), never straight
// to the rep — was sendRepDailyReport() (direct real send) until
// 2026-09-18; that bypassed the click-to-approve system entirely, same
// bug jobs/evidentReport.js had. Best-effort per rep so one bad email/DB
// hiccup doesn't block the other rep's preview.
async function sendAllSalesRepDailyReports() {
  const { rows: reps } = await db.query(
    `SELECT id, name, email FROM users WHERE email = ANY($1::text[])`,
    [DAILY_REPORT_REP_EMAILS]
  )
  const results = []
  for (const rep of reps) {
    try {
      await sendRepDailyReportForApproval(rep)
      results.push({ rep: rep.email, success: true })
    } catch (err) {
      console.error(`[sales-rep-daily-report] failed for ${rep.email}:`, err.message)
      results.push({ rep: rep.email, success: false, error: err.message })
    }
  }
  return results
}

module.exports = {
  monthWindow,
  MONTHLY_SALES_TARGET,
  computeMonthlySalesGoal,
  computeMonthlyDoctorsGoal,
  lastBusinessDayEasternDateString,
  computeDailyDoctorStatus,
  businessDaysLeftInMonth,
  MONTHLY_NEW_DOCTOR_TARGETS,
  buildDailyReportHtml,
  sendRepDailyReport,
  sendRepDailyReportForApproval,
  sendAllSalesRepDailyReports,
  mondayOfWeekEastern,
  DAILY_REPORT_REP_EMAILS,
  REPORT_CC,
  computeRepDailyEvidentStats,
  countNewDoctorsOnDate,
  listNewDoctorNamesOnDate,
  countNewDoctorsThisWeek,
  listNewDoctorNamesThisWeek,
  weeksInMonth,
  pickMtdByRepAsOf,
  acceptBookedByRep,
  eviSmartNewDoctorNamesForRep,
  pickMtdSource,
  summarizeBilledRows,
  evidentMtdForRep,
  evidentMtdCompanyTotal,
  lastDayOfPriorMonth,
  applySalesFromEvidentMtd,
}
