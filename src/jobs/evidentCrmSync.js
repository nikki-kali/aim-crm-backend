const cron = require('node-cron')
const { syncEvidentCasesForDate } = require('../services/evidentCaseSync')
const db = require('../config/db')
const { HISTORY_LOADED_THROUGH } = require('../services/evidentCaseSync')
const { claimJobRun, releaseJobRun, todayEt } = require('../services/cronRuns')
const { sendEmail } = require('../services/email')
const { APPROVER_EMAIL } = require('../services/reportApproval')

// The Evident -> CRM case sync (services/evidentCaseSync.js) for the days that
// have ended. Evident's "- AIM CRM" reports for business day D arrive on D
// between 8 and 11 PM New York time (every day of the week); this job runs
// the next weekday morning.
//
// It syncs every day since the history load that it has not applied yet,
// oldest first, so weekends, holidays and a missed morning all catch up on
// their own. A day is recorded as applied (cron_job_runs, job
// "evident-case-sync-day") only once it succeeds, and an applied day is never
// re-applied: an older Open Cases list would undo newer statuses. If a day
// fails, the later days wait for the next run.
const SYNC_DAY_JOB = 'evident-case-sync-day'
const LOOKBACK_DAYS = 30

const addDays = (date, n) => {
  const d = new Date(`${date}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + n)
  return d.toISOString().slice(0, 10)
}

// Days from the day after the history load (or LOOKBACK_DAYS ago, if later)
// to yesterday, minus the ones already applied. Oldest first.
function pendingDates(todayEt, applied) {
  let d = addDays(HISTORY_LOADED_THROUGH, 1)
  const floor = addDays(todayEt, -LOOKBACK_DAYS)
  if (d < floor) d = floor
  const out = []
  for (; d < todayEt; d = addDays(d, 1)) if (!applied.has(d)) out.push(d)
  return out
}

// Unlike claimJobRun this does not fail open: without the record of applied
// days, nothing is applied.
async function appliedDates(query = (sql, params) => db.query(sql, params)) {
  const { rows } = await query('SELECT run_date::text AS d FROM cron_job_runs WHERE job=$1', [SYNC_DAY_JOB])
  return new Set(rows.map((r) => r.d))
}

const esc = (v) => String(v == null ? '' : v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))

// The email to the approver: every day's summary for a dry run; for a real run,
// only the days where the CRM and Evident disagree.
function buildSyncEmail(summaries, { apply }) {
  const days = summaries.map((s) => {
    const found = Object.entries(s.reportsFound).map(([k, n]) => `${k}: ${n === null ? 'missing' : n}`).join(', ')
    const changes = Object.entries(s.statusChanges || {}).map(([k, n]) => `${esc(k)}: ${n}`).join('<br>') || 'none'
    const problems = (s.problems || s.notes || [])
    return `<h3 style="margin:18px 0 6px;font:600 15px Arial">${esc(s.date)}${s.error ? ' (failed)' : ''}</h3>` +
      (s.error ? `<p style="color:#b42318">${esc(s.error)}</p>` : `
      <p style="margin:0;font:13px/1.5 Arial">Reports (cases in each): ${esc(found)}<br>
      New cases: ${s.newCases}<br>Closed (left Open Cases, not in Cases Sent Today): ${s.closures.length}${s.closures.length ? ` (${esc(s.closures.slice(0, 30).join(', '))})` : ''}<br>
      Billing rows: ${s.invoiceRows}${s.invoiceTotal !== null ? `, total $${Number(s.invoiceTotal).toFixed(2)}` : ''}<br>
      Skipped: ${s.skipped.length}${s.skipped.length ? ` (${esc(s.skipped.map((x) => `${x.ref} ${x.why}`).slice(0, 10).join('; '))})` : ''}</p>
      <p style="margin:6px 0 0;font:13px/1.5 Arial"><b>Status changes</b><br>${changes}</p>
      ${problems.length ? `<p style="margin:6px 0 0;font:13px/1.5 Arial;color:#b42318"><b>Check</b><br>${problems.map(esc).join('<br>')}</p>` : ''}`)
  }).join('')
  const subject = apply
    ? `CRM case sync: the CRM and Evident disagree (${summaries.map((s) => s.date).join(', ')})`
    : `CRM case sync dry run: ${summaries.map((s) => s.date).join(', ')} (nothing written)`
  const intro = apply
    ? 'The daily Evident to CRM case sync ran. On the days below the CRM does not match Evident\'s reports.'
    : 'The daily Evident to CRM case sync worked out what it would change. Nothing was written to the CRM. It starts writing once EVIDENT_CASE_SYNC_APPLY is set to true on Render.'
  return { subject, html: `<div style="font:14px/1.5 Arial;color:#0f2b3a"><p>${intro}</p>${days}</div>` }
}

// The job body, shared by the built-in cron below and the external trigger
// (routes/cron.js, POST /api/cron/evident-crm-sync). Gated behind
// EVIDENT_CRM_SYNC_ENABLED; writes only when EVIDENT_CASE_SYNC_APPLY is 'true',
// otherwise a dry run of every pending day, emailed to the approver. `force`
// skips the once-per-day guard (never the per-day applied record).
async function runEvidentCrmSyncJob({ source = 'cron', force = false, deps = {} } = {}) {
  if (process.env.EVIDENT_CRM_SYNC_ENABLED !== 'true') {
    console.log('[evident-crm-sync] run skipped — EVIDENT_CRM_SYNC_ENABLED is not set to true')
    return 'disabled'
  }
  const sync = deps.sync || syncEvidentCasesForDate
  const send = deps.send || ((msg) => sendEmail({ to: [APPROVER_EMAIL], ...msg }))
  const claim = deps.claim || claimJobRun
  const release = deps.release || releaseJobRun
  const applied = deps.appliedDates || appliedDates
  const apply = process.env.EVIDENT_CASE_SYNC_APPLY === 'true'
  const day = deps.today || todayEt()
  if (!force && !(await claim('evident-crm-sync', day, source))) {
    console.log(`[evident-crm-sync] already ran for ${day}, skipping (${source})`)
    return 'already-ran'
  }
  let dates
  try {
    dates = pendingDates(day, await applied())
  } catch (err) {
    console.error('[evident-crm-sync] could not read which days are already synced; nothing applied:', err)
    await release('evident-crm-sync', day)
    return 'failed'
  }
  const summaries = []
  let failed = false
  for (const date of dates) {
    console.log(`[evident-crm-sync] ${apply ? 'syncing' : 'dry run for'} ${date} (${source})...`)
    try {
      const summary = await sync(date, { apply })
      console.log('[evident-crm-sync] done:', JSON.stringify(summary))
      summaries.push(summary)
      if (apply) await claim(SYNC_DAY_JOB, date, source)
    } catch (err) {
      failed = true
      console.error(`[evident-crm-sync] failed for ${date}:`, err)
      summaries.push({ date, error: err.message, reportsFound: {}, statusChanges: {}, closures: [], skipped: [], invoiceRows: 0, invoiceTotal: null, newCases: 0 })
      if (apply) break // later days build on this one
    }
  }
  const toReport = apply ? summaries.filter((s) => s.error || (s.problems && s.problems.length)) : summaries
  if (toReport.length) {
    try {
      await send(buildSyncEmail(toReport, { apply }))
    } catch (err) {
      console.error('[evident-crm-sync] summary email failed:', err)
    }
  }
  if (failed) {
    await release('evident-crm-sync', day)
    return 'failed'
  }
  return apply ? 'ran' : 'dry-run'
}

// Weekdays 7am America/New_York (cron-job.org's "AIM · 7:00 CRM sync" timer is
// the main trigger; Render's free instance sleeps, so this is the backup).
function startEvidentCrmSyncScheduler() {
  cron.schedule(
    '0 7 * * 1-5',
    () => runEvidentCrmSyncJob({ source: 'cron' }),
    { timezone: 'America/New_York' }
  )
  console.log('[evident-crm-sync] job registered')
}

module.exports = { startEvidentCrmSyncScheduler, pendingDates, buildSyncEmail, runEvidentCrmSyncJob, SYNC_DAY_JOB }
