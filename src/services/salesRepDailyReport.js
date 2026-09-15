const db = require('../config/db')
const { sendEmail, salesRepDailyReportEmail } = require('./email')

// Recipients are the two real AIM reps by email, not a role query — role
// IN ('staff','sales_rep') would also catch Yoel Klein and the TEST
// ACCOUNT, both sales_rep but neither a real AIM rep for this report. See
// docs/superpowers/specs/2026-09-15-sales-rep-daily-and-leadership-report-design.md.
const DAILY_REPORT_REP_EMAILS = ['james@aimdentallab.com', 'williama@aimdentallab.com']
// Yoel is cc'd on both reps' emails for visibility, not sent his own
// personalized report for his own KH doctors.
const REPORT_CC = ['yoel@khdentallab.com']

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

// "Submitted a case today" mirrors weeklyRepReport.js's/cases.js's
// existing client<->case attribution: cases have no assigned_to or
// client_id of their own, matched by cl.doctor_name = c.client_name. The
// day boundary is computed in Postgres via AT TIME ZONE (not JS Date
// arithmetic) — the same DST/UTC-drift class of bug the Evident report's
// review already caught once in this codebase.
async function computeDailyDoctorStatus(repId, dateStr) {
  const { rows } = await db.query(
    `SELECT cl.doctor_name, cl.clinic_name,
      EXISTS (
        SELECT 1 FROM cases c
        WHERE c.client_name = cl.doctor_name
          AND c.created_at >= ($2::date AT TIME ZONE 'America/New_York')
          AND c.created_at <  (($2::date + 1) AT TIME ZONE 'America/New_York')
      ) AS submitted_today
     FROM clients cl
     WHERE cl.assigned_to = $1
     ORDER BY cl.doctor_name`,
    [repId, dateStr]
  )
  const doctors = rows.map(r => ({
    doctor_name: r.doctor_name,
    clinic_name: r.clinic_name,
    submitted_today: r.submitted_today,
  }))
  const submittedCount = doctors.filter(d => d.submitted_today).length
  return {
    doctors,
    totalCount: doctors.length,
    submittedCount,
    notSubmittedCount: doctors.length - submittedCount,
  }
}

// "New doctor" = a clients row assigned to the rep with created_at in the
// current week (Monday through dateStr, in progress — live progress
// building across the week, not a completed prior week). Falls back to a
// default target of 5 when no admin-set weekly new_doctors goal exists for
// this rep for the current week; no goal row gets auto-created for the
// fallback case.
async function computeWeeklyNewDoctorGoal(repId, dateStr) {
  const weekStart = mondayOfWeekEastern(dateStr)

  const [goalRes, countRes] = await Promise.all([
    db.query(
      `SELECT target FROM goals
       WHERE rep_id=$1 AND metric='new_doctors' AND period='weekly'
         AND period_start <= $2 AND period_end >= $2`,
      [repId, dateStr]
    ),
    db.query(
      `SELECT COUNT(*) AS val FROM clients
       WHERE assigned_to=$1
         AND created_at >= ($2::date AT TIME ZONE 'America/New_York')
         AND created_at <  (($3::date + 1) AT TIME ZONE 'America/New_York')`,
      [repId, weekStart, dateStr]
    ),
  ])

  const target = goalRes.rows[0] ? Number(goalRes.rows[0].target) : DEFAULT_WEEKLY_NEW_DOCTOR_TARGET
  return { target, current: Number(countRes.rows[0].val), hasCustomGoal: !!goalRes.rows[0] }
}

function buildDailyReportHtml(repName, dateStr, status, goal, { test = false } = {}) {
  const dateLabel = new Date(`${dateStr}T12:00:00`).toLocaleDateString('en-US', {
    weekday: 'long', month: 'long', day: 'numeric', year: 'numeric',
  })
  const html = salesRepDailyReportEmail({ repName, dateLabel, ...status, goal, test })
  return { html, dateLabel }
}

// Sends one rep's daily report. `to`/`cc` overrides exist for the
// admin-triggered test send (routes/reports.js) — omit both to send to the
// rep's own address, cc'd to Yoel, exactly as the weekday automated job
// does. `test: true` prepends a "TEST" subject marker and banner, same
// convention as every other report in this codebase.
async function sendRepDailyReport(rep, { to, cc = REPORT_CC, test = false, dateStr = todayEasternDateString() } = {}) {
  const status = await computeDailyDoctorStatus(rep.id, dateStr)
  const goal = await computeWeeklyNewDoctorGoal(rep.id, dateStr)
  const { html, dateLabel } = buildDailyReportHtml(rep.name || rep.email, dateStr, status, goal, { test })
  await sendEmail({
    to: to || rep.email,
    ...(cc?.length ? { cc } : {}),
    subject: `${test ? 'TEST — ' : ''}Daily Sales Report — ${rep.name || rep.email} — ${dateLabel}`,
    html,
  })
  return { status, goal }
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
  sendAllSalesRepDailyReports,
  mondayOfWeekEastern,
  DAILY_REPORT_REP_EMAILS,
  REPORT_CC,
  DEFAULT_WEEKLY_NEW_DOCTOR_TARGET,
}
