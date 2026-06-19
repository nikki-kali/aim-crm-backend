const express = require('express')
const db = require('../config/db')
const auth = require('../middleware/auth')

const router = express.Router()

// GET /api/tasks?entity_type=lead&entity_id=xxx
router.get('/', auth, async (req, res, next) => {
  try {
    const { entity_type, entity_id } = req.query
    let query = `SELECT t.*, u.name AS assigned_to_name FROM tasks t
                 LEFT JOIN users u ON u.id = t.assigned_to WHERE 1=1`
    const params = []
    if (entity_type) { params.push(entity_type); query += ` AND t.entity_type=$${params.length}` }
    if (entity_id) { params.push(entity_id); query += ` AND t.entity_id=$${params.length}` }
    query += ' ORDER BY t.completed ASC, t.due_date ASC'
    const { rows } = await db.query(query, params)
    res.json(rows)
  } catch (err) { next(err) }
})

// POST /api/tasks
router.post('/', auth, async (req, res, next) => {
  try {
    const { entity_type, entity_id, title, notes, due_date, assigned_to } = req.body
    if (!title?.trim()) return res.status(400).json({ error: 'Title is required' })
    const { rows } = await db.query(
      `INSERT INTO tasks (entity_type, entity_id, title, notes, due_date, assigned_to, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [entity_type || null, entity_id || null, title.trim(), notes || '',
       due_date || null, assigned_to || null, req.user.id]
    )
    res.status(201).json(rows[0])
  } catch (err) { next(err) }
})

// PUT /api/tasks/:id
router.put('/:id', auth, async (req, res, next) => {
  try {
    const { title, notes, due_date, assigned_to, completed } = req.body
    const { rows } = await db.query(
      `UPDATE tasks SET title=$1, notes=$2, due_date=$3, assigned_to=$4,
       completed=$5, completed_at=CASE WHEN $5=true THEN NOW() ELSE NULL END
       WHERE id=$6 RETURNING *`,
      [title, notes || '', due_date || null, assigned_to || null, !!completed, req.params.id]
    )
    if (!rows[0]) return res.status(404).json({ error: 'Task not found' })
    res.json(rows[0])
  } catch (err) { next(err) }
})

// DELETE /api/tasks/:id
router.delete('/:id', auth, async (req, res, next) => {
  try {
    await db.query('DELETE FROM tasks WHERE id=$1', [req.params.id])
    res.json({ success: true })
  } catch (err) { next(err) }
})

module.exports = router
