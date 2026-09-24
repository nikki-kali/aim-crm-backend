const { fetchEvidentEmails, fetchEviSmartEmails } = require('./gmailFetch')
const { parseAndAggregate, pickEviSmartForDate } = require('./parseEvident')
const { buildCombinedLeadershipEmail } = require('./buildReport')
const { getHistory, appendRow } = require('./log')
const { sendEmail } = require('../email')
const { APPROVER_EMAIL, createApprovalToken, buildApproveUrl, injectApprovalBanner } = require('../reportApproval')
const db = require('../../config/db')
const { computeProgress } = require('../goalProgress')
const { DAILY_REPORT_REP_EMAILS } = require('../salesRepDailyReport')

const RECIPIENTS = ['ben@aimdentallab.com', 'execassistant@aimdentallab.com', 'yoel@khdentallab.com']

// Report #3's goal-progress section (Ben Silberstein's requirement,
// 2026-09-19) — each rep's goals whose period covers today, with real
// progress computed the same way the Goals UI does (shared computeProgress,
// see goalProgress.js). A plain data-fetch kept OUT of buildReport.js on
// purpose: that file stays a pure function of (agg, historyRows, ...) with
// no DB access, so its existing tests never need a database. Same reason
// overrides/repGoals are both passed in rather than queried inside it.
async function fetchRepGoalsWithProgress() {
  const { rows: reps } = await db.query(
    `SELECT id, name, email FROM users WHERE email = ANY($1::text[]) ORDER BY name`,
    [DAILY_REPORT_REP_EMAILS]
  )
  const result = []
  for (const rep of reps) {
    const { rows: goals } = await db.query(
      `SELECT * FROM goals WHERE rep_id=$1 AND period_start <= CURRENT_DATE AND period_end >= CURRENT_DATE ORDER BY created_at`,
      [rep.id]
    )
    const withProgress = await Promise.all(goals.map(computeProgress))
    result.push({ repName: rep.name || rep.email, goals: withProgress })
  }
  return result
}

// Fetches the real "EviSmart Daily Sales Report" and returns its parsed
// Totals (or null) — the sole source for Daily/MTD/YTD Booked+Billed in
// the Leadership Report (user instruction, 2026-09-23). A real day can
// have more than one send for the same date (an initial pull plus a
// same-day "updated pull" resend, confirmed for real 2026-09-23), and a
// real failure send carries no Totals table at all ("could not run (not
// logged in)", seen for real 2026-09-19/20) — so this tries every fetched
// message newest-first (by Gmail's own internalDate) and returns the
// first one that actually parses, rather than assuming the first message
// returned is the freshest or that a send with no Totals table means "no
// data exists today."
async function fetchEviSmartTotals(runDate) {
  const messages = await fetchEviSmartEmails()
  // Only an email dated for runDate and sent after that day ended counts
  // (see pickEviSmartForDate) — never just "the newest one," which could be
  // an early-day pull or a different day's report.
  return pickEviSmartForDate(messages, runDate)
}

