// scripts/backfill-evident-crm-sync.js
// One-time historical catch-up. Run manually:
//   node scripts/backfill-evident-crm-sync.js --from=2026-01-01 [--to=2026-09-16]
// `--to` defaults to yesterday (today's own sync is the cron job's job,
// not the backfill's). Walks chronologically FORWARD (oldest first) — see
// the design spec's "why chronological order matters" for why this
// matters for billed-after-booked accuracy. Safe to re-run or resume:
// syncCasesForDate is idempotent per day (case upserts keyed by
// evident_case_number; client creation guarded by a name-match lookup).
require('dotenv').config()
const { syncCasesForDate } = require('../src/services/evidentCrmSync')
const { sleep, THROTTLE_MS } = require('../src/services/evidentReport/gmailFetch')

function parseArgs() {
  const args = {}
  for (const arg of process.argv.slice(2)) {
    const [key, value] = arg.replace(/^--/, '').split('=')
    args[key] = value
  }
  return args
}

function addDays(dateStr, n) {
  const [y, m, d] = dateStr.split('-').map(Number)
  const date = new Date(Date.UTC(y, m - 1, d))
  date.setUTCDate(date.getUTCDate() + n)
  return date.toISOString().slice(0, 10)
}

function yesterdayEasternDateString() {
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' })
  return addDays(today, -1)
}

async function main() {
  const { from, to } = parseArgs()
  if (!from) {
    console.error('Usage: node scripts/backfill-evident-crm-sync.js --from=YYYY-MM-DD [--to=YYYY-MM-DD]')
    process.exit(1)
  }
  const endDate = to || yesterdayEasternDateString()

  console.log(`Backfilling Evident CRM sync from ${from} through ${endDate}...`)
  const totals = { casesCreated: 0, casesUpdated: 0, clientsCreated: 0, errors: 0 }
  const failedDates = []

  let cur = from
  while (cur <= endDate) {
    try {
      const summary = await syncCasesForDate(cur)
      totals.casesCreated += summary.casesCreated
      totals.casesUpdated += summary.casesUpdated
      totals.clientsCreated += summary.clientsCreated
      totals.errors += summary.errors.length
      console.log(`${cur}: +${summary.casesCreated} cases created, ${summary.casesUpdated} updated, +${summary.clientsCreated} clients created, ${summary.errors.length} row errors`)
      if (summary.errors.length > 0) {
        console.log(`  row errors: ${JSON.stringify(summary.errors)}`)
      }
    } catch (err) {
      console.error(`${cur}: FAILED — ${err.message}`)
      failedDates.push(cur)
    }
    cur = addDays(cur, 1)
    await sleep(THROTTLE_MS)
  }

  console.log('\n--- Backfill complete ---')
  console.log(`Total: ${totals.casesCreated} cases created, ${totals.casesUpdated} updated, ${totals.clientsCreated} clients created, ${totals.errors} row errors`)
  if (failedDates.length > 0) {
    console.log(`Dates that failed entirely (retry these individually with --from=X --to=X): ${failedDates.join(', ')}`)
  }
  process.exit(0)
}

main().catch((err) => {
  console.error('Backfill failed:', err)
  process.exit(1)
})
