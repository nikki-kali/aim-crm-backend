const express = require('express')
const cors = require('cors')
const db = require('../config/db')
const { scoreFromLead } = require('../services/scoring')
const { sendEmail } = require('../services/email')
const { matchRepByState } = require('../services/repTerritories')
const rateLimiter = require('../middleware/rateLimiter')
const { remakeCost, money } = require('../services/growthAudit/calc')
const { writeReport } = require('../services/growthAudit/report')
const { reportEmail, leadNotificationEmail } = require('../services/growthAudit/email')
const { parseCallback, describeCallback, icsEvent } = require('../services/growthAudit/callback')
const { renderReportPdf, reportPdfFilename } = require('../services/growthAudit/pdf')

// POST /api/growth-audit: the website's Growth Audit assessment (/partner).
//
// 1. Saves the lead (case_interest "Growth Audit"), assigned to the right rep:
//    the rep the practice named, or the rep whose territory covers the state
//    in the practice address they gave instead.
// 2. Responds straight away with that rep's name, so the page can show who
//    will call. The page shows the cost results itself.
// 3. In the background, builds the report from rules (services/growthAudit/report.js)
//    and emails it to the practice, then notifies sales.
//
// Public and unauthenticated like web-leads: open CORS scoped to this route,
// honeypot, IP rate limit, and every field escaped before it reaches HTML.

const router = express.Router()
router.use(cors())
router.use(express.json({ limit: '64kb' }))

const REP_IDS = { james: 'James', william: 'William' }
// James's direct line (CONTACT.salesPhone on the website); everyone else
// falls back to the main lab number.
const DIRECT_LINES = { james: { phone: '347-863-9787', tel: '+13478639787' } }
const MAIN_LINE = { phone: '(718) 854-3900', tel: '+17188543900' }

const US_STATES = {
  alabama: 'AL', alaska: 'AK', arizona: 'AZ', arkansas: 'AR', california: 'CA', colorado: 'CO', connecticut: 'CT', delaware: 'DE',
  florida: 'FL', georgia: 'GA', hawaii: 'HI', idaho: 'ID', illinois: 'IL', indiana: 'IN', iowa: 'IA', kansas: 'KS', kentucky: 'KY',
  louisiana: 'LA', maine: 'ME', maryland: 'MD', massachusetts: 'MA', michigan: 'MI', minnesota: 'MN', mississippi: 'MS',
  missouri: 'MO', montana: 'MT', nebraska: 'NE', nevada: 'NV', 'new hampshire': 'NH', 'new jersey': 'NJ', 'new mexico': 'NM',
  'new york': 'NY', 'north carolina': 'NC', 'north dakota': 'ND', ohio: 'OH', oklahoma: 'OK', oregon: 'OR', pennsylvania: 'PA',
  'rhode island': 'RI', 'south carolina': 'SC', 'south dakota': 'SD', tennessee: 'TN', texas: 'TX', utah: 'UT', vermont: 'VT',
  virginia: 'VA', washington: 'WA', 'west virginia': 'WV', wisconsin: 'WI', wyoming: 'WY', 'district of columbia': 'DC',
}
const STATE_CODES = new Set(Object.values(US_STATES))

// Best-effort state from a free-text address: "..., NY 11206", "..., NY",
// or a spelled-out state name. Returns null when it can't tell.
function stateFromAddress(address) {
  const text = String(address || '')
  const coded = [...text.toUpperCase().matchAll(/\b([A-Z]{2})\b(?=\s*\d{5}|\s*$|\s*,)/g)].map((m) => m[1]).filter((c) => STATE_CODES.has(c))
  if (coded.length) return coded[coded.length - 1]
  const lower = text.toLowerCase()
  const named = Object.keys(US_STATES).filter((name) => lower.includes(name)).sort((a, b) => b.length - a.length)[0]
  return named ? US_STATES[named] : null
}

async function findRepUser(repId) {
  const first = REP_IDS[repId]
  if (!first) return null
  const { rows } = await db.query(`SELECT id, name, email FROM users WHERE name ILIKE $1 ORDER BY id LIMIT 1`, [`${first}%`])
  return rows[0] || null
}

const REP_REGIONS = { james: 'New York City metro', william: 'West Coast' }

function contactFor(repId, user) {
  const line = DIRECT_LINES[repId] || MAIN_LINE
  if (user) {
    return {
      name: user.name,
      firstName: user.name.split(' ')[0],
      region: REP_REGIONS[repId] || null,
      email: user.email || null,
      phone: line.phone,
      phoneTel: line.tel,
    }
  }
  return { name: 'The AIM team', firstName: 'the AIM team', region: null, email: 'digital@aimdentallab.com', phone: MAIN_LINE.phone, phoneTel: MAIN_LINE.tel }
}

