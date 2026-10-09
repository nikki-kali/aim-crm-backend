const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const path = require('path')
const P = require('../../src/services/evidentReport/parseEvident')
const { applyEviSmartNewDoctors, applyEviSmartMtdPrimary } = require('../../src/services/evidentReport/eviSmartPrimary')

const NEW = fs.readFileSync(path.join(__dirname, 'fixtures/evismart-2026-10-08-with-new-doctors.html'), 'utf8')
const OLD = fs.readFileSync(path.join(__dirname, 'fixtures/evismart-daily-sales-report-sep25-nested-ytd.html'), 'utf8')

test('the real 8 Oct email: last month and the new doctors are read', () => {
  const x = P.extractEviSmartExtras(NEW)
  assert.deepEqual(x.lastMonth, { monthName: 'September', bookedCount: 1821, booked: 171172.07, billed: 168424.13 })
  assert.equal(x.newDoctors.james.length, 1)
  assert.deepEqual(x.newDoctors.james[0], { code: 'A1119', name: 'Dr. Idelle Brand', firstCase: '5 Oct 2026', firstCaseIso: '2026-10-05', cases: 2 })
  assert.deepEqual(x.newDoctors.william, [])      // "None this month" is a known zero, not missing data
})

test('the September reference table is not mistaken for this month', () => {
  const x = P.extractEviSmartExtras(NEW)
  assert.equal(x.newDoctors.james.map((d) => d.name).includes('Domino Dental'), false)
})

test('an older-format email has no new-doctors table: unknown, never zero (its last-month row is still read)', () => {
  const x = P.extractEviSmartExtras(OLD)
  assert.equal(x.newDoctors, null)
  assert.equal(x.lastMonth.monthName, 'Aug')
})

test('the 8 Oct email still parses to the same totals the reports already use', () => {
  const t = P.extractEviSmartTotals(NEW)
  assert.equal(t.dailyBilledValue, 11339.34)
  assert.equal(t.mtdBookedValue, 44301.03)
  assert.deepEqual(t.repMtd.booked, { james: 685.13, william: 1262.45, na: 42353.45, company: 44301.03 })
})

test('EviSmart is primary for month-to-date: it overrides Evident even when Evident arrived, and clears a rejection', () => {
  const agg = { missing: [], companyMtdBooked: 485192.03, companyMtdBookedByRep: { na: 1, james: 5360.43, william: 8028.1 }, companyMtdBilled: 56726.56, companyMtdBilledByRep: { na: 54531.62, james: 234, william: 1960.94 }, bookedMtdRejected: { reason: 'x' } }
  const out = applyEviSmartMtdPrimary(agg, P.extractEviSmartTotals(NEW))
  assert.equal(out.companyMtdBooked, 44301.03)
  assert.deepEqual(out.companyMtdBookedByRep, { na: 42353.45, james: 685.13, william: 1262.45 })
  assert.equal(out.bookedMtdRejected, undefined)
  assert.deepEqual(out.missing, [])
})

test('without EviSmart, Evident figures are left exactly as they were', () => {
  const agg = { missing: ['MTD Booked Daily Update'], companyMtdBooked: 0, companyMtdBookedByRep: null }
  assert.deepEqual(applyEviSmartMtdPrimary(agg, null), agg)
})

test('new doctors from EviSmart replace the goal progress for that rep only', () => {
  const x = P.extractEviSmartExtras(NEW)
  const goals = [
    { repName: 'James Delaney', goals: [{ metric: 'new_doctors', target: '18', current_value: 0, progress_pct: 0 }, { metric: 'monthly_revenue', target: '50000', current_value: 234 }] },
    { repName: 'William Alexander', goals: [{ metric: 'new_doctors', target: '12', current_value: 0, progress_pct: 0 }] },
  ]
  const out = applyEviSmartNewDoctors(goals, x)
  assert.equal(out[0].goals[0].current_value, 1)
  assert.equal(out[0].goals[0].progress_pct, 6)
  assert.equal(out[0].goals[1].current_value, 234)   // revenue untouched
  assert.equal(out[1].goals[0].current_value, 0)
})

test('with no extras (older email) the CRM-based new-doctor numbers are left alone', () => {
  const goals = [{ repName: 'James Delaney', goals: [{ metric: 'new_doctors', target: '18', current_value: 3, progress_pct: 17 }] }]
  assert.deepEqual(applyEviSmartNewDoctors(goals, { newDoctors: null, lastMonth: null }), goals)
  assert.deepEqual(applyEviSmartNewDoctors(goals, null), goals)
})

test('first-case dates come through as ISO, and the September reference list is kept separately', () => {
  const x = P.extractEviSmartExtras(NEW)
  assert.equal(x.newDoctors.james[0].firstCaseIso, '2026-10-05')
  assert.deepEqual(x.newDoctorsPrevMonth.james.map((d) => [d.name, d.firstCaseIso]), [
    ['Dr. Cecilia U. Schneuerman', '2026-09-02'], ['Domino Dental', '2026-09-22'], ['Dr. Joel Manley', '2026-09-23'],
  ])
  assert.deepEqual(x.newDoctorsPrevMonth.william.map((d) => d.name), ['Dr. Leslie Grace Lopez'])
})

test('countEviSmartNewDoctors: today and this week from the real 8 Oct email', () => {
  const { countEviSmartNewDoctors } = require('../../src/services/evidentReport/eviSmartPrimary')
  const x = P.extractEviSmartExtras(NEW)
  // Thursday 8 Oct; the week started Monday 5 Oct; Dr. Idelle Brand's first case was 5 Oct.
  assert.deepEqual(countEviSmartNewDoctors(x, 'james', '2026-10-08', '2026-10-05'), { today: 0, week: 1, names: ['Dr. Idelle Brand'] })
  assert.deepEqual(countEviSmartNewDoctors(x, 'william', '2026-10-08', '2026-10-05'), { today: 0, week: 0, names: [] })
  // On her first-case day she is "today" too.
  assert.deepEqual(countEviSmartNewDoctors(x, 'james', '2026-10-05', '2026-10-05'), { today: 1, week: 1, names: ['Dr. Idelle Brand'] })
})

test('countEviSmartNewDoctors: a week that crosses the month end also counts the September list', () => {
  const { countEviSmartNewDoctors } = require('../../src/services/evidentReport/eviSmartPrimary')
  const x = P.extractEviSmartExtras(NEW)
  // Week of Mon 21 Sep through Wed 23 Sep: Domino Dental (22 Sep) and Dr. Joel Manley (23 Sep).
  const r = countEviSmartNewDoctors(x, 'james', '2026-09-23', '2026-09-21')
  assert.equal(r.week, 2)
  assert.equal(r.today, 1)
})

test('countEviSmartNewDoctors returns null when the email has no new-doctors table (callers keep the CRM numbers)', () => {
  const { countEviSmartNewDoctors } = require('../../src/services/evidentReport/eviSmartPrimary')
  assert.equal(countEviSmartNewDoctors({ newDoctors: null }, 'james', '2026-10-08', '2026-10-05'), null)
  assert.equal(countEviSmartNewDoctors(null, 'james', '2026-10-08', '2026-10-05'), null)
})
