const express = require('express')
const cors = require('cors')
const db = require('../config/db')
const { scoreFromLead } = require('../services/scoring')
const { sendEmail, pickupRequestedEmail } = require('../services/email')
const rateLimiter = require('../middleware/rateLimiter')
const { pickupActionToken } = require('./intake')

const router = express.Router()
const BACKEND_URL = process.env.RENDER_EXTERNAL_URL || 'https://aim-crm-backend.onrender.com'

// This route is called from the marketing website's browser JS, which lives
// on a different origin than FRONTEND_URL (the CRM app) — app.js's global
// CORS policy only allows the CRM's origin. Rather than loosen that policy
// for every authenticated route, scope an open CORS policy to just this one
// public, unauthenticated, rate-limited endpoint. Mounted in app.js before
// the global cors()/express.json(), so both are needed here too.
router.use(cors())
router.use(express.json({ limit: '256kb' }))

function webLeadEmail({ formType, name, practice, email, phone, caseType, message, monthlyVolume, leadId, isPickup }) {
  const rows = [
    ['Form', formType === 'scanner-program' ? 'Scanner Placement Program' : 'Contact / Start a Case'],
    ['Name', name],
    ['Practice', practice || '—'],
    ['Email', email],
    ['Phone', phone || '—'],
    caseType && ['Reason', caseType],
    monthlyVolume && ['Est. monthly volume', monthlyVolume],
    message && ['Message', message],
  ].filter(Boolean)

  const rowsHtml = rows
    .map(
      ([label, value]) => `
      <tr>
        <td style="padding:8px 12px;border-bottom:1px solid #f3f4f6;color:#6b7280;font-weight:600;white-space:nowrap">${label}</td>
        <td style="padding:8px 12px;border-bottom:1px solid #f3f4f6">${value}</td>
      </tr>`
    )
    .join('')

  // One-click stage-2/3 links — the CRM dashboard has the same "Dispatch"/
  // "Received" buttons, but isn't in regular staff use yet, so these links
  // are the actual trigger path for now. See routes/intake.js's
  // /:id/pickup-action/:stage for what they hit.
  const actionLinksHtml = isPickup
    ? `
      <div style="margin-top:24px;padding-top:20px;border-top:1px solid #f3f4f6">
        <a href="${BACKEND_URL}/api/leads/${leadId}/pickup-action/dispatched?token=${pickupActionToken(leadId, 'dispatched')}"
           style="display:inline-block;background:#06babe;color:#fff;padding:10px 18px;border-radius:8px;text-decoration:none;font-weight:600;font-size:13px;margin-right:10px">
          Mark Dispatched
        </a>
        <a href="${BACKEND_URL}/api/leads/${leadId}/pickup-action/received?token=${pickupActionToken(leadId, 'received')}"
           style="display:inline-block;background:#fff;color:#06babe;border:1.5px solid #06babe;padding:9px 18px;border-radius:8px;text-decoration:none;font-weight:600;font-size:13px">
          Mark Received
        </a>
      </div>`
    : ''

  return `
    <!DOCTYPE html>
    <html><body style="margin:0;padding:0;background:#f9fafb;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif">
    <div style="max-width:600px;margin:40px auto;background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,.1)">
      <div style="background:#06babe;padding:20px 32px">
        <span style="color:#fff;font-weight:700;font-size:16px">New website lead</span>
      </div>
      <div style="padding:32px">
        <table style="width:100%;border-collapse:collapse;font-size:14px">${rowsHtml}</table>
        ${actionLinksHtml}
      </div>
      <div style="background:#f9fafb;padding:16px 32px;font-size:12px;color:#9ca3af">
        AIM Dental Laboratory website — aimdentallab.com
      </div>
    </div>
    </body></html>
  `
}