// Returns the last COMPLETED business day before now, in America/New_York
// (the cron's own timezone) — NOT literally "today" (user correction,
// 2026-09-22: a report generated/sent Tuesday still reported "Tuesday,
// September 22" even though the data behind it is "last night's Evident
// emails," i.e. Monday's activity; the report must be dated to the
// business day its data actually reflects). Every weekday cron run of
// this report reflects the PRIOR business day's activity — Evident's own
// batch arrives overnight for the day that just ended — so a Tuesday 8am
// run needs Monday's date, and a Monday 8am run needs Friday's (skipping
// the weekend), matching the same "use the last business day" rule
// already applied 2026-09-19 for a non-business-day admin trigger. Pure
// calendar-day arithmetic on Date.UTC, same technique as chart.js's
// mondayOfWeek, so this doesn't depend on the server process's own local
// timezone. 'en-CA' reliably formats as YYYY-MM-DD (verified against this
// Node version before relying on it here).
function lastBusinessDayEasternDateString() {
  const todayStr = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' })
  const d = new Date(`${todayStr}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() - 1)
  while (d.getUTCDay() === 0 || d.getUTCDay() === 6) {
    d.setUTCDate(d.getUTCDate() - 1)
  }
  return d.toISOString().slice(0, 10)
}

// Runs the full pipeline once: fetch → parse → build → render → send →
// log. Used both by jobs/evidentReport.js's daily cron and the admin
// manual test-send route (routes/reports.js's POST /evident-report/send).
async function runEvidentReport() {
  const runDate = lastBusinessDayEasternDateString()

  // Pre-flight duplicate check, before fetching Gmail or sending anything.
  // evident_report_log.date is UNIQUE, so a same-day re-run was already
  // guaranteed to fail on the later appendRow() — but that happened AFTER
  // sendEmail(), so a re-run sent a real duplicate to leadership first and
  // only failed loudly on the write. Checking history up front means the
  // duplicate send itself is prevented, not just the duplicate DB row.
  console.log('[evident-report] reading history log...')
  const historyRows = await getHistory()
  if (historyRows.some((r) => r.date === runDate)) {
    throw new Error(`[evident-report] a report for ${runDate} was already sent today — refusing to send a duplicate`)
  }

  console.log('[evident-report] fetching last night\'s Evident emails...')
  const messages = await fetchEvidentEmails()
  console.log(`[evident-report] found ${messages.length} Evident email(s)`)

  const aggregate = parseAndAggregate(messages, { runDate })
  if (aggregate.missing.length > 0) {
    console.warn(`[evident-report] missing reports: ${aggregate.missing.join(', ')}`)
  }

  console.log('[evident-report] fetching EviSmart Daily Sales Report...')
  aggregate.eviSmart = await fetchEviSmartTotals(runDate)
  if (!aggregate.eviSmart) {
    console.warn('[evident-report] EviSmart Daily Sales Report unavailable — Daily/MTD/YTD Booked/Billed will show as "—"')
  }

  const repGoals = await fetchRepGoalsWithProgress()
  const { subject, html, sheetRow } = buildCombinedLeadershipEmail(aggregate, historyRows, repGoals, {})

  // One combined email (leadership request, 2026-09-23 — supersedes Ben
  // Silberstein's 2026-09-19 "must be 3 distinct emails" instruction;
  // buildCombinedLeadershipEmail merges the same 3 reports' own content
  // under one subject/header, so nothing about each report's own data or
  // metrics changed, only how many emails they arrive in).
  console.log(`[evident-report] sending combined report to ${RECIPIENTS.join(', ')}...`)
  await sendEmail({
    to: RECIPIENTS,
    bcc: ['media@aimdentallab.com'],
    subject,
    html,
  })

  // The log-write gate excludes the two YTD Booked Cases reports and the
  // new MTD Booked Daily Update report — none of their arrival cadence is
  // confirmed yet (MTD Booked Daily Update only started arriving
  // 2026-09-16), and gating the entire day's log write on an unproven
  // report would silently stop day-over-day deltas/the trend chart from
  // ever working again if it turns out not to arrive every weekday. The
  // email's own missing-reports banner still reflects ALL missing reports
  // for transparency — only the persistence gate is loosened.
  const criticalMissing = aggregate.missing.filter((label) => !label.startsWith('YTD Booked Cases') && label !== 'MTD Booked Daily Update')

  // Only log today's row when all critical expected Evident reports
  // actually came in — a zeroed sheetRow from a Gmail outage /
  // sender-address change would otherwise get persisted and poison
  // TOMORROW's delta computation with a fabricated zero baseline (a
  // confident, unflagged "▲ $X vs. yesterday" comparing against garbage),
  // and burn today's UNIQUE `date` slot so a corrected re-run isn't
  // possible without manual DB surgery.
  if (criticalMissing.length === 0) {
    console.log('[evident-report] logging today\'s totals...')
    await appendRow(sheetRow)
  } else {
    console.warn(
      `[evident-report] NOT logging today's (${runDate}) totals — ${criticalMissing.length} of 8 critical (non-YTD) expected reports were missing (${criticalMissing.join(', ')}). ` +
      'Tomorrow\'s delta will compare against an older day instead of a fabricated zero baseline.'
    )
  }

  console.log('[evident-report] done.')
  return { aggregate, subject }
}

// Builds today's report (live data, no PDF, no log write, no send to
// real leadership) and emails it to APPROVER_EMAIL with an "Approve &
// Send" button. Clicking that button hits routes/reports.js's public
// GET /approve, which calls runEvidentReport() above for the actual real
// send — so approving always re-fetches fresh live data at send time
// rather than replaying this preview's snapshot, same "always current,
// never a stale replay" principle as every other real send in this
// pipeline. Does NOT check evident_report_log for a same-day duplicate
// the way runEvidentReport does — sending a fresh preview is harmless and
// repeatable; only the real send (on approval) is duplicate-guarded.
async function sendEvidentReportForApproval() {
  const runDate = lastBusinessDayEasternDateString()
  const historyRows = await getHistory()
  const messages = await fetchEvidentEmails()
  const aggregate = parseAndAggregate(messages, { runDate })
  aggregate.eviSmart = await fetchEviSmartTotals(runDate)
  const repGoals = await fetchRepGoalsWithProgress()
  const { subject, html } = buildCombinedLeadershipEmail(aggregate, historyRows, repGoals, {})

  const token = await createApprovalToken({ reportType: 'evident-report', reportDate: runDate })
  const approveUrl = buildApproveUrl(token)
  const bannered = injectApprovalBanner(html, { reportLabel: 'Daily Leadership Dashboard', approveUrl })

  await sendEmail({
    to: [APPROVER_EMAIL],
    subject: `Approve? — ${subject}`,
    html: bannered,
  })
  return { subject, approveUrl }
}

module.exports = { runEvidentReport, sendEvidentReportForApproval }
