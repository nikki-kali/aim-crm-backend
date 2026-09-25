const db = require('../config/db')

// Claims "job J has run for day D". Returns true if this caller is the
// first (and should run the job), false if it already ran. Fails OPEN: if
// the run-record table is unreachable, run the job anyway — a missed
// morning report is worse than a duplicate approval preview.
async function claimJobRun(job, dateStr, source, query = (sql, params) => db.query(sql, params)) {
  try {
    const { rows } = await query(
      `INSERT INTO cron_job_runs (job, run_date, source) VALUES ($1, $2, $3)
       ON CONFLICT (job, run_date) DO NOTHING RETURNING job`,
      [job, dateStr, source]
    )
    return rows.length > 0
  } catch (err) {
    console.error(`[cron-runs] could not record run for ${job} ${dateStr}, running anyway:`, err.message)
    return true
  }
}

// Frees the claim after a failed run so a later trigger the same day can retry.
async function releaseJobRun(job, dateStr, query = (sql, params) => db.query(sql, params)) {
  try {
    await query('DELETE FROM cron_job_runs WHERE job=$1 AND run_date=$2', [job, dateStr])
  } catch (err) {
    console.error(`[cron-runs] could not release ${job} ${dateStr}:`, err.message)
  }
}

const todayEt = () => new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' })

module.exports = { claimJobRun, releaseJobRun, todayEt }