// POST /api/web-leads — public endpoint for the marketing website's Contact
// and Scanner Program forms. No API key (it's called from browser JS, so a
// key here would just be public); relies on a honeypot field + IP rate
// limiting instead, same as most public marketing-site lead forms.
router.post(
  '/',
  rateLimiter({ windowMs: 10 * 60 * 1000, max: 8 }),
  async (req, res, next) => {
    try {
      const {
        name, practice, email, phone, caseType, message, monthlyVolume, company, topic,
        pickupAddress, pickupDate, pickupWindow, caseCount, instructions,
      } = req.body

      // Honeypot: real visitors never see or fill this field. Pretend success
      // so bots don't learn their submission was rejected.
      if (company) {
        return res.json({ success: true })
      }

      if (!name?.trim()) return res.status(400).json({ error: 'name is required' })
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email || '')) {
        return res.status(400).json({ error: 'a valid email is required' })
      }

      const formType = topic === 'Scanner Placement Program' ? 'scanner-program' : 'contact'
      const caseInterest = formType === 'scanner-program' ? 'Scanner Program' : caseType || 'General Inquiry'
      // The pickup scheduler and the plain Contact form both post here as
      // formType 'contact' (no distinct topic), so the pickup scheduler's
      // fixed caseType 'Schedule Pickup' is the only signal that tells them
      // apart — used for CC routing below and for the pickup_status/stage-1
      // confirmation email.
      const isPickup = caseType === 'Schedule Pickup'
      const notesParts = []
      if (monthlyVolume) notesParts.push(`Est. monthly volume: ${monthlyVolume}`)
      if (message) notesParts.push(message)
      const notes = notesParts.join('\n\n')

      const leadData = {
        doctor_name: name.trim(),
        lead_source: 'Website Form Submission',
        estimated_value: 0,
        intent_level: 'Medium',
        case_interest: caseInterest,
      }
      const aiScore = scoreFromLead(leadData)

      const { rows } = await db.query(
        `INSERT INTO leads
          (doctor_name, clinic_name, brand, phone, email, lead_source, referral_source,
           case_interest, notes, status, intent_level, ai_score, created_via, created_at, updated_at, last_contacted_at, pickup_status)
         VALUES ($1,$2,'Aim Dental',$3,$4,'Website Form Submission',$5,$6,$7,'Lead','Medium',$8,'web-leads-api',NOW(),NOW(),NOW(),$9)
         RETURNING id`,
        [
          name.trim(),
          practice || '',
          phone || '',
          email,
          formType,
          caseInterest,
          notes,
          aiScore,
          isPickup ? 'requested' : null,
        ]
      )

      // Contact, Scanner Program, and Pickup submissions go to different
      // inboxes — configurable independently since they've already diverged
      // (Contact routed to media@ "for now", Scanner Program stayed on the
      // original WEB_LEADS_EMAIL/digital@ default, Pickup routes to
      // digital@ with the widest CC list of the three).
      const recipient =
        formType === 'scanner-program'
          ? process.env.WEB_LEADS_EMAIL || 'digital@aimdentallab.com'
          : isPickup
            ? process.env.PICKUP_FORM_EMAIL || 'digital@aimdentallab.com'
            : process.env.CONTACT_FORM_EMAIL || 'media@aimdentallab.com'

      const cc =
        formType === 'scanner-program'
          ? undefined
          : isPickup
            ? ['customer@aimdentallab.com', 'media@aimdentallab.com', 'execassistant@aimdentallab.com', 'ben@aimdentallab.com', 'shipping@khdentallab.com']
            : ['customer@aimdentallab.com', 'digital@aimdentallab.com']

      // Email notification is best-effort — a lead that's saved but doesn't
      // trigger an email is recoverable (it's in the CRM); failing the whole
      // request over a flaky email send would lose the submission entirely.
      try {
        await sendEmail({
          to: recipient,
          cc,
          subject:
            formType === 'scanner-program'
              ? `Scanner Program request — ${name.trim()}`
              : `New website contact — ${name.trim()}`,
          html: webLeadEmail({
            formType, name: name.trim(), practice, email, phone, caseType, message, monthlyVolume,
            leadId: rows[0].id, isPickup,
          }),
        })
      } catch (emailErr) {
        console.error('web-leads: email notification failed', emailErr)
      }

      // Stage 1 of 3 — confirms receipt to the requester themselves (separate
      // from the internal notification above, and independently best-effort:
      // this failing should never affect the internal one or the saved lead).
      // Stages 2/3 (dispatched/received) fire from services/pickupStatus.js,
      // triggered either by the one-click links in the internal email above
      // or by the matching buttons in the CRM dashboard (routes/leads.js) —
      // whichever staff actually use.
      if (isPickup && email) {
        try {
          await sendEmail({
            to: email,
            subject: 'AIM Dental Laboratory — pickup request received',
            html: pickupRequestedEmail({
              doctorName: name.trim(),
              pickupAddress,
              pickupDate,
              pickupWindow,
              caseCount,
              instructions,
            }),
          })
        } catch (emailErr) {
          console.error('web-leads: requester confirmation email failed', emailErr)
        }
      }

      res.json({ success: true, id: rows[0].id })
    } catch (err) {
      next(err)
    }
  }
)

module.exports = router
