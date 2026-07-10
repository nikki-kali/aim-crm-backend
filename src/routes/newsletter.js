const express = require('express')
const cors = require('cors')
const db = require('../config/db')
const { sendEmail } = require('../services/email')
const rateLimiter = require('../middleware/rateLimiter')

const router = express.Router()

// Same pattern as webLeads.js: called from the marketing website's browser
// JS on a different origin, so it needs its own open CORS + json parsing,
// mounted in app.js before the global cors()/express.json().
router.use(cors())
router.use(express.json({ limit: '64kb' }))

// POST /api/newsletter — public endpoint for the site's newsletter popup and
// footer/blog CTA. Honeypot + IP rate limiting, no API key (same reasoning
// as web-leads: this is called from public browser JS, so a key here would
// just be public too).
router.post(
  '/',
  rateLimiter({ windowMs: 10 * 60 * 1000, max: 8 }),
  async (req, res, next) => {
    try {
      const { email, company, source } = req.body

      if (company) {
        return res.json({ success: true })
      }

      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email || '')) {
        return res.status(400).json({ error: 'a valid email is required' })
      }

      const normalizedEmail = email.trim().toLowerCase()

      const { rows } = await db.query(
        `INSERT INTO newsletter_subscribers (email, source)
         VALUES ($1, $2)
         ON CONFLICT (email) DO NOTHING
         RETURNING id`,
        [normalizedEmail, source || 'website']
      )

      const alreadySubscribed = rows.length === 0

      // Notification email is best-effort — a subscriber that's saved but
      // doesn't trigger a notification is still fully captured in the table.
      if (!alreadySubscribed) {
        try {
          await sendEmail({
            to: process.env.NEWSLETTER_NOTIFY_EMAIL || 'media@aimdentallab.com',
            subject: 'New newsletter subscriber',
            html: `<p>New subscriber: <strong>${normalizedEmail}</strong></p><p>Source: ${source || 'website'}</p>`,
          })
        } catch (emailErr) {
          console.error('newsletter: email notification failed', emailErr)
        }
      }

      res.json({ success: true, alreadySubscribed })
    } catch (err) {
      next(err)
    }
  }
)

module.exports = router
