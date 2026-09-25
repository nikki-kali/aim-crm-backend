// src/jobs/evidentReport.js
const cron = require('node-cron')
const { sendEvidentReportForApproval, runEvidentReport } = require('../services/evidentReport')
const { sendEmail } = require('../services/email')
const { APPROVER_EMAIL } = require('../services/reportApproval')
const { isHeld } = require('../services/reportHold')
const { claimJobRun, releaseJobRun, todayEt } = require('../services/cronRuns')

// Deliberately its own file, not added to jobs/scheduler.js — that file
// has real in-progress unrelated work and must not be touched. Same
// pattern as jobs/mediaCleanup.js and jobs/socialTokenRefresh.js.
// The 7:00 AM send to leadership (pure: the sender and the alert are passed
// in so every branch is testable without email). Only runs when the switch
// EVIDENT_REPORT_AUTO_SEND is on. If EviSmart's report for the day is
// unusable, nothing goes to leadership and the approver is alerted instead;
// a day already sent (for example the approver clicked Approve & Send after
// the 6:00 AM preview) is left alone, and a day the approver held (the
// "Hold today's send" link in the preview) is skipped.
async function deliverToLeadership({ autoSend, sendToLeadership, alertApprover, isHeld = async () => false }) {
  if (!autoSend) return 'switch-off'
  if (await isHeld()) return 'held-by-approver'
  try {
    await sendToLeadership()
    return 'sent-to-leadership'
  } catch (err) {
    if (err.code === 'ALREADY_SENT') return 'already-sent'
    if (err.code === 'EVISMART_UNAVAILABLE') {
      console.warn('[evident-report] EviSmart report unavailable; NOT sending to leadership, alerting the approver')
      await alertApprover(err.message)
      return 'held'
    }
    throw err
  }
}

const enabled = () => process.env.EVIDENT_REPORT_ENABLED === 'true'

// 6:00 AM run, shared by the built-in cron and the external trigger
// (routes/cron.js): emails the approver the preview with its Approve & Send
// button. `force` skips the once-per-day guard for a deliberate re-run.
async function runEvidentReportJob({ source = 'cron', force = false } = {}) {
  if (!enabled()) {
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

// 7:00 AM run: the automatic send to leadership (see deliverToLeadership).
async function runEvidentReportSendJob({ source = 'cron', force = false } = {}) {
  if (!enabled()) {
    console.log('[evident-report-send] run skipped — EVIDENT_REPORT_ENABLED is not set to true')
    return 'disabled'
  }
  const autoSend = process.env.EVIDENT_REPORT_AUTO_SEND === 'true'
  if (!autoSend) {
    console.log('[evident-report-send] run skipped — EVIDENT_REPORT_AUTO_SEND is not set to true')
    return 'switch-off'
  }
  const day = todayEt()
  if (!force && !(await claimJobRun('evident-report-send', day, source))) {
    console.log(`[evident-report-send] already ran for ${day}, skipping (${source})`)
    return 'already-ran'
  }
  console.log(`[evident-report-send] Running automatic send to leadership (${source})`)
  try {
    const outcome = await deliverToLeadership({
      autoSend,
      isHeld: () => isHeld(day),
      sendToLeadership: () => runEvidentReport({ requireEviSmart: true }),
      alertApprover: (reason) => sendEmail({
        to: [APPROVER_EMAIL],
        subject: 'Daily Leadership Dashboard was NOT sent to leadership',
        html: `<p>The automatic 7:00 AM send was held back: ${reason}</p><p>Nothing went to leadership. Once the EviSmart Daily Sales Report is available, you can send it from the preview email (Approve &amp; Send), or ask me to re-run it.</p>`,
      }),
    })
    console.log(`[evident-report-send] ${outcome}`)
    if (outcome === 'held') await releaseJobRun('evident-report-send', day)
    return outcome
  } catch (err) {
    console.error('[evident-report-send] run failed:', err)
    await releaseJobRun('evident-report-send', day)
    return 'failed'
  }
}

function startEvidentReportScheduler() {
  // Weekdays America/New_York: 6:00 AM the approval preview to the approver,
  // 7:00 AM the automatic send to leadership (an hour to review or send it
  // sooner). The report covers the previous business day, using EviSmart's
  // end-of-day email sent the evening before.
  cron.schedule('0 6 * * 1-5', () => runEvidentReportJob({ source: 'cron' }), { timezone: 'America/New_York' })
  cron.schedule('0 7 * * 1-5', () => runEvidentReportSendJob({ source: 'cron' }), { timezone: 'America/New_York' })
  console.log('[evident-report] job registered')
}

module.exports = { startEvidentReportScheduler, runEvidentReportJob, runEvidentReportSendJob, deliverToLeadership }
