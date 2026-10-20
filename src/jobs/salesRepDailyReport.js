// src/jobs/salesRepDailyReport.js
const cron = require('node-cron')
const db = require('../config/db')
const { sendAllSalesRepDailyReports, sendRepDailyReport, eviSmartReportAvailable, lastBusinessDayEasternDateString, DAILY_REPORT_REP_EMAILS } = require('../services/salesRepDailyReport')
const { claimJobRun, releaseJobRun, todayEt } = require('../services/cronRuns')
const { isHeld } = require('../services/reportHold')
const { sendEmail } = require('../services/email')
const { APPROVER_EMAIL, claimRepLinksForAutoSend, markRepLinksSent } = require('../services/reportApproval')

// Its own file, not added to jobs/scheduler.js — same reasoning as
// mediaCleanup.js/socialTokenRefresh.js/evidentReport.js. (Task 7
// separately removes scheduler.js's OLD Weekly Rep Report cron block —
// a scoped, deliberate exception to the "don't touch scheduler.js" rule,
// since it retires dead code, not because this new job belongs there.)
// The job body, shared by the built-in cron below and the external trigger
// (routes/cron.js). Sends each rep's preview (with its own "Approve & Send"
// button) to APPROVER_EMAIL — never straight to the rep. Gated behind
// SALES_REP_DAILY_REPORT_ENABLED. `force` skips the once-per-day guard.
async function runSalesRepDailyReportJob({ source = 'cron', force = false } = {}) {
  if (process.env.SALES_REP_DAILY_REPORT_ENABLED !== 'true') {
    console.log('[sales-rep-daily-report] run skipped — SALES_REP_DAILY_REPORT_ENABLED is not set to true')
    return 'disabled'
  }
  const day = todayEt()
  if (!force && !(await claimJobRun('sales-rep-daily-report', day, source))) {
    console.log(`[sales-rep-daily-report] already ran for ${day}, skipping (${source})`)
    return 'already-ran'
  }
  console.log(`[sales-rep-daily-report] Running daily preview run (${source})`)
  try {
    await sendAllSalesRepDailyReports()
    return 'ran'
  } catch (err) {
    console.error('[sales-rep-daily-report] run failed:', err)
    await releaseJobRun('sales-rep-daily-report', day)
    return 'failed'
  }
}

// The 9:00 AM ET automatic send to each rep (pure: every dependency passed
// in, so each outcome is tested). Nothing goes out when the day is held or
// its Evident figures aren't all in (the approver is told instead). Per rep:
// a rep the approver already approved (or is approving) is skipped, and the
// rep's approval links are taken over before sending, so a report can never
// go out twice. Returns { outcome, reps: { email: result } }.
async function deliverRepReports({ held, dataReady, reps, claimOnce, takeOverLinks, send, markSent, releaseOnce, alertApprover }) {
  if (await held()) return { outcome: 'held-by-approver', reps: {} }
  if (!(await dataReady())) {
    await alertApprover("The day's Evident figures were not all in, so neither rep report was sent automatically.")
    return { outcome: 'data-not-ready', reps: {} }
  }
  const results = {}
  const failed = []
  for (const rep of reps) {
    if (!(await claimOnce(rep))) { results[rep.email] = 'already-ran'; continue }
    let taken = false
    try {
      taken = await takeOverLinks(rep)
      if (!taken) { results[rep.email] = 'already-approved'; continue }
      await send(rep)
      await markSent(rep).catch((err) => console.error(`[sales-rep-daily-report-send] could not mark ${rep.email} as sent:`, err))
      results[rep.email] = 'sent'
    } catch (err) {
      console.error(`[sales-rep-daily-report-send] ${rep.email} failed:`, err)
      // Before the links were taken over nothing went out, so a later run may
      // retry this rep; after that, the send may have partly happened, so it
      // stays used (fail closed) and the approver is told.
      if (!taken) await releaseOnce(rep).catch(() => {})
      results[rep.email] = 'failed'
      failed.push(`${rep.name || rep.email}: ${err.message}`)
    }
  }
  if (failed.length) await alertApprover(`Not sent automatically: ${failed.join('; ')}. Check the rep's inbox before resending.`)
  return { outcome: failed.length ? 'partly-sent' : 'done', reps: results }
}

// 9:00 AM ET run: the automatic send to the reps (see deliverRepReports).
// Needs SALES_REP_DAILY_REPORT_ENABLED and the switch SALES_REP_REPORT_AUTO_SEND.
async function runSalesRepDailyReportSendJob({ source = 'cron' } = {}) {
  if (process.env.SALES_REP_DAILY_REPORT_ENABLED !== 'true') return 'disabled'
  if (process.env.SALES_REP_REPORT_AUTO_SEND !== 'true') {
    console.log('[sales-rep-daily-report-send] run skipped, SALES_REP_REPORT_AUTO_SEND is not set to true')
    return 'switch-off'
  }
  const day = todayEt()
  const dateStr = lastBusinessDayEasternDateString()
  const { rows: reps } = await db.query(`SELECT id, name, email FROM users WHERE email = ANY($1::text[]) ORDER BY name`, [DAILY_REPORT_REP_EMAILS])
  const job = (rep) => `sales-rep-daily-report-send:${rep.id}`
  try {
    const { outcome, reps: results } = await deliverRepReports({
      held: () => isHeld(day, undefined, 'reps'),
      dataReady: () => eviSmartReportAvailable(dateStr),
      reps,
      claimOnce: (rep) => claimJobRun(job(rep), day, source),
      takeOverLinks: (rep) => claimRepLinksForAutoSend(rep.id, dateStr),
      send: (rep) => sendRepDailyReport(rep, { dateStr }),
      markSent: (rep) => markRepLinksSent(rep.id, dateStr),
      releaseOnce: (rep) => releaseJobRun(job(rep), day),
      alertApprover: (reason) => sendEmail({
        to: [APPROVER_EMAIL],
        subject: 'Rep Daily Sales Reports were NOT all sent automatically',
        html: `<p>The automatic 9:00 AM ET rep report send for ${dateStr}: ${reason}</p><p>You can still send each one from its preview email (Approve &amp; Send).</p>`,
      }),
    })
    console.log(`[sales-rep-daily-report-send] ${outcome} ${JSON.stringify(results)}`)
    return outcome
  } catch (err) {
    console.error('[sales-rep-daily-report-send] run failed:', err)
    return 'failed'
  }
}

function startSalesRepDailyReportScheduler() {
  // Weekdays 8:00am America/New_York — same slot the old Weekly Rep
  // Report used, now firing daily instead of just Monday.
  cron.schedule(
    '0 8 * * 1-5',
    () => runSalesRepDailyReportJob({ source: 'cron' }),
    { timezone: 'America/New_York' }
  )
  // Weekdays 9:00 AM America/New_York: the automatic send, an hour after the
  // previews (only when SALES_REP_REPORT_AUTO_SEND is on).
  cron.schedule('0 9 * * 1-5', () => runSalesRepDailyReportSendJob({ source: 'cron' }), { timezone: 'America/New_York' })
  console.log('[sales-rep-daily-report] job registered')
}

module.exports = { startSalesRepDailyReportScheduler, runSalesRepDailyReportJob, runSalesRepDailyReportSendJob, deliverRepReports }
