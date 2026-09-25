const crypto = require('crypto')
const db = require('../config/db')

const BACKEND_URL = process.env.RENDER_EXTERNAL_URL || 'https://aim-crm-backend.onrender.com'
const HOLD_JOB = 'evident-report-hold'

// "Hold today's send" link in the daily preview. The link carries the Eastern
// date it applies to plus an HMAC signature made with CRON_SECRET, so it can't
// be forged or reused on another day, and needs no database token. Holding is
// idempotent (holding twice is the same as once), so nothing is single-use.
const secret = () => process.env.CRON_SECRET || ''
const sign = (day) => crypto.createHmac('sha256', secret()).update(`hold:${day}`).digest('hex')

function verifyHold(day, sig) {
  if (!secret() || !/^\d{4}-\d{2}-\d{2}$/.test(String(day)) || typeof sig !== 'string') return false
  const expected = Buffer.from(sign(day))
  const given = Buffer.from(sig)
  return expected.length === given.length && crypto.timingSafeEqual(expected, given)
}

// null when CRON_SECRET isn't configured (the preview then simply has no hold link).
function buildHoldUrl(day) {
  if (!secret()) return null
  return `${BACKEND_URL}/api/report-hold?day=${day}&sig=${sign(day)}`
}

// The hold is a row in cron_job_runs (job 'evident-report-hold'), the same
// once-per-day record table the daily jobs use.
async function holdDay(day, query = (sql, params) => db.query(sql, params)) {
  await query(
    `INSERT INTO cron_job_runs (job, run_date, source) VALUES ($1, $2, 'approver-hold') ON CONFLICT (job, run_date) DO NOTHING`,
    [HOLD_JOB, day]
  )
}

async function isHeld(day, query = (sql, params) => db.query(sql, params)) {
  const { rows } = await query(`SELECT 1 FROM cron_job_runs WHERE job=$1 AND run_date=$2`, [HOLD_JOB, day])
  return rows.length > 0
}

module.exports = { verifyHold, buildHoldUrl, holdDay, isHeld, HOLD_JOB }
