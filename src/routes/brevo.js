const express = require('express')
const auth = require('../middleware/auth')
const requireAdmin = require('../middleware/requireAdmin')

const router = express.Router()
const BREVO_BASE = 'https://api.brevo.com/v3'

/* Real Brevo integration for Marketing OS's Campaigns module (previously
   100% local mock state, no backend at all — see CLAUDE.md's Campaigns
   sub-app section). Reuses the same BREVO_API_KEY already configured for
   the newsletter Brevo sync (routes/newsletter.js) — same account, same
   key, just a different part of Brevo's API. The key lives only here,
   never in Marketing OS's browser bundle, same trusted-server pattern
   contentApprovals.js already uses for Team Pulse. */
async function callBrevo(path, options = {}) {
  if (!process.env.BREVO_API_KEY) {
    throw new Error('BREVO_API_KEY is not configured on this server')
  }
  const res = await fetch(`${BREVO_BASE}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      'api-key': process.env.BREVO_API_KEY,
      ...options.headers,
    },
  })
  if (res.status === 204) return {}
  const body = await res.json().catch(() => ({}))
  if (!res.ok) {
    throw new Error(body.message || `Brevo request failed (${res.status})`)
  }
  return body
}

// GET /api/brevo/lists — real contact lists, for the Audience tab's real
// segment sizing instead of invented counts.
router.get('/brevo/lists', auth, async (req, res, next) => {
  try {
    const data = await callBrevo('/contacts/lists?limit=50')
    res.json({
      lists: (data.lists || []).map((l) => ({ id: l.id, name: l.name, uniqueSubscribers: l.uniqueSubscribers })),
    })
  } catch (err) {
    next(err)
  }
})

// GET /api/brevo/senders — real, active verified senders for the Builder
// tab's "From" field.
router.get('/brevo/senders', auth, async (req, res, next) => {
  try {
    const data = await callBrevo('/senders')
    res.json({
      senders: (data.senders || []).filter((s) => s.active).map((s) => ({ id: s.id, name: s.name, email: s.email })),
    })
  } catch (err) {
    next(err)
  }
})

// GET /api/brevo/campaigns — real campaign history (the existing 3 sent +
// 1 suspended, plus anything created going forward) for the Dashboard,
// Analytics rollup, and status list pages.
router.get('/brevo/campaigns', auth, async (req, res, next) => {
  try {
    const data = await callBrevo('/emailCampaigns?limit=100&sort=desc')
    res.json({ campaigns: data.campaigns || [] })
  } catch (err) {
    next(err)
  }
})

// GET /api/brevo/campaigns/:id — single campaign, full detail + stats
// (CampaignDetail's Overview/Analytics tabs).
router.get('/brevo/campaigns/:id', auth, async (req, res, next) => {
  try {
    const data = await callBrevo(`/emailCampaigns/${req.params.id}`)
    res.json({ campaign: data })
  } catch (err) {
    next(err)
  }
})

// POST /api/brevo/campaigns — creates a real DRAFT in Brevo. Never sends:
// Brevo's own createEmailCampaign only sends if a scheduledAt is passed,
// which this deliberately never does — sending is its own separate,
// explicitly-confirmed route below.
router.post('/brevo/campaigns', auth, async (req, res, next) => {
  try {
    const { name, subject, senderName, senderEmail, htmlContent, listIds } = req.body
    if (!name || !subject || !senderEmail || !htmlContent || !listIds?.length) {
      return res.status(400).json({ error: 'name, subject, senderEmail, htmlContent, and listIds are required' })
    }
    const data = await callBrevo('/emailCampaigns', {
      method: 'POST',
      body: JSON.stringify({
        name,
        subject,
        htmlContent,
        sender: { name: senderName, email: senderEmail },
        recipients: { listIds },
      }),
    })
    res.status(201).json({ campaignId: data.id })
  } catch (err) {
    next(err)
  }
})

// PUT /api/brevo/campaigns/:id — updates an existing real draft (re-saving
// the Builder/Audience tabs after the first push to Brevo). Brevo rejects
// this once a campaign has actually sent, which is the correct behavior —
// not specially handled here, the error just passes through.
router.put('/brevo/campaigns/:id', auth, async (req, res, next) => {
  try {
    const { name, subject, senderName, senderEmail, htmlContent, listIds } = req.body
    const body = {}
    if (name) body.name = name
    if (subject) body.subject = subject
    if (htmlContent) body.htmlContent = htmlContent
    if (senderEmail) body.sender = { name: senderName, email: senderEmail }
    if (listIds?.length) body.recipients = { listIds }
    await callBrevo(`/emailCampaigns/${req.params.id}`, { method: 'PUT', body: JSON.stringify(body) })
    res.json({ success: true })
  } catch (err) {
    next(err)
  }
})

// POST /api/brevo/campaigns/:id/send — REAL send, immediately, to every
// recipient on the campaign's lists (hundreds of real dentist contacts —
// see CLAUDE.md). Deliberately its own single-purpose route, not folded
// into the PUT above, so the frontend can gate it behind its own explicit
// "yes, really send this" confirmation, never bundled into a routine
// save. requireAdmin on top of auth, since this is real and irreversible.
router.post('/brevo/campaigns/:id/send', auth, requireAdmin, async (req, res, next) => {
  try {
    await callBrevo(`/emailCampaigns/${req.params.id}/sendNow`, { method: 'POST' })
    res.json({ success: true })
  } catch (err) {
    next(err)
  }
})

module.exports = router
