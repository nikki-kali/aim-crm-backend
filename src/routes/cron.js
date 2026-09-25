const express = require('express')
const crypto = require('crypto')
const { runEvidentCrmSyncJob } = require('../jobs/evidentCrmSync')
const { runEvidentReportJob, runEvidentReportSendJob } = require('../jobs/evidentReport')
const { runSalesRepDailyReportJob } = require('../jobs/salesRepDailyReport')

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
}

function isAuthorized(provided, secret) {
  if (!secret || !provided) return false
  const a = Buffer.from(String(provided))
  const b = Buffer.from(String(secret))
  return a.length === b.length && crypto.timingSafeEqual(a, b)
}

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
  run({ source: 'external', force: req.query.force === 'true' })
    .then((outcome) => console.log(`[cron-trigger] ${req.params.job}: ${outcome}`))
    .catch((err) => console.error(`[cron-trigger] ${req.params.job} failed:`, err))
})

module.exports = router
module.exports.isAuthorized = isAuthorized
module.exports.JOBS = JOBS
