// src/jobs/salesRepDailyReport.js
const cron = require('node-cron')
const { sendAllSalesRepDailyReports } = require('../services/salesRepDailyReport')
const { claimJobRun, releaseJobRun, todayEt } = require('../services/cronRuns')

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

function startSalesRepDailyReportScheduler() {
  // Weekdays 8:00am America/New_York — same slot the old Weekly Rep
  // Report used, now firing daily instead of just Monday.
  cron.schedule(
    '0 8 * * 1-5',
    () => runSalesRepDailyReportJob({ source: 'cron' }),
    { timezone: 'America/New_York' }
  )
  console.log('[sales-rep-daily-report] job registered')
}

module.exports = { startSalesRepDailyReportScheduler, runSalesRepDailyReportJob }
