const express = require('express')
const db = require('../config/db')
const auth = require('../middleware/auth')
const requireAdmin = require('../middleware/requireAdmin')

const router = express.Router()

router.get('/', auth, async (req, res, next) => {
  try {
    const { rows } = await db.query('SELECT * FROM clients ORDER BY total_revenue DESC')
    res.json(rows)
  } catch (err) { next(err) }
})

router.post('/', auth, async (req, res, next) => {
  try {
    const d = req.body
    const { rows } = await db.query(
      `INSERT INTO clients (doctor_name, clinic_name, brand, phone, email, referral_source, total_revenue, case_count, notes, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,NOW(),NOW()) RETURNING *`,
      [d.doctor_name, d.clinic_name || '', d.brand || 'Aim Dental', d.phone || '', d.email || '',
       d.referral_source || '', Number(d.total_revenue) || 0, Number(d.case_count) || 0, d.notes || '']
    )
    res.status(201).json(rows[0])
  } catch (err) { next(err) }
})

router.put('/:id', auth, async (req, res, next) => {
  try {
    const d = req.body
    const { rows } = await db.query(
      `UPDATE clients SET doctor_name=$1, clinic_name=$2, brand=$3, phone=$4, email=$5,
       referral_source=$6, total_revenue=$7, case_count=$8, notes=$9, updated_at=NOW()
       WHERE id=$10 RETURNING *`,
      [d.doctor_name, d.clinic_name || '', d.brand || 'Aim Dental', d.phone || '', d.email || '',
       d.referral_source || '', Number(d.total_revenue) || 0, Number(d.case_count) || 0, d.notes || '', req.params.id]
    )
    if (!rows[0]) return res.status(404).json({ error: 'Client not found' })
    res.json(rows[0])
  } catch (err) { next(err) }
})

router.delete('/:id', auth, requireAdmin, async (req, res, next) => {
  try {
    await db.query('DELETE FROM clients WHERE id=$1', [req.params.id])
    res.json({ success: true })
  } catch (err) { next(err) }
})

module.exports = router
