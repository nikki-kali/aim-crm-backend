const test = require('node:test')
const assert = require('node:assert/strict')
const { resolveViewableRepId, Q4_MONTHS } = require('../src/services/repProgress')

test('Q4_MONTHS covers exactly October, November, December 2026', () => {
  assert.deepEqual(Q4_MONTHS.map((m) => m.month), ['October', 'November', 'December'])
  assert.equal(Q4_MONTHS[0].period_start, '2026-10-01')
  assert.equal(Q4_MONTHS[2].period_end, '2026-12-31')
})

test('resolveViewableRepId: a scoped user with no rep_id gets their own id', () => {
  const user = { id: 'rep-1', role: 'sales_rep' }
  assert.equal(resolveViewableRepId(user, undefined), 'rep-1')
})

test('resolveViewableRepId: a scoped user requesting their own id explicitly is allowed', () => {
  const user = { id: 'rep-1', role: 'staff' }
  assert.equal(resolveViewableRepId(user, 'rep-1'), 'rep-1')
})

test('resolveViewableRepId: a scoped user requesting a DIFFERENT id is refused with a 403', () => {
  const user = { id: 'rep-1', role: 'sales_rep' }
  assert.throws(() => resolveViewableRepId(user, 'rep-2'), (err) => {
    assert.equal(err.status, 403)
    return true
  })
})

test('resolveViewableRepId: an admin with no rep_id gets their own id', () => {
  const user = { id: 'admin-1', role: 'admin' }
  assert.equal(resolveViewableRepId(user, undefined), 'admin-1')
})

test('resolveViewableRepId: an admin can request any rep_id', () => {
  const user = { id: 'admin-1', role: 'admin' }
  assert.equal(resolveViewableRepId(user, 'rep-2'), 'rep-2')
})
