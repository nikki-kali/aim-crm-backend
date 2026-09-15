// src/jobs/evidentReport.js
const cron = require('node-cron')
const { runEvidentReport } = require('../services/evidentReport')

// Deliberately its own file, not added to jobs/scheduler.js — that file
// has real in-progress unrelated work and must not be touched. Same
// pattern as jobs/mediaCleanup.js and jobs/socialTokenRefresh.js.
function startEvidentReportScheduler() {
  // Weekdays 6am America/New_York — matches the standalone project's
  // original schedule (after Evident's overnight reports land, before
  // the start of the business day).
  cron.schedule(
    '0 6 * * 1-5',
    async () => {
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
