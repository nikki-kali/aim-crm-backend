const express = require('express')
const db = require('../config/db')
const auth = require('../middleware/auth')
const requireAdmin = require('../middleware/requireAdmin')
const { scoreFromLead } = require('../services/scoring')

const router = express.Router()

// POST /api/leads/import
router.post('/import', auth, async (req, res, next) => {
  try {
    const { rows, filename, assigned_to } = req.body
    if (!Array.isArray(rows) || rows.length === 0) return res.status(400).json({ error: 'No rows provided' })

    const assignedTo = req.user.role === 'staff' ? req.user.id : (assigned_to || req.user.id)

    const { rows: existing } = await db.query(`SELECT email FROM leads WHERE email IS NOT NULL AND email != ''`)
    const existingEmails = new Set(existing.map(r => r.email.toLowerCase().trim()))
    const now = new Date().toISOString()

    const toInsert = []
    let skipped = 0
    for (const row of rows) {
      if (row.email && existingEmails.has(row.email.toLowerCase().trim())) { skipped++; continue }
      const val = Number(row.estimated_value) || 0
      toInsert.push({ ...row, estimated_value: val, ai_score: scoreFromLead({ ...row, estimated_value: val }) })
    }

    let added = 0
    // Batch INSERT in chunks of 500 to stay within pg parameter limits
    const CHUNK = 500
    const COLS = 14
    for (let i = 0; i < toInsert.length; i += CHUNK) {
      const chunk = toInsert.slice(i, i + CHUNK)
      const values = []
      const placeholders = chunk.map((row, j) => {
        const base = j * COLS
        values.push(
          row.doctor_name,
          row.clinic_name || '',
          row.brand || 'Aim Dental',
          row.case_interest || '',
          row.phone || '',
          row.email || '',
          row.lead_source || '',
          row.estimated_value,
          row.notes || '',
          row.status || 'Lead',
          row.intent_level || 'Medium',
          row.ai_score,
          assignedTo,
          now
        )
        return `($${base+1},$${base+2},$${base+3},$${base+4},$${base+5},$${base+6},$${base+7},$${base+8},$${base+9},$${base+10},$${base+11},$${base+12},$${base+13},$${base+14},$${base+14},$${base+14})`
      })
      await db.query(
        `INSERT INTO leads (doctor_name, clinic_name, brand, case_interest, phone, email,
         referral_source, estimated_value, notes, status, intent_level, ai_score,
         assigned_to, last_contacted_at, created_at, updated_at)
         VALUES ${placeholders.join(',')}`,
        values
      )
      added += chunk.length
    }

    await db.query(`INSERT INTO import_history (filename, added, skipped, imported_by) VALUES ($1,$2,$3,$4)`,
      [filename || 'unknown.csv', added, skipped, req.user.id]).catch(() => {})
    res.json({ added, skipped })
  } catch (err) { next(err) }
})

// GET /api/leads
router.get('/', auth, async (req, res, next) => {
  try {
    const { brand, status, search, archived } = req.query
    let query = `SELECT l.*, u.name AS assigned_to_name FROM leads l LEFT JOIN users u ON u.id = l.assigned_to WHERE l.is_archived = $1`
    const params = [archived === 'true']

    // ?view=mine|all|unassigned; default: staff→mine, admin→all
    const view = req.query.view || (req.user.role === 'staff' ? 'mine' : 'all')
    if (view === 'mine') {
      params.push(req.user.id)
      query += ` AND l.assigned_to = $${params.length}`
    } else if (view === 'unassigned') {
      query += ` AND l.assigned_to IS NULL`
    } else {
      // 'all' view — admin can still narrow by ?rep=
      if (req.query.rep) {
        params.push(req.query.rep)
        query += ` AND l.assigned_to = $${params.length}`
      }
    }

    if (brand && brand !== 'All') { params.push(brand); query += ` AND l.brand = $${params.length}` }
    if (status && status !== 'All') { params.push(status); query += ` AND l.status = $${params.length}` }
    if (search) {
      params.push(`%${search}%`)
      query += ` AND (l.doctor_name ILIKE $${params.length} OR l.clinic_name ILIKE $${params.length} OR l.case_interest ILIKE $${params.length})`
    }
    query += ' ORDER BY l.created_at DESC'
    const { rows } = await db.query(query, params)
    res.json(rows)
  } catch (err) { next(err) }
})

