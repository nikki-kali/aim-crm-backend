const express = require('express')
const db = require('../config/db')
const auth = require('../middleware/auth')
const requireAdmin = require('../middleware/requireAdmin')
const { generateCaseNumber } = require('../utils/caseNumber')

const router = express.Router()

router.get('/', auth, async (req, res, next) => {
  try {
    const { rows } = await db.query('SELECT * FROM cases ORDER BY due_date ASC')
    res.json(rows)
  } catch (err) { next(err) }
})

router.post('/', auth, async (req, res, next) => {
  try {
    const d = req.body
    if (!d.client_name?.trim()) return res.status(400).json({ error: 'Client name is required' })
    if (!d.due_date) return res.status(400).json({ error: 'Due date is required' })

    const caseNumber = d.case_number?.trim() || await generateCaseNumber(d.brand || 'Aim Dental')

    const { rows } = await db.query(
      `INSERT INTO cases (case_number, client_name, brand, case_type, due_date, value, priority, status, notes, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,NOW(),NOW()) RETURNING *`,
      [caseNumber, d.client_name.trim(), d.brand || 'Aim Dental', d.case_type || 'Crown & Bridge',
       d.due_date, Number(d.value) || 0, d.priority || 'Normal', d.status || 'Pending', d.notes || '']
    )
    res.status(201).json(rows[0])
  } catch (err) { next(err) }
})

router.put('/:id', auth, async (req, res, next) => {
  try {
    const d = req.body
    const { rows } = await db.query(
      `UPDATE cases SET case_number=$1, client_name=$2, brand=$3, case_type=$4, due_date=$5,
       value=$6, priority=$7, status=$8, notes=$9, updated_at=NOW() WHERE id=$10 RETURNING *`,
      [d.case_number, d.client_name, d.brand, d.case_type, d.due_date,
       Number(d.value) || 0, d.priority, d.status, d.notes || '', req.params.id]
    )
    if (!rows[0]) return res.status(404).json({ error: 'Case not found' })
    res.json(rows[0])
  } catch (err) { next(err) }
})

router.delete('/:id', auth, requireAdmin, async (req, res, next) => {
  try {
    await db.query('DELETE FROM cases WHERE id=$1', [req.params.id])
    res.json({ success: true })
  } catch (err) { next(err) }
})

module.exports = router
