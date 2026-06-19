const express = require('express')
const db = require('../config/db')
const auth = require('../middleware/auth')
const { runAutomationLogic } = require('../services/automations')

const router = express.Router()

router.get('/', auth, async (req, res, next) => {
  try {
    const { rows } = await db.query('SELECT * FROM automations ORDER BY created_at')
    res.json(rows)
  } catch (err) { next(err) }
})

router.put('/:id', auth, async (req, res, next) => {
  try {
    const { enabled } = req.body
    const { rows } = await db.query(
      'UPDATE automations SET enabled=$1 WHERE id=$2 RETURNING *',
      [enabled, req.params.id]
    )
    res.json(rows[0])
  } catch (err) { next(err) }
})

// POST /api/automations/run — run all enabled automations
router.post('/run', auth, async (req, res, next) => {
  try {
    const { rows } = await db.query('SELECT * FROM automations WHERE enabled=true')
    const results = {}
    for (const auto of rows) {
      results[auto.key] = await runAutomationLogic(auto.key)
      await db.query(
        'UPDATE automations SET last_run_at=NOW(), run_count=run_count+1 WHERE id=$1',
        [auto.id]
      )
    }
    res.json(results)
  } catch (err) { next(err) }
})

// POST /api/automations/run/:key — run single automation
router.post('/run/:key', auth, async (req, res, next) => {
  try {
    const result = await runAutomationLogic(req.params.key)
    await db.query(
      'UPDATE automations SET last_run_at=NOW(), run_count=run_count+1 WHERE key=$1',
      [req.params.key]
    )
    res.json(result)
  } catch (err) { next(err) }
})

module.exports = router
