// src/jobs/shotLists.js
const cron = require('node-cron')
const { shotListForDate, sendShotList } = require('../services/shotLists')
const { claimJobRun, releaseJobRun, todayEt } = require('../services/cronRuns')

// Sends the week's lab shot list on its scheduled Monday (services/shotLists).
// Shared by the built-in cron and the external trigger (routes/cron.js).
async function runShotListJob({ source = 'cron', force = false } = {}) {
  const day = todayEt()
  const entry = shotListForDate(day)
  if (!entry) return 'nothing-today'
  if (!force && !(await claimJobRun('shot-list', day, source))) {
    console.log(`[shot-list] already sent for ${day}, skipping (${source})`)
    return 'already-ran'
  }
  try {
    await sendShotList(entry)
    console.log(`[shot-list] week ${entry.week} sent (${source})`)
    return 'ran'
  } catch (err) {
    console.error('[shot-list] send failed:', err)
    await releaseJobRun('shot-list', day)
    return 'failed'
  }
}

function startShotListScheduler() {
  // Mondays 9:00am America/New_York (the backend is woken just before by the
  // Mon/Wed/Fri wake routine).
  cron.schedule('0 9 * * 1', () => runShotListJob({ source: 'cron' }), { timezone: 'America/New_York' })
  console.log('[shot-list] job registered')
}

module.exports = { startShotListScheduler, runShotListJob }
