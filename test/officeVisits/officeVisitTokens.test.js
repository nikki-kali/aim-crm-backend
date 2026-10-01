require('dotenv').config()
const test = require('node:test')
const assert = require('node:assert/strict')
const db = require('../../src/config/db')
const { createToken, peekToken, consumeToken, invalidateOtherTokens } = require('../../src/services/officeVisitTokens')

// Whole-branch review finding (I7): these tests previously wrote real
// rows to the only database this project has and never cleaned them up.
// Every test here now deletes what it created in a `finally` block —
// standing project rule: no staging DB exists, so tests must never leave
// synthetic rows behind in production.
async function makeTestBooking() {
  const { rows } = await db.query(
    `INSERT INTO office_visit_bookings (source, contact_name, phone, status)
     VALUES ('public_form', 'Test Contact', '555-0100', 'pending') RETURNING id`
  )
  return rows[0].id
}

async function cleanupBooking(bookingId) {
  await db.query(`DELETE FROM office_visit_tokens WHERE booking_id = $1`, [bookingId])
  await db.query(`DELETE FROM office_visit_bookings WHERE id = $1`, [bookingId])
}

test('createToken + peekToken: a fresh token peeks without consuming it', async () => {
  const bookingId = await makeTestBooking()
  try {
    const token = await createToken({ bookingId, action: 'approve' })
    const peeked = await peekToken(token)
    assert.equal(peeked.booking_id, bookingId)
    assert.equal(peeked.action, 'approve')
    // Peeking again still works — peek never marks used.
    const peekedAgain = await peekToken(token)
    assert.equal(peekedAgain.booking_id, bookingId)
  } finally {
    await cleanupBooking(bookingId)
  }
})

test('consumeToken claims a token exactly once', async () => {
  const bookingId = await makeTestBooking()
  try {
    const token = await createToken({ bookingId, action: 'suggest_time' })
    const first = await consumeToken(token)
    assert.equal(first.booking_id, bookingId)
    assert.equal(first.action, 'suggest_time')
    const second = await consumeToken(token)
    assert.equal(second, null, 'a second consume of the same token must fail')
  } finally {
    await cleanupBooking(bookingId)
  }
})

test('peekToken and consumeToken return null for an unknown token', async () => {
  assert.equal(await peekToken('not-a-real-token'), null)
  assert.equal(await consumeToken('not-a-real-token'), null)
})

test('invalidateOtherTokens burns the sibling token so it cannot contradict an already-handled booking', async () => {
  const bookingId = await makeTestBooking()
  try {
    const approveToken = await createToken({ bookingId, action: 'approve' })
    const suggestToken = await createToken({ bookingId, action: 'suggest_time' })
    // Rep clicks Approve first.
    const claim = await consumeToken(approveToken)
    assert.equal(claim.action, 'approve')
    await invalidateOtherTokens(bookingId, approveToken)
    // The OTHER token (suggest_time) must now be dead too — a forwarded
    // email or a second click can't send a contradictory "still pending"
    // message after the practice already got a real confirmation.
    const stillUsable = await peekToken(suggestToken)
    assert.equal(stillUsable, null, 'the sibling token must be invalidated once one action is taken')
  } finally {
    await cleanupBooking(bookingId)
  }
})
