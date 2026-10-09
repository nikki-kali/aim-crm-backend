const { fetchEvidentEmails, fetchEviSmartEmails } = require('./gmailFetch')
const { parseAndAggregate, pickEviSmartMessageForDate, extractEviSmartExtras, applyEmailMtdTotals, repKeyFromSalesperson } = require('./parseEvident')
const { applyEviSmartMtdPrimary, applyEviSmartNewDoctors } = require('./eviSmartPrimary')
const { buildCombinedLeadershipEmail } = require('./buildReport')
const { getHistory, appendRow } = require('./log')
const { sendEmail } = require('../email')
const { APPROVER_EMAIL, createApprovalToken, buildApproveUrl, injectApprovalBanner } = require('../reportApproval')
const { buildHoldUrl } = require('../reportHold')
const { todayEt } = require('../cronRuns')
const db = require('../../config/db')
const { computeProgress } = require('../goalProgress')
const { DAILY_REPORT_REP_EMAILS, evidentMtdCompanyTotal, lastDayOfPriorMonth } = require('../salesRepDailyReport')
const { applyBookedMtdGuard } = require('./bookedMtdGuard')

const RECIPIENTS = ['ben@aimdentallab.com', 'execassistant@aimdentallab.com', 'yoel@khdentallab.com']

// Report #3's goal-progress section (Ben Silberstein's requirement,
// 2026-09-19) — each rep's goals whose period covers today, with real
// progress computed the same way the Goals UI does (shared computeProgress,
// see goalProgress.js). A plain data-fetch kept OUT of buildReport.js on
// purpose: that file stays a pure function of (agg, historyRows, ...) with
// no DB access, so its existing tests never need a database. Same reason
// overrides/repGoals are both passed in rather than queried inside it.
async function fetchRepGoalsWithProgress(runDate) {
  const { rows: reps } = await db.query(
    `SELECT id, name, email FROM users WHERE email = ANY($1::text[]) ORDER BY name`,
    [DAILY_REPORT_REP_EMAILS]
  )
  const result = []
  for (const rep of reps) {
    const { rows: goals } = await db.query(
      `SELECT * FROM goals WHERE rep_id=$1 AND period_start <= $2::date AND period_end >= $2::date ORDER BY created_at`,
      [rep.id, runDate]
    )
    const withProgress = await Promise.all(goals.map(computeProgress))
    result.push({ repName: rep.name || rep.email, goals: withProgress })
  }
  return result
}

// Each rep's Revenue goal = BILLED for the month (Elizabeth, 2026-10-02:
// "sales = billed"), taken from the same day's "Daily MTD Total Billed" the
// report's MTD Billed card shows — so the bar and the card can never
// disagree. Without that email the Revenue bar is left out rather than
// filled from the CRM, whose case dates count a September case billed in
// October as an October sale.
// Last month for the month-over-month section: booked from the prior
// month's final "MTD Booked Daily Update" (#12), billed from its final
// "Daily MTD Total Billed" (#40) — per Elizabeth, not EviSmart's #92 row.
async function evidentLastMonth(runDate, extras = null) {
  const prior = lastDayOfPriorMonth(runDate)
  // EviSmart's own last-month figures come first (user decision, 2026-10-09),
  // but only when its row is for the month actually before the report month.
  const priorName = new Date(`${prior}T12:00:00Z`).toLocaleDateString('en-US', { month: 'long', timeZone: 'UTC' })
  const lm = extras && extras.lastMonth
  if (lm && lm.monthName && priorName.toLowerCase().startsWith(lm.monthName.toLowerCase().slice(0, 3)) && lm.booked != null && lm.billed != null) {
    return { monthName: priorName, booked: lm.booked, billed: lm.billed }
  }
  const [booked, billed] = await Promise.all([evidentMtdCompanyTotal(prior, 'booked'), evidentMtdCompanyTotal(prior, 'billed')])
  if (booked == null || billed == null) return null
  return { monthName: new Date(`${prior}T12:00:00Z`).toLocaleDateString('en-US', { month: 'long', timeZone: 'UTC' }), booked, billed }
}

