const db = require('../config/db')
const { sendEmail, salesRepDailyReportEmail } = require('./email')
const { fetchEvidentEmailsInRange } = require('./evidentReport/gmailFetch')
const { extractDailyBookedCustomerNames } = require('./evidentReport/parseEvident')
const { computeProgress } = require('./goalProgress')
const { APPROVER_EMAIL, createApprovalToken, buildApproveUrl, injectApprovalBanner } = require('./reportApproval')
const { renderGoalBarsGif } = require('./goalBarGifRenderer')

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
async function computeMonthlyDoctorsGoal(repEmail, dateStr) {
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

async function buildDailyReportHtml(repName, repEmail, dateStr, status, { test = false } = {}) {
  const dateLabel = new Date(`${dateStr}T12:00:00`).toLocaleDateString('en-US', {
    weekday: 'long', month: 'long', day: 'numeric', year: 'numeric',
  })
  const salesGoal = await computeMonthlySalesGoal(repEmail, dateStr)
  const doctorsGoal = await computeMonthlyDoctorsGoal(repEmail, dateStr)
  const daysLeft = businessDaysLeftInMonth(dateStr)

  // Animated bars (user request, 2026-09-28) temporarily disabled (user
  // request, 2026-09-29: "send the old daily sales rep report... the one
  // without the animation") — skip the GIF render entirely rather than
  // just hiding it client-side, so the static bars below are what both
  // the approval preview AND the real send-on-approve show, consistently.
  // Revert this one line (call renderGoalBarsGif({...}) again) to turn
  // the animation back on.
  const barsGifUrl = null

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

  const html = salesRepDailyReportEmail({ repName, dateLabel, ...enrichedStatus, test, salesGoal, doctorsGoal, daysLeft, barsGifUrl })
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
  const { html, dateLabel } = await buildDailyReportHtml(rep.name || rep.email, rep.email, dateStr, status, { test })
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
  const { html, dateLabel } = await buildDailyReportHtml(rep.name || rep.email, rep.email, dateStr, status, {})

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
}
