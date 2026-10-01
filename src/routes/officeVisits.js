const express = require('express')
const cors = require('cors')
const db = require('../config/db')
const rateLimiter = require('../middleware/rateLimiter')
const { matchRepByState } = require('../services/repTerritories')
const { createToken, peekToken, consumeToken } = require('../services/officeVisitTokens')
const {
  repNotificationEmail, repSuggestTimeConfirmPage, repApproveConfirmPage,
  practiceConfirmationEmail, practicePendingEmail,
} = require('../services/officeVisitEmails')
const { OFFICE_VISIT_CATEGORIES } = require('../constants/officeVisitCategories')
const { sendEmail } = require('../services/email')

const router = express.Router()
const BACKEND_URL = process.env.RENDER_EXTERNAL_URL || 'https://aim-crm-backend.onrender.com'
const VALID_BRANDS = ['Aim Dental', 'Kings Highway']
const FALLBACK_EMAIL = 'media@aimdentallab.com'

// Public, self-contained CORS — same pattern as webLeads.js/implantIntake.js.
// Mounted in app.js BEFORE the global cors() policy; own cors()+json() here
// so it isn't restricted to the CRM frontend's origin.
router.use(cors())
router.use(express.json({ limit: '256kb' }))

const HTML_ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }
function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => HTML_ESCAPES[c])
}

