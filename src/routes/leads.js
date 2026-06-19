const express = require('express')
const db = require('../config/db')
const auth = require('../middleware/auth')
const requireAdmin = require('../middleware/requireAdmin')
const { scoreFromLead } = require('../services/scoring')

const router = express.Router()

// POST /api/leads/import — accepts parsed rows as JSON, deduplicates, bulk inserts
router.post('/import', auth, async (req, res, next) => {
  try {
    const { rows, filename } = req.body
    if (!Array.isArray(rows) || rows.length === 0) {
      return res.status(400).json({ error: 'No rows provided' })
    }

    const { rows: existing } = await db.query(
      `SELECT email FROM leads WHERE email IS NOT NULL AND email != ''`
    )
    const existingEmails = new Set(existing.map(r => r.email.toLowerCase().trim()))

    const now = new Date().toISOString()
    const toInsert = []
    let skipped = 0

    for (const row of rows) {
      if (row.email && existingEmails.has(row.email.toLowerCase().trim())) {
        skipped++
        continue
      }
      const val = Number(row.estimated_value) || 0
      toInsert.push({ ...row, estimated_value: val, ai_score: scoreFromLead({ ...row, estimated_value: val }) })
    }

    let added = 0
    if (toInsert.length > 0) {
      for (const row of toInsert) {
        await db.query(
          `INSERT INTO leads (doctor_name, clinic_name, brand, case_interest, phone, email,
           referral_source, estimated_value, notes, status, intent_level, ai_score,
           last_contacted_at, created_at, updated_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$13,$13)`,
          [row.doctor_name, row.clinic_name || '', row.brand || 'Aim Dental', row.case_interest || '',
           row.phone || '', row.email || '', row.lead_source || '', row.estimated_value,
           row.notes || '', 'Lead', row.intent_level || 'Medium', row.ai_score, now]
        )
        added++
      }
      // Log import history
      await db.query(
        `INSERT INTO import_history (filename, added, skipped, imported_by) VALUES ($1,$2,$3,$4)`,
        [filename || 'unknown.csv', added, skipped, req.user.id]
      ).catch(() => {}) // non-fatal if import_history table not ready
    }

    res.json({ added, skipped })
  } catch (err) { next(err) }
})

// GET /api/leads
router.get('/', auth, async (req, res, next) => {
  try {
    const { brand, status, search } = req.query
    let query = 'SELECT * FROM leads WHERE 1=1'
    const params = []

    if (brand && brand !== 'All') {
      params.push(brand)
      query += ` AND brand = $${params.length}`
    }
    if (status && status !== 'All') {
      params.push(status)
      query += ` AND status = $${params.length}`
    }
    if (search) {
      params.push(`%${search}%`)
      query += ` AND (doctor_name ILIKE $${params.length} OR clinic_name ILIKE $${params.length} OR case_interest ILIKE $${params.length})`
    }

    query += ' ORDER BY created_at DESC'
    const { rows } = await db.query(query, params)
    res.json(rows)
  } catch (err) {
    next(err)
  }
})

// POST /api/leads
router.post('/', auth, async (req, res, next) => {
  try {
    const data = req.body
    if (!data.doctor_name?.trim()) {
      return res.status(400).json({ error: 'Doctor name is required' })
    }
    const estimatedValue = Number(data.estimated_value) || 0
    const aiScore = scoreFromLead({ ...data, estimated_value: estimatedValue })
    const now = new Date().toISOString()

    const { rows } = await db.query(
      `INSERT INTO leads
        (doctor_name, clinic_name, brand, case_interest, phone, email,
         lead_source, referral_source, estimated_value, status, intent_level,
         notes, ai_score, last_contacted_at, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$7,$8,$9,$10,$11,$12,$13,$14,$14)
       RETURNING *`,
      [
        data.doctor_name.trim(),
        data.clinic_name || '',
        data.brand || 'Aim Dental',
        data.case_interest || '',
        data.phone || '',
        data.email || '',
        data.lead_source || '',
        estimatedValue,
        data.status || 'Lead',
        data.intent_level || 'Medium',
        data.notes || '',
        aiScore,
        data.last_contacted_at || now,
      ]
    )
    res.status(201).json(rows[0])
  } catch (err) {
    next(err)
  }
})

// PUT /api/leads/:id
router.put('/:id', auth, async (req, res, next) => {
  try {
    const data = req.body
    const estimatedValue = Number(data.estimated_value) || 0
    const aiScore = scoreFromLead({ ...data, estimated_value: estimatedValue })

    const { rows } = await db.query(
      `UPDATE leads SET
        doctor_name=$1, clinic_name=$2, brand=$3, case_interest=$4,
        phone=$5, email=$6, lead_source=$7, referral_source=$7,
        estimated_value=$8, status=$9, intent_level=$10,
        notes=$11, ai_score=$12, updated_at=NOW()
       WHERE id=$13 RETURNING *`,
      [
        data.doctor_name,
        data.clinic_name || '',
        data.brand || 'Aim Dental',
        data.case_interest || '',
        data.phone || '',
        data.email || '',
        data.lead_source || '',
        estimatedValue,
        data.status || 'Lead',
        data.intent_level || 'Medium',
        data.notes || '',
        aiScore,
        req.params.id,
      ]
    )
    if (!rows[0]) return res.status(404).json({ error: 'Lead not found' })
    res.json(rows[0])
  } catch (err) {
    next(err)
  }
})

// DELETE /api/leads/:id  (admin only)
router.delete('/:id', auth, requireAdmin, async (req, res, next) => {
  try {
    await db.query('DELETE FROM leads WHERE id=$1', [req.params.id])
    res.json({ success: true })
  } catch (err) {
    next(err)
  }
})

// POST /api/leads/:id/contacted
router.post('/:id/contacted', auth, async (req, res, next) => {
  try {
    const { rows } = await db.query(
      'UPDATE leads SET last_contacted_at=NOW(), updated_at=NOW() WHERE id=$1 RETURNING *',
      [req.params.id]
    )
    if (!rows[0]) return res.status(404).json({ error: 'Lead not found' })
    res.json(rows[0])
  } catch (err) {
    next(err)
  }
})

module.exports = router
