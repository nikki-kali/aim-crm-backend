const express = require('express')
const db = require('../config/db')
const jwt = require('jsonwebtoken')

const router = express.Router()
const STATUSES = ['', 'approved', 'edit', 'rejected']
// Fixed allowlist of review-able posts for the October review. A postId
// outside this set is rejected rather than silently creating an arbitrary
// row, since the id also becomes the table's primary key.
const POST_IDS = ['oct05', 'oct09', 'oct11', 'scanner', 'oct13', 'oct23', 'oct23-video', 'oct27', 'oct31']

// The review page is open to anyone with the link (no sign-in required).
// A valid token, if one is sent, still identifies the reviewer; otherwise
// the reviewer types a name, which is stored marked as unverified.
function optionalUser(req) {
  const header = req.headers.authorization
  if (!header?.startsWith('Bearer ')) return null
  try {
    return jwt.verify(header.slice(7), process.env.JWT_SECRET)
  } catch {
    return null
  }
}

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
router.get('/', async (req, res, next) => {
  try {
    const { rows } = await db.query('select * from content_approval_decisions order by post_id')
    res.json({ decisions: rows.map(mapRow) })
  } catch (err) {
    next(err)
  }
})

// PUT /api/content-approval-decisions/:postId — upsert one post's decision.
// Signed-in reviewers are identified from the verified JWT. Anyone else must
// send `reviewerName`; it is saved with a "(not signed in)" suffix so the
// audit trail never presents a typed name as a verified one.
router.put('/:postId', async (req, res, next) => {
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
    const user = optionalUser(req)
    let reviewerName
    if (user) {
      reviewerName = user.name || user.email || 'Unknown'
    } else {
      const typed = typeof req.body?.reviewerName === 'string' ? req.body.reviewerName.trim() : ''
      if (!typed) return res.status(400).json({ error: 'Please enter your name' })
      if (typed.length > 80) return res.status(400).json({ error: 'Name is too long' })
      reviewerName = `${typed} (not signed in)`
    }
    const reviewerId = user?.id ?? null

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
