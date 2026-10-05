require('dotenv').config()
const test = require('node:test')
const assert = require('node:assert/strict')
const crypto = require('crypto')
const db = require('../src/config/db')
// Sales figures come from Evident's MTD billed email; tests have no Gmail
// access, so stub that one lookup BEFORE whatsappDailyPost reads it.
const salesRepDailyReport = require('../src/services/salesRepDailyReport')
let mtdStub = async () => 1000
salesRepDailyReport.evidentMtdForRep = (...args) => mtdStub(...args)
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

test('the image has no last-month section, and no last-month figures are fetched', async () => {
  const calls = []
  mtdStub = async (email, dateStr, kind) => { calls.push(dateStr); return 100 }
  try {
    const post = await buildWhatsappDailyPost('2026-10-02', 2)
    assert.ok(post.reps.every((r) => r.lastMonth === undefined))
    assert.deepEqual([...new Set(calls)], ['2026-10-02'], 'only this month\'s figure is requested')
    const html = buildWhatsappImageHtml(post, 'msg')
    assert.doesNotMatch(html, /Last month/i)
    assert.match(html, /This month/)
    assert.match(html, /Acquired this week/)
  } finally {
    mtdStub = async () => 1000
  }
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

test('monthly sales come from Evident MTD billed (sales = billed), not the CRM case sum', async () => {
  mtdStub = async (email, dateStr, kind) => (kind === 'billed' && email === 'williama@aimdentallab.com' && dateStr === '2026-10-01' ? 569.96 : 0)
  try {
    const post = await buildWhatsappDailyPost('2026-10-01', 2)
    const william = post.reps.find((r) => r.firstName === 'William')
    assert.equal(william.salesCur, 569.96)
    assert.match(post.caption, /\*William\*\nSales: \$570 of \$15,000/)
  } finally {
    mtdStub = async () => 1000
  }
})

test('when the Evident MTD billed email is unavailable, sales show "—" instead of a made-up number', async () => {
  mtdStub = async () => null
  try {
    const post = await buildWhatsappDailyPost('2026-10-01', 2)
    assert.ok(post.reps.every((r) => r.salesCur === null))
    assert.equal(post.team.salesCur, null)
    assert.match(post.caption, /Sales: — of/)
    const html = buildWhatsappImageHtml(post, 'msg')
    assert.match(html, />—</)
    assert.doesNotMatch(html, /NaN/)
  } finally {
    mtdStub = async () => 1000
  }
})
