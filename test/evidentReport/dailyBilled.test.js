const test = require('node:test')
const assert = require('node:assert')
const { dailyBilledBreakdown } = require('../../src/services/evidentReport/buildReport')

test('Daily Billed splits by company (KH codes) and sales rep, and adds up', () => {
  const rows = [
    { customerCode: 'KH2101', billedValue: 334, salesperson: '' },
    { customerCode: 'A1267', billedValue: 321.98, salesperson: '' },
    { customerCode: 'A1304', billedValue: 65, salesperson: 'william' },
    { customerCode: 'A1164', billedValue: 174, salesperson: 'james dela' },
    { customerCode: 'KH2179', billedValue: 0, salesperson: '' },
    { customerCode: 'A1116', billedValue: null, salesperson: '' },
  ]
  const d = dailyBilledBreakdown(rows, 894.98)
  assert.equal(d.count, 4)
  assert.deepEqual(d.companies, [{ name: 'AIM Dental', value: 560.98, count: 3 }, { name: 'Kings Highway', value: 334, count: 1 }])
  assert.deepEqual(d.reps, [
    { name: 'William Alexander', value: 65, count: 1 },
    { name: 'James Delaney', value: 174, count: 1 },
    { name: 'No sales rep', value: 655.98, count: 2 },
  ])
  assert.equal(dailyBilledBreakdown(rows, null), null)
})
