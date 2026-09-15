// src/jobs/salesRepDailyReport.js
const cron = require('node-cron')
const { sendAllSalesRepDailyReports } = require('../services/salesRepDailyReport')

// Its own file, not added to jobs/scheduler.js — same reasoning as
// mediaCleanup.js/socialTokenRefresh.js/evidentReport.js. (Task 7
// separately removes scheduler.js's OLD Weekly Rep Report cron block —
// a scoped, deliberate exception to the "don't touch scheduler.js" rule,
// since it retires dead code, not because this new job belongs there.)
function startSalesRepDailyReportScheduler() {
  // Weekdays 8:00am America/New_York — same slot the old Weekly Rep
  // Report used, now firing daily instead of just Monday.
  cron.schedule(
    '0 8 * * 1-5',
    async () => {
      // Gated behind SALES_REP_DAILY_REPORT_ENABLED, same pattern as
      // WEEKLY_REPORT_ENABLED/UNASSIGNED_LEADS_REPORT_ENABLED/
      // EVIDENT_REPORT_ENABLED — lets the code ship and be reviewed via
      // the admin manual-send route before a real weekday 8am send to
      // James/William goes live on its own.
      if (process.env.SALES_REP_DAILY_REPORT_ENABLED !== 'true') {
        console.log('[sales-rep-daily-report] scheduled run skipped — SALES_REP_DAILY_REPORT_ENABLED is not set to true')
        return
      }
      console.log('[sales-rep-daily-report] Running scheduled daily run')
      try {
        await sendAllSalesRepDailyReports()
      } catch (err) {
        console.error('[sales-rep-daily-report] scheduled run failed:', err)
      }
    },
    { timezone: 'America/New_York' }
  )
  console.log('[sales-rep-daily-report] job registered')
}

module.exports = { startSalesRepDailyReportScheduler }
