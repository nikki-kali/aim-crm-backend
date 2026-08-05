const express = require('express')
const db = require('../config/db')
const auth = require('../middleware/auth')

const router = express.Router()

// Admins see the company-wide digest (user_id IS NULL); everyone else sees
// only alerts individually addressed to them (see services/automations.js
// and services/workflowEngine.js for what writes each kind). Staff never
// gets any user_id-tagged rows written for it, so this naturally comes back
// empty for staff without needing a separate case.
router.get('/', auth, async (req, res, next) => {
  try {
    const isAdmin = req.user.role === 'admin'
    const { rows } = await db.query(
      isAdmin
        ? `SELECT * FROM alerts WHERE user_id IS NULL ORDER BY created_at DESC LIMIT 30`
        : `SELECT * FROM alerts WHERE user_id=$1 ORDER BY created_at DESC LIMIT 30`,
      isAdmin ? [] : [req.user.id]
    )
    res.json(rows)
  } catch (err) { next(err) }
})

router.put('/read-all', auth, async (req, res, next) => {
  try {
    const isAdmin = req.user.role === 'admin'
    await db.query(
      isAdmin
        ? `UPDATE alerts SET read=true WHERE user_id IS NULL AND read=false`
        : `UPDATE alerts SET read=true WHERE user_id=$1 AND read=false`,
      isAdmin ? [] : [req.user.id]
    )
    res.json({ success: true })
  } catch (err) { next(err) }
})

router.put('/:id/read', auth, async (req, res, next) => {
  try {
    const isAdmin = req.user.role === 'admin'
    const { rows } = await db.query(
      isAdmin
        ? `UPDATE alerts SET read=true WHERE id=$1 AND user_id IS NULL RETURNING id`
        : `UPDATE alerts SET read=true WHERE id=$1 AND user_id=$2 RETURNING id`,
      isAdmin ? [req.params.id] : [req.params.id, req.user.id]
    )
    if (!rows.length) return res.status(404).json({ error: 'Alert not found' })
    res.json({ success: true })
  } catch (err) { next(err) }
})

router.delete('/read', auth, async (req, res, next) => {
  try {
    const isAdmin = req.user.role === 'admin'
    await db.query(
      isAdmin
        ? `DELETE FROM alerts WHERE read=true AND user_id IS NULL`
        : `DELETE FROM alerts WHERE read=true AND user_id=$1`,
      isAdmin ? [] : [req.user.id]
    )
    res.json({ success: true })
  } catch (err) { next(err) }
})

module.exports = router
