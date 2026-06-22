const express = require('express')
const db = require('../config/db')
const auth = require('../middleware/auth')

const router = express.Router()

function getMondayDate(d = new Date()) {
  const day = d.getDay()
  const monday = new Date(d)
  monday.setDate(d.getDate() - (day === 0 ? 6 : day - 1))
  monday.setHours(0, 0, 0, 0)
  return monday.toISOString().split('T')[0]
}

// GET /api/todos?week=YYYY-MM-DD&user_id=UUID (user_id admin-only)
router.get('/', auth, async (req, res, next) => {
  try {
    const weekStart = req.query.week || getMondayDate()
    const userId = (req.user.role === 'admin' && req.query.user_id)
      ? req.query.user_id
      : req.user.id

    const { rows } = await db.query(`
      SELECT t.*, u.name AS owner_name, r.title AS rock_title
      FROM weekly_todos t
      LEFT JOIN users u ON u.id = t.owner_id
      LEFT JOIN rocks r ON r.id = t.rock_id
      WHERE t.owner_id = $1 AND t.week_start = $2 AND t.archived = false
      ORDER BY t.carried_over ASC, t.completed ASC, t.created_at ASC
    `, [userId, weekStart])

    res.json(rows)
  } catch (err) { next(err) }
})

// POST /api/todos
router.post('/', auth, async (req, res, next) => {
  try {
    const { description, due_date, rock_id, owner_id, week } = req.body
    if (!description?.trim()) return res.status(400).json({ error: 'Description required' })

    const weekStart = week || getMondayDate()
    const effectiveOwner = (req.user.role === 'admin' && owner_id) ? owner_id : req.user.id

    // Default due date = Friday of current week
    let effectiveDue = due_date
    if (!effectiveDue) {
      const monday = new Date(weekStart + 'T00:00:00Z')
      monday.setUTCDate(monday.getUTCDate() + 4)
      effectiveDue = monday.toISOString().split('T')[0]
    }

    const { rows } = await db.query(`
      INSERT INTO weekly_todos (owner_id, created_by, description, due_date, rock_id, week_start)
      VALUES ($1, $2, $3, $4, $5, $6)
      RETURNING *
    `, [effectiveOwner, req.user.id, description.trim(), effectiveDue, rock_id || null, weekStart])

    res.status(201).json(rows[0])
  } catch (err) { next(err) }
})

// PUT /api/todos/:id — toggle completed or update description
router.put('/:id', auth, async (req, res, next) => {
  try {
    const { completed, description } = req.body

    const { rows: [todo] } = await db.query('SELECT * FROM weekly_todos WHERE id=$1', [req.params.id])
    if (!todo) return res.status(404).json({ error: 'To-Do not found' })

    const canEdit = req.user.role === 'admin' || todo.owner_id === req.user.id
    if (!canEdit) return res.status(403).json({ error: 'Not authorized' })

    const { rows } = await db.query(`
      UPDATE weekly_todos SET
        completed    = COALESCE($1::boolean, completed),
        completed_at = CASE WHEN $1 = true THEN NOW() WHEN $1 = false THEN NULL ELSE completed_at END,
        description  = COALESCE($2, description)
      WHERE id = $3
      RETURNING *
    `, [completed !== undefined ? completed : null, description || null, req.params.id])

    res.json(rows[0])
  } catch (err) { next(err) }
})

// DELETE /api/todos/:id
router.delete('/:id', auth, async (req, res, next) => {
  try {
    const { rows: [todo] } = await db.query('SELECT * FROM weekly_todos WHERE id=$1', [req.params.id])
    if (!todo) return res.status(404).json({ error: 'Not found' })
    const canDelete = req.user.role === 'admin' || todo.owner_id === req.user.id
    if (!canDelete) return res.status(403).json({ error: 'Not authorized' })
    await db.query('DELETE FROM weekly_todos WHERE id=$1', [req.params.id])
    res.json({ success: true })
  } catch (err) { next(err) }
})

module.exports = { router, getMondayDate }
