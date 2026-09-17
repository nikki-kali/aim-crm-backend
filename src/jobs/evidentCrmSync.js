const cron = require('node-cron')
const { syncCasesForDate } = require('../services/evidentCrmSync')

function todayEasternDateString() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' })
}

// Weekdays 7am America/New_York — before the 8am Leadership/Sales Rep
// report sends, so by the time those go out the CRM already reflects
// today's real Evident activity. Purely a convenience ordering: the
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
      console.log('[evident-crm-sync] running scheduled sync...')
      try {
        const summary = await syncCasesForDate(todayEasternDateString())
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
