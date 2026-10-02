require('dotenv').config()
const test = require('node:test')
const assert = require('node:assert/strict')
const crypto = require('crypto')
const db = require('../../src/config/db')
const { listNewDoctorNamesOnDate, listNewDoctorNamesThisWeek } = require('../../src/services/salesRepDailyReport')

async function makeTestDoctor(repId, firstCaseDate, nameSuffix) {
  const doctorName = `TEST DOCTOR WHATSAPP ${nameSuffix} ${crypto.randomBytes(3).toString('hex')}`
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

test('listNewDoctorNamesOnDate returns the real names of doctors whose first-ever case was exactly dateStr', async () => {
  const { rows: [james] } = await db.query(`SELECT id FROM users WHERE email='james@aimdentallab.com'`)
  const dateStr = '2026-09-14' // a quiet real day, unlikely to collide with real new doctors
  const before = await listNewDoctorNamesOnDate(james.id, dateStr)
  const name1 = await makeTestDoctor(james.id, dateStr, 'ONE')
  const name2 = await makeTestDoctor(james.id, dateStr, 'TWO')
  try {
    const after = await listNewDoctorNamesOnDate(james.id, dateStr)
    assert.equal(after.length, before.length + 2)
    assert.ok(after.includes(name1))
    assert.ok(after.includes(name2))
  } finally {
    await cleanup(name1)
    await cleanup(name2)
  }
})

test('listNewDoctorNamesOnDate excludes a doctor whose first case was a different day', async () => {
  const { rows: [james] } = await db.query(`SELECT id FROM users WHERE email='james@aimdentallab.com'`)
  const dateStr = '2026-09-14'
  const name = await makeTestDoctor(james.id, '2026-09-16', 'OTHERDAY')
  try {
    const names = await listNewDoctorNamesOnDate(james.id, dateStr)
    assert.ok(!names.includes(name))
  } finally {
    await cleanup(name)
  }
})

test('listNewDoctorNamesOnDate returns an empty array for a rep with no new doctors that day', async () => {
  const { rows: [james] } = await db.query(`SELECT id FROM users WHERE email='james@aimdentallab.com'`)
  const names = await listNewDoctorNamesOnDate(james.id, '1999-01-01')
  assert.deepEqual(names, [])
})

test('listNewDoctorNamesThisWeek returns real doctor names whose first case fell Monday-through-dateStr', async () => {
  const { rows: [james] } = await db.query(`SELECT id FROM users WHERE email='james@aimdentallab.com'`)
  const dateStr = '2025-06-12' // Thursday; week start (Monday) is 2025-06-09. A past week no other test counts — September/October dates here raced goalProgress.test.js and whatsappDailyPost.test.js, which run in parallel against the same database
  const before = await listNewDoctorNamesThisWeek(james.id, dateStr)
  const name = await makeTestDoctor(james.id, '2025-06-10', 'THISWEEK')
  try {
    const after = await listNewDoctorNamesThisWeek(james.id, dateStr)
    assert.equal(after.length, before.length + 1)
    assert.ok(after.includes(name))
  } finally {
    await cleanup(name)
  }
})

test('listNewDoctorNamesThisWeek excludes a doctor whose first case was the prior week', async () => {
  const { rows: [james] } = await db.query(`SELECT id FROM users WHERE email='james@aimdentallab.com'`)
  const dateStr = '2025-06-12'
  const name = await makeTestDoctor(james.id, '2025-06-06', 'PRIORWEEK')
  try {
    const names = await listNewDoctorNamesThisWeek(james.id, dateStr)
    assert.ok(!names.includes(name))
  } finally {
    await cleanup(name)
  }
})
