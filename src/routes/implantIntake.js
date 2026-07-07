const express = require('express')
const cors = require('cors')
const { sendEmail } = require('../services/email')
const rateLimiter = require('../middleware/rateLimiter')

const router = express.Router()

// Public, browser-facing route — same reasoning as webLeads.js: mounted in
// app.js before the global CORS/body-parser middleware, so both are
// self-contained here too rather than relying on the CRM-frontend-only
// policy (which would otherwise eat every preflight for this path first).
router.use(cors())
router.use(express.json({ limit: '512kb' }))

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
}

function intakeEmail({ doctor, patientRef, contact, date, sections }) {
  const sectionsHtml = sections
    .map((section) => {
      const rows = section.questions
        .map(
          (item) => `
          <tr>
            <td style="padding:8px 12px;border-bottom:1px solid #f3f4f6;color:#6b7280;width:45%">${escapeHtml(item.q)}</td>
            <td style="padding:8px 12px;border-bottom:1px solid #f3f4f6;font-weight:600">${
              item.answer ? escapeHtml(item.answer) : '<span style="color:#d97706">— not answered —</span>'
            }</td>
          </tr>`
        )
        .join('')

      return `
        <div style="margin-bottom:20px">
          <h3 style="font-size:14px;color:#111;margin:0 0 8px;padding-bottom:6px;border-bottom:2px solid #06babe">${escapeHtml(section.title)}</h3>
          <table style="width:100%;border-collapse:collapse;font-size:13px">${rows}</table>
          ${section.notes ? `<p style="font-size:13px;color:#374151;margin:8px 0 0;padding:8px 12px;background:#f9fafb;border-radius:6px"><strong>Notes:</strong> ${escapeHtml(section.notes)}</p>` : ''}
        </div>`
    })
    .join('')

  return `
    <!DOCTYPE html>
    <html><body style="margin:0;padding:0;background:#f9fafb;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif">
    <div style="max-width:680px;margin:40px auto;background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,.1)">
      <div style="background:#06babe;padding:20px 32px">
        <span style="color:#fff;font-weight:700;font-size:16px">Implant Case Intake Submission</span>
      </div>
      <div style="padding:24px 32px 8px">
        <table style="width:100%;border-collapse:collapse;font-size:14px;margin-bottom:8px">
          <tr>
            <td style="padding:6px 12px 6px 0;color:#6b7280;font-weight:600">Doctor/Practice</td>
            <td style="padding:6px 0">${escapeHtml(doctor)}</td>
            <td style="padding:6px 12px 6px 0;color:#6b7280;font-weight:600">Patient/Case #</td>
            <td style="padding:6px 0">${escapeHtml(patientRef)}</td>
          </tr>
          <tr>
            <td style="padding:6px 12px 6px 0;color:#6b7280;font-weight:600">Contact</td>
            <td style="padding:6px 0">${contact ? escapeHtml(contact) : '—'}</td>
            <td style="padding:6px 12px 6px 0;color:#6b7280;font-weight:600">Date</td>
            <td style="padding:6px 0">${date ? escapeHtml(date) : '—'}</td>
          </tr>
        </table>
      </div>
      <div style="padding:8px 32px 24px">${sectionsHtml}</div>
      <div style="background:#f9fafb;padding:16px 32px;font-size:12px;color:#9ca3af">
        AIM Dental Laboratory website — Implant Case Intake Protocol
      </div>
    </div>
    </body></html>
  `
}

// POST /api/implant-intake — the "Submit Case to AIM" action on the Implant
// Case Intake Protocol page. Emails the completed questionnaire to the lab;
// it accompanies a case (physical pickup or digital scan submission), it
// isn't itself the mechanism for sending the case's actual scans/impressions.
router.post(
  '/',
  rateLimiter({ windowMs: 10 * 60 * 1000, max: 8 }),
  async (req, res, next) => {
    try {
      const { doctor, patientRef, contact, date, sections, company } = req.body

      // Honeypot — pretend success so bots don't learn their submission was rejected.
      if (company) {
        return res.json({ success: true })
      }

      if (!doctor?.trim()) return res.status(400).json({ error: 'Doctor/Practice name is required' })
      if (!patientRef?.trim()) return res.status(400).json({ error: 'Patient name or case # is required' })
      if (!Array.isArray(sections) || sections.length === 0) {
        return res.status(400).json({ error: 'sections are required' })
      }

      await sendEmail({
        to: process.env.IMPLANT_INTAKE_EMAIL || 'digital@aimdentallab.com',
        subject: `Implant Case Intake — ${doctor.trim()} / ${patientRef.trim()}`,
        html: intakeEmail({ doctor: doctor.trim(), patientRef: patientRef.trim(), contact, date, sections }),
      })

      res.json({ success: true })
    } catch (err) {
      next(err)
    }
  }
)

module.exports = router
