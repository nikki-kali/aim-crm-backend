const express = require('express')
const db = require('../config/db')
const auth = require('../middleware/auth')
const requireAdmin = require('../middleware/requireAdmin')

const router = express.Router()

// GET /api/report-schedules
router.get('/', auth, requireAdmin, async (req, res, next) => {
  try {
    const { rows } = await db.query('SELECT * FROM report_schedules ORDER BY created_at DESC')
    res.json(rows)
  } catch (err) { next(err) }
})

// POST /api/report-schedules
router.post('/', auth, requireAdmin, async (req, res, next) => {
  try {
    const { name, frequency, recipients } = req.body
    if (!name?.trim()) return res.status(400).json({ error: 'Name is required' })
    if (!['daily','weekly','monthly'].includes(frequency)) return res.status(400).json({ error: 'Invalid frequency' })
    if (!Array.isArray(recipients) || recipients.length === 0) return res.status(400).json({ error: 'At least one recipient required' })

    const { rows } = await db.query(
      `INSERT INTO report_schedules (name, frequency, recipients, created_by)
       VALUES ($1,$2,$3,$4) RETURNING *`,
      [name.trim(), frequency, recipients, req.user.id]
    )
    res.status(201).json(rows[0])
  } catch (err) { next(err) }
})

// PUT /api/report-schedules/:id — toggle enabled or update
router.put('/:id', auth, requireAdmin, async (req, res, next) => {
  try {
    const { name, frequency, recipients, enabled } = req.body
    const { rows } = await db.query(
      `UPDATE report_schedules SET name=$1, frequency=$2, recipients=$3, enabled=$4
       WHERE id=$5 RETURNING *`,
      [name, frequency, recipients, enabled !== false, req.params.id]
    )
    if (!rows[0]) return res.status(404).json({ error: 'Schedule not found' })
    res.json(rows[0])
  } catch (err) { next(err) }
})

// DELETE /api/report-schedules/:id
router.delete('/:id', auth, requireAdmin, async (req, res, next) => {
  try {
    await db.query('DELETE FROM report_schedules WHERE id=$1', [req.params.id])
    res.json({ success: true })
  } catch (err) { next(err) }
})

module.exports = router
