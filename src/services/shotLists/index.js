const fs = require('fs')
const path = require('path')
const { sendEmail } = require('../email')

// Weekly lab-team shot lists (photo/video requests for marketing). Moved here
// from claude.ai routines on 2026-10-12 and shifted back one week because no
// Week 1 assets came in; Week 1 is re-sent. Each list goes to the marketing
// inbox, which forwards it to the team.
const TO = 'akielimjoco@gmail.com'
const SCHEDULE = [
  { week: 1, sendDate: '2026-10-12', subject: 'Week 1 Shot List for the Lab Team (re-sent)' },
  { week: 2, sendDate: '2026-10-19', subject: 'Week 2 Shot List for the Lab Team' },
  { week: 3, sendDate: '2026-10-26', subject: 'Week 3 Shot List for the Lab Team' },
  { week: 4, sendDate: '2026-11-02', subject: 'Week 4 Shot List for the Lab Team' },
]

function shotListForDate(dateStr) {
  return SCHEDULE.find((s) => s.sendDate === dateStr) || null
}

async function sendShotList(entry) {
  const html = fs.readFileSync(path.join(__dirname, `week${entry.week}.html`), 'utf8')
  await sendEmail({ to: TO, subject: entry.subject, html })
}

module.exports = { SCHEDULE, shotListForDate, sendShotList }
