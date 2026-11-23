const test = require('node:test')
const assert = require('node:assert')
const { buildReport2Email, labTotalsSection } = require('../../src/services/evidentReport/buildReport')
const { repKeyFromSalesperson, extractRepColumns } = require('../../src/services/evidentReport/parseEvident')

const agg = (extra = {}) => ({
  runDate: '2026-11-20', missing: [],
  companyDailyBookedRows: [
    { salesperson: 'James Delaney', value: 10 },
    { salesperson: 'Zareh, Frederick', value: 25.5 },
    { salesperson: 'Frederick Zareh', value: 4.5 },
  ],
  companyDailyBilledRows: [{ salesperson: 'Zareh, Frederick', value: 9, billedValue: 9 }],
  companyMtdBookedByRep: { na: 1, james: 2, william: 3, fred: 100 },
  companyMtdBilledByRep: { na: 1, james: 2, william: 3, fred: 60 },
  ...extra,
})

test('Frederick Zareh is recognised under every likely label', () => {
  for (const n of ['Zareh, Frederick', 'Frederick Zareh', 'Fred Zareh', 'Zare, Fred']) assert.equal(repKeyFromSalesperson(n), 'fred', n)
  assert.equal(repKeyFromSalesperson('William Alexander'), 'william')
})

test('MTD columns: Frederick only appears once Evident has a column for him', () => {
  const withFred = extractRepColumns(['Ref', 'N/A', 'Delaney, James', 'Zareh, Frederick'], { 'N/A': '5', 'Delaney, James': '1', 'Zareh, Frederick': '7' })
  assert.equal(withFred.fred, 7)
  const without = extractRepColumns(['Ref', 'N/A', 'Delaney, James'], { 'N/A': '5', 'Delaney, James': '1' })
  assert.equal('fred' in without, false)
})

test('dashboard has a Frederick Zareh card with the same four figures as James and William', () => {
  const html = buildReport2Email(agg(), []).html
  assert.match(html, /Frederick Zareh/)
  assert.ok(html.indexOf('William Alexander') < html.indexOf('Frederick Zareh'))
  assert.match(html, /\$30\.00/) // two booked rows, 25.50 + 4.50
  assert.match(html, /\$100\.00/) // MTD booked
  assert.match(html, /\$60\.00/) // MTD billed
})

test('before Evident reports Frederick, his MTD shows "-" and nothing breaks', () => {
  const html = buildReport2Email(agg({ companyMtdBookedByRep: { na: 1, james: 2, william: 3 }, companyMtdBilledByRep: null }), []).html
  assert.match(html, /Frederick Zareh/)
})

test('New Jobs shows the arrival-date month and day, with or without a case count', () => {
  const withCases = labTotalsSection({ runDate: '2026-11-20', newJobs: { mtd: { value: 155973.32, count: 1500 }, day: { value: 9000, count: 118 } } })
  assert.match(withCases, /\$155,973/)
  assert.match(withCases, /1,500 cases/)
  assert.match(withCases, /118 cases/)
  const noCount = labTotalsSection({ runDate: '2026-11-20', newJobs: { mtd: { value: 155973.32, count: null }, day: { value: 9000, count: null } } })
  assert.match(noCount, /\$155,973/)
  assert.doesNotMatch(noCount, /null|NaN/)
})
