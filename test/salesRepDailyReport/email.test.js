const test = require('node:test')
const assert = require('node:assert/strict')
const { salesRepDailyReportEmail } = require('../../src/services/email')

const SAMPLE = {
  repName: 'James Delaney',
  dateLabel: 'Tuesday, September 15, 2026',
  doctors: [
    { doctor_name: 'Dr. Brian Gold', clinic_name: null, submitted_today: true },
    { doctor_name: 'Dr. Cecilia U. Schneuerman', clinic_name: null, submitted_today: false },
  ],
  totalCount: 2,
  submittedCount: 1,
  notSubmittedCount: 1,
  goal: { target: 5, current: 2, hasCustomGoal: false },
}

test('renders totals, doctor rows, and weekly goal progress', () => {
  const html = salesRepDailyReportEmail(SAMPLE)
  assert.match(html, /Daily Sales Report/)
  assert.match(html, /James Delaney/)
  assert.match(html, /Dr\. Brian Gold/)
  assert.match(html, /Dr\. Cecilia U\. Schneuerman/)
  assert.match(html, /Submitted/)
  assert.match(html, /Not submitted/)
  assert.match(html, />2 <span[^>]*>of 5<\/span></)
})

test('test send shows the TEST banner', () => {
  const html = salesRepDailyReportEmail({ ...SAMPLE, test: true })
  assert.match(html, /Test send/)
})

test('a rep with zero assigned doctors gets an empty-state message, not a broken table', () => {
  const html = salesRepDailyReportEmail({ ...SAMPLE, doctors: [], totalCount: 0, submittedCount: 0, notSubmittedCount: 0 })
  assert.match(html, /No doctors assigned yet/)
})
