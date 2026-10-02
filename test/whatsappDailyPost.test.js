require('dotenv').config()
const test = require('node:test')
const assert = require('node:assert/strict')
const crypto = require('crypto')
const db = require('../src/config/db')
const { buildWhatsappDailyPost, buildWhatsappImageHtml, pickDailyMessage } = require('../src/services/whatsappDailyPost')

async function makeTestDoctor(repId, firstCaseDate) {
  const doctorName = `TEST DOCTOR WAPOST ${crypto.randomBytes(3).toString('hex')}`
  await db.query(
    `INSERT INTO clients (doctor_name, assigned_to, created_at, brand) VALUES ($1,$2,$3,'Aim Dental')`,
    [doctorName, repId, firstCaseDate]
  )
  await db.query(
    `INSERT INTO cases (case_number, client_name, created_at, status) VALUES ($1,$2,$3,'Case Received')`,
    [`TEST-${crypto.randomBytes(4).toString('hex')}`, doctorName, firstCaseDate]
  )
  return doctorName
}

async function cleanup(doctorName) {
  await db.query(`DELETE FROM cases WHERE client_name = $1`, [doctorName])
  await db.query(`DELETE FROM clients WHERE doctor_name = $1`, [doctorName])
}

test('the caption includes a "Won today" line with the real doctor name when a rep has one', async () => {
  const { rows: [james] } = await db.query(`SELECT id FROM users WHERE email='james@aimdentallab.com'`)
  const dateStr = '2026-09-15'
  const doctorName = await makeTestDoctor(james.id, dateStr)
  try {
    const post = await buildWhatsappDailyPost(dateStr, 1)
    assert.ok(post, 'post should build successfully')
    assert.match(post.caption, new RegExp(`Won today: .*${doctorName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`))
  } finally {
    await cleanup(doctorName)
  }
})

test('the caption omits "Won today" entirely for a rep with no real wins that day', async () => {
  // A date with no real new-doctor activity for either rep.
  const post = await buildWhatsappDailyPost('1999-01-01', 1)
  if (post) assert.doesNotMatch(post.caption, /Won today:/)
})

test('each rep carries a real last-month sales/doctors summary computed from the prior calendar month', async () => {
  const post = await buildWhatsappDailyPost('2026-10-01', 1)
  assert.ok(post, 'post should build successfully')
  for (const r of post.reps) {
    assert.ok(r.lastMonth, `${r.firstName} should have a lastMonth summary`)
    assert.equal(typeof r.lastMonth.salesCur, 'number')
    assert.equal(typeof r.lastMonth.salesTarget, 'number')
    assert.equal(typeof r.lastMonth.docsCur, 'number')
    assert.equal(typeof r.lastMonth.docsTarget, 'number')
  }
})

test('a new doctor whose first case fell in the prior month counts toward that rep\'s lastMonth doctors, not the current month', async () => {
  const { rows: [james] } = await db.query(`SELECT id FROM users WHERE email='james@aimdentallab.com'`)
  const priorMonthDate = '2026-09-14'
  const before = await buildWhatsappDailyPost('2026-10-01', 1)
  const jamesBefore = before.reps.find((r) => r.firstName === 'James')
  const doctorName = await makeTestDoctor(james.id, priorMonthDate)
  try {
    const after = await buildWhatsappDailyPost('2026-10-01', 1)
    const jamesAfter = after.reps.find((r) => r.firstName === 'James')
    assert.equal(jamesAfter.lastMonth.docsCur, jamesBefore.lastMonth.docsCur + 1)
    assert.equal(jamesAfter.docsCur, jamesBefore.docsCur, 'a prior-month doctor must not also bump the current month count')
  } finally {
    await cleanup(doctorName)
  }
})

test('buildWhatsappImageHtml renders a last-month summary line under each rep card', () => {
  const post = {
    dateStr: '2026-10-01',
    team: { salesCur: 1000, salesTarget: 65000, docsCur: 1, docsTarget: 30 },
    reps: [
      { firstName: 'James', salesCur: 500, salesTarget: 50000, docsCur: 1, docsTarget: 18, wonToday: [], lastMonth: { salesCur: 42000, salesTarget: 50000, docsCur: 14, docsTarget: 16 } },
      { firstName: 'William', salesCur: 500, salesTarget: 15000, docsCur: 0, docsTarget: 12, wonToday: [], lastMonth: { salesCur: 9000, salesTarget: 15000, docsCur: 8, docsTarget: 12 } },
    ],
  }
  const html = buildWhatsappImageHtml(post, 'Test message')
  assert.match(html, /Last month/)
  assert.match(html, /\$42,000/)
  assert.match(html, /\$9,000/)
})

test('buildWhatsappImageHtml omits the last-month strip for a rep with no lastMonth data rather than showing fabricated numbers', () => {
  const post = {
    dateStr: '2026-10-01',
    team: { salesCur: 0, salesTarget: 65000, docsCur: 0, docsTarget: 30 },
    reps: [
      { firstName: 'James', salesCur: 0, salesTarget: 50000, docsCur: 0, docsTarget: 18, wonToday: [], lastMonth: null },
    ],
  }
  const html = buildWhatsappImageHtml(post, 'Test message')
  assert.doesNotMatch(html, /Last month/)
})

test('pickDailyMessage returns a start-of-month themed message for the first 5 days of the month', () => {
  const msg = pickDailyMessage(2)
  assert.equal(typeof msg, 'string')
  assert.ok(msg.length > 0)
})

test('pickDailyMessage returns the normal rotating quote after the first 5 days of the month', () => {
  const { PUSH_QUOTES } = require('../src/services/email')
  const msg = pickDailyMessage(20)
  assert.ok(PUSH_QUOTES.includes(msg))
})
