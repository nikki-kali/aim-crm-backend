// src/jobs/evidentReport.js
const cron = require('node-cron')
const { sendEvidentReportForApproval, runEvidentReport } = require('../services/evidentReport')
const { claimJobRun, releaseJobRun, todayEt } = require('../services/cronRuns')

// Deliberately its own file, not added to jobs/scheduler.js — that file
// has real in-progress unrelated work and must not be touched. Same
// pattern as jobs/mediaCleanup.js and jobs/socialTokenRefresh.js.
// What one run does, given the switch and the two ways to deliver. Kept pure
// (both senders are passed in) so every branch can be tested without email:
//  - switch off (default): only the approval preview goes to the approver.
//  - switch on (EVIDENT_REPORT_AUTO_SEND=true): the real report goes straight
//    to the leadership list, but only when EviSmart's report for the day is
//    usable; if it isn't, nothing goes to leadership and the approval preview
//    goes to the approver instead so a person can decide. A day that was
//    already sent is left alone (the evident_report_log guard).
async function deliverDailyReport({ autoSend, sendToLeadership, sendPreview }) {
  if (!autoSend) {
    await sendPreview()
    return 'preview-sent'
  }
  try {
    await sendToLeadership()
    return 'sent-to-leadership'
  } catch (err) {
    if (err.code === 'ALREADY_SENT') return 'already-sent'
    if (err.code === 'EVISMART_UNAVAILABLE') {
      console.warn('[evident-report] EviSmart report unavailable; NOT sending to leadership, sending the approval preview instead')
      await sendPreview()
      return 'preview-fallback'
    }
    throw err
  }
}

// The job body, shared by the built-in cron below and the external trigger
// (routes/cron.js). Gated behind EVIDENT_REPORT_ENABLED, and the send to
// leadership additionally behind EVIDENT_REPORT_AUTO_SEND (see
// deliverDailyReport). `force` skips the once-per-day guard (for a deliberate
// manual re-run).
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
  const autoSend = process.env.EVIDENT_REPORT_AUTO_SEND === 'true'
  console.log(`[evident-report] Running daily run (${source}, ${autoSend ? 'automatic send to leadership' : 'approval preview only'})`)
  try {
    return await deliverDailyReport({
      autoSend,
      sendToLeadership: () => runEvidentReport({ requireEviSmart: true }),
      sendPreview: () => sendEvidentReportForApproval(),
    })
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

module.exports = { startEvidentReportScheduler, runEvidentReportJob, deliverDailyReport }
