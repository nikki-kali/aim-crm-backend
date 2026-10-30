const express = require('express')
const cors = require('cors')
const multer = require('multer')
const path = require('path')
const { sendEmail } = require('../services/email')
const rateLimiter = require('../middleware/rateLimiter')

const router = express.Router()

// Public "Apply now" form on the website's careers page (the hiring poster's
// QR code points there). Applicants are not leads, so nothing is written to
// the database: the application is emailed to the hiring contact with the
// resume attached (to Stephen Murphy, Lab Director, cc the executive
// assistant, unless overridden by env), and that email is the only record. Because of that, a
// failed send is reported to the applicant instead of being swallowed
// (unlike scanSubmission.js, where the lead row is the fallback record).
// Same self-contained CORS as the other public routes, mounted before the
// global policy in app.js. Multipart only, so no express.json() here.
router.use(cors())

// Positions the form may name; anything else is rejected.
const POSITIONS = Object.freeze(['Digital Dental Technician'])

const MAX_RESUME_BYTES = 8 * 1024 * 1024
const ALLOWED_EXTENSIONS = ['.pdf', '.doc', '.docx']

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_RESUME_BYTES, files: 1 },
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase()
    if (!ALLOWED_EXTENSIONS.includes(ext)) {
      return cb(new Error('Please attach your resume as a PDF or Word document.'))
    }
    cb(null, true)
  },
})

// Collapses control characters and line breaks (except in the summary) and
// caps length, so no field can inject headers or extra lines into the email.
function clean(value, max = 200, { multiline = false } = {}) {
  let s = String(value ?? '')
  s = multiline
    ? s.replace(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u2028\u2029]/g, ' ')
    : s.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, ' ').replace(/\s+/g, ' ')
  return s.trim().slice(0, max)
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
}

// Returns { data } or { error }. Pure, so it can be tested without sending mail.
function validateApplication(body = {}) {
  const position = POSITIONS.includes(body.position) ? body.position : ''
  if (!position) return { error: 'Unknown position.' }
  const name = clean(body.name, 120)
  const email = clean(body.email, 200).toLowerCase()
  const phone = clean(body.phone, 40)
  const location = clean(body.location, 120)
  const experience = clean(body.experience, 40)
  const summary = clean(body.summary, 3000, { multiline: true })
  if (!name) return { error: 'Please enter your name.' }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return { error: 'Please enter a valid email.' }
  if (phone && !/^[0-9 ()+.\-x]{3,40}$/i.test(phone)) return { error: 'Please enter a valid phone number.' }
  if (!summary) return { error: 'Please add a short summary of your experience.' }
  return { data: { position, name, email, phone, location, experience, summary } }
}

function recipients(env = process.env) {
  const to = (env.JOB_APPLICATION_TO ?? 'stephenm@aimdentallab.com').split(',').map((s) => s.trim()).filter(Boolean)
  const cc = (env.JOB_APPLICATION_CC ?? 'execassistant@aimdentallab.com').split(',').map((s) => s.trim()).filter(Boolean)
  return { to, cc }
}

function applicationEmail(d, resumeName) {
  const rows = [
    ['Position', d.position],
    ['Name', d.name],
    ['Email', d.email],
    ['Phone', d.phone || 'Not given'],
    ['Location', d.location || 'Not given'],
    ['Years of experience', d.experience || 'Not given'],
    ['Experience summary', d.summary],
    ['Resume', resumeName || 'Not attached'],
  ]
  const rowsHtml = rows.map(([label, value]) => `
      <tr>
        <td style="padding:8px 12px;border-bottom:1px solid #eef3f4;color:#6b7280;font-weight:600;white-space:nowrap;vertical-align:top">${escapeHtml(label)}</td>
        <td style="padding:8px 12px;border-bottom:1px solid #eef3f4;white-space:pre-line">${escapeHtml(value)}</td>
      </tr>`).join('')
  return `<!DOCTYPE html>
<html><body style="margin:0;padding:0;background:#eaf6f7;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif">
<div style="max-width:600px;margin:32px auto;background:#fff;border-radius:16px;overflow:hidden;border:1px solid #d7edee">
  <div style="background:#0b2742;padding:20px 28px">
    <span style="color:#06babe;font-size:11px;font-weight:700;letter-spacing:2px;text-transform:uppercase">Careers</span><br>
    <span style="color:#fff;font-weight:700;font-size:18px">New application: ${escapeHtml(d.position)}</span>
  </div>
  <div style="padding:24px 28px">
    <table style="width:100%;border-collapse:collapse;font-size:14px;color:#3d5560">${rowsHtml}</table>
    <p style="margin:18px 0 0;font-size:13px;color:#7a8c91">Reply to this email to contact the applicant directly.</p>
  </div>
  <div style="background:#f6fbfb;padding:14px 28px;font-size:12px;color:#7a8c91">Sent from the Apply form on aimdentallab.com</div>
</div>
</body></html>`
}

// POST /api/job-applications
router.post(
  '/',
  rateLimiter({ windowMs: 10 * 60 * 1000, max: 6 }),
  (req, res, next) => {
    upload.single('resume')(req, res, (err) => {
      if (err instanceof multer.MulterError) {
        if (err.code === 'LIMIT_FILE_SIZE') return res.status(413).json({ error: `Your resume must be under ${MAX_RESUME_BYTES / (1024 * 1024)}MB.` })
        return res.status(400).json({ error: err.message })
      }
      if (err) return res.status(400).json({ error: err.message })
      next()
    })
  },
  async (req, res, next) => {
    try {
      // Honeypot: pretend success so bots learn nothing.
      if (req.body?.company) return res.json({ success: true })

      const { data, error } = validateApplication(req.body)
      if (error) return res.status(400).json({ error })
      if (!req.file) return res.status(400).json({ error: 'Please attach your resume.' })

      const { to, cc } = recipients()
      if (!to.length) {
        console.error('job-applications: JOB_APPLICATION_TO is not set; application not sent')
        return res.status(503).json({ error: 'Applications are not open online yet. Please try again later.' })
      }

      try {
        await sendEmail({
          to,
          cc,
          replyTo: data.email,
          subject: `Application: ${data.position} - ${data.name}`,
          html: applicationEmail(data, req.file.originalname),
          attachments: [{ filename: req.file.originalname, content: req.file.buffer }],
        })
      } catch (sendErr) {
        console.error('job-applications: send failed', sendErr.message)
        return res.status(502).json({ error: "We couldn't send your application. Please try again in a few minutes." })
      }

      res.json({ success: true })
    } catch (err) {
      next(err)
    }
  }
)

module.exports = router
module.exports.validateApplication = validateApplication
module.exports.recipients = recipients
module.exports.applicationEmail = applicationEmail
module.exports.POSITIONS = POSITIONS
