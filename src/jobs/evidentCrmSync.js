const cron = require('node-cron')
const { syncCasesForDate } = require('../services/evidentCrmSync')
const { claimJobRun, releaseJobRun, todayEt } = require('../services/cronRuns')

// Evident's "Daily Booking Report - Nadine"/"Daily Billed Report - Nadine"
// emails for business day D are delivered around 8:00pm America/New_York
// on day D itself (verified against real Gmail data: the Sep 16 report's
// internalDate converts to 2026-09-16 8:00:42pm ET; the Sep 15 report to
// 2026-09-15 8:00:41pm ET). This job runs the FOLLOWING weekday morning
// (see the 7am cron schedule below), so it must ask syncCasesForDate for
// the previous day(s), not today's — today's own report hasn't been sent
// yet. Asking for today's date would never find a match and would
// silently produce an all-zero summary every single run, forever.
//
// Tuesday-Friday: just yesterday. Monday: Friday, Saturday and Sunday — a
// plain "yesterday" on Monday is Sunday, so Friday's report was never
// synced (confirmed 2026-09-25: no cases dated Friday 2026-09-18 in the
// CRM). Weekend dates are included in case Evident sends on them; a date
// with no emails is a harmless no-op, and re-syncing an already-synced day
// is idempotent (cases are matched on evident_case_number).
function datesToSync(todayEt) {
  const [y, m, d] = todayEt.split('-').map(Number)
  const today = new Date(Date.UTC(y, m - 1, d))
  const daysBack = today.getUTCDay() === 1 ? [3, 2, 1] : [1]
  return daysBack.map((n) => {
    const date = new Date(today)
    date.setUTCDate(date.getUTCDate() - n)
    return date.toISOString().slice(0, 10)
  })
}

// The job body, shared by the built-in cron below and the external trigger
// (routes/cron.js). Gated behind EVIDENT_CRM_SYNC_ENABLED. `force` skips the
// once-per-day guard (syncing is idempotent, so a re-run is safe).
async function runEvidentCrmSyncJob({ source = 'cron', force = false } = {}) {
  if (process.env.EVIDENT_CRM_SYNC_ENABLED !== 'true') {
    console.log('[evident-crm-sync] run skipped — EVIDENT_CRM_SYNC_ENABLED is not set to true')
    return 'disabled'
  }
  const day = todayEt()
  if (!force && !(await claimJobRun('evident-crm-sync', day, source))) {
    console.log(`[evident-crm-sync] already ran for ${day}, skipping (${source})`)
    return 'already-ran'
  }
  let failed = 0
  // One date failing (e.g. no email yet) must not stop the others.
  for (const dateStr of datesToSync(day)) {
    console.log(`[evident-crm-sync] running sync for ${dateStr} (${source})...`)
    try {
      const summary = await syncCasesForDate(dateStr)
      console.log('[evident-crm-sync] done:', summary)
    } catch (err) {
      failed += 1
      console.error(`[evident-crm-sync] run failed for ${dateStr}:`, err)
    }
  }
  if (failed > 0) {
    await releaseJobRun('evident-crm-sync', day)
    return 'failed'
  }
  return 'ran'
}

// Weekdays 7am America/New_York — before the 8am Leadership/Sales Rep
// report sends, so by the time those go out the CRM already reflects
// yesterday's real Evident activity (see yesterdayEasternDateString above
// for why "yesterday" and not "today"). Purely a convenience ordering: the
// reports read live Evident data directly, not through the CRM, so
// nothing breaks if this runs later or fails outright on a given day.
function startEvidentCrmSyncScheduler() {
  cron.schedule(
    '0 7 * * 1-5',
    () => runEvidentCrmSyncJob({ source: 'cron' }),
    { timezone: 'America/New_York' }
  )
  console.log('[evident-crm-sync] job registered')
}

module.exports = { startEvidentCrmSyncScheduler, datesToSync, runEvidentCrmSyncJob }
