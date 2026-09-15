const test = require('node:test')
const assert = require('node:assert/strict')
const { mondayOfWeekEastern } = require('../../src/services/salesRepDailyReport')

test('a Tuesday resolves to that week\'s Monday', () => {
  assert.equal(mondayOfWeekEastern('2026-09-15'), '2026-09-14')
})

test('Monday itself resolves to itself', () => {
  assert.equal(mondayOfWeekEastern('2026-09-14'), '2026-09-14')
})

test('a Sunday resolves to the Monday that started that week', () => {
  assert.equal(mondayOfWeekEastern('2026-09-20'), '2026-09-14')
})
