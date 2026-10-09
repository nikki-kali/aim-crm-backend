const express = require('express')
const crypto = require('crypto')
const { runEvidentCrmSyncJob } = require('../jobs/evidentCrmSync')
const { runEvidentReportJob, runEvidentReportSendJob } = require('../jobs/evidentReport')
const { runSalesRepDailyReportJob } = require('../jobs/salesRepDailyReport')
const { runWhatsappPostJob } = require('../jobs/whatsappPost')
const { checkEvidentEmails, buildMissingEmailsAlert } = require('../services/evidentReport/emailCheck')
const { fetchEviSmartHeaders } = require('../services/evidentReport/gmailFetch')
const { sendEmail } = require('../services/email')
const { APPROVER_EMAIL } = require('../services/reportApproval')

const router = express.Router()

// Lets an outside timer (e.g. cron-job.org) start the daily jobs at their
// exact times. Render's free plan puts the server to sleep, and the built-in
// node-cron only fires if the process happens to be awake at that minute
// (confirmed 2026-09-25: the 7am CRM sync never ran). A request also wakes
// the server. Each job still honours its own *_ENABLED flag and its
// once-per-day record (services/cronRuns.js), so this and the built-in cron
// can both be on without sending anything twice.
const JOBS = {
  'evident-crm-sync': runEvidentCrmSyncJob,
  'evident-report': runEvidentReportJob,
  'evident-report-send': runEvidentReportSendJob,
  'sales-rep-daily-report': runSalesRepDailyReportJob,
  'whatsapp-post': runWhatsappPostJob,
}

function isAuthorized(provided, secret) {
  if (!secret || !provided) return false
  const a = Buffer.from(String(provided))
  const b = Buffer.from(String(secret))
  return a.length === b.length && crypto.timingSafeEqual(a, b)
}

// Overridable seam so tests never touch Gmail or send mail.
const emailCheckDeps = {
  check: () => checkEvidentEmails({ fetchEviSmart: fetchEviSmartHeaders }),
  sendAlert: async (result) => {
    const { subject, html } = buildMissingEmailsAlert(result)
    await sendEmail({ to: [APPROVER_EMAIL], subject, html })
  },
}

// 5:30 AM completeness check (called by n8n): are the Evident emails for the
// report day all here? Answers synchronously with JSON (unlike the job
// triggers below, which answer 202 and run in the background). With
// ?alert=true the server itself emails the approver when something is
// missing, so the caller needs no email credentials. Must be registered
// before '/:job', which would otherwise answer 404 "unknown job".
router.post('/evident-email-check', async (req, res) => {
  const secret = process.env.CRON_SECRET
  if (!secret) return res.status(503).json({ error: 'cron trigger is not configured' })
  if (!isAuthorized(req.get('x-cron-secret'), secret)) return res.status(401).json({ error: 'unauthorized' })
  try {
    const result = await emailCheckDeps.check()
    if (!result.ok && req.query.alert === 'true') {
      try {
        await emailCheckDeps.sendAlert(result)
        return res.json({ ...result, alerted: true })
      } catch (err) {
        console.error('[cron-trigger] evident-email-check alert email failed:', err)
        return res.json({ ...result, alerted: false, alertError: err.message })
      }
    }
    return res.json(result)
  } catch (err) {
    console.error('[cron-trigger] evident-email-check failed:', err)
    return res.status(502).json({ ok: false, error: `Could not read the Evident emails from Gmail: ${err.message}` })
  }
})

// POST only, secret in a header: a GET reachable from a link could be
// triggered by an email scanner (see the approval-link GET safety rule).
router.post('/:job', (req, res) => {
  const secret = process.env.CRON_SECRET
  if (!secret) return res.status(503).json({ error: 'cron trigger is not configured' })
  if (!isAuthorized(req.get('x-cron-secret'), secret)) return res.status(401).json({ error: 'unauthorized' })

  const run = JOBS[req.params.job]
  if (!run) return res.status(404).json({ error: 'unknown job' })

  // Answer right away (the job can take minutes; a timer's request would
  // time out), then run it in the background.
  res.status(202).json({ accepted: true, job: req.params.job })
  // `final=true` marks the last attempt of the day, for jobs that wait for a late email.
  run({ source: 'external', force: req.query.force === 'true', final: req.query.final === 'true' })
    .then((outcome) => console.log(`[cron-trigger] ${req.params.job}: ${outcome}`))
    .catch((err) => console.error(`[cron-trigger] ${req.params.job} failed:`, err))
})

module.exports = router
module.exports.isAuthorized = isAuthorized
module.exports.JOBS = JOBS
module.exports.emailCheckDeps = emailCheckDeps