const text = (v, max = 300) => String(v ?? '').trim().slice(0, max)

router.post('/', rateLimiter({ windowMs: 10 * 60 * 1000, max: 6 }), async (req, res, next) => {
  try {
    const body = req.body || {}
    if (body.company) return res.json({ success: true }) // honeypot: pretend success

    const lead = {
      name: text(body.name, 120),
      practice: text(body.practice, 160),
      email: text(body.email, 200),
      phone: text(body.phone, 40),
      rep: text(body.rep, 20),
      address: text(body.address, 300),
      pains: Array.isArray(body.pains) ? body.pains.map((p) => text(p, 60)).filter(Boolean).slice(0, 8) : [],
      interest: text(body.interest, 120),
      message: text(body.message, 1500),
      attribution: text(body.attribution, 400),
    }
    if (!lead.name) return res.status(400).json({ error: 'name is required' })
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(lead.email)) return res.status(400).json({ error: 'a valid email is required' })
    if (!lead.phone) return res.status(400).json({ error: 'phone is required' })
    if (!['james', 'william', 'none'].includes(lead.rep)) return res.status(400).json({ error: 'rep is required' })
    if (lead.rep === 'none' && !lead.address) return res.status(400).json({ error: 'practice address is required when no rep is named' })

    const cost = remakeCost(body)
    if (!cost.inputs.units || !cost.inputs.hourValue) return res.status(400).json({ error: 'units and chair hour value are required' })

    // Routing: the named rep, else whoever covers the address's state.
    let repId = lead.rep === 'none' ? null : lead.rep
    let user = repId ? await findRepUser(repId) : null
    let routing = repId ? 'named by the practice' : 'no rep named'
    if (!repId) {
      const state = stateFromAddress(lead.address)
      const matched = state ? await matchRepByState(state) : null
      if (matched) {
        user = matched
        repId = Object.keys(REP_IDS).find((id) => matched.name?.startsWith(REP_IDS[id])) || null
        routing = `matched by state ${state}`
      } else {
        routing = state ? `no rep covers ${state} yet, needs manual assignment` : 'state not recognized, needs manual assignment'
      }
    }
    const contact = contactFor(repId, user)

    // The booked call-back, in the practice's time zone (from the rep's
    // territory). An invalid or stale slot (an old browser tab, say) never
    // loses the lead: it's saved without one and flagged for a manual call.
    let callback = null
    try {
      callback = parseCallback({ date: body.callbackDate, window: body.callbackWindow, repId })
    } catch (err) {
      // Best-effort: a bad slot must never stop the lead being saved.
      console.error('growth-audit: unusable call-back slot', err?.message)
    }
    const callbackText = callback ? describeCallback(callback) : 'not booked (invalid or missing slot), call the next business day'

    const notes = [
      `AIM rep: ${contact.name} (${routing})`,
      `Call-back booked: ${callbackText}`,
      lead.address ? `Practice address: ${lead.address}` : '',
      `Growth Audit: ${cost.inputs.units} units/month, ${cost.inputs.remakes} remakes/month, ${cost.inputs.minutes} min per remake at ${money(cost.inputs.hourValue)}/hr, lab remake fee ${cost.inputs.labFee ? money(cost.inputs.labFee) : 'none'}.`,
      `Estimated yearly remake cost: ${money(cost.total)}.`,
      lead.pains.length ? `Problems: ${lead.pains.join(', ')}` : '',
      lead.interest ? `Wants help with: ${lead.interest}` : '',
      lead.message,
      lead.attribution ? `Came from: ${lead.attribution}` : '',
    ]
      .filter(Boolean)
      .join('\n\n')

    const aiScore = scoreFromLead({
      doctor_name: lead.name,
      lead_source: 'Website Form Submission',
      estimated_value: 0,
      intent_level: 'High',
      case_interest: 'Growth Audit',
    })

    const { rows } = await db.query(
      `INSERT INTO leads
         (doctor_name, clinic_name, brand, phone, email, lead_source, referral_source, case_interest, notes,
          status, intent_level, ai_score, assigned_to, created_via, created_at, updated_at, last_contacted_at)
       VALUES ($1,$2,'Aim Dental',$3,$4,'Website Form Submission','growth-audit','Growth Audit',$5,
          'Lead','High',$6,$7,'growth-audit-api',NOW(),NOW(),NOW())
       RETURNING id`,
      [lead.name, lead.practice, lead.phone, lead.email, notes, aiScore, user?.id || null]
    )
    const leadId = rows[0].id

    res.json({
      success: true,
      id: leadId,
      rep: user ? { name: contact.name, email: contact.email } : null,
      callback: callback ? describeCallback(callback) : null,
    })

    // After responding: the report can take a while to write.
    setImmediate(async () => {
      const { report, source } = await writeReport({ cost, pains: lead.pains, interest: lead.interest, firstName: contact.firstName, callback: callback ? describeCallback(callback) : null })
      const repFirst = contact.firstName === 'the AIM team' ? 'AIM' : contact.firstName
      const callbackLine = callback ? describeCallback(callback) : null
      const emailArgs = { practice: lead.practice, cost, report, contact, callback: callbackLine }
      // The printable copy. If Chrome fails, the report still goes out without it.
      let pdf = null
      try {
        pdf = await renderReportPdf(reportEmail({ ...emailArgs, print: true }))
      } catch (err) {
        console.error('growth-audit: report PDF failed, sending without it', err)
      }
      try {
        await sendEmail({
          to: lead.email,
          bcc: process.env.GROWTH_AUDIT_EMAIL || 'media@aimdentallab.com',
          replyTo: contact.email || 'media@aimdentallab.com',
          subject: `Your Growth Audit report: remakes are costing you about ${money(cost.total)} a year`,
          html: reportEmail({ ...emailArgs, pdfAttached: Boolean(pdf) }),
          // The printable report, plus the practice's own invite: the whole
          // window, so they expect the call.
          attachments: [
            pdf && { filename: reportPdfFilename(lead.practice), contentType: 'application/pdf', content: pdf },
            callback && {
              filename: 'aim-call-back.ics',
              contentType: 'text/calendar',
              content: icsEvent({
                uid: `growth-audit-${leadId}-practice@aimdentallab.com`,
                start: callback.start,
                end: callback.end,
                summary: `Call from ${contact.name}, AIM Dental Laboratory`,
                description: `${contact.name} will call you about your Growth Audit results, ${callbackLine}. Questions before then? ${contact.phone}`,
                location: contact.phone,
              }),
            },
          ].filter(Boolean),
        })
      } catch (err) {
        console.error('growth-audit: report email failed', err)
      }
      try {
        // To the rep directly (with the call in their calendar), copied to
        // media@. With no rep matched it goes to media@ for manual assignment.
        const repEmail = contact.email && contact.email !== 'digital@aimdentallab.com' ? contact.email : null
        const salesInbox = process.env.GROWTH_AUDIT_EMAIL || 'media@aimdentallab.com'
        await sendEmail({
          to: repEmail || salesInbox,
          cc: repEmail ? [salesInbox] : undefined,
          subject: callback
            ? `[${report.priority}] Call-back booked ${callback.dayLabel}, ${callback.short}: ${lead.name}, ${lead.practice} (${money(cost.total)}/yr in remakes)`
            : `[${report.priority}] Growth Audit lead, call next business day: ${lead.name}, ${lead.practice}`,
          html: leadNotificationEmail({ leadId, lead, cost, contact, routing, reportSource: source, report, callbackText, callbackBooked: Boolean(callback) }),
          // The rep's invite: a 30-minute hold at the start of the window,
          // with a reminder 15 minutes before.
          attachments: callback
            ? [{
                filename: 'growth-audit-call-back.ics',
                contentType: 'text/calendar',
                content: icsEvent({
                  uid: `growth-audit-${leadId}-rep@aimdentallab.com`,
                  start: callback.start,
                  end: new Date(callback.start.getTime() + 30 * 60000),
                  summary: `${repFirst}: call ${lead.name}, ${lead.practice} (Growth Audit)`,
                  description: [
                    `Call-back window: ${describeCallback(callback)}`,
                    `Phone: ${lead.phone}`,
                    `Email: ${lead.email}`,
                    `Yearly remake cost: ${money(cost.total)} (${cost.annualRemakes} remakes a year)`,
                    lead.pains.length ? `Problems: ${lead.pains.join(', ')}` : '',
                    `CRM lead #${leadId}`,
                  ].filter(Boolean).join('\n'),
                  location: lead.phone,
                }),
              }]
            : undefined,
        })
      } catch (err) {
        console.error('growth-audit: lead notification failed', err)
      }
    })
  } catch (err) {
    next(err)
  }
})

module.exports = router
module.exports.stateFromAddress = stateFromAddress