// POST /api/leads
router.post('/', auth, async (req, res, next) => {
  try {
    const data = req.body
    if (!data.doctor_name?.trim()) return res.status(400).json({ error: 'Doctor name is required' })
    const estimatedValue = Number(data.estimated_value) || 0
    const aiScore = scoreFromLead({ ...data, estimated_value: estimatedValue })
    const now = new Date().toISOString()
    const assignedTo = req.user.role === 'staff' ? req.user.id : (data.assigned_to || req.user.id)
    const { rows } = await db.query(
      `INSERT INTO leads (doctor_name, clinic_name, brand, case_interest, phone, email,
       lead_source, referral_source, estimated_value, status, intent_level, notes,
       ai_score, assigned_to, last_contacted_at, created_via, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$16) RETURNING *`,
      [data.doctor_name.trim(), data.clinic_name || '', data.brand || 'Aim Dental',
       data.case_interest || '', data.phone || '', data.email || '', data.lead_source || '',
       estimatedValue, data.status || 'Lead', data.intent_level || 'Medium', data.notes || '',
       aiScore, assignedTo, data.last_contacted_at || now, data.created_via || 'manual', now]
    )
    res.status(201).json(rows[0])
  } catch (err) { next(err) }
})

// PUT /api/leads/:id
router.put('/:id', auth, async (req, res, next) => {
  try {
    const data = req.body
    const estimatedValue = Number(data.estimated_value) || 0
    const aiScore = scoreFromLead({ ...data, estimated_value: estimatedValue })

    const params = [
      data.doctor_name, data.clinic_name || '', data.brand || 'Aim Dental',
      data.case_interest || '', data.phone || '', data.email || '', data.lead_source || '',
      estimatedValue, data.status || 'Lead', data.intent_level || 'Medium',
      data.notes || '', aiScore,
    ] // $1–$12

    let set = `doctor_name=$1, clinic_name=$2, brand=$3, case_interest=$4,
      phone=$5, email=$6, lead_source=$7, referral_source=$7, estimated_value=$8,
      status=$9, intent_level=$10, notes=$11, ai_score=$12, updated_at=NOW()`

    if (req.user.role === 'admin' && data.assigned_to !== undefined) {
      params.push(data.assigned_to)
      set += `, assigned_to=$${params.length}`
    }

    params.push(req.params.id)
    let where = `WHERE id=$${params.length}`

    if (req.user.role === 'staff') {
      params.push(req.user.id)
      where += ` AND assigned_to=$${params.length}`
    }

    const { rows } = await db.query(`UPDATE leads SET ${set} ${where} RETURNING *`, params)
    if (!rows[0]) return res.status(404).json({ error: 'Lead not found' })
    res.json(rows[0])
  } catch (err) { next(err) }
})

// PUT /api/leads/:id/assign — any authenticated user can reassign any lead
router.put('/:id/assign', auth, async (req, res, next) => {
  try {
    const { assigned_to } = req.body
    const { rows } = await db.query(
      'UPDATE leads SET assigned_to=$1, updated_at=NOW() WHERE id=$2 RETURNING *',
      [assigned_to || null, req.params.id]
    )
    if (!rows[0]) return res.status(404).json({ error: 'Lead not found' })

    let desc = 'Lead unassigned'
    if (assigned_to) {
      const { rows: uRows } = await db.query('SELECT name FROM users WHERE id=$1', [assigned_to])
      desc = `Lead assigned to ${uRows[0]?.name || assigned_to}`
    }
    await db.query(
      `INSERT INTO activities (entity_type, entity_id, type, description, created_by)
       VALUES ('lead',$1,'assigned',$2,$3)`,
      [req.params.id, desc, req.user.id]
    ).catch(() => {})

    res.json(rows[0])
  } catch (err) { next(err) }
})

