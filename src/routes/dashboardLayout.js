const express = require('express')
const db = require('../config/db')
const auth = require('../middleware/auth')

const router = express.Router()

const VALID_TYPES = ['rep', 'admin']

// GET /api/dashboard-layout?type=rep|admin — the caller's saved widget
// order for that dashboard, or null if they've never customized it (the
// frontend falls back to its hardcoded default in that case).
router.get('/', auth, async (req, res, next) => {
  try {
    const { type } = req.query
    if (!VALID_TYPES.includes(type)) return res.status(400).json({ error: 'type must be rep or admin' })
    const { rows } = await db.query(
      `SELECT widgets FROM dashboard_layouts WHERE user_id=$1 AND dashboard_type=$2`,
      [req.user.id, type]
    )
    res.json(rows[0]?.widgets || null)
  } catch (err) { next(err) }
})

// PUT /api/dashboard-layout — body { dashboard_type, widgets: [{id, visible}, ...] }
router.put('/', auth, async (req, res, next) => {
  try {
    const { dashboard_type, widgets } = req.body
    if (!VALID_TYPES.includes(dashboard_type)) return res.status(400).json({ error: 'dashboard_type must be rep or admin' })
    if (!Array.isArray(widgets)) return res.status(400).json({ error: 'widgets must be an array' })
    const { rows } = await db.query(
      `INSERT INTO dashboard_layouts (user_id, dashboard_type, widgets, updated_at)
       VALUES ($1,$2,$3,NOW())
       ON CONFLICT (user_id, dashboard_type) DO UPDATE SET widgets=$3, updated_at=NOW()
       RETURNING widgets`,
      [req.user.id, dashboard_type, JSON.stringify(widgets)]
    )
    res.json(rows[0].widgets)
  } catch (err) { next(err) }
})

// DELETE /api/dashboard-layout?type=rep|admin — reset to the frontend's
// hardcoded default by removing the saved row entirely.
router.delete('/', auth, async (req, res, next) => {
  try {
    const { type } = req.query
    if (!VALID_TYPES.includes(type)) return res.status(400).json({ error: 'type must be rep or admin' })
    await db.query(`DELETE FROM dashboard_layouts WHERE user_id=$1 AND dashboard_type=$2`, [req.user.id, type])
    res.json({ success: true })
  } catch (err) { next(err) }
})

module.exports = router
