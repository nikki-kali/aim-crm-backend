require('dotenv').config()
const test = require('node:test')
const assert = require('node:assert/strict')
const crypto = require('crypto')
const db = require('../src/config/db')
const { computeProgress } = require('../src/services/goalProgress')

// Real bug found 2026-10-01: the old new_doctors metric counted
// `clients.created_at` (when the client ROW was created in the CRM),
// not when the doctor's real first case happened. A client row can be
// created a day or more AFTER its doctor's real first case (the
// overnight Evident sync creates the client the same run it creates the
// case, but that run can land on a different calendar day than the
// case's own real date — confirmed for real with Dr. Leslie Grace
// Lopez: first case 2026-09-30, client row created 2026-10-01, so the
// old metric missed her as a September new doctor entirely). The fix
// counts by the doctor's real first case date instead, matching
// salesRepDailyReport.js's countNewDoctorsOnDate exactly.
// March 2025 on purpose: a closed month no other test file counts. These
// tests compare James's whole-month count before/after one insert, and
// other files run in parallel inserting James test doctors dated
// mid-September 2026, which made a September period here flaky. Same
// scenario as the real Dr. Lopez case, shifted to a quiet month.
async function makeTestDoctor(repId, { firstCaseDate, clientCreatedAt }) {
  const doctorName = `TEST DOCTOR GOALPROGRESS ${crypto.randomBytes(4).toString('hex')}`
  await db.query(
    `INSERT INTO clients (doctor_name, assigned_to, created_at, brand) VALUES ($1,$2,$3,'Aim Dental')`,
    [doctorName, repId, clientCreatedAt]
  )
  await db.query(
    `INSERT INTO cases (case_number, client_name, created_at, status)
     VALUES ($1,$2,$3,'Case Received')`,
    [`TEST-${crypto.randomBytes(4).toString('hex')}`, doctorName, firstCaseDate]
  )
  return doctorName
}

async function cleanupTestDoctor(doctorName) {
  await db.query(`DELETE FROM cases WHERE client_name = $1`, [doctorName])
  await db.query(`DELETE FROM clients WHERE doctor_name = $1`, [doctorName])
}

test('computeProgress new_doctors counts a doctor by real first-case date, not when the client row was created', async () => {
  const { rows: [james] } = await db.query(`SELECT id FROM users WHERE email='james@aimdentallab.com'`)
  const period = { period_start: '2025-03-01', period_end: '2025-03-31' }
  const before = await computeProgress({ rep_id: james.id, metric: 'new_doctors', target: 100, ...period })

  // First case Sept 30 (inside the goal period), client row created Oct 1
  // (outside it) — exactly the real Lopez scenario.
  const doctorName = await makeTestDoctor(james.id, {
    firstCaseDate: '2025-03-31', clientCreatedAt: '2025-04-01',
  })
  try {
    const after = await computeProgress({ rep_id: james.id, metric: 'new_doctors', target: 100, ...period })
    assert.equal(after.current_value, before.current_value + 1,
      'the September count should go up by exactly 1 once this doctor (real first case in September) exists, even though her client row was created in October')
  } finally {
    await cleanupTestDoctor(doctorName)
  }
})

test('computeProgress new_doctors does NOT count a doctor whose first case falls outside the period, even if the client row was created inside it', async () => {
  const { rows: [james] } = await db.query(`SELECT id FROM users WHERE email='james@aimdentallab.com'`)
  const period = { period_start: '2025-03-01', period_end: '2025-03-31' }
  const before = await computeProgress({ rep_id: james.id, metric: 'new_doctors', target: 100, ...period })

  // Inverse of the real bug scenario: first case in August, but the
  // client row happens to have been created in September. A real
  // September new-doctors goal must NOT count her.
  const doctorName = await makeTestDoctor(james.id, {
    firstCaseDate: '2025-02-15', clientCreatedAt: '2025-03-05',
  })
  try {
    const after = await computeProgress({ rep_id: james.id, metric: 'new_doctors', target: 100, ...period })
    assert.equal(after.current_value, before.current_value,
      'the September count must not change — her real first case was in August, only her client row landed in September')
  } finally {
    await cleanupTestDoctor(doctorName)
  }
})
