const express = require('express')
const db = require('../config/db')
const auth = require('../middleware/auth')

const router = express.Router()

router.get('/', auth, async (req, res, next) => {
  try {
    const { rows } = await db.query(
      'SELECT * FROM alerts ORDER BY created_at DESC LIMIT 30'
    )
    res.json(rows)
  } catch (err) { next(err) }
})

router.put('/read-all', auth, async (req, res, next) => {
  try {
    await db.query('UPDATE alerts SET read=true WHERE read=false')
    res.json({ success: true })
  } catch (err) { next(err) }
})

router.put('/:id/read', auth, async (req, res, next) => {
  try {
    await db.query('UPDATE alerts SET read=true WHERE id=$1', [req.params.id])
    res.json({ success: true })
  } catch (err) { next(err) }
})

router.delete('/read', auth, async (req, res, next) => {
  try {
    await db.query('DELETE FROM alerts WHERE read=true')
    res.json({ success: true })
  } catch (err) { next(err) }
})

module.exports = router
