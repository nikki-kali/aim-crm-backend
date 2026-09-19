const { fetchEvidentEmails } = require('./gmailFetch')
const { parseAndAggregate } = require('./parseEvident')
const { buildReport1Email, buildReport2Email, buildReport3Email } = require('./buildReport')
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

// Anchored to America/New_York (the cron's own timezone) rather than
// falling back to parseEvident.js's UTC-derived default — the admin manual
// -send route has no guarantee it's invoked during the same UTC calendar
// day as ET, and writing "tomorrow's" date would collide with the next
// morning's real cron run on evident_report_log.date's UNIQUE constraint.
// 'en-CA' reliably formats as YYYY-MM-DD (verified against this Node
// version before relying on it here).
function todayEasternDateString() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' })
}

// Runs the full pipeline once: fetch → parse → build → render → send →
// log. Used both by jobs/evidentReport.js's daily cron and the admin
// manual test-send route (routes/reports.js's POST /evident-report/send).
async function runEvidentReport() {
  const runDate = todayEasternDateString()

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

  const repGoals = await fetchRepGoalsWithProgress()
  const report1 = buildReport1Email(aggregate, historyRows, {})
  const report2 = buildReport2Email(aggregate)
  const report3 = buildReport3Email(aggregate, historyRows, repGoals)
  const { subject, sheetRow } = report1

  // Three separate emails, not one combined email (Ben Silberstein's
  // requirement, 2026-09-19 — supersedes the earlier "all in one report"
  // instruction). Sent back to back to the same recipients/bcc.
  console.log(`[evident-report] sending 3 reports to ${RECIPIENTS.join(', ')}...`)
  for (const report of [report1, report2, report3]) {
    await sendEmail({
      to: RECIPIENTS,
      bcc: ['media@aimdentallab.com'],
      subject: report.subject,
      html: report.html,
    })
  }

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
  const runDate = todayEasternDateString()
  const historyRows = await getHistory()
  const messages = await fetchEvidentEmails()
  const aggregate = parseAndAggregate(messages, { runDate })
  const repGoals = await fetchRepGoalsWithProgress()
  const reports = [
    buildReport1Email(aggregate, historyRows, {}),
    buildReport2Email(aggregate),
    buildReport3Email(aggregate, historyRows, repGoals),
  ]

  // One approval token/link shared by all 3 preview emails — clicking
  // "Approve & Send" on ANY of them triggers the same real action
  // (runEvidentReport() re-fetching live data and sending all 3 real
  // emails), so a single click is all that's needed even though the
  // approver receives 3 separate previews (one per report, matching
  // exactly what leadership will get — Ben Silberstein's requirement,
  // 2026-09-19).
  const token = await createApprovalToken({ reportType: 'evident-report', reportDate: runDate })
  const approveUrl = buildApproveUrl(token)

  for (const [i, report] of reports.entries()) {
    const bannered = injectApprovalBanner(report.html, { reportLabel: `${report.subject.split(' - ')[0]} (${i + 1} of 3)`, approveUrl })
    await sendEmail({
      to: [APPROVER_EMAIL],
      subject: `Approve? — ${report.subject}`,
      html: bannered,
    })
  }
  return { subjects: reports.map((r) => r.subject), approveUrl }
}

module.exports = { runEvidentReport, sendEvidentReportForApproval }