// DELETE /api/leads/:id (admin only)
router.delete('/:id', auth, requireAdmin, async (req, res, next) => {
  try {
    await db.query('DELETE FROM leads WHERE id=$1', [req.params.id])
    res.json({ success: true })
  } catch (err) { next(err) }
})

// POST /api/leads/:id/contacted
router.post('/:id/contacted', auth, async (req, res, next) => {
  try {
    const ownerClause = req.user.role === 'staff' ? 'AND assigned_to=$2' : ''
    const params = req.user.role === 'staff' ? [req.params.id, req.user.id] : [req.params.id]
    const { rows } = await db.query(
      `UPDATE leads SET last_contacted_at=NOW(), updated_at=NOW() WHERE id=$1 ${ownerClause} RETURNING *`,
      params
    )
    if (!rows[0]) return res.status(404).json({ error: 'Lead not found' })
    res.json(rows[0])
  } catch (err) { next(err) }
})

// POST /api/leads/:id/archive
router.post('/:id/archive', auth, async (req, res, next) => {
  try {
    const ownerClause = req.user.role === 'staff' ? 'AND assigned_to=$2' : ''
    const params = req.user.role === 'staff' ? [req.params.id, req.user.id] : [req.params.id]
    const { rows } = await db.query(
      `UPDATE leads SET is_archived=true, updated_at=NOW() WHERE id=$1 ${ownerClause} RETURNING *`,
      params
    )
    if (!rows[0]) return res.status(404).json({ error: 'Lead not found' })
    await db.query(
      `INSERT INTO activities (entity_type, entity_id, type, description, created_by)
       VALUES ('lead',$1,'archived','Lead archived',$2)`,
      [req.params.id, req.user.id]
    ).catch(() => {})
    res.json(rows[0])
  } catch (err) { next(err) }
})

// POST /api/leads/:id/unarchive
router.post('/:id/unarchive', auth, async (req, res, next) => {
  try {
    const ownerClause = req.user.role === 'staff' ? 'AND assigned_to=$2' : ''
    const params = req.user.role === 'staff' ? [req.params.id, req.user.id] : [req.params.id]
    const { rows } = await db.query(
      `UPDATE leads SET is_archived=false, updated_at=NOW() WHERE id=$1 ${ownerClause} RETURNING *`,
      params
    )
    if (!rows[0]) return res.status(404).json({ error: 'Lead not found' })
    res.json(rows[0])
  } catch (err) { next(err) }
})

// POST /api/leads/:id/convert — lead-to-client auto-conversion
router.post('/:id/convert', auth, async (req, res, next) => {
  try {
    const { rows: leadRows } = await db.query('SELECT * FROM leads WHERE id=$1', [req.params.id])
    const lead = leadRows[0]
    if (!lead) return res.status(404).json({ error: 'Lead not found' })
    if (lead.converted_to_client_id) return res.status(409).json({ error: 'Lead already converted' })

    // Create client from lead data, inheriting the same assigned_to
    const { rows: clientRows } = await db.query(
      `INSERT INTO clients (doctor_name, clinic_name, brand, phone, email, referral_source,
       lead_source, notes, original_lead_id, assigned_to, total_revenue, case_count, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$6,$7,$8,$9,$10,0,NOW(),NOW()) RETURNING *`,
      [lead.doctor_name, lead.clinic_name || '', lead.brand || 'Aim Dental',
       lead.phone || '', lead.email || '', lead.referral_source || lead.lead_source || '',
       lead.notes || '', lead.id, lead.assigned_to, Number(lead.estimated_value) || 0]
    )
    const client = clientRows[0]

    await db.query(
      `UPDATE leads SET converted_to_client_id=$1, status='Won', updated_at=NOW() WHERE id=$2`,
      [client.id, lead.id]
    )

    await db.query(
      `INSERT INTO activities (entity_type, entity_id, type, description, created_by) VALUES
       ('lead',$1,'converted','Lead converted to client',$3),
       ('client',$2,'converted','Client created from lead conversion',$3)`,
      [lead.id, client.id, req.user.id]
    ).catch(() => {})

    res.json({ success: true, client })
  } catch (err) { next(err) }
})

module.exports = router
