// src/jobs/evidentReport.js
const cron = require('node-cron')
const { runEvidentReport } = require('../services/evidentReport')

// Deliberately its own file, not added to jobs/scheduler.js — that file
// has real in-progress unrelated work and must not be touched. Same
// pattern as jobs/mediaCleanup.js and jobs/socialTokenRefresh.js.
function startEvidentReportScheduler() {
  // Weekdays 8am America/New_York — moved from the original 6am slot
  // 2026-09-17 to line up with the Sales Rep Daily Report's own 8am send,
  // so leadership and the reps' inboxes get their daily reports together.
  cron.schedule(
    '0 8 * * 1-5',
    async () => {
      // Gated behind EVIDENT_REPORT_ENABLED, same pattern as
      // WEEKLY_REPORT_ENABLED/UNASSIGNED_LEADS_REPORT_ENABLED in
      // scheduler.js — lets the code ship and be reviewed via the admin
      // manual-send route (routes/reports.js, deliberately NOT gated)
      // before a real weekday 8am send to leadership goes live on its own.
      if (process.env.EVIDENT_REPORT_ENABLED !== 'true') {
        console.log('[evident-report] scheduled run skipped — EVIDENT_REPORT_ENABLED is not set to true')
        return
      }
      console.log('[evident-report] Running scheduled daily run')
      try {
        await runEvidentReport()
      } catch (err) {
        console.error('[evident-report] scheduled run failed:', err)
      }
    },
    { timezone: 'America/New_York' }
  )
  console.log('[evident-report] job registered')
}

module.exports = { startEvidentReportScheduler }
