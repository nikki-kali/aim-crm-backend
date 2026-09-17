const db = require('../config/db')
const { sendEmail, salesRepDailyReportEmail } = require('./email')
const { fetchEvidentEmailsInRange } = require('./evidentReport/gmailFetch')
const { extractDailyBookedCustomerNames, extractCaseTotals } = require('./evidentReport/parseEvident')
const { APPROVER_EMAIL, createApprovalToken, buildApproveUrl, injectApprovalBanner } = require('./reportApproval')

// Recipients are the two real AIM reps by email, not a role query — role
// IN ('staff','sales_rep') would also catch Yoel Klein and the TEST
// ACCOUNT, both sales_rep but neither a real AIM rep for this report. See
// docs/superpowers/specs/2026-09-15-sales-rep-daily-and-leadership-report-design.md.
const DAILY_REPORT_REP_EMAILS = ['james@aimdentallab.com', 'williama@aimdentallab.com']
// Yoel is cc'd on both reps' emails for visibility, not sent his own
// personalized report for his own KH doctors.
const REPORT_CC = ['yoel@khdentallab.com']

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

// This week's (Monday through dateStr) booked cases + how much of that is
// already billed, straight from Evident's own "Daily Booked Cases" report
// for this rep, summed day by day — the same per-day parsing the
// Leadership Report already relies on, so these numbers can never drift
// from what leadership sees. Widened from "today only" to "this week"
// 2026-09-17, alongside the same change to Submitted status, so the KPI
// cards and the Active Doctors List describe the same window. hasData is
// true as long as at least one real email for this rep arrived within the
// week (even a genuine zero-booking day still counts) — only false when
// nothing came back at all, so the section is omitted rather than shown
// as a fabricated $0. Best-effort: a Gmail hiccup or an unrecognized rep
// email must never block the rest of the report from sending, so this
// always resolves to { hasData: false } rather than throwing.
async function fetchRepBookedThisWeek(repEmail, dateStr) {
  const repKey = EVIDENT_REP_KEY_BY_EMAIL[repEmail]
  if (!repKey) return { hasData: false }
  try {
    const weekStart = mondayOfWeekEastern(dateStr)
    const days = daysBetween(weekStart, dateStr)
    const label = EVIDENT_DAILY_BOOKED_LABEL_BY_REP_KEY[repKey]
    const messages = await fetchEvidentEmailsInRange(`subject:"${label}" newer_than:8d`)

    const totals = { count: 0, billed: 0, wip: 0, value: 0 }
    let hasData = false
    for (const msg of messages) {
      if (!days.includes(msg.date)) continue
      hasData = true
      const t = extractCaseTotals(msg.html)
      totals.count += t.count
      totals.billed += t.billed
      totals.wip += t.wip
      totals.value += t.value
    }
    return { ...totals, hasData }
  } catch (err) {
    console.error(`[sales-rep-daily-report] failed to fetch this week's booked/billed for ${repEmail}:`, err.message)
    return { hasData: false }
  }
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
// week-range fetch pattern as countNewDoctorsBookedThisWeek below.
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

const DEFAULT_WEEKLY_NEW_DOCTOR_TARGET = 5

// 'en-CA' reliably formats as YYYY-MM-DD. Each report file in this
// codebase owns its own small ET-date helper (see evidentReport/index.js's
// todayEasternDateString()) rather than sharing one, matching how
// mediaCleanup.js/socialTokenRefresh.js each own their own cron setup too.
function todayEasternDateString() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' })
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
async function computeDailyDoctorStatus(repId, dateStr) {
  const weekStart = mondayOfWeekEastern(dateStr)
  const { rows } = await db.query(
    `SELECT cl.doctor_name, cl.clinic_name,
      EXISTS (
        SELECT 1 FROM cases c
        WHERE c.client_name = cl.doctor_name
          AND c.created_at::date >= $2::date AND c.created_at::date <= $3::date
      ) AS submitted_this_week
     FROM clients cl
     WHERE cl.assigned_to = $1
     ORDER BY cl.doctor_name`,
    [repId, weekStart, dateStr]
  )
  const doctors = rows.map(r => ({
    doctor_name: r.doctor_name,
    clinic_name: r.clinic_name,
    submitted_this_week: r.submitted_this_week,
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

// A doctor who booked a case with this rep THIS WEEK (Monday through
// dateStr), per Evident's own "Daily Booked Cases" report, but who has no
// `clients` record at all yet — counted toward the weekly new-doctor goal
// immediately on booking, without waiting for a case to bill or for staff
// to manually add them to the CRM (billing alone can take weeks; the CRM
// record might never get created without someone noticing). Matched
// against clients.doctor_name case/punctuation-insensitively — not a full
// fuzzy match, but consistent with every other name check in this
// pipeline (see cases.js's import-evident route's own doctor-name
// matching). A doctor whose clients record was itself created this week
// is already counted by the query above via created_at, and correctly
// excluded here (their name IS now known), so nobody is double-counted.
// Best-effort: a Gmail hiccup returns 0 rather than throwing, so the goal
// still renders with at least the CRM-only count.
async function countNewDoctorsBookedThisWeek(repEmail, dateStr) {
  const repKey = EVIDENT_REP_KEY_BY_EMAIL[repEmail]
  if (!repKey) return 0
  try {
    const weekStart = mondayOfWeekEastern(dateStr)
    const label = EVIDENT_DAILY_BOOKED_LABEL_BY_REP_KEY[repKey]
    const days = daysBetween(weekStart, dateStr)
    // Sized to comfortably cover the whole week (up to 7 real days) plus a
    // cushion for delivery-time drift around midnight ET.
    const messages = await fetchEvidentEmailsInRange(`subject:"${label}" newer_than:8d`)

    const namesThisWeek = new Set()
    for (const msg of messages) {
      if (!days.includes(msg.date)) continue
      for (const name of extractDailyBookedCustomerNames(msg.html)) {
        namesThisWeek.add(normalizeDoctorName(name))
      }
    }
    if (namesThisWeek.size === 0) return 0

    const { rows } = await db.query(`SELECT doctor_name FROM clients`)
    const known = new Set(rows.map((r) => normalizeDoctorName(r.doctor_name)))

    let newCount = 0
    for (const name of namesThisWeek) {
      if (!known.has(name)) newCount++
    }
    return newCount
  } catch (err) {
    console.error(`[sales-rep-daily-report] failed to detect new doctors booked this week for ${repEmail}:`, err.message)
    return 0
  }
}

// "New doctor" counts two things toward `current`: (1) a clients row
// assigned to the rep with created_at in the current week (Monday through
// dateStr, in progress — live progress building across the week, not a
// completed prior week), and (2) a doctor Evident shows this rep booked
// this week who has no clients record anywhere yet (see
// countNewDoctorsBookedThisWeek above). Falls back to a default target of
// 5 when no admin-set weekly new_doctors goal exists for this rep for the
// current week; no goal row gets auto-created for the fallback case.
async function computeWeeklyNewDoctorGoal(repId, dateStr, repEmail) {
  const weekStart = mondayOfWeekEastern(dateStr)

  const [goalRes, countRes, newFromBookings] = await Promise.all([
    db.query(
      `SELECT target FROM goals
       WHERE rep_id=$1 AND metric='new_doctors' AND period='weekly'
         AND period_start <= $2 AND period_end >= $2`,
      [repId, dateStr]
    ),
    // Same `::date` reasoning as computeDailyDoctorStatus above — the
    // previous `AT TIME ZONE` boundary here was the same genuine bug, and
    // mattered more for this query than for the cases one, since
    // `clients.created_at` is set via a real `NOW()` at insert time (see
    // cases.js's import-evident client-create path), not UTC-midnight-of-
    // business-date, so it doesn't get the accidental cushion Evident-
    // imported `cases.created_at` rows do. Inclusive on both ends: Monday
    // (weekStart) through dateStr, matching "this week so far."
    db.query(
      `SELECT COUNT(*) AS val FROM clients
       WHERE assigned_to=$1
         AND created_at::date >= $2::date AND created_at::date <= $3::date`,
      [repId, weekStart, dateStr]
    ),
    countNewDoctorsBookedThisWeek(repEmail, dateStr),
  ])

  const target = goalRes.rows[0] ? Number(goalRes.rows[0].target) : DEFAULT_WEEKLY_NEW_DOCTOR_TARGET
  const current = Number(countRes.rows[0].val) + newFromBookings
  return { target, current, hasCustomGoal: !!goalRes.rows[0] }
}

async function buildDailyReportHtml(repName, repEmail, dateStr, status, goal, { test = false } = {}) {
  const dateLabel = new Date(`${dateStr}T12:00:00`).toLocaleDateString('en-US', {
    weekday: 'long', month: 'long', day: 'numeric', year: 'numeric',
  })
  const bookedThisWeek = await fetchRepBookedThisWeek(repEmail, dateStr)

  // Enrich the CRM-sourced doctor list with live Evident data: a doctor
  // counts as submitted this week if EITHER the CRM has a case dated this
  // week OR Evident's own live emails show a booking this week — see
  // fetchRepBookedDoctorNamesThisWeek's comment for why the CRM alone can
  // lag behind what actually happened.
  const liveBookedNames = await fetchRepBookedDoctorNamesThisWeek(repEmail, dateStr)
  const doctors = status.doctors.map((d) => ({
    ...d,
    submitted_this_week: d.submitted_this_week || liveBookedNames.has(normalizeDoctorName(d.doctor_name)),
  }))
  const submittedCount = doctors.filter((d) => d.submitted_this_week).length
  const enrichedStatus = { ...status, doctors, submittedCount, notSubmittedCount: doctors.length - submittedCount }

  const html = salesRepDailyReportEmail({ repName, dateLabel, ...enrichedStatus, goal, test, bookedThisWeek })
  return { html, dateLabel }
}

// Sends one rep's daily report. `to`/`cc` overrides exist for the
// admin-triggered test send (routes/reports.js) — omit both to send to the
// rep's own address, cc'd to Yoel, exactly as the weekday automated job
// does. `test: true` prepends a "TEST" subject marker and banner, same
// convention as every other report in this codebase. Always bcc'd to
// media@aimdentallab.com, per standing rule (matches every other
// leadership-facing/sales-rep report email in this codebase).
async function sendRepDailyReport(rep, { to, cc = REPORT_CC, test = false, dateStr = todayEasternDateString() } = {}) {
  const status = await computeDailyDoctorStatus(rep.id, dateStr)
  const goal = await computeWeeklyNewDoctorGoal(rep.id, dateStr, rep.email)
  const { html, dateLabel } = await buildDailyReportHtml(rep.name || rep.email, rep.email, dateStr, status, goal, { test })
  await sendEmail({
    to: to || rep.email,
    ...(cc?.length ? { cc } : {}),
    bcc: ['media@aimdentallab.com'],
    subject: `${test ? 'TEST — ' : ''}Daily Sales Report — ${rep.name || rep.email} — ${dateLabel}`,
    html,
  })
  return { status, goal }
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
async function sendRepDailyReportForApproval(rep, dateStr = todayEasternDateString()) {
  const status = await computeDailyDoctorStatus(rep.id, dateStr)
  const goal = await computeWeeklyNewDoctorGoal(rep.id, dateStr, rep.email)
  const { html, dateLabel } = await buildDailyReportHtml(rep.name || rep.email, rep.email, dateStr, status, goal, {})

  const token = await createApprovalToken({ reportType: 'sales-rep-daily-report', repId: rep.id, reportDate: dateStr })
  const approveUrl = buildApproveUrl(token)
  const bannered = injectApprovalBanner(html, { reportLabel: `${rep.name || rep.email}'s Daily Sales Report`, approveUrl })

  const subject = `Approve? — Daily Sales Report — ${rep.name || rep.email} — ${dateLabel}`
  await sendEmail({ to: [APPROVER_EMAIL], subject, html: bannered })
  return { subject, approveUrl }
}

// Weekday-morning automated send (jobs/salesRepDailyReport.js) — James and
// William only, cc'd to Yoel. Best-effort per rep so one bad email/DB
// hiccup doesn't block the other rep's report.
async function sendAllSalesRepDailyReports() {
  const { rows: reps } = await db.query(
    `SELECT id, name, email FROM users WHERE email = ANY($1::text[])`,
    [DAILY_REPORT_REP_EMAILS]
  )
  const results = []
  for (const rep of reps) {
    try {
      await sendRepDailyReport(rep)
      results.push({ rep: rep.email, success: true })
    } catch (err) {
      console.error(`[sales-rep-daily-report] failed for ${rep.email}:`, err.message)
      results.push({ rep: rep.email, success: false, error: err.message })
    }
  }
  return results
}

module.exports = {
  computeDailyDoctorStatus,
  computeWeeklyNewDoctorGoal,
  buildDailyReportHtml,
  sendRepDailyReport,
  sendRepDailyReportForApproval,
  sendAllSalesRepDailyReports,
  mondayOfWeekEastern,
  DAILY_REPORT_REP_EMAILS,
  REPORT_CC,
  DEFAULT_WEEKLY_NEW_DOCTOR_TARGET,
}
