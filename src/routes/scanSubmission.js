const express = require('express')
const cors = require('cors')
const multer = require('multer')
const path = require('path')
const db = require('../config/db')
const { scoreFromLead } = require('../services/scoring')
const { sendEmail } = require('../services/email')
const rateLimiter = require('../middleware/rateLimiter')

const router = express.Router()

// Public, browser-facing route — same reasoning as webLeads.js/
// implantIntake.js: mounted in app.js before the global CORS policy, so
// it's self-contained here too. No express.json() here (unlike those two)
// since this route only ever receives multipart/form-data, parsed by
// multer below, not JSON.
router.use(cors())

const MAX_FILE_BYTES = 15 * 1024 * 1024 // 15MB per file
const MAX_FILES = 4
// Resend's total email size cap (body + attachments) is ~40MB — keeping
// combined attachments well under that leaves room for the HTML body and
// MIME overhead.
const MAX_TOTAL_BYTES = 30 * 1024 * 1024
const ALLOWED_EXTENSIONS = ['.stl', '.ply', '.obj', '.dcm']

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_FILE_BYTES, files: MAX_FILES },
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase()
    if (!ALLOWED_EXTENSIONS.includes(ext)) {
      return cb(new Error(`Unsupported file type "${ext || file.originalname}". Accepted formats: ${ALLOWED_EXTENSIONS.join(', ').toUpperCase()}`))
    }
    cb(null, true)
  },
})

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
}

function scanSubmissionEmail({ name, practice, email, phone, details, fileNames }) {
  const rows = [
    ['Doctor', name],
    ['Practice', practice || '—'],
    ['Email', email],
    ['Phone', phone || '—'],
    details && ['Case details', details],
    ['Attached files', fileNames.length ? fileNames.join(', ') : 'None — sent separately'],
  ].filter(Boolean)

  const rowsHtml = rows
    .map(
      ([label, value]) => `
      <tr>
        <td style="padding:8px 12px;border-bottom:1px solid #f3f4f6;color:#6b7280;font-weight:600;white-space:nowrap;vertical-align:top">${escapeHtml(label)}</td>
        <td style="padding:8px 12px;border-bottom:1px solid #f3f4f6;white-space:pre-line">${escapeHtml(String(value))}</td>
      </tr>`
    )
    .join('')

  return `
    <!DOCTYPE html>
    <html><body style="margin:0;padding:0;background:#f9fafb;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif">
    <div style="max-width:600px;margin:40px auto;background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,.1)">
      <div style="background:#06babe;padding:20px 32px">
        <span style="color:#fff;font-weight:700;font-size:16px">New scanned case submission</span>
      </div>
      <div style="padding:32px">
        <table style="width:100%;border-collapse:collapse;font-size:14px">${rowsHtml}</table>
      </div>
      <div style="background:#f9fafb;padding:16px 32px;font-size:12px;color:#9ca3af">
        AIM Dental Laboratory website — aimdentallab.com
      </div>
    </div>
    </body></html>
  `
}

// POST /api/scan-submission — public endpoint for the "Submit a Scanned
// Case" page. Kept separate from web-leads (which takes a JSON body) since
// this needs multipart parsing for file attachments.
router.post(
  '/',
  rateLimiter({ windowMs: 10 * 60 * 1000, max: 8 }),
  (req, res, next) => {
    upload.array('files', MAX_FILES)(req, res, (err) => {
      if (err instanceof multer.MulterError) {
        if (err.code === 'LIMIT_FILE_SIZE') {
          return res.status(413).json({ error: `Each file must be under ${MAX_FILE_BYTES / (1024 * 1024)}MB.` })
        }
        if (err.code === 'LIMIT_FILE_COUNT') {
          return res.status(400).json({ error: `You can attach up to ${MAX_FILES} files.` })
        }
        return res.status(400).json({ error: err.message })
      }
      if (err) return res.status(400).json({ error: err.message })
      next()
    })
  },
  async (req, res, next) => {
    try {
      const { name, practice, email, phone, details, company } = req.body

      // Honeypot: real visitors never see or fill this field. Pretend
      // success so bots don't learn their submission was rejected.
      if (company) {
        return res.json({ success: true })
      }

      if (!name?.trim()) return res.status(400).json({ error: 'name is required' })
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email || '')) {
        return res.status(400).json({ error: 'a valid email is required' })
      }

      const files = req.files || []
      const totalBytes = files.reduce((sum, f) => sum + f.size, 0)
      if (totalBytes > MAX_TOTAL_BYTES) {
        return res.status(413).json({ error: `Total attachment size must be under ${MAX_TOTAL_BYTES / (1024 * 1024)}MB combined.` })
      }

      const notes = [details || '', files.length ? `Attached files: ${files.map((f) => f.originalname).join(', ')}` : '']
        .filter(Boolean)
        .join('\n\n')

      const leadData = {
        doctor_name: name.trim(),
        lead_source: 'Website Form Submission',
        estimated_value: 0,
        intent_level: 'Medium',
        case_interest: 'Scanned Case Submission',
      }
      const aiScore = scoreFromLead(leadData)

      const { rows } = await db.query(
        `INSERT INTO leads
          (doctor_name, clinic_name, brand, phone, email, lead_source, referral_source,
           case_interest, notes, status, intent_level, ai_score, created_via, created_at, updated_at, last_contacted_at)
         VALUES ($1,$2,'Aim Dental',$3,$4,'Website Form Submission','contact','Scanned Case Submission',$5,'Lead','Medium',$6,'scan-submission-api',NOW(),NOW(),NOW())
         RETURNING id`,
        [name.trim(), practice || '', phone || '', email, notes, aiScore]
      )

      // Email (with attachments) is best-effort — a lead that's saved but
      // doesn't trigger an email is still recoverable from the CRM; failing
      // the whole request over a flaky send would lose the submission
      // (and the doctor's uploaded files) entirely.
      // CC list mirrors the pickup scheduler's internal notification
      // (webLeads.js) minus customer@/shipping@khdentallab.com, which don't
      // apply to a digital scan submission.
      const cc = process.env.SCAN_SUBMISSION_CC
        ? process.env.SCAN_SUBMISSION_CC.split(',').map((s) => s.trim()).filter(Boolean)
        : ['media@aimdentallab.com', 'execassistant@aimdentallab.com', 'ben@aimdentallab.com']

      try {
        await sendEmail({
          to: process.env.SCAN_SUBMISSION_EMAIL || 'digital@aimdentallab.com',
          cc,
          subject: `New scanned case — ${name.trim()}`,
          html: scanSubmissionEmail({
            name: name.trim(), practice, email, phone, details,
            fileNames: files.map((f) => f.originalname),
          }),
          attachments: files.map((f) => ({ filename: f.originalname, content: f.buffer })),
        })
      } catch (emailErr) {
        console.error('scan-submission: email notification failed', emailErr)
      }

      res.json({ success: true, id: rows[0].id })
    } catch (err) {
      next(err)
    }
  }
)

module.exports = router
