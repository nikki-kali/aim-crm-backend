// src/jobs/evidentReport.js
const cron = require('node-cron')
const { sendEvidentReportForApproval } = require('../services/evidentReport')
const { claimJobRun, releaseJobRun, todayEt } = require('../services/cronRuns')

// Deliberately its own file, not added to jobs/scheduler.js — that file
// has real in-progress unrelated work and must not be touched. Same
// pattern as jobs/mediaCleanup.js and jobs/socialTokenRefresh.js.
// The job body, shared by the built-in cron below and the external trigger
// (routes/cron.js). Sends the daily preview (with its "Approve & Send"
// button) to APPROVER_EMAIL only — never straight to leadership.
// Gated behind EVIDENT_REPORT_ENABLED, same pattern as the other jobs.
// `force` skips the once-per-day guard (for a deliberate manual re-run).
async function runEvidentReportJob({ source = 'cron', force = false } = {}) {
  if (process.env.EVIDENT_REPORT_ENABLED !== 'true') {
    console.log('[evident-report] run skipped — EVIDENT_REPORT_ENABLED is not set to true')
    return 'disabled'
  }
  const day = todayEt()
  if (!force && !(await claimJobRun('evident-report', day, source))) {
    console.log(`[evident-report] already ran for ${day}, skipping (${source})`)
    return 'already-ran'
  }
  console.log(`[evident-report] Running daily preview run (${source})`)
  try {
    await sendEvidentReportForApproval()
    return 'ran'
  } catch (err) {
    console.error('[evident-report] run failed:', err)
    await releaseJobRun('evident-report', day)
    return 'failed'
  }
}

function startEvidentReportScheduler() {
  // Weekdays 6am America/New_York (user request, 2026-09-23; it was 8am
  // from 2026-09-17, 6am before that). The report covers the previous
  // business day, using EviSmart's end-of-day email sent the evening before.
  cron.schedule(
    '0 6 * * 1-5',
    () => runEvidentReportJob({ source: 'cron' }),
    { timezone: 'America/New_York' }
  )
  console.log('[evident-report] job registered')
}

module.exports = { startEvidentReportScheduler, runEvidentReportJob }
