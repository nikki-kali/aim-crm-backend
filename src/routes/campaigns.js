const express = require('express')
const db = require('../config/db')
const auth = require('../middleware/auth')

const router = express.Router()

// Real persistence for Marketing OS's Campaigns module (see CLAUDE.md's
// Campaigns sub-app section) — this backend previously had no concept of
// this data at all; every campaign lived in the frontend's in-memory
// CampaignsContext.jsx and reset on every reload. Same jsonb-per-nested-
// object convention routes/contentPosts.js already established.

function toDateStr(value) {
  if (!value) return null
  return value instanceof Date ? value.toISOString().slice(0, 10) : value
}

function mapCampaign(row) {
  return {
    id: row.id,
    campaignId: row.campaign_id,
    lab: row.lab,
    status: row.status,
    type: row.type,
    owner: row.owner,
    priority: row.priority,
    createdBy: row.created_by,
    createdDate: toDateStr(row.created_at),
    lastModified: toDateStr(row.updated_at),
    name: row.name,
    goal: row.goal,
    description: row.description,
    objective: row.objective,
    kpiTargets: row.kpi_targets,
    audience: row.audience,
    email: row.email,
    abTest: row.ab_test,
    scheduling: row.scheduling,
    automation: row.automation,
    analytics: row.analytics,
    activityLog: row.activity_log,
    settings: row.settings,
    brevoCampaignId: row.brevo_campaign_id,
  }
}

// GET /api/campaigns?brand=aim
router.get('/campaigns', auth, async (req, res, next) => {
  try {
    const { brand } = req.query
    const { rows } = brand
      ? await db.query('select * from campaigns where lab = $1 order by updated_at desc', [brand])
      : await db.query('select * from campaigns order by updated_at desc')
    res.json({ campaigns: rows.map(mapCampaign) })
  } catch (err) {
    next(err)
  }
})

// GET /api/campaigns/:id
router.get('/campaigns/:id', auth, async (req, res, next) => {
  try {
    const { rows } = await db.query('select * from campaigns where id = $1', [req.params.id])
    if (rows.length === 0) return res.status(404).json({ error: 'Campaign not found' })
    res.json({ campaign: mapCampaign(rows[0]) })
  } catch (err) {
    next(err)
  }
})

// POST /api/campaigns — the frontend's own createBlankCampaign() already
// produces the full nested shape (kpiTargets/audience/email/... all
// populated with real defaults, not empty objects), so this just
// persists whatever it's given rather than duplicating that default
// object server-side. "New campaign" and Templates' "Use template" both
// call this with the full body.
router.post('/campaigns', auth, async (req, res, next) => {
  try {
    const b = req.body || {}
    const { rows } = await db.query(
      `insert into campaigns (
         campaign_id, lab, status, type, owner, priority, created_by, name, goal, description,
         objective, kpi_targets, audience, email, ab_test, scheduling, automation, analytics,
         activity_log, settings
       ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,$13::jsonb,$14::jsonb,$15::jsonb,$16::jsonb,$17::jsonb,$18::jsonb,$19::jsonb,$20::jsonb)
       returning *`,
      [
        b.campaignId || `CMP-${String(Date.now()).slice(-4)}`,
        b.lab || 'aim',
        b.status || 'draft',
        b.type || 'Email',
        b.owner || 'Admin',
        b.priority || 'medium',
        req.user?.name || 'Admin',
        b.name || 'Untitled campaign',
        b.goal || '',
        b.description || '',
        b.objective || 'Generate Leads',
        JSON.stringify(b.kpiTargets || {}),
        JSON.stringify(b.audience || {}),
        JSON.stringify(b.email || {}),
        JSON.stringify(b.abTest || {}),
        JSON.stringify(b.scheduling || {}),
        JSON.stringify(b.automation || {}),
        JSON.stringify(b.analytics || {}),
        JSON.stringify(b.activityLog || []),
        JSON.stringify(b.settings || {}),
      ]
    )
    res.json({ campaign: mapCampaign(rows[0]) })
  } catch (err) {
    next(err)
  }
})

