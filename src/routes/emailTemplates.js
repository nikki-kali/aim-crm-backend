const express = require('express')
const db = require('../config/db')
const auth = require('../middleware/auth')
const requireAdmin = require('../middleware/requireAdmin')

const router = express.Router()

// GET /api/email-templates
router.get('/', auth, async (req, res, next) => {
  try {
    const { rows } = await db.query('SELECT * FROM email_templates ORDER BY stage ASC')
    res.json(rows)
  } catch (err) { next(err) }
})

// PUT /api/email-templates/:id
router.put('/:id', auth, requireAdmin, async (req, res, next) => {
  try {
    const { subject, body_html, enabled } = req.body
    const { rows } = await db.query(
      `UPDATE email_templates SET subject=$1, body_html=$2, enabled=$3, updated_at=NOW()
       WHERE id=$4 RETURNING *`,
      [subject, body_html, enabled !== false, req.params.id]
    )
    if (!rows[0]) return res.status(404).json({ error: 'Template not found' })
    res.json(rows[0])
  } catch (err) { next(err) }
})

module.exports = router
