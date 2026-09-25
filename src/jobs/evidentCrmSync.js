const cron = require('node-cron')
const { syncCasesForDate } = require('../services/evidentCrmSync')

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

// Weekdays 7am America/New_York — before the 8am Leadership/Sales Rep
// report sends, so by the time those go out the CRM already reflects
// yesterday's real Evident activity (see yesterdayEasternDateString above
// for why "yesterday" and not "today"). Purely a convenience ordering: the
// reports read live Evident data directly, not through the CRM, so
// nothing breaks if this runs later or fails outright on a given day.
function startEvidentCrmSyncScheduler() {
  cron.schedule(
    '0 7 * * 1-5',
    async () => {
      // Gated behind EVIDENT_CRM_SYNC_ENABLED, same shipped-but-off
      // pattern as every other automated job in this codebase — lets the
      // code ship and be reviewed via a manual single-day run (see
      // scripts/backfill-evident-crm-sync.js, runnable for just today)
      // before it starts writing to the real CRM on its own every day.
      if (process.env.EVIDENT_CRM_SYNC_ENABLED !== 'true') {
        console.log('[evident-crm-sync] scheduled run skipped — EVIDENT_CRM_SYNC_ENABLED is not set to true')
        return
      }
      const todayEt = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' })
      // One date failing (e.g. no email yet) must not stop the others.
      for (const dateStr of datesToSync(todayEt)) {
        console.log(`[evident-crm-sync] running scheduled sync for ${dateStr}...`)
        try {
          const summary = await syncCasesForDate(dateStr)
          console.log('[evident-crm-sync] done:', summary)
        } catch (err) {
          console.error(`[evident-crm-sync] scheduled run failed for ${dateStr}:`, err)
        }
      }
    },
    { timezone: 'America/New_York' }
  )
  console.log('[evident-crm-sync] job registered')
}

module.exports = { startEvidentCrmSyncScheduler, datesToSync }