// PATCH /api/campaigns/:id — shallow merge, matching CampaignsContext's
// existing updateCampaign(id, updates) contract exactly: whichever
// top-level keys are present get overwritten wholesale (nested objects
// are NOT deep-merged — callers must spread the existing nested object
// themselves first, same as the frontend always required).
const PATCHABLE_COLUMNS = {
  lab: 'lab', status: 'status', type: 'type', owner: 'owner', priority: 'priority',
  name: 'name', goal: 'goal', description: 'description', objective: 'objective',
  kpiTargets: 'kpi_targets', audience: 'audience', email: 'email', abTest: 'ab_test',
  scheduling: 'scheduling', automation: 'automation', analytics: 'analytics',
  activityLog: 'activity_log', settings: 'settings', brevoCampaignId: 'brevo_campaign_id',
}
const JSONB_COLUMNS = new Set(['kpi_targets', 'audience', 'email', 'ab_test', 'scheduling', 'automation', 'analytics', 'activity_log', 'settings'])

router.patch('/campaigns/:id', auth, async (req, res, next) => {
  try {
    const updates = req.body || {}
    const setClauses = []
    const values = []
    let i = 1
    for (const [key, column] of Object.entries(PATCHABLE_COLUMNS)) {
      if (!(key in updates)) continue
      const value = updates[key]
      if (JSONB_COLUMNS.has(column)) {
        setClauses.push(`${column} = $${i}::jsonb`)
        values.push(value === null ? null : JSON.stringify(value))
      } else {
        setClauses.push(`${column} = $${i}`)
        values.push(value)
      }
      i++
    }
    if (setClauses.length === 0) return res.status(400).json({ error: 'No updatable fields provided' })

    values.push(req.params.id)
    const { rows } = await db.query(
      `update campaigns set ${setClauses.join(', ')} where id = $${i} returning *`,
      values
    )
    if (rows.length === 0) return res.status(404).json({ error: 'Campaign not found' })
    res.json({ campaign: mapCampaign(rows[0]) })
  } catch (err) {
    next(err)
  }
})

// GET/PATCH /api/campaign-settings/:brand — account-level send controls
// (frequency cap, suppression windows), one row per brand — backs
// CampaignsSettings.jsx.
router.get('/campaign-settings/:brand', auth, async (req, res, next) => {
  try {
    const { rows } = await db.query('select * from campaign_settings where lab = $1', [req.params.brand])
    if (rows.length === 0) return res.status(404).json({ error: 'No settings for this brand' })
    const row = rows[0]
    res.json({ settings: { frequencyCap: row.frequency_cap, suppression: row.suppression } })
  } catch (err) {
    next(err)
  }
})

router.patch('/campaign-settings/:brand', auth, async (req, res, next) => {
  try {
    const updates = req.body || {}
    const setClauses = []
    const values = []
    let i = 1
    if ('frequencyCap' in updates) { setClauses.push(`frequency_cap = $${i}::jsonb`); values.push(JSON.stringify(updates.frequencyCap)); i++ }
    if ('suppression' in updates) { setClauses.push(`suppression = $${i}::jsonb`); values.push(JSON.stringify(updates.suppression)); i++ }
    if (setClauses.length === 0) return res.status(400).json({ error: 'No updatable fields provided' })

    values.push(req.params.brand)
    const { rows } = await db.query(
      `update campaign_settings set ${setClauses.join(', ')} where lab = $${i} returning *`,
      values
    )
    if (rows.length === 0) return res.status(404).json({ error: 'No settings for this brand' })
    const row = rows[0]
    res.json({ settings: { frequencyCap: row.frequency_cap, suppression: row.suppression } })
  } catch (err) {
    next(err)
  }
})

module.exports = router
