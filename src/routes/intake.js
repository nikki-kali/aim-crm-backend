const express = require('express')
const db = require('../config/db')
const { scoreFromLead } = require('../services/scoring')

const router = express.Router()

// POST /api/leads/capture — public endpoint (no JWT, API key only)
router.post('/capture', async (req, res, next) => {
  try {
    const apiKey = req.headers['x-api-key']
    if (!apiKey || apiKey !== process.env.LEAD_CAPTURE_API_KEY) {
      return res.status(401).json({ error: 'Invalid API key' })
    }

    const { doctor_name, clinic_name, phone, email, case_interest, source, notes } = req.body
    if (!doctor_name?.trim()) return res.status(400).json({ error: 'doctor_name is required' })
    if (!phone && !email) return res.status(400).json({ error: 'phone or email is required' })

    const leadData = {
      doctor_name: doctor_name.trim(),
      lead_source: source || 'website',
      estimated_value: 0,
      intent_level: 'Medium',
      case_interest: case_interest || '',
    }
    const aiScore = scoreFromLead(leadData)

    const { rows } = await db.query(
      `INSERT INTO leads
        (doctor_name, clinic_name, brand, phone, email, lead_source, referral_source,
         case_interest, notes, status, intent_level, ai_score, created_via, created_at, updated_at, last_contacted_at)
       VALUES ($1,$2,'Aim Dental',$3,$4,$5,$5,$6,$7,'Lead','Medium',$8,'api',NOW(),NOW(),NOW())
       RETURNING id`,
      [doctor_name.trim(), clinic_name || '', phone || '', email || '',
       source || 'website', case_interest || '', notes || '', aiScore]
    )

    res.json({ success: true, id: rows[0].id })
  } catch (err) {
    next(err)
  }
})

module.exports = router
