const express = require('express')
const crypto = require('crypto')
const cors = require('cors')
const db = require('../config/db')
const { scoreFromLead } = require('../services/scoring')
const { sendEmail } = require('../services/email')
const { appendLogRow } = require('../services/sheets')
const rateLimiter = require('../middleware/rateLimiter')

const router = express.Router()

// Trade-show offer redemptions: a doctor who got an AIM scratch card at the
// show registers the practice on aimdentallab.com/gnydm/redeem. Every card
// carries the same offer, so the card itself proves nothing; what makes this
// safe is (1) one redemption per practice, checked on email, phone, practice
// name and street address, enforced by unique indexes in the database, and
// (2) a cap on how many practices can redeem. A practice that matches an
// existing AIM client or clinic is still recorded, but as "needs_review" so
// the team decides, since the offer is meant for new practices.
//
// Nothing here runs until the event is switched on with its prize and limit
// (environment variables below), so the page can ship before Stephen confirms
// the offer without anyone being able to redeem a placeholder.
const EVENTS = Object.freeze(Object.assign(Object.create(null), {
  'gnydm-2026': Object.freeze({
    label: 'GNYDM 2026',
    source: 'GNYDM 2026',
    envPrefix: 'GNYDM_2026',
    // First case must reach AIM within 14 days of the show (Stephen, Nov 4).
    deadlineLabel: 'December 15, 2026',
    // Registrations close at the end of the deadline day, New York time.
    closesAt: '2026-12-16T05:00:00Z',
  }),
  // Test mode for checking the whole flow on the live system before launch.
  // Open only while GNYDM_2026_TEST_REDEMPTIONS_OPEN=true. It never creates a
  // CRM lead, emails only media@ (subject "[TEST]"), and its rows show in the
  // real event's sheet labeled "TEST - ignore".
  'gnydm-2026-test': Object.freeze({
    label: 'GNYDM 2026 (TEST)',
    source: 'GNYDM 2026 TEST',
    envPrefix: 'GNYDM_2026_TEST',
    deadlineLabel: 'December 15, 2026',
    closesAt: '2026-12-16T05:00:00Z',
    test: true,
  }),
}))
const TEST_INBOX = 'media@aimdentallab.com'

const TEAM_TO = ['james@aimdentallab.com']
const TEAM_CC = ['media@aimdentallab.com', 'execassistant@aimdentallab.com', 'ben@aimdentallab.com']

const INTERESTS = ['Crown & Bridge', 'Implant', 'Dentures', 'Ortho', 'Digital scanning', 'Not sure yet']
const SCANNERS = ['iTero', '3Shape TRIOS', 'Medit', 'Dentsply Sirona Primescan', 'Carestream / DEXIS', 'Shining 3D', 'Other scanner', 'No scanner (impressions)']

// Same cleaning as event sign-ups: this is a public, unauthenticated source
// whose values end up in staff emails and a shared sheet.
function clean(value, max = 200) {
  return String(value ?? '')
    .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, ' ')
    .replace(/[<>&"'`]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max)
}

// ---------- normalization used for the once-per-practice checks ----------

function normEmail(email) {
  return String(email || '').trim().toLowerCase()
}

// US numbers only: 10 digits, a leading country code 1 dropped.
function normPhone(phone) {
  let d = String(phone || '').replace(/\D/g, '')
  if (d.length === 11 && d.startsWith('1')) d = d.slice(1)
  return d
}

// Only legal suffixes, titles and filler are dropped ("Smith Dental, PC" and
// "The Smith Dental" match). Words like "Dental" or "Care" are kept on
// purpose: dropping them would make "Brooklyn Dental" and "Brooklyn Dental
// Care" one practice. The same practice under a reworded name is still caught
// by its email, phone or address.
const PRACTICE_NOISE = new Set(['the', 'dds', 'dmd', 'pc', 'pllc', 'llc', 'inc', 'of', 'and', 'dr'])
function normPractice(name) {
  const words = String(name || '').toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, ' ').trim().split(' ').filter(Boolean)
  const kept = words.filter((w) => !PRACTICE_NOISE.has(w))
  return (kept.length ? kept : words).join(' ')
}

