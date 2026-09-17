const cron = require('node-cron')
const { syncCasesForDate } = require('../services/evidentCrmSync')

// Evident's "Daily Booking Report - Nadine"/"Daily Billed Report - Nadine"
// emails for business day D are delivered around 8:00pm America/New_York
// on day D itself (verified against real Gmail data: the Sep 16 report's
// internalDate converts to 2026-09-16 8:00:42pm ET; the Sep 15 report to
// 2026-09-15 8:00:41pm ET). This job runs the FOLLOWING weekday morning
// (see the 7am cron schedule below), so it must ask syncCasesForDate for
// YESTERDAY's date, not today's — today's own report hasn't been sent
// yet. Asking for today's date would never find a match and would
// silently produce an all-zero summary every single run, forever.
function yesterdayEasternDateString() {
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' })
  const [y, m, d] = today.split('-').map(Number)
  const date = new Date(Date.UTC(y, m - 1, d))
  date.setUTCDate(date.getUTCDate() - 1)
  return date.toISOString().slice(0, 10)
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
      const dateStr = yesterdayEasternDateString()
      console.log(`[evident-crm-sync] running scheduled sync for ${dateStr}...`)
      try {
        const summary = await syncCasesForDate(dateStr)
        console.log('[evident-crm-sync] done:', summary)
      } catch (err) {
        console.error('[evident-crm-sync] scheduled run failed:', err)
      }
    },
    { timezone: 'America/New_York' }
  )
  console.log('[evident-crm-sync] job registered')
}

module.exports = { startEvidentCrmSyncScheduler }
