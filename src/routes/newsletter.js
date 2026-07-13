const express = require('express')
const cors = require('cors')
const db = require('../config/db')
const { sendEmail } = require('../services/email')
const { upsertSubscriberRow } = require('../services/sheets')
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

      // Brevo sync is best-effort and runs regardless of alreadySubscribed —
      // Brevo's own upsert (updateEnabled: true) is a harmless no-op if the
      // contact is already there, and this self-heals anyone who was only
      // ever captured in the table before this sync existed. Brevo is the
      // system of record for actual subscribe/unsubscribe state (compliant
      // unsubscribe links once newsletters are sent through its campaign
      // tool) — this table stays as a redundant record, not the source of truth.
      if (process.env.BREVO_API_KEY && process.env.BREVO_LIST_ID) {
        try {
          await fetch('https://api.brevo.com/v3/contacts', {
            method: 'POST',
            headers: {
              'api-key': process.env.BREVO_API_KEY,
              'content-type': 'application/json',
            },
            body: JSON.stringify({
              email: normalizedEmail,
              listIds: [Number(process.env.BREVO_LIST_ID)],
              updateEnabled: true,
              attributes: { SOURCE: source || 'website' },
            }),
          })
        } catch (brevoErr) {
          console.error('newsletter: Brevo sync failed', brevoErr)
        }
      }

      // Sheet sync is also best-effort — same reasoning as the Brevo sync
      // above, and skips silently (see upsertSubscriberRow) if the sheet
      // isn't configured yet.
      try {
        await upsertSubscriberRow({ email: normalizedEmail, status: 'Subscribed', source })
      } catch (sheetErr) {
        console.error('newsletter: sheet sync failed', sheetErr)
      }

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

// POST /api/newsletter/webhook — called by Brevo (Contacts -> Automation ->
// Webhooks, "Contact unsubscribed" event) once newsletters are actually sent
// through Brevo's campaign tool. Protected by a shared-secret query param
// since Brevo doesn't sign these payloads — set the webhook URL in Brevo's
// dashboard to include ?token=<BREVO_WEBHOOK_SECRET>.
//
// Brevo's exact payload field names (email/event) are per their marketing
// webhook docs as of this writing — worth double-checking against a real
// test payload (logged below) the first time this is configured, since
// Brevo doesn't version this shape.
router.post('/webhook', async (req, res) => {
  if (!process.env.BREVO_WEBHOOK_SECRET || req.query.token !== process.env.BREVO_WEBHOOK_SECRET) {
    return res.status(401).json({ error: 'unauthorized' })
  }

  console.log('newsletter webhook payload:', JSON.stringify(req.body))

  const { email, event } = req.body || {}
  if (email && event === 'unsubscribe') {
    try {
      await upsertSubscriberRow({ email: String(email).toLowerCase(), status: 'Unsubscribed' })
    } catch (sheetErr) {
      console.error('newsletter webhook: sheet update failed', sheetErr)
    }
  }

  res.json({ success: true })
})

module.exports = router
