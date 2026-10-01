require('dotenv').config()
const test = require('node:test')
const assert = require('node:assert/strict')
const crypto = require('crypto')
const db = require('../src/config/db')
const { buildWhatsappDailyPost } = require('../src/services/whatsappDailyPost')

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
