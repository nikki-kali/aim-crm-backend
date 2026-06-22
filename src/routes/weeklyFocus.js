const express = require('express')
const db = require('../config/db')
const auth = require('../middleware/auth')

const router = express.Router()

function getMondayOfWeek(date) {
  const d = new Date(date)
  const day = d.getDay()
  const diff = day === 0 ? -6 : 1 - day
  d.setDate(d.getDate() + diff)
  return d.toISOString().split('T')[0]
}

// GET /api/weekly-focus?week=YYYY-MM-DD (optional, defaults to current week's Monday)
router.get('/', auth, async (req, res, next) => {
  try {
    const weekStart = req.query.week || getMondayOfWeek(new Date())
    const { rows } = await db.query(
      'SELECT * FROM weekly_focus WHERE user_id=$1 AND week_start=$2',
      [req.user.id, weekStart]
    )
    res.json(rows[0] || null)
  } catch (err) { next(err) }
})

// POST /api/weekly-focus — upsert for current (or specified) week
router.post('/', auth, async (req, res, next) => {
  try {
    const { focus_text, week } = req.body
    if (!focus_text?.trim()) return res.status(400).json({ error: 'Focus text is required' })
    const weekStart = week || getMondayOfWeek(new Date())
    const { rows } = await db.query(
      `INSERT INTO weekly_focus (user_id, week_start, focus_text, updated_at)
       VALUES ($1,$2,$3,NOW())
       ON CONFLICT (user_id, week_start) DO UPDATE SET focus_text=$3, updated_at=NOW()
       RETURNING *`,
      [req.user.id, weekStart, focus_text.trim()]
    )
    res.json(rows[0])
  } catch (err) { next(err) }
})

module.exports = router
