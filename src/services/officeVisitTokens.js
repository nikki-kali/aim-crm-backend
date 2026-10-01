const crypto = require('crypto')
const db = require('../config/db')

// Single-use, expiring action tokens for the two email-triggered Office
// Visit actions (approve / suggest another time). Modeled on
// reportApproval.js's createApprovalToken/peekApprovalToken/
// consumeApprovalToken but kept in its own table (office_visit_tokens)
// since it references a booking, not a report. 7-day TTL — longer than
// the 24h report-approval window, since a rep may not check this email as
// urgently as a leadership report.
const TOKEN_TTL_DAYS = 7

async function createToken({ bookingId, action }) {
  const token = crypto.randomBytes(32).toString('hex')
  const expiresAt = new Date(Date.now() + TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000)
  await db.query(
    `INSERT INTO office_visit_tokens (token, booking_id, action, expires_at)
     VALUES ($1,$2,$3,$4)`,
    [token, bookingId, action, expiresAt]
  )
  return token
}

// Read-only — does NOT mark the token used. Backs the GET /confirm
// confirmation page, which must be safe for an email client/provider's
// automated link pre-fetch (see officeVisits.js route comments and the
// project-wide reportApproval.js precedent this mirrors).
async function peekToken(token) {
  const { rows } = await db.query(
    `SELECT booking_id, action FROM office_visit_tokens
     WHERE token = $1 AND used_at IS NULL AND expires_at > NOW()`,
    [token]
  )
  return rows[0] || null
}

// Atomic claim: the UPDATE's WHERE clause (unused, unexpired) means a
// second attempt (double-click, or two tabs) matches zero rows and
// returns null rather than re-running the real action twice.
async function consumeToken(token) {
  const { rows } = await db.query(
    `UPDATE office_visit_tokens SET used_at = NOW()
     WHERE token = $1 AND used_at IS NULL AND expires_at > NOW()
     RETURNING booking_id, action`,
    [token]
  )
  return rows[0] || null
}

// Burns every OTHER unused token for this booking once one action has
// been taken on it — whole-branch review finding (Important, confirmed):
// without this, the sibling token (e.g. "suggest another time" after
// "approve" was already clicked) stays valid and can send the practice a
// contradictory email, or re-overwrite a confirmed_date/time that was
// since set a different way (e.g. via the CRM's reschedule flow).
async function invalidateOtherTokens(bookingId, excludeToken) {
  await db.query(
    `UPDATE office_visit_tokens SET used_at = NOW()
     WHERE booking_id = $1 AND token != $2 AND used_at IS NULL`,
    [bookingId, excludeToken]
  )
}

module.exports = { createToken, peekToken, consumeToken, invalidateOtherTokens }
