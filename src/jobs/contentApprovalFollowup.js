// src/jobs/contentApprovalFollowup.js
const cron = require('node-cron')
const { sendContentApprovalFollowupPreview } = require('../services/contentApproval/requestEmail')
const { claimJobRun, releaseJobRun, todayEt } = require('../services/cronRuns')

// Nudges leadership about content posts with no decision yet. Like the other
// report jobs, it only ever sends a PREVIEW (threaded under the original
// request, with an Approve & Send button) to media@; leadership gets it only
// after that click. Skips quietly when every upcoming post has a decision.
// Shared by the built-in cron below and the external trigger (routes/cron.js).
async function runContentApprovalFollowupJob({ source = 'cron', force = false } = {}) {
  const day = todayEt()
  if (!force && !(await claimJobRun('content-approval-followup', day, source))) {
    console.log(`[content-approval-followup] already ran for ${day}, skipping (${source})`)
    return 'already-ran'
  }
  try {
    const result = await sendContentApprovalFollowupPreview()
    console.log(`[content-approval-followup] ${result.sent ? `preview sent (${result.due.join(', ')})` : 'nothing pending, no email'} (${source})`)
    return result.sent ? 'ran' : 'nothing-pending'
  } catch (err) {
    console.error('[content-approval-followup] run failed:', err)
    await releaseJobRun('content-approval-followup', day)
    return 'failed'
  }
}

function startContentApprovalFollowupScheduler() {
  // Mon, Wed, Fri 9:00am America/New_York.
  cron.schedule('0 9 * * 1,3,5', () => runContentApprovalFollowupJob({ source: 'cron' }), { timezone: 'America/New_York' })
  console.log('[content-approval-followup] job registered')
}

module.exports = { startContentApprovalFollowupScheduler, runContentApprovalFollowupJob }
