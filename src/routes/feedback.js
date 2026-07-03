const express = require('express')
const db = require('../config/db')
const auth = require('../middleware/auth')
const requireAdmin = require('../middleware/requireAdmin')
const { sendEmail } = require('../services/email')

const router = express.Router()

const TYPES = ['bug', 'feature', 'general']
const STATUSES = ['new', 'in_progress', 'resolved']

function feedbackEmail({ type, subject, message, userName, userEmail }) {
  const typeLabel = { bug: '🐞 Bug Report', feature: '💡 Feature Request', general: '💬 General Feedback' }[type]
  return `
    <!DOCTYPE html>
    <html><body style="margin:0;padding:0;background:#f9fafb;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif">
    <div style="max-width:600px;margin:40px auto;background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,.1)">
      <div style="background:#06babe;padding:20px 32px">
        <span style="color:#fff;font-weight:700;font-size:16px">🦷 Aim Dental CRM — New Feedback</span>
      </div>
      <div style="padding:32px">
        <p style="color:#6b7280;margin:0 0 4px;font-size:12px;text-transform:uppercase;font-weight:600">${typeLabel}</p>
        <h2 style="color:#111;margin:0 0 16px">${subject}</h2>
        <p style="color:#374151;font-size:14px;line-height:1.6;white-space:pre-wrap">${message}</p>
        <p style="color:#9ca3af;font-size:12px;margin-top:24px">Submitted by ${userName} (${userEmail})</p>
      </div>
    </div>
    </body></html>
  `
}

// POST /api/feedback — submit new feedback (any authenticated user)
router.post('/', auth, async (req, res, next) => {
  try {
    const { type, subject, message } = req.body
    if (!subject?.trim() || !message?.trim()) {
      return res.status(400).json({ error: 'Subject and message are required' })
    }
    const finalType = TYPES.includes(type) ? type : 'general'

    const { rows } = await db.query(
      `INSERT INTO feedback (user_id, type, subject, message)
       VALUES ($1, $2, $3, $4) RETURNING *`,
      [req.user.id, finalType, subject.trim(), message.trim()]
    )

    sendEmail({
      subject: `New ${finalType} feedback: ${subject.trim()}`,
      html: feedbackEmail({
        type: finalType,
        subject: subject.trim(),
        message: message.trim(),
        userName: req.user.name || 'Unknown',
        userEmail: req.user.email || '',
      }),
    }).catch((err) => console.error('Failed to send feedback notification email:', err.message))

    res.status(201).json(rows[0])
  } catch (err) { next(err) }
})

// GET /api/feedback — list all feedback (admin only)
router.get('/', auth, requireAdmin, async (req, res, next) => {
  try {
    const { rows } = await db.query(
      `SELECT f.*, u.name AS user_name, u.email AS user_email
       FROM feedback f
       LEFT JOIN users u ON u.id = f.user_id
       ORDER BY f.created_at DESC`
    )
    res.json(rows)
  } catch (err) { next(err) }
})

// PUT /api/feedback/:id/status — update status (admin only)
router.put('/:id/status', auth, requireAdmin, async (req, res, next) => {
  try {
    const { status } = req.body
    if (!STATUSES.includes(status)) {
      return res.status(400).json({ error: 'Invalid status' })
    }
    const { rows } = await db.query(
      `UPDATE feedback SET status=$1, updated_at=now() WHERE id=$2 RETURNING *`,
      [status, req.params.id]
    )
    if (!rows.length) return res.status(404).json({ error: 'Not found' })
    res.json(rows[0])
  } catch (err) { next(err) }
})

module.exports = router
