const crypto = require('crypto')
const db = require('../config/db')
const { sendEmail } = require('./email')

const CODE_TTL_MS = 10 * 60 * 1000 // 10 minutes to enter the code
const TOKEN_TTL_MS = 30 * 60 * 1000 // 30 minutes to actually finish submitting after verifying
const MAX_ATTEMPTS = 5

// In-memory, same tradeoff as middleware/rateLimiter.js — fine for this
// backend's single-instance Render deployment. A pending code is lost on
// restart/redeploy, which just means the doctor requests a new one; nothing
// durable depends on this surviving.
const pendingCodes = new Map() // normalized email -> { code, expiresAt, attempts }

function normalizeEmail(email) {
  return (email || '').trim().toLowerCase()
}

// A "known" email (already a lead or client) skips verification entirely —
// only genuinely first-time submitters get the code-entry gate.
async function isKnownEmail(email) {
  const e = normalizeEmail(email)
  if (!e) return false
  const { rows } = await db.query(
    `SELECT 1 FROM leads WHERE LOWER(email) = $1
     UNION
     SELECT 1 FROM clients WHERE LOWER(email) = $1
     LIMIT 1`,
    [e]
  )
  return rows.length > 0
}

function generateCode() {
  return String(crypto.randomInt(0, 1000000)).padStart(6, '0')
}

function verificationEmail(code) {
  return `
    <!DOCTYPE html>
    <html><body style="margin:0;padding:0;background:#f9fafb;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif">
    <div style="max-width:480px;margin:40px auto;background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,.1)">
      <div style="background:#06babe;padding:20px 32px">
        <span style="color:#fff;font-weight:700;font-size:16px">AIM Dental Laboratory</span>
      </div>
      <div style="padding:32px;text-align:center">
        <p style="color:#374151;font-size:14px;margin:0 0 16px">Your verification code is:</p>
        <p style="font-size:32px;font-weight:700;letter-spacing:8px;color:#111;margin:0 0 16px">${code}</p>
        <p style="color:#6b7280;font-size:13px;margin:0">This code expires in 10 minutes. If you didn&rsquo;t request this, you can ignore this email.</p>
      </div>
    </div>
    </body></html>
  `
}

// Called when a doctor first enters their email in a gated form. Returns
// { required: false } immediately for a known email (nothing sent); for an
// unrecognized one, generates+stores a code, emails it, and returns
// { required: true } so the frontend can show the code-entry step.
async function requestVerification(email) {
  const e = normalizeEmail(email)
  if (!e) {
    const err = new Error('email is required')
    err.status = 400
    throw err
  }

  if (await isKnownEmail(e)) {
    return { required: false }
  }

  const code = generateCode()
  pendingCodes.set(e, { code, expiresAt: Date.now() + CODE_TTL_MS, attempts: 0 })

  await sendEmail({
    to: email,
    subject: 'Your AIM Dental Laboratory verification code',
    html: verificationEmail(code),
  })
  return { required: true }
}

// Signed, short-lived token proving this email passed code verification —
// same HMAC-token-instead-of-a-session pattern as routes/intake.js's
// pickupActionToken, since there's no login system for public form
// submitters. The submission endpoints (webLeads.js, scanSubmission.js)
// check this token server-side rather than trusting a client-side flag.
function issueToken(email) {
  const e = normalizeEmail(email)
  const expiresAt = Date.now() + TOKEN_TTL_MS
  const payload = `${e}:${expiresAt}`
  const sig = crypto
    .createHmac('sha256', process.env.EMAIL_VERIFICATION_SECRET || '')
    .update(payload)
    .digest('hex')
    .slice(0, 32)
  return Buffer.from(`${payload}:${sig}`).toString('base64url')
}

function confirmVerification(email, code) {
  const e = normalizeEmail(email)
  const entry = pendingCodes.get(e)
  if (!entry) {
    return { success: false, error: 'No verification code was requested for this email, or it already expired. Please request a new one.' }
  }
  if (Date.now() > entry.expiresAt) {
    pendingCodes.delete(e)
    return { success: false, error: 'This code has expired. Please request a new one.' }
  }
  entry.attempts += 1
  if (entry.attempts > MAX_ATTEMPTS) {
    pendingCodes.delete(e)
    return { success: false, error: 'Too many incorrect attempts. Please request a new code.' }
  }
  if (entry.code !== String(code || '').trim()) {
    return { success: false, error: 'That code is incorrect. Please try again.' }
  }

  pendingCodes.delete(e)
  return { success: true, token: issueToken(e) }
}

// Checked server-side by the actual submission endpoints. Returns false on
// any malformed/expired/mismatched token rather than throwing, since a
// missing token for an already-known email is the normal, expected case.
function verifyToken(email, token) {
  const e = normalizeEmail(email)
  if (!token) return false

  let decoded
  try {
    decoded = Buffer.from(token, 'base64url').toString('utf8')
  } catch {
    return false
  }
  const parts = decoded.split(':')
  if (parts.length !== 3) return false
  const [tokenEmail, expiresAtStr, sig] = parts
  if (tokenEmail !== e) return false

  const expiresAt = Number(expiresAtStr)
  if (!expiresAt || Date.now() > expiresAt) return false

  const expected = crypto
    .createHmac('sha256', process.env.EMAIL_VERIFICATION_SECRET || '')
    .update(`${tokenEmail}:${expiresAtStr}`)
    .digest('hex')
    .slice(0, 32)

  const a = Buffer.from(sig)
  const b = Buffer.from(expected)
  return a.length === b.length && crypto.timingSafeEqual(a, b)
}

module.exports = { isKnownEmail, requestVerification, confirmVerification, verifyToken }
