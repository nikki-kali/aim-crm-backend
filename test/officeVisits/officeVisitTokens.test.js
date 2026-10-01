require('dotenv').config()
const test = require('node:test')
const assert = require('node:assert/strict')
const db = require('../../src/config/db')
const { createToken, peekToken, consumeToken } = require('../../src/services/officeVisitTokens')

async function makeTestBooking() {
  const { rows } = await db.query(
    `INSERT INTO office_visit_bookings (source, contact_name, phone, status)
     VALUES ('public_form', 'Test Contact', '555-0100', 'pending') RETURNING id`
  )
  return rows[0].id
}

test('createToken + peekToken: a fresh token peeks without consuming it', async () => {
  const bookingId = await makeTestBooking()
  const token = await createToken({ bookingId, action: 'approve' })
  const peeked = await peekToken(token)
  assert.equal(peeked.booking_id, bookingId)
  assert.equal(peeked.action, 'approve')
  // Peeking again still works — peek never marks used.
  const peekedAgain = await peekToken(token)
  assert.equal(peekedAgain.booking_id, bookingId)
})

test('consumeToken claims a token exactly once', async () => {
  const bookingId = await makeTestBooking()
  const token = await createToken({ bookingId, action: 'suggest_time' })
  const first = await consumeToken(token)
  assert.equal(first.booking_id, bookingId)
  assert.equal(first.action, 'suggest_time')
  const second = await consumeToken(token)
  assert.equal(second, null, 'a second consume of the same token must fail')
})

test('peekToken and consumeToken return null for an unknown token', async () => {
  assert.equal(await peekToken('not-a-real-token'), null)
  assert.equal(await consumeToken('not-a-real-token'), null)
})
