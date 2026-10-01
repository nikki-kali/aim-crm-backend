const express = require('express')
const db = require('../config/db')
const auth = require('../middleware/auth')
const { createToken } = require('../services/officeVisitTokens')
const { practiceConfirmationEmail, toDateStr } = require('../services/officeVisitEmails')
const { OFFICE_VISIT_CATEGORIES } = require('../constants/officeVisitCategories')
const { sendEmail } = require('../services/email')

const router = express.Router()
router.use(auth)

// Express's res.json() serializes a `date` column's JS Date object via
// .toISOString() (always UTC), which can shift the displayed date by one
// day whenever this server runs in a non-UTC timezone — same root cause
// as the email-formatting bug (see officeVisitEmails.js's toDateStr).
// Normalizing to a plain "YYYY-MM-DD" string here means the Frontend's
// own date formatting always receives a clean, timezone-safe value.
function normalizeBookingDates(row) {
  return { ...row, requested_date: toDateStr(row.requested_date), confirmed_date: toDateStr(row.confirmed_date) }
}

// GET / — list all bookings for the Office Visits tab. pending bookings
// include their approve_token/suggest_time_token so the Frontend's inline
// Approve/Suggest-time buttons can call the SAME public POST
// /api/office-visits/confirm endpoint the email links use, rather than
// duplicating that logic behind auth.
router.get('/', async (req, res) => {
  try {
    const { rows } = await db.query(
      `SELECT ovb.*, u.name AS assigned_rep_name
       FROM office_visit_bookings ovb
       LEFT JOIN users u ON u.id = ovb.assigned_rep_id
       ORDER BY ovb.created_at DESC`
    )
    const pendingIds = rows.filter((r) => r.status === 'pending').map((r) => r.id)
    let tokensByBooking = {}
    if (pendingIds.length > 0) {
      const { rows: tokenRows } = await db.query(
        `SELECT booking_id, token, action FROM office_visit_tokens
         WHERE booking_id = ANY($1::uuid[]) AND used_at IS NULL AND expires_at > NOW()`,
        [pendingIds]
      )
      tokensByBooking = tokenRows.reduce((acc, t) => {
        acc[t.booking_id] = acc[t.booking_id] || {}
        acc[t.booking_id][t.action === 'approve' ? 'approve_token' : 'suggest_time_token'] = t.token
        return acc
      }, {})
    }
    const withTokens = rows.map((r) => normalizeBookingDates({ ...r, ...(tokensByBooking[r.id] || {}) }))
    return res.json(withTokens)
  } catch (err) {
    console.error('[office-visits-admin] GET / failed:', err)
    return res.status(500).json({ error: 'Failed to load office visits' })
  }
})

// POST / — Way 2: a rep schedules an office visit directly. Approved
// immediately (no approval step needed, the rep IS the approval).
// Confirmation email fires only if an email was provided.
router.post('/', async (req, res) => {
  try {
    const { practice_name, contact_name, contact_role, address_line1, address_line2, city, state, zip,
      email, phone, message, service_interests, requested_date, requested_time } = req.body

    if (!contact_name || !phone || !requested_date || !requested_time) {
      return res.status(400).json({ error: 'contact_name, phone, requested_date, and requested_time are required' })
    }
    const interests = Array.isArray(service_interests)
      ? service_interests.filter((s) => OFFICE_VISIT_CATEGORIES.includes(s))
      : []

    const { rows } = await db.query(
      `INSERT INTO office_visit_bookings
         (source, practice_name, contact_name, contact_role, address_line1, address_line2, city, state, zip,
          email, phone, message, service_interests, requested_date, requested_time, confirmed_date, confirmed_time,
          status, assigned_rep_id)
       VALUES ('rep_scheduled',$1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$13,$14,'approved',$15)
       RETURNING *`,
      [practice_name || null, contact_name, contact_role || null, address_line1 || null, address_line2 || null,
        city || null, state || null, zip || null, email || null, phone, message || null, interests,
        requested_date, requested_time, req.user.id]
    )
    const booking = rows[0]

    if (booking.email) {
      const { rows: repRows } = await db.query(`SELECT name, email FROM users WHERE id = $1`, [req.user.id])
      const { subject, html } = practiceConfirmationEmail({ booking, rep: repRows[0] })
      await sendEmail({ to: [booking.email], subject, html })
    }

    return res.status(201).json(normalizeBookingDates(booking))
  } catch (err) {
    console.error('[office-visits-admin] POST / failed:', err)
    return res.status(500).json({ error: 'Failed to create office visit' })
  }
})

// PUT /:id/reschedule — the CRM-only action after "suggest another time":
// the rep has already called the practice and agreed a real time, so this
// sets it directly (not an email-link action — see spec).
router.put('/:id/reschedule', async (req, res) => {
  try {
    const { confirmed_date, confirmed_time } = req.body
    if (!confirmed_date || !confirmed_time) {
      return res.status(400).json({ error: 'confirmed_date and confirmed_time are required' })
    }
    const { rows } = await db.query(
      `UPDATE office_visit_bookings SET status='approved', confirmed_date=$1, confirmed_time=$2, updated_at=NOW()
       WHERE id = $3 RETURNING *`,
      [confirmed_date, confirmed_time, req.params.id]
    )
    const booking = rows[0]
    if (!booking) return res.status(404).json({ error: 'Booking not found' })

    if (booking.email) {
      const { rows: repRows } = await db.query(`SELECT name, email FROM users WHERE id = $1`, [booking.assigned_rep_id])
      const rep = repRows[0] || { name: 'Your AIM Dental rep', email: null }
      const { subject, html } = practiceConfirmationEmail({ booking, rep })
      await sendEmail({ to: [booking.email], subject, html })
    }
    return res.json(normalizeBookingDates(booking))
  } catch (err) {
    console.error('[office-visits-admin] PUT /:id/reschedule failed:', err)
    return res.status(500).json({ error: 'Failed to reschedule' })
  }
})

module.exports = router
