const express = require('express')
const db = require('../config/db')
const auth = require('../middleware/auth')

const router = express.Router()
const STATUSES = ['', 'approved', 'edit', 'rejected']

function mapRow(row) {
  return {
    postId: row.post_id,
    status: row.status,
    feedback: row.feedback,
    reviewer: row.reviewer,
    updated: row.updated_at,
  }
}

// GET /api/content-approval-decisions — every post's decision
router.get('/', auth, async (req, res, next) => {
  try {
    const { rows } = await db.query('select * from content_approval_decisions order by post_id')
    res.json({ decisions: rows.map(mapRow) })
  } catch (err) {
    next(err)
  }
})

// PUT /api/content-approval-decisions/:postId — upsert one post's decision
router.put('/:postId', auth, async (req, res, next) => {
  try {
    const { status = '', feedback = '', reviewer = '' } = req.body || {}
    if (!STATUSES.includes(status)) return res.status(400).json({ error: 'Invalid status' })
    if (String(feedback).length > 4000 || String(reviewer).length > 200) {
      return res.status(400).json({ error: 'Feedback or reviewer name is too long' })
    }
    const { rows } = await db.query(
      `insert into content_approval_decisions (post_id, status, feedback, reviewer, updated_at)
       values ($1, $2, $3, $4, now())
       on conflict (post_id) do update
         set status = excluded.status, feedback = excluded.feedback,
             reviewer = excluded.reviewer, updated_at = now()
       returning *`,
      [req.params.postId, status, String(feedback), String(reviewer)]
    )
    res.json({ decision: mapRow(rows[0]) })
  } catch (err) {
    next(err)
  }
})

module.exports = router
