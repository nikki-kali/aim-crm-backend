const express = require('express')
const db = require('../config/db')
const auth = require('../middleware/auth')

const router = express.Router()

// GET /api/tasks/my — aggregated "My Tasks" view: every incomplete task
// assigned to the current user, across entity types, for the daily-planning
// page. Only 'client' entity_type is ever actually created today (see
// Clients.jsx), so that's the only join that can produce a name/address —
// tasks on other entity types still show, just without that context.
router.get('/my', auth, async (req, res, next) => {
  try {
    const { rows } = await db.query(
      // to_char (not t.due_date raw) so the response carries a plain
      // YYYY-MM-DD string — the pg driver otherwise hands back a JS Date
      // for the `date` column that gets serialized through the server's
      // local timezone, shifting the calendar day by one depending on
      // server/browser offset. Aliased to the same name as t.* so it
      // overrides the raw column (node-postgres keeps the later value
      // when a query has two same-named fields).
      `SELECT t.*, to_char(t.due_date, 'YYYY-MM-DD') AS due_date,
              cl.doctor_name AS client_name, cl.address AS client_address
       FROM tasks t
       LEFT JOIN clients cl ON t.entity_type = 'client' AND cl.id = t.entity_id
       WHERE t.assigned_to = $1 AND t.completed = false
       ORDER BY t.due_date ASC NULLS LAST`,
      [req.user.id]
    )
    res.json(rows)
  } catch (err) { next(err) }
})

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
    const { entity_type, entity_id, title, notes, due_date, assigned_to, priority } = req.body
    if (!title?.trim()) return res.status(400).json({ error: 'Title is required' })
    const { rows } = await db.query(
      `INSERT INTO tasks (entity_type, entity_id, title, notes, due_date, assigned_to, created_by, priority)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [entity_type || null, entity_id || null, title.trim(), notes || '',
       due_date || null, assigned_to || null, req.user.id, priority || 'normal']
    )
    res.status(201).json(rows[0])
  } catch (err) { next(err) }
})

// PUT /api/tasks/:id
router.put('/:id', auth, async (req, res, next) => {
  try {
    const { title, notes, due_date, assigned_to, completed, priority, entity_type, entity_id } = req.body
    const { rows } = await db.query(
      `UPDATE tasks SET title=$1, notes=$2, due_date=$3, assigned_to=$4,
       completed=$5, completed_at=CASE WHEN $5=true THEN NOW() ELSE NULL END,
       priority=$6, entity_type=$7, entity_id=$8
       WHERE id=$9 RETURNING *`,
      [title, notes || '', due_date || null, assigned_to || null, !!completed,
       priority || 'normal', entity_type || null, entity_id || null, req.params.id]
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
