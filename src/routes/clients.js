const express = require('express')
const db = require('../config/db')
const auth = require('../middleware/auth')
const requireAdmin = require('../middleware/requireAdmin')

const router = express.Router()

router.get('/', auth, async (req, res, next) => {
  try {
    let query = `SELECT c.*, u.name AS assigned_to_name FROM clients c LEFT JOIN users u ON u.id = c.assigned_to`
    const params = []
    if (req.user.role === 'staff') {
      query += ` WHERE c.assigned_to = $1`
      params.push(req.user.id)
    } else if (req.query.rep) {
      query += ` WHERE c.assigned_to = $1`
      params.push(req.query.rep)
    }
    query += ' ORDER BY c.total_revenue DESC'
    const { rows } = await db.query(query, params)
    res.json(rows)
  } catch (err) { next(err) }
})

// GET /api/clients/:id — detail with activities, tasks, cases
router.get('/:id', auth, async (req, res, next) => {
  try {
    const { id } = req.params
    const ownerClause = req.user.role === 'staff' ? 'AND assigned_to=$2' : ''
    const clientParams = req.user.role === 'staff' ? [id, req.user.id] : [id]
    const [clientRes, activitiesRes, tasksRes, casesRes] = await Promise.all([
      db.query(`SELECT * FROM clients WHERE id=$1 ${ownerClause}`, clientParams),
      db.query(
        `SELECT a.*, u.name AS created_by_name FROM activities a
         LEFT JOIN users u ON u.id = a.created_by
         WHERE a.entity_type='client' AND a.entity_id=$1
         ORDER BY a.created_at DESC LIMIT 30`,
        [id]
      ),
      db.query(
        `SELECT t.*, u.name AS assigned_to_name FROM tasks t
         LEFT JOIN users u ON u.id = t.assigned_to
         WHERE t.entity_type='client' AND t.entity_id=$1
         ORDER BY t.completed ASC, t.due_date ASC`,
        [id]
      ),
      db.query(
        `SELECT id, case_number, case_type, status, due_date, value, priority
         FROM cases WHERE client_name = (SELECT doctor_name FROM clients WHERE id=$1)
         ORDER BY created_at DESC LIMIT 10`,
        [id]
      ),
    ])
    if (!clientRes.rows[0]) return res.status(404).json({ error: 'Client not found' })
    res.json({
      ...clientRes.rows[0],
      activities: activitiesRes.rows,
      tasks: tasksRes.rows,
      cases: casesRes.rows,
    })
  } catch (err) { next(err) }
})

router.post('/', auth, async (req, res, next) => {
  try {
    const d = req.body
    const assignedTo = req.user.role === 'staff' ? req.user.id : (d.assigned_to || req.user.id)
    const { rows } = await db.query(
      `INSERT INTO clients (doctor_name, clinic_name, brand, phone, email, referral_source,
       total_revenue, case_count, notes, assigned_to, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,NOW(),NOW()) RETURNING *`,
      [d.doctor_name, d.clinic_name || '', d.brand || 'Aim Dental', d.phone || '', d.email || '',
       d.referral_source || '', Number(d.total_revenue) || 0, Number(d.case_count) || 0,
       d.notes || '', assignedTo]
    )
    res.status(201).json(rows[0])
  } catch (err) { next(err) }
})

router.put('/:id', auth, async (req, res, next) => {
  try {
    const d = req.body
    const ownerClause = req.user.role === 'staff' ? `AND assigned_to=$10` : ''
    const params = [d.doctor_name, d.clinic_name || '', d.brand || 'Aim Dental', d.phone || '', d.email || '',
       d.referral_source || '', Number(d.total_revenue) || 0, Number(d.case_count) || 0, d.notes || '', req.params.id]
    if (req.user.role === 'staff') params.push(req.user.id)
    const { rows } = await db.query(
      `UPDATE clients SET doctor_name=$1, clinic_name=$2, brand=$3, phone=$4, email=$5,
       referral_source=$6, total_revenue=$7, case_count=$8, notes=$9, updated_at=NOW()
       WHERE id=$10 ${ownerClause} RETURNING *`,
      params
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
