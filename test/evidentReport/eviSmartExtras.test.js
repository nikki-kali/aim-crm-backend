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
  assert.deepEqual(x.newDoctors.james[0], { code: 'A1119', name: 'Dr. Idelle Brand', firstCase: '5 Oct 2026', cases: 2 })
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
  // The real email lists Dr. Idelle Brand (A1119) for James, but she is not a
  // new doctor (user, 2026-10-09), so James stays at 0.
  assert.equal(out[0].goals[0].current_value, 0)
  assert.equal(out[0].goals[1].current_value, 234)   // revenue untouched
  assert.equal(out[1].goals[0].current_value, 0)
})

test('a genuinely new doctor is still counted; only excluded codes are dropped', () => {
  const extras = { newDoctors: { james: [{ code: 'A1119', name: 'Dr. Idelle Brand', cases: 2 }, { code: 'A4160', name: 'Dr. New Person', cases: 1 }], william: [] }, lastMonth: null }
  const goals = [{ repName: 'James Delaney', goals: [{ metric: 'new_doctors', target: '18', current_value: 0, progress_pct: 0 }] }]
  const out = applyEviSmartNewDoctors(goals, extras)
  assert.equal(out[0].goals[0].current_value, 1)
  assert.equal(out[0].goals[0].progress_pct, 6)
})

test('withoutExcludedDoctors removes A1119 from the lists and leaves the rest', () => {
  const { withoutExcludedDoctors, EXCLUDED_NEW_DOCTOR_CODES } = require('../../src/services/evidentReport/eviSmartPrimary')
  assert.ok(EXCLUDED_NEW_DOCTOR_CODES.has('A1119'))
  const x = withoutExcludedDoctors(P.extractEviSmartExtras(NEW))
  assert.deepEqual(x.newDoctors, { james: [], william: [] })
  assert.equal(x.lastMonth.booked, 171172.07)
  assert.equal(withoutExcludedDoctors(null), null)
  assert.deepEqual(withoutExcludedDoctors({ newDoctors: null, lastMonth: null }), { newDoctors: null, lastMonth: null })
})

test('with no extras (older email) the CRM-based new-doctor numbers are left alone', () => {
  const goals = [{ repName: 'James Delaney', goals: [{ metric: 'new_doctors', target: '18', current_value: 3, progress_pct: 17 }] }]
  assert.deepEqual(applyEviSmartNewDoctors(goals, { newDoctors: null, lastMonth: null }), goals)
  assert.deepEqual(applyEviSmartNewDoctors(goals, null), goals)
})
