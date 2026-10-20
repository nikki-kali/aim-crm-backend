const crypto = require('crypto')
const db = require('../config/db')

const BACKEND_URL = process.env.RENDER_EXTERNAL_URL || 'https://aim-crm-backend.onrender.com'
const HOLD_JOB = 'evident-report-hold'
// Each automatic send has its own hold: holding the rep reports never holds
// the leadership dashboard, and the reverse.
const HOLD_JOBS = { leadership: HOLD_JOB, reps: 'rep-report-hold' }
const holdJob = (kind) => HOLD_JOBS[kind] || HOLD_JOB

// "Hold today's send" link in the daily preview. The link carries the Eastern
// date it applies to plus an HMAC signature made with CRON_SECRET, so it can't
// be forged or reused on another day, and needs no database token. Holding is
// idempotent (holding twice is the same as once), so nothing is single-use.
const secret = () => process.env.CRON_SECRET || ''
// The leadership signature keeps its original form so links already sent still work.
const sign = (day, kind = 'leadership') => crypto.createHmac('sha256', secret()).update(kind === 'leadership' ? `hold:${day}` : `hold:${kind}:${day}`).digest('hex')

function verifyHold(day, sig, kind = 'leadership') {
  if (!secret() || !HOLD_JOBS[kind] || !/^\d{4}-\d{2}-\d{2}$/.test(String(day)) || typeof sig !== 'string') return false
  const expected = Buffer.from(sign(day, kind))
  const given = Buffer.from(sig)
  return expected.length === given.length && crypto.timingSafeEqual(expected, given)
}

// null when CRON_SECRET isn't configured (the preview then simply has no hold link).
function buildHoldUrl(day, kind = 'leadership') {
  if (!secret()) return null
  return `${BACKEND_URL}/api/report-hold?day=${day}${kind === 'leadership' ? '' : `&kind=${kind}`}&sig=${sign(day, kind)}`
}

// The hold is a row in cron_job_runs (job 'evident-report-hold'), the same
// once-per-day record table the daily jobs use.
async function holdDay(day, query = (sql, params) => db.query(sql, params), kind = 'leadership') {
  await query(
    `INSERT INTO cron_job_runs (job, run_date, source) VALUES ($1, $2, 'approver-hold') ON CONFLICT (job, run_date) DO NOTHING`,
    [holdJob(kind), day]
  )
}

async function isHeld(day, query = (sql, params) => db.query(sql, params), kind = 'leadership') {
  const { rows } = await query(`SELECT 1 FROM cron_job_runs WHERE job=$1 AND run_date=$2`, [holdJob(kind), day])
  return rows.length > 0
}

module.exports = { verifyHold, buildHoldUrl, holdDay, isHeld, HOLD_JOB, HOLD_JOBS }
