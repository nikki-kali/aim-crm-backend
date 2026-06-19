const express = require('express')
const db = require('../config/db')
const auth = require('../middleware/auth')

const router = express.Router()

// GET /api/activities?entity_type=lead&entity_id=xxx
router.get('/', auth, async (req, res, next) => {
  try {
    const { entity_type, entity_id } = req.query
    if (!entity_type || !entity_id) return res.status(400).json({ error: 'entity_type and entity_id required' })
    const { rows } = await db.query(
      `SELECT a.*, u.name AS created_by_name FROM activities a
       LEFT JOIN users u ON u.id = a.created_by
       WHERE a.entity_type=$1 AND a.entity_id=$2
       ORDER BY a.created_at DESC`,
      [entity_type, entity_id]
    )
    res.json(rows)
  } catch (err) { next(err) }
})

// POST /api/activities
router.post('/', auth, async (req, res, next) => {
  try {
    const { entity_type, entity_id, type, description } = req.body
    if (!entity_type || !entity_id || !type) return res.status(400).json({ error: 'entity_type, entity_id, type required' })
    const { rows } = await db.query(
      `INSERT INTO activities (entity_type, entity_id, type, description, created_by)
       VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [entity_type, entity_id, type, description || '', req.user.id]
    )
    res.status(201).json(rows[0])
  } catch (err) { next(err) }
})

module.exports = router
