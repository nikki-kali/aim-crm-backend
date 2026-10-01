const express = require('express')
const cors = require('cors')
const db = require('../config/db')
const rateLimiter = require('../middleware/rateLimiter')
const { matchRepByState } = require('../services/repTerritories')
const { createToken, peekToken, consumeToken, invalidateOtherTokens } = require('../services/officeVisitTokens')
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
// The confirm pages (repApproveConfirmPage/repSuggestTimeConfirmPage) are
// plain HTML <form method="POST"> submissions, which browsers send as
// application/x-www-form-urlencoded, not JSON — without this, POST
// /confirm's req.body was undefined for every real click from an email
// (found by whole-branch review, reproduced: every Approve/Suggest-time
// click 500'd). /request stays JSON-only (the public form's own fetch
// call sends JSON) but accepting both here is harmless.
router.use(express.urlencoded({ extended: false, limit: '256kb' }))

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

// GET /api/office-visits/book — public. The actual page behind "the
// booking link" handed to the marketing sites — /request above is JSON-only
// and has nothing a browser can load directly. One shared link for both
// reps: the form collects the practice's address and POSTs to /request,
// which auto-assigns James or William by state (repTerritories.js) — there
// is no per-rep link. ?brand= lets either marketing site pre-tag which
// brand the submission is for without the dentist seeing or choosing it;
// an unrecognized/missing value falls back to Aim Dental (the same default
// /request itself applies) rather than exposing a broken brand field.
router.get('/book', (req, res) => {
  const brand = VALID_BRANDS.includes(req.query.brand) ? req.query.brand : 'Aim Dental'
  const categoryCheckboxes = OFFICE_VISIT_CATEGORIES.map((cat) => `
        <label style="display:flex;align-items:center;gap:8px;font-size:14px;color:#10353f;padding:8px 0">
          <input type="checkbox" name="service_interests" value="${escapeHtml(cat)}" style="width:17px;height:17px">
          ${escapeHtml(cat)}
        </label>`).join('')

  return res.send(`<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Schedule an Office Visit — AIM Dental Laboratory</title></head>
<body style="margin:0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#f7faf9;padding:40px 16px">
  <div style="max-width:480px;margin:0 auto">
    <h1 style="font-size:20px;color:#10353f;margin:0 0 6px">Schedule an Office Visit</h1>
    <p style="font-size:14px;color:#5b7a86;margin:0 0 24px">Tell us a bit about your practice and a preferred time — a rep from AIM Dental Laboratory will confirm or suggest another time shortly.</p>

    <form id="ov-form" style="background:#fff;border-radius:16px;padding:24px;box-shadow:0 4px 20px rgba(0,0,0,.06)">
      <input type="hidden" name="brand" value="${escapeHtml(brand)}">

      <label style="display:block;font-size:13px;color:#10353f;font-weight:600;margin:0 0 4px">Practice name</label>
      <input type="text" name="practice_name" style="width:100%;box-sizing:border-box;padding:10px 12px;border:1px solid #d7e3e1;border-radius:8px;margin-bottom:14px;font-size:14px">

      <label style="display:block;font-size:13px;color:#10353f;font-weight:600;margin:0 0 4px">Your name *</label>
      <input type="text" name="contact_name" required style="width:100%;box-sizing:border-box;padding:10px 12px;border:1px solid #d7e3e1;border-radius:8px;margin-bottom:14px;font-size:14px">

      <label style="display:block;font-size:13px;color:#10353f;font-weight:600;margin:0 0 4px">Your role</label>
      <input type="text" name="contact_role" style="width:100%;box-sizing:border-box;padding:10px 12px;border:1px solid #d7e3e1;border-radius:8px;margin-bottom:14px;font-size:14px">

      <label style="display:block;font-size:13px;color:#10353f;font-weight:600;margin:0 0 4px">Phone *</label>
      <input type="tel" name="phone" required style="width:100%;box-sizing:border-box;padding:10px 12px;border:1px solid #d7e3e1;border-radius:8px;margin-bottom:14px;font-size:14px">

      <label style="display:block;font-size:13px;color:#10353f;font-weight:600;margin:0 0 4px">Email *</label>
      <input type="email" name="email" required style="width:100%;box-sizing:border-box;padding:10px 12px;border:1px solid #d7e3e1;border-radius:8px;margin-bottom:14px;font-size:14px">

      <label style="display:block;font-size:13px;color:#10353f;font-weight:600;margin:0 0 4px">Address</label>
      <input type="text" name="address_line1" placeholder="Street address" style="width:100%;box-sizing:border-box;padding:10px 12px;border:1px solid #d7e3e1;border-radius:8px;margin-bottom:8px;font-size:14px">
      <div style="display:flex;gap:8px;margin-bottom:14px">
        <input type="text" name="city" placeholder="City" style="flex:2;box-sizing:border-box;padding:10px 12px;border:1px solid #d7e3e1;border-radius:8px;font-size:14px">
        <input type="text" name="state" placeholder="State" maxlength="2" style="flex:1;box-sizing:border-box;padding:10px 12px;border:1px solid #d7e3e1;border-radius:8px;font-size:14px">
        <input type="text" name="zip" placeholder="Zip" style="flex:1;box-sizing:border-box;padding:10px 12px;border:1px solid #d7e3e1;border-radius:8px;font-size:14px">
      </div>

      <div style="display:flex;gap:8px;margin-bottom:14px">
        <div style="flex:1">
          <label style="display:block;font-size:13px;color:#10353f;font-weight:600;margin:0 0 4px">Preferred date *</label>
          <input type="date" name="requested_date" required style="width:100%;box-sizing:border-box;padding:10px 12px;border:1px solid #d7e3e1;border-radius:8px;font-size:14px">
        </div>
        <div style="flex:1">
          <label style="display:block;font-size:13px;color:#10353f;font-weight:600;margin:0 0 4px">Preferred time *</label>
          <input type="time" name="requested_time" required style="width:100%;box-sizing:border-box;padding:10px 12px;border:1px solid #d7e3e1;border-radius:8px;font-size:14px">
        </div>
      </div>

      <label style="display:block;font-size:13px;color:#10353f;font-weight:600;margin:0 0 4px">Interested in</label>
      <div style="margin-bottom:14px">${categoryCheckboxes}</div>

      <label style="display:block;font-size:13px;color:#10353f;font-weight:600;margin:0 0 4px">Anything else?</label>
      <textarea name="message" rows="3" style="width:100%;box-sizing:border-box;padding:10px 12px;border:1px solid #d7e3e1;border-radius:8px;margin-bottom:18px;font-size:14px;font-family:inherit"></textarea>

      <button type="submit" style="width:100%;padding:13px;background:#06babe;color:#fff;border:none;border-radius:999px;font-size:15px;font-weight:600;cursor:pointer">Request Office Visit</button>
      <p id="ov-error" style="display:none;color:#b91c1c;font-size:13px;margin:10px 0 0"></p>
    </form>
    <div id="ov-success" style="display:none;background:#fff;border-radius:16px;padding:28px;box-shadow:0 4px 20px rgba(0,0,0,.06);text-align:center">
      <h2 style="font-size:17px;color:#10353f;margin:0 0 8px">Request sent!</h2>
      <p style="font-size:14px;color:#5b7a86;margin:0">A rep from AIM Dental Laboratory will confirm your visit shortly.</p>
    </div>
  </div>

  <script>
    document.getElementById('ov-form').addEventListener('submit', async function (e) {
      e.preventDefault()
      var form = e.target
      var errorEl = document.getElementById('ov-error')
      errorEl.style.display = 'none'
      var data = new FormData(form)
      var payload = {
        practice_name: data.get('practice_name'),
        contact_name: data.get('contact_name'),
        contact_role: data.get('contact_role'),
        phone: data.get('phone'),
        email: data.get('email'),
        address_line1: data.get('address_line1'),
        city: data.get('city'),
        state: data.get('state'),
        zip: data.get('zip'),
        requested_date: data.get('requested_date'),
        requested_time: data.get('requested_time'),
        message: data.get('message'),
        brand: data.get('brand'),
        service_interests: data.getAll('service_interests'),
      }
      try {
        var res = await fetch('/api/office-visits/request', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        })
        if (!res.ok) {
          var body = await res.json().catch(function () { return {} })
          errorEl.textContent = body.error || 'Something went wrong. Please try again.'
          errorEl.style.display = 'block'
          return
        }
        form.style.display = 'none'
        document.getElementById('ov-success').style.display = 'block'
      } catch (err) {
        errorEl.textContent = 'Something went wrong. Please check your connection and try again.'
        errorEl.style.display = 'block'
      }
    })
  </script>
</body></html>`)
})

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
    const { token } = req.body || {}
    if (!token) return res.status(400).send(resultPage('Missing link', 'This link is missing its token.'))

    const claim = await consumeToken(token)
    if (!claim) return res.status(410).send(resultPage('Link expired or already used', 'This link has already been used, or is more than 7 days old.'))
    // The sibling token (the OTHER action on this same booking) must die
    // too, or a forwarded email / a later click can send the practice a
    // contradictory message, or overwrite a confirmed_date/time that was
    // since set a different way (e.g. via the CRM's reschedule flow).
    await invalidateOtherTokens(claim.booking_id, token)

    const { rows } = await db.query(`SELECT * FROM office_visit_bookings WHERE id = $1`, [claim.booking_id])
    const booking = rows[0]
    if (!booking) return res.status(404).send(resultPage('Not found', 'This booking no longer exists.'))

    const rep = booking.assigned_rep_id
      ? (await db.query(`SELECT name, email FROM users WHERE id = $1`, [booking.assigned_rep_id])).rows[0]
      : { name: 'Your AIM Dental rep', email: FALLBACK_EMAIL }

    if (claim.action === 'approve') {
      // status='pending' guard: if this booking was already handled a
      // different way since this token was issued (e.g. rescheduled in
      // the CRM after "suggest another time"), a stale Approve click must
      // not silently overwrite the real confirmed_date/time back to the
      // original request.
      const { rows: updatedRows } = await db.query(
        `UPDATE office_visit_bookings SET status='approved', confirmed_date=requested_date, confirmed_time=requested_time, updated_at=NOW()
         WHERE id=$1 AND status='pending' RETURNING *`,
        [booking.id]
      )
      if (updatedRows.length === 0) {
        return res.send(resultPage('Already handled', 'This booking was already updated another way — no changes were made.'))
      }
      const updated = updatedRows[0]
      if (updated.email) {
        try {
          const { subject, html } = practiceConfirmationEmail({ booking: updated, rep })
          await sendEmail({ to: [updated.email], subject, html })
        } catch (emailErr) {
          // The booking IS confirmed — a transporter failure must not make
          // this look like nothing happened (that invites a duplicate
          // booking on retry). Log and still report success.
          console.error('[office-visits] confirmation email failed to send (booking is still confirmed):', emailErr)
        }
      }
      return res.send(resultPage('Approved!', 'The office visit has been confirmed and the practice has been emailed.'))
    }

    // suggest_time — same status='pending' guard as approve above.
    const { rows: suggestedRows } = await db.query(
      `UPDATE office_visit_bookings SET status='time_suggested', updated_at=NOW() WHERE id=$1 AND status='pending' RETURNING *`,
      [booking.id]
    )
    if (suggestedRows.length === 0) {
      return res.send(resultPage('Already handled', 'This booking was already updated another way — no changes were made.'))
    }
    if (booking.email) {
      try {
        const { subject, html } = practicePendingEmail({ booking, rep })
        await sendEmail({ to: [booking.email], subject, html, headers: { 'In-Reply-To': `<office-visit-${booking.id}@aimdentallab.com>`, References: `<office-visit-${booking.id}@aimdentallab.com>` } })
      } catch (emailErr) {
        console.error('[office-visits] pending email failed to send (booking is still marked time_suggested):', emailErr)
      }
    }
    return res.send(resultPage('Marked pending', 'The practice has been told you will reach out directly.'))
  } catch (err) {
    console.error('[office-visits] POST /confirm failed:', err)
    return res.status(500).send(resultPage('Something went wrong', err.message || ''))
  }
})

module.exports = router
