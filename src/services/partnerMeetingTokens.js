const crypto = require('crypto')
const db = require('../config/db')

// Single-use, expiring action tokens for the email buttons: one "approve"
// token per proposed time (slot_index 0 to 2) plus one "call_first". Same
// design as officeVisitTokens.js: peek never changes anything (email
// scanners pre-fetch links), consume is atomic, and a taken action burns the rest.
const TOKEN_TTL_DAYS = 14

async function createToken({ requestId, action, slotIndex = null }) {
  const token = crypto.randomBytes(32).toString('hex')
  const expiresAt = new Date(Date.now() + TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000)
  await db.query(
    `INSERT INTO partner_meeting_tokens (token, request_id, action, slot_index, expires_at) VALUES ($1,$2,$3,$4,$5)`,
    [token, requestId, action, slotIndex, expiresAt]
  )
  return token
}

async function peekToken(token) {
  const { rows } = await db.query(
    `SELECT request_id, action, slot_index FROM partner_meeting_tokens WHERE token = $1 AND used_at IS NULL AND expires_at > NOW()`,
    [token]
  )
  return rows[0] || null
}

async function consumeToken(token) {
  const { rows } = await db.query(
    `UPDATE partner_meeting_tokens SET used_at = NOW() WHERE token = $1 AND used_at IS NULL AND expires_at > NOW() RETURNING request_id, action, slot_index`,
    [token]
  )
  return rows[0] || null
}

async function invalidateOtherTokens(requestId, excludeToken) {
  await db.query(
    `UPDATE partner_meeting_tokens SET used_at = NOW() WHERE request_id = $1 AND token != $2 AND used_at IS NULL`,
    [requestId, excludeToken]
  )
}

module.exports = { createToken, peekToken, consumeToken, invalidateOtherTokens }