const STREET_ABBR = {
  street: 'st', avenue: 'ave', av: 'ave', road: 'rd', boulevard: 'blvd', drive: 'dr', lane: 'ln', place: 'pl',
  court: 'ct', parkway: 'pkwy', highway: 'hwy', square: 'sq', terrace: 'ter', plaza: 'plz', turnpike: 'tpke',
  north: 'n', south: 's', east: 'e', west: 'w', first: '1st', second: '2nd', third: '3rd', fourth: '4th', fifth: '5th',
  suite: 'unit', ste: 'unit', apt: 'unit', apartment: 'unit', fl: 'floor', flr: 'floor', rm: 'room',
}
// Street + ZIP, so "802 Myrtle Avenue, Suite 2" and "802 Myrtle Ave Ste 2"
// match, while two practices in different suites of one building do not.
function normAddress(street, zip) {
  const s = String(street || '').toLowerCase().replace(/#\s*/g, ' unit ').replace(/[^a-z0-9]+/g, ' ').trim()
    .split(' ').filter(Boolean).map((w) => STREET_ABBR[w] || w.replace(/^(\d+)(st|nd|rd|th)$/, '$1$2'))
  const z = String(zip || '').replace(/\D/g, '').slice(0, 5)
  return `${s.join(' ')}|${z}`
}

// Returns { data } or { error }. Pure, so it can be tested without a database.
function validateRedemption(body = {}) {
  const key = typeof body.event === 'string' ? body.event : ''
  if (!Object.prototype.hasOwnProperty.call(EVENTS, key)) return { error: 'Unknown event.' }
  const name = clean(body.name, 120)
  const practice = clean(body.practice, 160)
  const email = normEmail(clean(body.email, 200))
  const phone = clean(body.phone, 40)
  const street = clean(body.street, 200)
  const city = clean(body.city, 100)
  const state = clean(body.state, 2).toUpperCase()
  const zip = clean(body.zip, 10)
  if (!name) return { error: 'Please enter your name.' }
  if (!practice) return { error: 'Please enter your practice name.' }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return { error: 'Please enter a valid email.' }
  if (normPhone(phone).length !== 10) return { error: 'Please enter a 10-digit practice phone number.' }
  if (!street || !/\d/.test(street)) return { error: 'Please enter the practice street address.' }
  if (!city) return { error: 'Please enter the city.' }
  if (!/^[A-Z]{2}$/.test(state)) return { error: 'Please enter the 2-letter state.' }
  if (!/^\d{5}(-\d{4})?$/.test(zip)) return { error: 'Please enter a 5-digit ZIP code.' }
  if (body.terms !== true) return { error: 'Please confirm the offer terms.' }
  return {
    data: {
      eventKey: key, event: EVENTS[key], name, practice, email, phone, street, city, state, zip,
      scanner: SCANNERS.includes(body.scanner) ? body.scanner : '',
      interest: INTERESTS.includes(body.interest) ? body.interest : '',
      consent: body.consent === true,
      attribution: clean(body.attribution, 300),
      norm: {
        email,
        phone: normPhone(phone),
        practice: normPractice(practice),
        address: normAddress(street, zip),
      },
    },
  }
}

// The event's live settings, or null while it's switched off.
function eventSettings(event, env = process.env, now = new Date()) {
  if (event.test) {
    if (env[`${event.envPrefix}_REDEMPTIONS_OPEN`] !== 'true') return { open: false, reason: 'not_open' }
    return { open: true, prize: 'TEST - not a real offer', limit: 5, sheetId: '', sheetWebhook: '', sheetSecret: '' }
  }
  const prize = clean(env[`${event.envPrefix}_PRIZE`] || '', 160)
  const limit = parseInt(env[`${event.envPrefix}_REDEMPTION_LIMIT`] || '', 10)
  if (env[`${event.envPrefix}_REDEMPTIONS_OPEN`] !== 'true' || !prize || !(limit > 0)) return { open: false, reason: 'not_open' }
  if (now >= new Date(event.closesAt)) return { open: false, reason: 'closed' }
  return {
    open: true, prize, limit,
    sheetId: env[`${event.envPrefix}_REDEMPTIONS_SHEET_ID`] || '',
    sheetWebhook: env[`${event.envPrefix}_REDEMPTIONS_SHEET_WEBHOOK`] || '',
    sheetSecret: env[`${event.envPrefix}_REDEMPTIONS_SHEET_SECRET`] || '',
  }
}

// Which of the four fields an earlier redemption already used.
function duplicateField(row, norm) {
  if (row.email_norm === norm.email) return 'email'
  if (row.phone_norm === norm.phone) return 'phone number'
  if (row.practice_norm === norm.practice) return 'practice name'
  if (row.address_norm === norm.address) return 'practice address'
  return 'details'
}

// Existing AIM clients and clinics that look like this practice. Matching
// any of them marks the redemption "needs_review" rather than rejecting it.
async function existingClientMatches(client, d) {
  const compact = d.practice.toLowerCase().replace(/[^a-z0-9]/g, '')
  const streetCompact = d.street.toLowerCase().replace(/[^a-z0-9]/g, '')
  const reasons = []
  const c = await client.query(
    `SELECT clinic_name, doctor_name FROM clients
      WHERE lower(email) = $1
         OR right(regexp_replace(coalesce(phone, ''), '\\D', '', 'g'), 10) = $2
         OR lower(regexp_replace(coalesce(clinic_name, ''), '[^a-zA-Z0-9]', '', 'g')) = $3
      LIMIT 3`,
    [d.norm.email, d.norm.phone, compact]
  )
  for (const r of c.rows) reasons.push(`Matches existing client ${r.clinic_name || r.doctor_name || ''}`.trim())
  const k = await client.query(
    `SELECT name FROM clinics
      WHERE lower(coalesce(email, '')) = $1
         OR right(regexp_replace(coalesce(phone, ''), '\\D', '', 'g'), 10) = $2
         OR lower(regexp_replace(coalesce(name, ''), '[^a-zA-Z0-9]', '', 'g')) = $3
         OR (length($4) > 6 AND lower(regexp_replace(coalesce(address, ''), '[^a-zA-Z0-9]', '', 'g')) LIKE $4 || '%')
      LIMIT 3`,
    [d.norm.email, d.norm.phone, compact, streetCompact]
  )
  for (const r of k.rows) reasons.push(`Matches existing clinic ${r.name || ''}`.trim())
  return [...new Set(reasons)]
}

function buildLeadNotes(d, s, status, reason) {
  return [
    `Registered for the ${d.event.label} show offer: ${s.prize}.`,
    `First case must reach AIM by ${d.event.deadlineLabel}.`,
    `Practice address: ${d.street}, ${d.city}, ${d.state} ${d.zip}`,
    d.scanner ? `Scanner: ${d.scanner}` : '',
    d.interest ? `Interested in: ${d.interest}` : '',
    `Marketing emails: ${d.consent ? 'yes, opted in' : 'not opted in'}`,
    status === 'needs_review' ? `Needs review: ${reason}` : 'Verified as a new practice.',
    d.attribution ? `Came from: ${d.attribution}` : '',
  ].filter(Boolean).join('\n')
}

function esc(v) {
  return String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

function teamEmail(d, s, r) {
  const review = r.status === 'needs_review'
  const subject = (d.event.test ? '[TEST] ' : '') + (review
    ? `Registered Practice won: ${s.prize} - needs review (${d.practice})`
    : `Registered New Practice won: ${s.prize} (${d.practice})`)
  const rows = [
    ['Prize won', s.prize], ['Status', review ? `Needs review: ${r.review_reason}` : 'Verified new practice'],
    ['Doctor', d.name], ['Practice', d.practice], ['Email', d.email], ['Phone', d.phone],
    ['Address', `${d.street}, ${d.city}, ${d.state} ${d.zip}`], ['Scanner', d.scanner || 'Not given'],
    ['Sends most', d.interest || 'Not given'], ['Marketing emails', d.consent ? 'Opted in' : 'Not opted in'],
    ['First case due', d.event.deadlineLabel], ['Redemption', `${r.count} of ${s.limit}`],
  ]
  const html = `<div style="font-family:Arial,Helvetica,sans-serif;color:#10353F;max-width:600px">
  <p style="font-size:12px;letter-spacing:2px;color:#207290;margin:0 0 4px">MARKETING UPDATES &amp; ALERTS</p>
  <h1 style="font-size:20px;margin:0 0 6px">${review ? 'A practice registered, but needs a check' : 'A new practice registered for the show offer'}</h1>
  <p style="font-size:14px;margin:0 0 16px">${esc(d.practice)} claimed <b>${esc(s.prize)}</b> from the ${esc(d.event.label)} scratch card.${review ? ' It matches an existing AIM client or clinic, so please confirm it qualifies before the offer is applied.' : ''}</p>
  <table cellpadding="6" cellspacing="0" style="border-collapse:collapse;font-size:14px;width:100%">
    ${rows.map(([k, v]) => `<tr><td style="border-bottom:1px solid #E5E7EB;color:#5B7A86;width:150px">${esc(k)}</td><td style="border-bottom:1px solid #E5E7EB">${esc(v)}</td></tr>`).join('')}
  </table>
  <p style="font-size:12px;color:#5B7A86;margin-top:16px">${d.event.test ? 'TEST registration: not added to the CRM. It appears in the shared sheet labeled "TEST - ignore".' : `Also added to the CRM as a ${esc(d.event.label)} lead and to the shared redemptions sheet.`}</p>
</div>`
  return { subject, html }
}

function doctorEmail(d, s) {
  const subject = `${d.event.test ? '[TEST] ' : ''}Your ${d.event.label} offer from AIM is registered`
  const html = `<div style="font-family:Arial,Helvetica,sans-serif;color:#10353F;max-width:600px">
  <h1 style="font-size:20px;margin:0 0 10px">Thank you, ${esc(d.name)}.</h1>
  <p style="font-size:14px;line-height:1.5">${esc(d.practice)} is registered for your ${esc(d.event.label)} offer: <b>${esc(s.prize)}</b>.</p>
  <p style="font-size:14px;line-height:1.5">To use it, send your first case so it reaches us by <b>${esc(d.event.deadlineLabel)}</b>. You can upload a scan or schedule a pickup at <a href="https://aimdentallab.com/contact" style="color:#207290">aimdentallab.com/contact</a>, or call us at (718) 854-3900.</p>
  <p style="font-size:14px;line-height:1.5">Full offer terms: <a href="https://aimdentallab.com/gnydm/redeem" style="color:#207290">aimdentallab.com/gnydm/redeem</a></p>
  <p style="font-size:13px;color:#5B7A86;margin-top:18px">AIM Dental Laboratory, 802 Myrtle Avenue, Brooklyn, NY 11206</p>
</div>`
  return { subject, html }
}

const SHEET_HEADER = ['Registered (New York time)', 'Status', 'Review note', 'Prize won', 'Doctor', 'Practice', 'Email', 'Phone',
  'Street', 'City', 'State', 'ZIP', 'Scanner', 'Sends most', 'Marketing emails', 'First case due', 'First case received', 'Came from', 'Redemption ID']
function sheetRow(d, s, r) {
  const when = new Date(r.created_at).toLocaleString('en-US', { timeZone: 'America/New_York' })
  const label = d.event.test ? 'TEST - ignore' : r.status === 'verified' ? 'Verified new practice' : 'Needs review'
  return [when, label, r.review_reason || '', s.prize, d.name, d.practice,
    d.email, d.phone, d.street, d.city, d.state, d.zip, d.scanner, d.interest, d.consent ? 'Yes' : 'No', d.event.deadlineLabel, '', d.attribution, r.id]
}

// Public, unauthenticated: own CORS + JSON parser, mounted before the app's
// global CORS policy (same pattern as event-signups).
router.use(cors())
router.use(express.json({ limit: '32kb' }))

// GET /api/event-redemptions/status?event=gnydm-2026
// Lets the page say "not open yet", "all claimed" or "closed" before the doctor types anything.
router.get('/status', async (req, res, next) => {
  try {
    const key = typeof req.query.event === 'string' ? req.query.event : ''
    if (!Object.prototype.hasOwnProperty.call(EVENTS, key)) return res.status(400).json({ error: 'Unknown event.' })
    const event = EVENTS[key]
    const s = eventSettings(event)
    if (!s.open) return res.json({ open: false, reason: s.reason, deadline: event.deadlineLabel })
    const { rows } = await db.query('SELECT count(*)::int AS n FROM event_redemptions WHERE event_key = $1', [key])
    const remaining = Math.max(0, s.limit - rows[0].n)
    res.json({ open: remaining > 0, reason: remaining > 0 ? null : 'full', prize: s.prize, deadline: event.deadlineLabel })
  } catch (err) {
    next(err)
  }
})

// The shared sheet pulls new rows from here. The Apps Script bound to the
// sheet runs every minute as media@ and calls this with the shared secret,
// so the sheet never needs a public web app or sharing outside AIM's
// Workspace (aimdentallab.com blocks "Anyone" web apps). Rows come back
// oldest first, after the cursor the script saved last time.
function rowFromRecord(rec, event) {
  const d = {
    name: rec.doctor_name, practice: rec.practice_name, email: rec.email, phone: rec.phone, street: rec.street,
    city: rec.city, state: rec.state, zip: rec.zip, scanner: rec.scanner || '', interest: rec.case_interest || '',
    consent: rec.marketing_consent, attribution: rec.attribution || '', event,
  }
  return sheetRow(d, { prize: rec.prize }, rec)
}

function secretMatches(provided, expected) {
  if (!expected || typeof provided !== 'string') return false
  const a = Buffer.from(provided)
  const b = Buffer.from(expected)
  return a.length === b.length && crypto.timingSafeEqual(a, b)
}

// GET /api/event-redemptions/export?event=gnydm-2026&after=<cursor>
router.get('/export', rateLimiter({ windowMs: 60 * 1000, max: 30 }), async (req, res, next) => {
  try {
    const key = typeof req.query.event === 'string' ? req.query.event : ''
    if (!Object.prototype.hasOwnProperty.call(EVENTS, key)) return res.status(400).json({ error: 'Unknown event.' })
    const event = EVENTS[key]
    const expected = process.env[`${event.envPrefix}_REDEMPTIONS_SHEET_SECRET`] || ''
    if (!secretMatches(req.get('x-sheet-secret'), expected)) return res.status(401).json({ error: 'Unauthorized.' })

    // The sheet also shows this event's test rows, labeled "TEST - ignore".
    const keys = Object.prototype.hasOwnProperty.call(EVENTS, `${key}-test`) ? [key, `${key}-test`] : [key]
    // Cursor = "<created_at ISO>|<id>" of the last row the sheet already has.
    const [afterTs, afterId] = String(req.query.after || '').split('|')
    const hasCursor = Boolean(afterTs && afterId && !Number.isNaN(Date.parse(afterTs)))
    const { rows } = await db.query(
      `SELECT * FROM event_redemptions
        WHERE event_key = ANY($1::text[]) ${hasCursor ? 'AND (created_at, id) > ($2::timestamptz, $3::uuid)' : ''}
        ORDER BY created_at, id LIMIT 200`,
      hasCursor ? [keys, afterTs, afterId] : [keys]
    )
    res.json({
      header: SHEET_HEADER,
      rows: rows.map((r) => ({ cursor: `${new Date(r.created_at).toISOString()}|${r.id}`, row: rowFromRecord(r, EVENTS[r.event_key] || event) })),
    })
  } catch (err) {
    next(err)
  }
})

// POST /api/event-redemptions
router.post('/', rateLimiter({ windowMs: 10 * 60 * 1000, max: 60 }), async (req, res, next) => {
  if (req.body?.company) return res.json({ success: true }) // honeypot
  const { data: d, error } = validateRedemption(req.body)
  if (error) return res.status(400).json({ error })
  const s = eventSettings(d.event)
  if (!s.open) {
    return res.status(s.reason === 'closed' ? 410 : 503).json({
      error: s.reason === 'closed'
        ? `This offer closed on ${d.event.deadlineLabel}.`
        : 'Offer registration is not open yet. Please try again soon or call (718) 854-3900.',
      reason: s.reason,
    })
  }

  let client
  let record
  try {
    client = await db.connect()
    await client.query('BEGIN')
    // Serializes redemptions for this event so the cap can't be overshot by
    // two registrations arriving at the same moment.
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`event-redemption:${d.eventKey}`])

    const dup = await client.query(
      `SELECT email_norm, phone_norm, practice_norm, address_norm FROM event_redemptions
        WHERE event_key = $1 AND (email_norm = $2 OR phone_norm = $3 OR practice_norm = $4 OR address_norm = $5) LIMIT 1`,
      [d.eventKey, d.norm.email, d.norm.phone, d.norm.practice, d.norm.address]
    )
    if (dup.rows.length) {
      await client.query('ROLLBACK')
      const field = duplicateField(dup.rows[0], d.norm)
      return res.status(409).json({
        error: `This offer has already been claimed using this ${field}. Each practice can redeem it once. Questions? Call (718) 854-3900.`,
        reason: 'duplicate',
      })
    }

    const count = await client.query('SELECT count(*)::int AS n FROM event_redemptions WHERE event_key = $1', [d.eventKey])
    if (count.rows[0].n >= s.limit) {
      await client.query('ROLLBACK')
      return res.status(410).json({ error: 'All show offers have now been claimed. Thank you for your interest; we would still love to see your first case.', reason: 'full' })
    }

    const matches = await existingClientMatches(client, d)
    const status = matches.length ? 'needs_review' : 'verified'
    const reviewReason = matches.join('; ')

    // Reuse the doctor's booth sign-up lead when there is one.
    const notes = buildLeadNotes(d, s, status, reviewReason)
    const prior = await client.query(
      'SELECT id FROM leads WHERE lower(email) = $1 AND referral_source = $2 ORDER BY created_at LIMIT 1',
      [d.norm.email, d.event.source]
    )
    let leadId = null
    if (d.event.test) {
      // test mode: no CRM lead
    } else if (prior.rows.length) {
      leadId = prior.rows[0].id
      await client.query("UPDATE leads SET notes = coalesce(notes, '') || $1, phone = coalesce(nullif(phone, ''), $2), updated_at = NOW() WHERE id = $3",
        [`\n\n${notes}`, d.phone, leadId])
    } else {
      const aiScore = scoreFromLead({ doctor_name: d.name, lead_source: 'Trade Show', estimated_value: 0, intent_level: 'High',
        case_interest: d.interest, email: d.email, phone: d.phone })
      const ins = await client.query(
        `INSERT INTO leads (doctor_name, clinic_name, brand, phone, email, lead_source, referral_source, case_interest, notes,
           status, intent_level, ai_score, created_via, created_at, updated_at)
         VALUES ($1,$2,'Aim Dental',$3,$4,'Trade Show',$5,$6,$7,'Lead','High',$8,'event-redemption-api',NOW(),NOW()) RETURNING id`,
        [d.name, d.practice, d.phone, d.email, d.event.source, d.interest || 'General Inquiry', notes, aiScore]
      )
      leadId = ins.rows[0].id
    }

    const saved = await client.query(
      `INSERT INTO event_redemptions (event_key, prize, doctor_name, practice_name, email, phone, street, city, state, zip, scanner,
         case_interest, marketing_consent, email_norm, phone_norm, practice_norm, address_norm, status, review_reason, lead_id, attribution)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21)
       RETURNING id, status, review_reason, created_at`,
      [d.eventKey, s.prize, d.name, d.practice, d.email, d.phone, d.street, d.city, d.state, d.zip, d.scanner || null,
        d.interest || null, d.consent, d.norm.email, d.norm.phone, d.norm.practice, d.norm.address, status, reviewReason || null,
        leadId == null ? null : String(leadId), d.attribution || null]
    )
    await client.query('COMMIT')
    record = { ...saved.rows[0], count: count.rows[0].n + 1 }
  } catch (err) {
    if (client) await client.query('ROLLBACK').catch(() => {})
    if (err && err.code === '23505') {
      return res.status(409).json({ error: 'This offer has already been claimed for this practice. Each practice can redeem it once.', reason: 'duplicate' })
    }
    return next(err)
  } finally {
    if (client) client.release()
  }

  // The redemption is saved; notifications are best effort and never undo it.
  const tasks = []
  const team = teamEmail(d, s, record)
  const teamTo = d.event.test ? [TEST_INBOX] : TEAM_TO
  const teamCc = d.event.test ? [] : TEAM_CC
  tasks.push(sendEmail({ to: teamTo, cc: teamCc, replyTo: d.email, subject: team.subject, html: team.html })
    .catch((e) => console.error('event-redemptions: team email failed', e.message)))
  const doc = doctorEmail(d, s)
  tasks.push(sendEmail({ to: d.email, replyTo: 'media@aimdentallab.com', subject: doc.subject, html: doc.html })
    .catch((e) => console.error('event-redemptions: doctor email failed', e.message)))
  tasks.push(appendLogRow({ spreadsheetId: s.sheetId, webhookUrl: s.sheetWebhook, webhookSecret: s.sheetSecret, header: SHEET_HEADER, row: sheetRow(d, s, record) })
    .then((ok) => { if (!ok) console.warn('event-redemptions: redemptions sheet not configured; row not added') })
    .catch((e) => console.error('event-redemptions: sheet append failed', e.message)))
  await Promise.all(tasks)

  res.json({ success: true, prize: s.prize, deadline: d.event.deadlineLabel, status: record.status, name: d.name, practice: d.practice })
})

module.exports = router
Object.assign(module.exports, {
  validateRedemption, eventSettings, normEmail, normPhone, normPractice, normAddress, duplicateField,
  teamEmail, doctorEmail, sheetRow, rowFromRecord, secretMatches, SHEET_HEADER, EVENTS, INTERESTS, SCANNERS, TEAM_TO, TEAM_CC,
})