function resultPage(title, message) {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title></head>
  <body style="margin:0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#f7faf9;padding:60px 20px;text-align:center">
    <div style="max-width:420px;margin:0 auto;background:#fff;border-radius:16px;padding:36px 30px;box-shadow:0 4px 20px rgba(0,0,0,.06)">
      <h1 style="margin:0 0 10px;font-size:19px;color:#10353f">${escapeHtml(title)}</h1>
      <p style="margin:0;font-size:14px;color:#5b7a86;line-height:1.5">${escapeHtml(message)}</p>
    </div>
  </body></html>`
}

// POST /api/office-visits/request — public. A dental practice's website
// form submits here. Matches a rep by state (repTerritories.js); no match
// falls back to media@aimdentallab.com rather than silently dropping the
// request. Creates both action tokens up front so the notification email
// can link to both "Approve" and "Suggest another time" right away.
router.post('/request', rateLimiter({ windowMs: 60 * 1000, max: 10 }), async (req, res) => {
  try {
    const { practice_name, contact_name, contact_role, address_line1, address_line2, city, state, zip,
      email, phone, message, service_interests, requested_date, requested_time, brand } = req.body

    if (!contact_name || !phone || !email || !requested_date || !requested_time) {
      return res.status(400).json({ error: 'contact_name, phone, email, requested_date, and requested_time are required' })
    }

    const interests = Array.isArray(service_interests)
      ? service_interests.filter((s) => OFFICE_VISIT_CATEGORIES.includes(s))
      : []
    const resolvedBrand = VALID_BRANDS.includes(brand) ? brand : 'Aim Dental'

    const { rows } = await db.query(
      `INSERT INTO office_visit_bookings
         (source, practice_name, contact_name, contact_role, address_line1, address_line2, city, state, zip,
          email, phone, message, service_interests, requested_date, requested_time, status, brand)
       VALUES ('public_form',$1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,'pending',$15)
       RETURNING *`,
      [practice_name || null, contact_name, contact_role || null, address_line1 || null, address_line2 || null,
        city || null, state || null, zip || null, email, phone, message || null, interests,
        requested_date, requested_time, resolvedBrand]
    )
    const booking = rows[0]

    const rep = await matchRepByState(state)
    if (rep) {
      await db.query(`UPDATE office_visit_bookings SET assigned_rep_id = $1 WHERE id = $2`, [rep.id, booking.id])
      booking.assigned_rep_id = rep.id
    }

    const approveToken = await createToken({ bookingId: booking.id, action: 'approve' })
    const suggestToken = await createToken({ bookingId: booking.id, action: 'suggest_time' })
    const approveUrl = `${BACKEND_URL}/api/office-visits/confirm?token=${approveToken}`
    const suggestTimeConfirmUrl = `${BACKEND_URL}/api/office-visits/confirm?token=${suggestToken}`

    const { subject, html } = repNotificationEmail({ booking, approveUrl, suggestTimeConfirmUrl })
    await sendEmail({ to: [rep ? rep.email : FALLBACK_EMAIL], subject, html })

    return res.status(201).json({ id: booking.id })
  } catch (err) {
    console.error('[office-visits] POST /request failed:', err)
    return res.status(500).json({ error: 'Something went wrong submitting your request. Please try again.' })
  }
})

// GET /api/office-visits/confirm?token=... — public, read-only. Shows a
// confirmation page; does NOT change any state or consume the token. Email
// providers/clients routinely pre-fetch links to scan them for safety — if
// this GET performed the real action, that automated pre-fetch would
// silently burn the single-use token (and confirm/suggest-time the
// booking) before the rep ever clicked anything. Mirrors
// reportApproval.js's peekApprovalToken / routes/reports.js's GET /approve
// precedent exactly.
router.get('/confirm', rateLimiter({ windowMs: 10 * 60 * 1000, max: 30 }), async (req, res) => {
  try {
    const { token } = req.query
    if (!token) return res.status(400).send(resultPage('Missing link', 'This link is missing its token.'))

    const claim = await peekToken(token)
    if (!claim) return res.status(410).send(resultPage('Link expired or already used', 'This link has already been used, or is more than 7 days old.'))

    const { rows } = await db.query(`SELECT * FROM office_visit_bookings WHERE id = $1`, [claim.booking_id])
    const booking = rows[0]
    if (!booking) return res.status(404).send(resultPage('Not found', 'This booking no longer exists.'))

    const page = claim.action === 'approve'
      ? repApproveConfirmPage({ booking, confirmUrl: token })
      : repSuggestTimeConfirmPage({ booking, confirmUrl: token })
    return res.send(page)
  } catch (err) {
    console.error('[office-visits] GET /confirm failed:', err)
    return res.status(500).send(resultPage('Something went wrong', err.message || ''))
  }
})

// POST /api/office-visits/confirm — public, the only route that actually
// changes state. Reached solely by a real submit of the confirmation
// page's <form> above (never a bare link a scanner would pre-fetch).
router.post('/confirm', rateLimiter({ windowMs: 10 * 60 * 1000, max: 30 }), async (req, res) => {
  try {
    const { token } = req.body
    if (!token) return res.status(400).send(resultPage('Missing link', 'This link is missing its token.'))

    const claim = await consumeToken(token)
    if (!claim) return res.status(410).send(resultPage('Link expired or already used', 'This link has already been used, or is more than 7 days old.'))

    const { rows } = await db.query(`SELECT * FROM office_visit_bookings WHERE id = $1`, [claim.booking_id])
    const booking = rows[0]
    if (!booking) return res.status(404).send(resultPage('Not found', 'This booking no longer exists.'))

    const rep = booking.assigned_rep_id
      ? (await db.query(`SELECT name, email FROM users WHERE id = $1`, [booking.assigned_rep_id])).rows[0]
      : { name: 'Your AIM Dental rep', email: FALLBACK_EMAIL }

    if (claim.action === 'approve') {
      await db.query(
        `UPDATE office_visit_bookings SET status='approved', confirmed_date=requested_date, confirmed_time=requested_time, updated_at=NOW() WHERE id=$1`,
        [booking.id]
      )
      const updated = { ...booking, confirmed_date: booking.requested_date, confirmed_time: booking.requested_time }
      if (booking.email) {
        const { subject, html } = practiceConfirmationEmail({ booking: updated, rep })
        await sendEmail({ to: [booking.email], subject, html })
      }
      return res.send(resultPage('Approved!', 'The office visit has been confirmed and the practice has been emailed.'))
    }

    // suggest_time
    await db.query(`UPDATE office_visit_bookings SET status='time_suggested', updated_at=NOW() WHERE id=$1`, [booking.id])
    if (booking.email) {
      const { subject, html } = practicePendingEmail({ booking, rep })
      await sendEmail({ to: [booking.email], subject, html, headers: { 'In-Reply-To': `<office-visit-${booking.id}@aimdentallab.com>`, References: `<office-visit-${booking.id}@aimdentallab.com>` } })
    }
    return res.send(resultPage('Marked pending', 'The practice has been told you will reach out directly.'))
  } catch (err) {
    console.error('[office-visits] POST /confirm failed:', err)
    return res.status(500).send(resultPage('Something went wrong', err.message || ''))
  }
})

module.exports = router
