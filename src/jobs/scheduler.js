const cron = require('node-cron')
const { runAutomationLogic } = require('../services/automations')

function startScheduler() {
  // Daily at 8:00 AM — cold leads + case due reminders
  cron.schedule('0 8 * * *', async () => {
    console.log('[cron] Running cold_lead check')
    await runAutomationLogic('cold_lead').catch(console.error)
    console.log('[cron] Running case_due check')
    await runAutomationLogic('case_due').catch(console.error)
  })

  // Every Monday at 9:00 AM — lost recovery + win streak
  cron.schedule('0 9 * * 1', async () => {
    console.log('[cron] Running lost_recovery check')
    await runAutomationLogic('lost_recovery').catch(console.error)
    console.log('[cron] Running win_streak check')
    await runAutomationLogic('win_streak').catch(console.error)
  })

  console.log('[scheduler] Cron jobs registered')
}

module.exports = { startScheduler }
