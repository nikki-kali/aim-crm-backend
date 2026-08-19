const express = require('express')
const cors = require('cors')
const db = require('../config/db')
const rateLimiter = require('../middleware/rateLimiter')
const { STAGES } = require('../constants/caseStages')

const router = express.Router()

// Public endpoint for the marketing website's "Track Your Case" page — own
// permissive CORS + json parser, same pattern as webLeads.js, since it's
// called from the marketing site's origin, not the CRM's. Must be mounted
// in app.js BEFORE the global cors()/express.json(), for the same reason
// documented there.
router.use(cors())
router.use(express.json({ limit: '8kb' }))

function digitsOnly(value) {
  return (value || '').replace(/\D/g, '')
}

// Case numbers are sequential (AIM-2026-001, -002, ...), not random — so a
// lookup by case number alone would let anyone enumerate other practices'
// cases by trying nearby numbers. Requiring the email or phone on file as a
// second factor, and returning the exact same generic response whether the
// case number doesn't exist OR exists but the contact doesn't match, closes
// that off: a requester learns nothing about whether a given case number is
// valid.
const NOT_FOUND_MESSAGE =
  "We couldn't find a matching case. Double-check your case number and the email or phone number on file with us."

// Stricter than web-leads' rate limit (8/10min) since this endpoint's whole
// purpose is a lookup that must not be brute-forceable — still generous
// enough for a doctor's office fumbling a typo a few times.
router.post(
  '/',
  rateLimiter({ windowMs: 10 * 60 * 1000, max: 15 }),
  async (req, res, next) => {
    try {
      const { caseNumber, contact } = req.body
      if (!caseNumber?.trim() || !contact?.trim()) {
        return res.status(400).json({ error: 'caseNumber and contact are required' })
      }

      const { rows } = await db.query(
        `SELECT case_number, status, due_date, est_completion_date, doctor_email, doctor_phone, stage_history
         FROM cases WHERE UPPER(case_number) = UPPER($1)`,
        [caseNumber.trim()]
      )
      const caseRow = rows[0]

      const contactInput = contact.trim().toLowerCase()
      const emailMatches = caseRow?.doctor_email && caseRow.doctor_email.trim().toLowerCase() === contactInput
      const phoneMatches =
        caseRow?.doctor_phone && digitsOnly(caseRow.doctor_phone).length > 0 &&
        digitsOnly(caseRow.doctor_phone) === digitsOnly(contact)

      if (!caseRow || !(emailMatches || phoneMatches)) {
        return res.status(404).json({ error: NOT_FOUND_MESSAGE })
      }

      // Only case-status fields go back to the browser — never doctor_email/
      // doctor_phone (the values used to verify the requester above), and
      // never anything from the clients/leads tables (practice contact info,
      // financials, etc.). stage_history is trimmed to stage + timestamp;
      // changed_by is an internal staff id and stays server-side.
      res.json({
        caseNumber: caseRow.case_number,
        status: caseRow.status,
        dueDate: caseRow.due_date,
        estCompletionDate: caseRow.est_completion_date,
        stages: STAGES,
        history: (caseRow.stage_history || []).map(({ stage, changed_at }) => ({ stage, changedAt: changed_at })),
      })
    } catch (err) {
      next(err)
    }
  }
)

module.exports = router
