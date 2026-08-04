const express = require('express')
const auth = require('../middleware/auth')

const router = express.Router()

// Thin proxy: Marketing OS's Content Studio (a separate app, separate
// deployment) has no backend of its own, but it already talks to this
// Backend for auth/leads — this reuses that same trusted channel to reach
// Team Pulse's content-approval bridge (a third app, sharing this app's
// Supabase project under a different schema — see Team Pulse's own
// CLAUDE.md, "Supabase project" section). TEAM_PULSE_API_KEY lives only
// here, never in Marketing OS's browser bundle — that's the whole reason
// this hop exists instead of Marketing OS calling Team Pulse directly.
async function callTeamPulse(path, options = {}) {
  if (!process.env.TEAM_PULSE_API_URL || !process.env.TEAM_PULSE_API_KEY) {
    throw new Error('TEAM_PULSE_API_URL/TEAM_PULSE_API_KEY are not configured on this server')
  }
  const res = await fetch(`${process.env.TEAM_PULSE_API_URL}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${process.env.TEAM_PULSE_API_KEY}`,
      ...options.headers,
    },
  })
  const body = await res.json().catch(() => ({}))
  if (!res.ok) {
    throw new Error(body.error || `Team Pulse request failed (${res.status})`)
  }
  return body
}

router.post('/submit', auth, async (req, res, next) => {
  try {
    const { brand, externalRef, title, description, mediaUrl } = req.body
    const result = await callTeamPulse('/api/integrations/marketing-os/tasks', {
      method: 'POST',
      body: JSON.stringify({ brand, externalRef, title, description, mediaUrl }),
    })
    res.json(result)
  } catch (err) {
    next(err)
  }
})

router.get('/status', auth, async (req, res, next) => {
  try {
    const { externalRefs } = req.query
    const result = await callTeamPulse(
      `/api/integrations/marketing-os/tasks?externalRefs=${encodeURIComponent(externalRefs || '')}`,
    )
    res.json(result)
  } catch (err) {
    next(err)
  }
})

module.exports = router
