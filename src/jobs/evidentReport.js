// src/jobs/evidentReport.js
const cron = require('node-cron')
const { sendEvidentReportForApproval } = require('../services/evidentReport')

// Deliberately its own file, not added to jobs/scheduler.js — that file
// has real in-progress unrelated work and must not be touched. Same
// pattern as jobs/mediaCleanup.js and jobs/socialTokenRefresh.js.
function startEvidentReportScheduler() {
  // Weekdays 6am America/New_York (user request, 2026-09-23; it was 8am
  // from 2026-09-17, 6am before that). The report covers the previous
  // business day, using EviSmart's end-of-day email sent the evening before.
  cron.schedule(
    '0 6 * * 1-5',
    async () => {
      // Gated behind EVIDENT_REPORT_ENABLED, same pattern as
      // WEEKLY_REPORT_ENABLED/UNASSIGNED_LEADS_REPORT_ENABLED in
      // scheduler.js — lets the code ship and be reviewed via the admin
      // manual-send route (routes/reports.js, deliberately NOT gated)
      // before this starts firing on its own every weekday morning.
      if (process.env.EVIDENT_REPORT_ENABLED !== 'true') {
        console.log('[evident-report] scheduled run skipped — EVIDENT_REPORT_ENABLED is not set to true')
        return
      }
      // Sends the daily preview (with its "Approve & Send" button) to
      // APPROVER_EMAIL only — never straight to leadership. Was
      // runEvidentReport() (direct real send) until 2026-09-18; that
      // bypassed the click-to-approve system entirely, since this cron
      // firing was the one remaining path that never went through a
      // preview. sendEvidentReportForApproval() has no same-day duplicate
      // guard (sending a fresh preview is harmless/repeatable) — the real
      // send, on approval, still goes through runEvidentReport()'s own
      // guard via routes/reports.js's POST /approve.
      console.log('[evident-report] Running scheduled daily preview run')
      try {
        await sendEvidentReportForApproval()
      } catch (err) {
        console.error('[evident-report] scheduled run failed:', err)
      }
    },
    { timezone: 'America/New_York' }
  )
  console.log('[evident-report] job registered')
}

module.exports = { startEvidentReportScheduler }
