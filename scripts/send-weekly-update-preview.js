// Sends the newest marketing weekly update (src/services/weeklyUpdate/updates)
// as a preview to media@aimdentallab.com with an "Approve & Send" link.
// Nothing goes to leadership until that link is confirmed.
// Run: node scripts/send-weekly-update-preview.js
require('dotenv').config({ quiet: true })
const { sendWeeklyUpdatePreview } = require('../src/services/weeklyUpdate')
sendWeeklyUpdatePreview()
  .then((u) => { console.log(`Preview of week ending ${u.week} sent to media@aimdentallab.com`); process.exit(0) })
  .catch((e) => { console.error(e.message); process.exit(1) })
