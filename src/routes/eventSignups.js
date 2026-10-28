const express = require('express')
const cors = require('cors')
const crypto = require('crypto')
const db = require('../config/db')
const { scoreFromLead } = require('../services/scoring')
const rateLimiter = require('../middleware/rateLimiter')

const router = express.Router()

// Trade-show sign-ups (the booth QR code and the staff tablet at the booth).
// Kept separate from /api/web-leads because a booth is the opposite of a
// normal website visitor: many sign-ups arrive from one IP (Javits Wi-Fi, or
// the staff tablet), so web-leads' 8-per-10-minutes limit would start
// rejecting real doctors within minutes. Only events listed here are
// accepted; the key is what the website page posts.
const EVENTS = {
  'gnydm-2026': { label: 'GNYDM 2026', source: 'GNYDM 2026' },
}

const INTERESTS = ['Crown & Bridge', 'Implant', 'Dentures', 'Ortho', 'Digital scanning', 'Not sure yet']

function clean(value, max = 200) {
  return String(value ?? '').trim().slice(0, max)
}

// Returns { data } or { error }. Pure, so it can be tested without a database.
function validateSignup(body = {}) {
  const event = EVENTS[body.event]
  if (!event) return { error: 'Unknown event.' }
  const name = clean(body.name, 120)
  const practice = clean(body.practice, 160)
  const email = clean(body.email, 200).toLowerCase()
  const phone = clean(body.phone, 40)
  const interest = INTERESTS.includes(body.interest) ? body.interest : ''
  if (!name) return { error: 'Please enter your name.' }
  if (!practice) return { error: 'Please enter your practice name.' }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return { error: 'Please enter a valid email.' }
  return {
    data: {
      event, eventKey: body.event, name, practice, email, phone, interest,
      consent: body.consent === true,
      staffEntry: body.staff === true,
      attribution: clean(body.attribution, 300),
    },
  }
}

// Short code shown on the visitor's success screen, so booth staff can see at
// a glance that a sign-up went through before handing over a prize. Derived
// from the lead id, so the same sign-up always shows the same code.
function confirmationCode(leadId) {
  return 'AIM-' + crypto.createHash('sha256').update(String(leadId)).digest('hex').slice(0, 4).toUpperCase()
}

function buildNotes(d) {
  return [
    `Signed up at ${d.event.label}${d.staffEntry ? ' (entered by AIM staff at the booth)' : ' (booth QR code)'}.`,
    d.interest ? `Interested in: ${d.interest}` : '',
    `Marketing emails: ${d.consent ? 'yes, opted in' : 'not opted in'}`,
    d.attribution ? `Came from: ${d.attribution}` : '',
  ].filter(Boolean).join('\n')
}

// Public, unauthenticated: same pattern as web-leads (own CORS + JSON parser,
// mounted before the app's global CORS policy).
router.use(cors())
router.use(express.json({ limit: '32kb' }))

// POST /api/event-signups
router.post('/', rateLimiter({ windowMs: 10 * 60 * 1000, max: 150 }), async (req, res, next) => {
  try {
    // Honeypot: pretend success so bots learn nothing.
    if (req.body?.company) return res.json({ success: true, code: 'AIM-0000' })

    const { data, error } = validateSignup(req.body)
    if (error) return res.status(400).json({ error })

    // One sign-up per email per event: a second scan returns the same code
    // instead of a second lead (and a second prize).
    const existing = await db.query(
      'SELECT id FROM leads WHERE lower(email) = $1 AND referral_source = $2 ORDER BY created_at LIMIT 1',
      [data.email, data.event.source]
    )
    if (existing.rows.length) {
      return res.json({ success: true, duplicate: true, code: confirmationCode(existing.rows[0].id), name: data.name })
    }

    const aiScore = scoreFromLead({
      doctor_name: data.name,
      lead_source: 'Trade Show',
      estimated_value: 0,
      intent_level: 'Medium',
      case_interest: data.interest,
      email: data.email,
      phone: data.phone,
    })

    const { rows } = await db.query(
      `INSERT INTO leads
         (doctor_name, clinic_name, brand, phone, email, lead_source, referral_source, case_interest, notes,
          status, intent_level, ai_score, created_via, created_at, updated_at)
       VALUES ($1,$2,'Aim Dental',$3,$4,'Trade Show',$5,$6,$7,'Lead','Medium',$8,'event-signup-api',NOW(),NOW())
       RETURNING id`,
      [data.name, data.practice, data.phone, data.email, data.event.source, data.interest || 'General Inquiry', buildNotes(data), aiScore]
    )

    res.json({ success: true, duplicate: false, code: confirmationCode(rows[0].id), name: data.name })
  } catch (err) {
    next(err)
  }
})

module.exports = router
module.exports.validateSignup = validateSignup
module.exports.confirmationCode = confirmationCode
module.exports.buildNotes = buildNotes
module.exports.EVENTS = EVENTS
module.exports.INTERESTS = INTERESTS