function applyEvidentMtdToGoals(repGoals, mtdByRep) {
  return repGoals.map((rep) => {
    const key = repKeyFromSalesperson(rep.repName)
    const goals = rep.goals.flatMap((g) => {
      if (g.metric !== 'monthly_revenue') return [g]
      if (!mtdByRep || !key) return []
      const current = mtdByRep[key]
      const target = Number(g.target)
      const pct = target > 0 ? Math.min(Math.round((current / target) * 100), 100) : 0
      return [{ ...g, current_value: current, progress_pct: pct }]
    })
    return { ...rep, goals }
  })
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
// The day's EviSmart report: its totals plus the extra tables (last month, new
// doctors). Only an email dated for runDate and sent after that day ended
// counts (see pickEviSmartMessageForDate), never just "the newest one," which
// could be an early-day pull or a different day's report.
async function fetchEviSmartDay(runDate) {
  const hit = pickEviSmartMessageForDate(await fetchEviSmartEmails(), runDate)
  return { totals: hit ? hit.totals : null, extras: hit ? extractEviSmartExtras(hit.message.html) : null }
}

// EviSmart is primary for month-to-date booked and billed; Evident fills in
// only when EviSmart has no report (see eviSmartPrimary.js).
function applyEviSmartPrimaryTo(aggregate, eviSmartRaw) {
  const out = applyEviSmartMtdPrimary(aggregate, eviSmartRaw)
  Object.assign(aggregate, out)
  if (!('bookedMtdRejected' in out)) delete aggregate.bookedMtdRejected
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
// `requireEviSmart`: refuse to send when EviSmart's report for the day didn't
// come through (throws code EVISMART_UNAVAILABLE BEFORE anything is sent), so
// an automatic send to leadership never goes out with "pull didn't come
// through" notices and missing totals. Used by the automatic daily send.
async function runEvidentReport({ requireEviSmart = false } = {}) {
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
    throw Object.assign(new Error(`[evident-report] a report for ${runDate} was already sent today — refusing to send a duplicate`), { code: 'ALREADY_SENT' })
  }

  console.log('[evident-report] fetching Evident emails...')
  const allMessages = await fetchEvidentEmails()
  // Only the messages actually dated for runDate — fetchEvidentEmails now
  // returns up to 5 days' worth so a Monday run still reaches Friday, so
  // this filter is what keeps the report from mixing in another day's
  // numbers (see fetchEvidentEmails and evidentCrmSync.js's identical
  // m.date === dateStr pattern).
  const messages = allMessages.filter((m) => m.date === runDate)
  console.log(`[evident-report] found ${messages.length} Evident email(s) for ${runDate} (${allMessages.length} fetched in the last 5 days)`)

  const aggregate = parseAndAggregate(messages, { runDate })
  const bookedRejection = await applyBookedMtdGuard(aggregate, runDate, (d) => evidentMtdCompanyTotal(d, 'booked'))
  if (bookedRejection) console.warn(`[evident-report] Evident's MTD Booked figure rejected: ${bookedRejection.reason}`)
  if (aggregate.missing.length > 0) {
    console.warn(`[evident-report] missing reports: ${aggregate.missing.join(', ')}`)
  }

  console.log('[evident-report] fetching EviSmart Daily Sales Report...')
  const eviDay = await fetchEviSmartDay(runDate)
  const eviSmartRaw = eviDay.totals
  applyEviSmartPrimaryTo(aggregate, eviSmartRaw)
  aggregate.eviSmart = applyEmailMtdTotals(eviSmartRaw, aggregate)
  aggregate.eviSmart.lastMonth = await evidentLastMonth(runDate, eviDay.extras)
  if (!eviSmartRaw) {
    console.warn('[evident-report] EviSmart Daily Sales Report unavailable — Daily Billed will show as N/A; every other figure comes from the Evident emails')
  }

  // The automatic send to leadership still requires EviSmart (Daily Billed)
  // until Elizabeth approves Evident's Daily Billed Report as the source.
  if (requireEviSmart && !eviSmartRaw) {
    throw Object.assign(new Error(`[evident-report] no usable EviSmart Daily Sales Report for ${runDate}, not sending to leadership`), { code: 'EVISMART_UNAVAILABLE' })
  }
  // An automatic send never goes out with a month-to-date booked figure that
  // failed the plausibility check: the approver is alerted instead, and can
  // still send it by hand (the preview shows N/A for that figure).
  if (requireEviSmart && aggregate.bookedMtdRejected) {
    throw Object.assign(new Error(`Evident's month-to-date booked figure for ${runDate} did not add up (${aggregate.bookedMtdRejected.reason}). Nothing was sent to leadership.`), { code: 'BOOKED_MTD_SUSPECT' })
  }

  const repGoals = applyEviSmartNewDoctors(applyEvidentMtdToGoals(await fetchRepGoalsWithProgress(runDate), aggregate.companyMtdBilledByRep), eviDay.extras)
  const { subject, html, sheetRow } = buildCombinedLeadershipEmail(aggregate, historyRows, repGoals, {})

  // One combined email (leadership request, 2026-09-23 — supersedes Ben
  // Silberstein's 2026-09-19 "must be 3 distinct emails" instruction;
  // buildCombinedLeadershipEmail merges the same 3 reports' own content
  // under one subject/header, so nothing about each report's own data or
  // metrics changed, only how many emails they arrive in).
  console.log(`[evident-report] sending combined report to ${RECIPIENTS.join(', ')}...`)
  await sendEmail({
    to: RECIPIENTS,
    bcc: ['media@aimdentallab.com', APPROVER_EMAIL],
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
  const messages = (await fetchEvidentEmails()).filter((m) => m.date === runDate)
  const aggregate = parseAndAggregate(messages, { runDate })
  await applyBookedMtdGuard(aggregate, runDate, (d) => evidentMtdCompanyTotal(d, 'booked'))
  const eviDay = await fetchEviSmartDay(runDate)
  const eviSmartRaw = eviDay.totals
  applyEviSmartPrimaryTo(aggregate, eviSmartRaw)
  aggregate.eviSmart = applyEmailMtdTotals(eviSmartRaw, aggregate)
  aggregate.eviSmart.lastMonth = await evidentLastMonth(runDate, eviDay.extras)
  const repGoals = applyEviSmartNewDoctors(applyEvidentMtdToGoals(await fetchRepGoalsWithProgress(runDate), aggregate.companyMtdBilledByRep), eviDay.extras)
  const { subject, html } = buildCombinedLeadershipEmail(aggregate, historyRows, repGoals, {})

  const token = await createApprovalToken({ reportType: 'evident-report', reportDate: runDate })
  const approveUrl = buildApproveUrl(token)
  // When the automatic send is on, the preview says when leadership gets it.
  const autoSendAt = process.env.EVIDENT_REPORT_AUTO_SEND === 'true' ? '7:00 AM ET' : undefined
  const holdUrl = autoSendAt ? buildHoldUrl(todayEt()) : undefined
  const bannered = injectApprovalBanner(html, { reportLabel: 'Daily Leadership Dashboard', approveUrl, autoSendAt, holdUrl })

  await sendEmail({
    to: [APPROVER_EMAIL],
    subject: `Approve? — ${subject}`,
    html: bannered,
  })
  return { subject, approveUrl }
}

module.exports = { runEvidentReport, sendEvidentReportForApproval, applyEvidentMtdToGoals }
