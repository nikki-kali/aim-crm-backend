const express = require('express')
const db = require('../config/db')
const auth = require('../middleware/auth')
const requireAdmin = require('../middleware/requireAdmin')

const router = express.Router()

// GET /api/clinics
router.get('/', auth, async (req, res, next) => {
  try {
    const { search, brand } = req.query
    let query = 'SELECT * FROM clinics WHERE 1=1'
    const params = []
    if (brand && brand !== 'All') { params.push(brand); query += ` AND brand=$${params.length}` }
    if (search) { params.push(`%${search}%`); query += ` AND name ILIKE $${params.length}` }
    query += ' ORDER BY name ASC'
    const { rows } = await db.query(query, params)
    res.json(rows)
  } catch (err) { next(err) }
})

// GET /api/clinics/:id — clinic detail with linked records
router.get('/:id', auth, async (req, res, next) => {
  try {
    const { id } = req.params
    const [clinicRes, leadsRes, casesRes, activitiesRes, tasksRes] = await Promise.all([
      db.query('SELECT * FROM clinics WHERE id=$1', [id]),
      db.query(`SELECT id, doctor_name, status, ai_score, estimated_value, created_at
                FROM leads WHERE clinic_id=$1 ORDER BY created_at DESC`, [id]),
      db.query(`SELECT id, case_number, client_name, case_type, status, due_date, value
                FROM cases WHERE clinic_id=$1 ORDER BY due_date ASC`, [id]),
      db.query(`SELECT a.*, u.name AS created_by_name FROM activities a
                LEFT JOIN users u ON u.id=a.created_by
                WHERE a.entity_type='clinic' AND a.entity_id=$1
                ORDER BY a.created_at DESC LIMIT 20`, [id]),
      db.query(`SELECT t.*, u.name AS assigned_to_name FROM tasks t
                LEFT JOIN users u ON u.id=t.assigned_to
                WHERE t.entity_type='clinic' AND t.entity_id=$1
                ORDER BY t.due_date ASC`, [id]),
    ])
    if (!clinicRes.rows[0]) return res.status(404).json({ error: 'Clinic not found' })
    res.json({
      ...clinicRes.rows[0],
      leads: leadsRes.rows,
      cases: casesRes.rows,
      activities: activitiesRes.rows,
      tasks: tasksRes.rows,
    })
  } catch (err) { next(err) }
})

// POST /api/clinics
router.post('/', auth, async (req, res, next) => {
  try {
    const d = req.body
    if (!d.name?.trim()) return res.status(400).json({ error: 'Clinic name is required' })
    const { rows } = await db.query(
      `INSERT INTO clinics (name, brand, address, phone, email, website, lead_source, notes, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,NOW(),NOW()) RETURNING *`,
      [d.name.trim(), d.brand || 'Aim Dental', d.address || '', d.phone || '',
       d.email || '', d.website || '', d.lead_source || '', d.notes || '']
    )
    res.status(201).json(rows[0])
  } catch (err) { next(err) }
})

// PUT /api/clinics/:id
router.put('/:id', auth, async (req, res, next) => {
  try {
    const d = req.body
    const { rows } = await db.query(
      `UPDATE clinics SET name=$1, brand=$2, address=$3, phone=$4, email=$5,
       website=$6, lead_source=$7, notes=$8, updated_at=NOW() WHERE id=$9 RETURNING *`,
      [d.name, d.brand || 'Aim Dental', d.address || '', d.phone || '',
       d.email || '', d.website || '', d.lead_source || '', d.notes || '', req.params.id]
    )
    if (!rows[0]) return res.status(404).json({ error: 'Clinic not found' })
    res.json(rows[0])
  } catch (err) { next(err) }
})

// GET /api/clinics/:id/notification-prefs
router.get('/:id/notification-prefs', auth, async (req, res, next) => {
  try {
    const { rows } = await db.query(
      'SELECT * FROM clinic_notification_prefs WHERE clinic_id=$1', [req.params.id]
    )
    res.json(rows)
  } catch (err) { next(err) }
})

// PUT /api/clinics/:id/notification-prefs — upsert a stage toggle
router.put('/:id/notification-prefs', auth, async (req, res, next) => {
  try {
    const { stage, enabled } = req.body
    await db.query(
      `INSERT INTO clinic_notification_prefs (clinic_id, stage, enabled)
       VALUES ($1,$2,$3)
       ON CONFLICT (clinic_id, stage) DO UPDATE SET enabled=$3`,
      [req.params.id, stage, enabled !== false]
    )
    res.json({ success: true })
  } catch (err) { next(err) }
})

// DELETE /api/clinics/:id (admin only)
router.delete('/:id', auth, requireAdmin, async (req, res, next) => {
  try {
    await db.query('DELETE FROM clinics WHERE id=$1', [req.params.id])
    res.json({ success: true })
  } catch (err) { next(err) }
})

module.exports = router
