const express = require('express')
const db = require('../config/db')
const auth = require('../middleware/auth')
const requireAdmin = require('../middleware/requireAdmin')
const { scoreFromLead } = require('../services/scoring')
const { advancePickupStage } = require('../services/pickupStatus')
const { convertLeadToClient } = require('../services/leadConversion')
const { isScopedRole } = require('../utils/roles')

const router = express.Router()

// POST /api/leads/import
router.post('/import', auth, async (req, res, next) => {
  try {
    const { rows, filename, assigned_to } = req.body
    if (!Array.isArray(rows) || rows.length === 0) return res.status(400).json({ error: 'No rows provided' })

    const assignedTo = isScopedRole(req.user.role) ? req.user.id : (assigned_to || req.user.id)

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
    const view = req.query.view || (isScopedRole(req.user.role) ? 'mine' : 'all')
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

// GET /api/leads/pickups — powers Case Pickup Schedules. Unlike the general
// list above, this isn't staff/admin scoped: pickup requests are lab-wide
// logistics (one truck, one schedule), so every authenticated user sees
// every pickup regardless of who it's assigned to.
router.get('/pickups', auth, async (req, res, next) => {
  try {
    const { rows } = await db.query(
      // pickup_date is cast to text via to_char rather than left as a `date`
      // column — node-pg's default DATE parser builds a local-timezone Date
      // object, which can shift a plain calendar date to the day before once
      // serialized back to JSON (a classic UTC-vs-local off-by-one). Sending
      // 'YYYY-MM-DD' text sidesteps that entirely.
      `SELECT id, doctor_name, clinic_name, brand, phone, email, pickup_status,
              to_char(pickup_date, 'YYYY-MM-DD') AS pickup_date,
              pickup_window, pickup_address, case_count,
              pickup_dispatched_at, pickup_received_at, created_at
       FROM leads
       WHERE case_interest = 'Schedule Pickup'
       ORDER BY pickup_date NULLS LAST, created_at`
    )
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
    const assignedTo = isScopedRole(req.user.role) ? req.user.id : (data.assigned_to || req.user.id)
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

    const { rows: beforeRows } = await db.query(`SELECT status FROM leads WHERE id=$1`, [req.params.id])

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

    if (isScopedRole(req.user.role)) {
      params.push(req.user.id)
      where += ` AND assigned_to=$${params.length}`
    }

    const { rows } = await db.query(`UPDATE leads SET ${set} ${where} RETURNING *`, params)
    if (!rows[0]) return res.status(404).json({ error: 'Lead not found' })

    if (beforeRows[0] && beforeRows[0].status !== rows[0].status) {
      await db.query(
        `INSERT INTO activities (entity_type, entity_id, type, description, created_by)
         VALUES ('lead',$1,'status_change',$2,$3)`,
        [req.params.id, `Status changed to ${rows[0].status}`, req.user.id]
      ).catch(() => {})
    }

    res.json(rows[0])
  } catch (err) { next(err) }
})

// GET /api/leads/:id/activities — timestamped note/status/assignment history
// for one lead, newest first. Scoped the same way as the lead itself so a
// rep can't read history off a lead they don't own.
router.get('/:id/activities', auth, async (req, res, next) => {
  try {
    const ownerClause = isScopedRole(req.user.role) ? 'AND assigned_to=$2' : ''
    const ownerParams = isScopedRole(req.user.role) ? [req.params.id, req.user.id] : [req.params.id]
    const { rows: leadCheck } = await db.query(`SELECT id FROM leads WHERE id=$1 ${ownerClause}`, ownerParams)
    if (!leadCheck[0]) return res.status(404).json({ error: 'Lead not found' })

    const { rows } = await db.query(
      `SELECT a.id, a.type, a.description, a.created_at, u.name AS created_by_name
       FROM activities a LEFT JOIN users u ON u.id = a.created_by
       WHERE a.entity_type='lead' AND a.entity_id=$1
       ORDER BY a.created_at DESC`,
      [req.params.id]
    )
    res.json(rows)
  } catch (err) { next(err) }
})

// POST /api/leads/:id/notes — append-only note, distinct from the single
// overwritable `notes` field on the lead itself. Logged as an activity so
// nothing gets lost as a lead moves through stages.
router.post('/:id/notes', auth, async (req, res, next) => {
  try {
    const text = (req.body.text || '').trim()
    if (!text) return res.status(400).json({ error: 'Note text is required' })

    const ownerClause = isScopedRole(req.user.role) ? 'AND assigned_to=$2' : ''
    const ownerParams = isScopedRole(req.user.role) ? [req.params.id, req.user.id] : [req.params.id]
    const { rows: leadCheck } = await db.query(`SELECT id FROM leads WHERE id=$1 ${ownerClause}`, ownerParams)
    if (!leadCheck[0]) return res.status(404).json({ error: 'Lead not found' })

    const { rows } = await db.query(
      `INSERT INTO activities (entity_type, entity_id, type, description, created_by)
       VALUES ('lead',$1,'note',$2,$3) RETURNING id, type, description, created_at`,
      [req.params.id, text, req.user.id]
    )
    res.status(201).json({ ...rows[0], created_by_name: req.user.name })
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

// DELETE /api/leads/:id/pickup — open to any authenticated user, not just
// admin: pickup requests are lab-wide logistics nobody "owns" (see GET
// /pickups above), so anyone should be able to reject a bogus one (spam or
// mistaken submission) off the schedule. Scoped to leads that are actually
// pickup requests so this can't be used as a side door to delete regular
// leads without admin rights.
router.delete('/:id/pickup', auth, async (req, res, next) => {
  try {
    const { rows } = await db.query(
      `DELETE FROM leads WHERE id=$1 AND case_interest='Schedule Pickup' RETURNING id`,
      [req.params.id]
    )
    if (!rows[0]) return res.status(404).json({ error: 'Pickup not found' })
    res.json({ success: true })
  } catch (err) { next(err) }
})

// POST /api/leads/:id/contacted
router.post('/:id/contacted', auth, async (req, res, next) => {
  try {
    const ownerClause = isScopedRole(req.user.role) ? 'AND assigned_to=$2' : ''
    const params = isScopedRole(req.user.role) ? [req.params.id, req.user.id] : [req.params.id]
    const { rows } = await db.query(
      `UPDATE leads SET last_contacted_at=NOW(), updated_at=NOW() WHERE id=$1 ${ownerClause} RETURNING *`,
      params
    )
    if (!rows[0]) return res.status(404).json({ error: 'Lead not found' })
    await db.query(
      `INSERT INTO activities (entity_type, entity_id, type, description, created_by)
       VALUES ('lead',$1,'contacted','Marked as contacted',$2)`,
      [req.params.id, req.user.id]
    ).catch(() => {})
    res.json(rows[0])
  } catch (err) { next(err) }
})

// POST /api/leads/:id/archive
router.post('/:id/archive', auth, async (req, res, next) => {
  try {
    const ownerClause = isScopedRole(req.user.role) ? 'AND assigned_to=$2' : ''
    const params = isScopedRole(req.user.role) ? [req.params.id, req.user.id] : [req.params.id]
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
    const ownerClause = isScopedRole(req.user.role) ? 'AND assigned_to=$2' : ''
    const params = isScopedRole(req.user.role) ? [req.params.id, req.user.id] : [req.params.id]
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
    const result = await convertLeadToClient(req.params.id, { actorId: req.user.id })
    if (result.notFound) return res.status(404).json({ error: 'Lead not found' })
    if (result.alreadyConverted) return res.status(409).json({ error: 'Lead already converted' })
    res.json({ success: true, client: result.client })
  } catch (err) { next(err) }
})

// POST /api/leads/:id/dispatch — pickup requests only: marks a courier as
// dispatched and emails the requester (stage 2 of 3; stage 1 is sent from
// webLeads.js on submission). Shares advancePickupStage() with the public
// one-click email links in routes/intake.js, since the dashboard isn't in
// regular staff use yet — either path can trigger this stage.
router.post('/:id/dispatch', auth, async (req, res, next) => {
  try {
    const requireAssignedTo = isScopedRole(req.user.role) ? req.user.id : null
    const result = await advancePickupStage(req.params.id, 'dispatched', { requireAssignedTo, actorId: req.user.id })
    if (result.notFound) return res.status(404).json({ error: 'Pickup lead not found' })
    res.json(result.lead)
  } catch (err) { next(err) }
})

// POST /api/leads/:id/receive — pickup requests only: marks the case as
// received at the lab and emails the requester (stage 3 of 3).
router.post('/:id/receive', auth, async (req, res, next) => {
  try {
    const requireAssignedTo = isScopedRole(req.user.role) ? req.user.id : null
    const result = await advancePickupStage(req.params.id, 'received', { requireAssignedTo, actorId: req.user.id })
    if (result.notFound) return res.status(404).json({ error: 'Pickup lead not found' })
    res.json(result.lead)
  } catch (err) { next(err) }
})

module.exports = router
