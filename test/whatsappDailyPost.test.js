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

test('the image and caption have no "acquired this week" section either', async () => {
  const post = await buildWhatsappDailyPost('2026-10-02', 2)
  assert.ok(post.reps.every((r) => r.doctorsThisWeek === undefined))
  assert.doesNotMatch(post.caption, /This week:/)
  const html = buildWhatsappImageHtml(post, 'msg')
  assert.doesNotMatch(html, /Acquired this week/i)
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

test('each rep shows month-to-date BOOKED and BILLED (both from Evident) on the image and in the caption', async () => {
  mtdStub = async (email, dateStr, kind) => {
    const william = email === 'williama@aimdentallab.com'
    if (kind === 'billed') return william ? 569.96 : 0
    return william ? 532.49 : 261
  }
  try {
    const post = await buildWhatsappDailyPost('2026-10-05', 6)
    const william = post.reps.find((r) => r.firstName === 'William')
    const james = post.reps.find((r) => r.firstName === 'James')
    assert.equal(william.salesCur, 569.96, 'billed still drives the Monthly sales bar')
    assert.equal(william.bookedCur, 532.49)
    assert.equal(james.bookedCur, 261)
    assert.equal(post.team.bookedCur, 793.49)
    assert.match(post.caption, /\*William\*\nSales: \$570 of \$15,000 \(4%\)\nBooked: \$532 · Billed: \$570/)
    assert.match(post.caption, /\*James\*\nSales: \$0 of \$50,000 \(0%\)\nBooked: \$261 · Billed: \$0/)
    assert.match(post.caption, /\*Team\*\nSales: \$570 of \$65,000 \(1%\)\nBooked: \$793 · Billed: \$570/)
    const text = buildWhatsappImageHtml(post, 'msg').replace(/<style[\s\S]*?<\/style>/gi, '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ')
    assert.match(text, /William Alexander|William/)
    assert.match(text, /Booked \$532 Billed \$570/)
    assert.match(text, /Booked \$261 Billed \$0/)
  } finally {
    mtdStub = async () => 1000
  }
})

test('a booked figure Evident did not provide shows a dash, not a made-up number, and does not break the billed figure', async () => {
  mtdStub = async (email, dateStr, kind) => (kind === 'booked' ? null : 100)
  try {
    const post = await buildWhatsappDailyPost('2026-10-05', 6)
    assert.ok(post.reps.every((r) => r.bookedCur === null && r.salesCur === 100))
    assert.equal(post.team.bookedCur, null)
    assert.match(post.caption, /Booked: — · Billed: \$100/)
    const html = buildWhatsappImageHtml(post, 'msg')
    assert.doesNotMatch(html, /NaN|undefined/)
  } finally {
    mtdStub = async () => 1000
  }
})
