const express = require('express')
const db = require('../config/db')
const auth = require('../middleware/auth')

const router = express.Router()
const STATUSES = ['', 'approved', 'edit', 'rejected']
// Fixed allowlist of review-able posts for the October review. A postId
// outside this set is rejected rather than silently creating an arbitrary
// row, since the id also becomes the table's primary key.
const POST_IDS = ['oct05', 'oct09', 'oct11', 'scanner', 'oct13', 'oct23', 'oct27', 'oct31']

function mapRow(row) {
  return {
    postId: row.post_id,
    status: row.status,
    feedback: row.feedback,
    reviewer: row.reviewer,
    reviewerId: row.reviewer_id,
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

// PUT /api/content-approval-decisions/:postId — upsert one post's decision.
// The reviewer identity comes from the verified JWT (req.user), never from
// the request body, so the audit trail can't be spoofed by typing someone
// else's name. `feedback` is the only free-text field a client controls.
router.put('/:postId', auth, async (req, res, next) => {
  try {
    const { postId } = req.params
    if (!POST_IDS.includes(postId)) {
      return res.status(400).json({ error: 'Unknown post id' })
    }
    const { status = '' } = req.body || {}
    const feedback = typeof req.body?.feedback === 'string' ? req.body.feedback : ''
    if (!STATUSES.includes(status)) {
      return res.status(400).json({ error: 'Invalid status' })
    }
    if (feedback.length > 4000) {
      return res.status(400).json({ error: 'Feedback is too long' })
    }
    const reviewerName = req.user?.name || req.user?.email || 'Unknown'
    const reviewerId = req.user?.id ?? null

    const { rows } = await db.query(
      `insert into content_approval_decisions (post_id, status, feedback, reviewer, reviewer_id, updated_at)
       values ($1, $2, $3, $4, $5, now())
       on conflict (post_id) do update
         set status = excluded.status, feedback = excluded.feedback,
             reviewer = excluded.reviewer, reviewer_id = excluded.reviewer_id,
             updated_at = now()
       returning *`,
      [postId, status, feedback, reviewerName, reviewerId]
    )
    res.json({ decision: mapRow(rows[0]) })
  } catch (err) {
    next(err)
  }
})

module.exports = router
