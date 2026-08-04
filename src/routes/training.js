const express = require('express')
const db = require('../config/db')
const auth = require('../middleware/auth')
const requireAdmin = require('../middleware/requireAdmin')

const router = express.Router()

const ITEM_TYPES = ['tour', 'scenario']

// GET /api/training/progress — current user's completed tour/scenario ids
router.get('/progress', auth, async (req, res, next) => {
  try {
    const { rows } = await db.query(
      `SELECT item_type, item_id, completed_at
       FROM training_progress
       WHERE user_id=$1
       ORDER BY completed_at`,
      [req.user.id]
    )
    res.json(rows)
  } catch (err) { next(err) }
})

// POST /api/training/progress — mark a tour module or scenario complete (idempotent)
router.post('/progress', auth, async (req, res, next) => {
  try {
    const { item_type, item_id } = req.body
    if (!ITEM_TYPES.includes(item_type) || !item_id) {
      return res.status(400).json({ error: 'item_type must be "tour" or "scenario", item_id is required' })
    }
    const { rows } = await db.query(
      `INSERT INTO training_progress (user_id, item_type, item_id)
       VALUES ($1, $2, $3)
       ON CONFLICT (user_id, item_type, item_id)
       DO UPDATE SET completed_at = now()
       RETURNING item_type, item_id, completed_at`,
      [req.user.id, item_type, item_id]
    )
    res.status(201).json(rows[0])
  } catch (err) { next(err) }
})

// GET /api/training/team — every staff member's completion, for the admin view
router.get('/team', auth, requireAdmin, async (req, res, next) => {
  try {
    const { rows: users } = await db.query(
      `SELECT id, name, email, role FROM users ORDER BY name`
    )
    const { rows: progress } = await db.query(
      `SELECT user_id, item_type, item_id, completed_at FROM training_progress`
    )
    const byUser = users.map((u) => ({
      ...u,
      completed: progress.filter((p) => p.user_id === u.id),
    }))
    res.json(byUser)
  } catch (err) { next(err) }
})

module.exports = router
