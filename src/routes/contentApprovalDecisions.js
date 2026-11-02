const express = require('express')
const db = require('../config/db')
const jwt = require('jsonwebtoken')
const rateLimiter = require('../middleware/rateLimiter')

const router = express.Router()
const STATUSES = ['', 'approved', 'edit', 'rejected']
// Upper bound on one post's thread, so an anonymous writer on this public
// page can't grow a thread (and every page load) without limit.
const MAX_THREAD = 200
// Fixed allowlist of review-able posts for the October review. A postId
// outside this set is rejected rather than silently creating an arbitrary
// row, since the id also becomes the table's primary key.
const POST_IDS = [
  'oct05', 'oct09', 'oct11', 'scanner', 'oct13', 'oct23', 'oct23-video', 'oct27', 'oct31',
  'oct21-howto-reel',
  // Blog articles under review (Marketing OS src/data/articleApprovals.js)
  'art-7questions', 'art-guarantee', 'art-zirconia', 'art-turnaround', 'art-diabetes',
  // November 2026 posts (Marketing OS src/data/novemberApprovals.js)
  'nov03', 'nov04', 'nov05', 'nov06', 'nov07', 'nov09', 'nov10', 'nov11', 'nov12', 'nov13', 'nov14', 'nov16', 'nov17', 'nov19', 'nov20', 'nov21', 'nov25', 'nov27',
]

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

// Returns { name, id } or { error }. Signed-in reviewers are identified from
// the verified JWT; anyone else must send `reviewerName`, saved with a
// "(not signed in)" suffix so a typed name never reads as a verified one.
function resolveReviewer(req) {
  const user = optionalUser(req)
  // Names only: this page is public, so an email never stands in for a name.
  if (user) return { name: user.name || 'Signed-in reviewer', id: user.id ?? null }
  const typed = typeof req.body?.reviewerName === 'string' ? req.body.reviewerName.trim() : ''
  if (!typed) return { error: 'Please enter your name' }
  if (typed.length > 80) return { error: 'Name is too long' }
  return { name: `${typed} (not signed in)`, id: null }
}

function mapRow(row) {
  return {
    postId: row.post_id,
    status: row.status,
    feedback: row.feedback,
    reviewer: row.reviewer,
    // reviewer_id stays in the table for the audit trail but isn't returned:
    // this endpoint is public, and internal user ids don't belong on it.
    updated: row.updated_at,
  }
}

function mapComment(row) {
  return {
    id: row.id,
    postId: row.post_id,
    parentId: row.parent_id,
    author: row.author,
    status: row.status,
    body: row.body,
    created: row.created_at,
  }
}

// Returns { data } or { error }. Pure, so it can be tested without a database.
function validateComment(postId, body = {}) {
  if (!POST_IDS.includes(postId)) return { error: 'Unknown post id' }
  const text = typeof body.body === 'string' ? body.body.trim() : ''
  if (!text) return { error: 'Please write a comment first' }
  if (text.length > 4000) return { error: 'Comment is too long' }
  let parentId = null
  if (body.parentId !== undefined && body.parentId !== null && body.parentId !== '') {
    parentId = Number(body.parentId)
    if (!Number.isInteger(parentId) || parentId <= 0) return { error: 'Invalid reply target' }
  }
  return { data: { text, parentId } }
}

// GET /api/content-approval-decisions/comments — every post's thread, oldest first
router.get('/comments', async (req, res, next) => {
  try {
    const { rows } = await db.query('select * from content_approval_comments order by created_at, id')
    res.json({ comments: rows.map(mapComment) })
  } catch (err) {
    next(err)
  }
})

// POST /api/content-approval-decisions/:postId/comments — add feedback, or a
// reply when `parentId` is sent. Replies stay one level deep: replying to a
// reply attaches to the same top-level entry.
router.post('/:postId/comments', rateLimiter({ windowMs: 10 * 60 * 1000, max: 30 }), async (req, res, next) => {
  try {
    const { postId } = req.params
    const { data, error } = validateComment(postId, req.body || {})
    if (error) return res.status(400).json({ error })
    const reviewer = resolveReviewer(req)
    if (reviewer.error) return res.status(400).json({ error: reviewer.error })

    const { rows: count } = await db.query('select count(*)::int as n from content_approval_comments where post_id = $1', [postId])
    if (count[0].n >= MAX_THREAD) return res.status(429).json({ error: 'This thread is full' })

    let parentId = null
    if (data.parentId) {
      const { rows: parent } = await db.query(
        'select id, parent_id from content_approval_comments where id = $1 and post_id = $2', [data.parentId, postId])
      if (!parent.length) return res.status(400).json({ error: 'That comment no longer exists' })
      parentId = parent[0].parent_id ?? parent[0].id
    }

    const { rows } = await db.query(
      `insert into content_approval_comments (post_id, parent_id, author, author_id, body)
       values ($1, $2, $3, $4, $5) returning *`,
      [postId, parentId, reviewer.name, reviewer.id, data.text]
    )
    res.json({ comment: mapComment(rows[0]) })
  } catch (err) {
    next(err)
  }
})

// GET /api/content-approval-decisions — every post's decision
router.get('/', async (req, res, next) => {
  try {
    const { rows } = await db.query('select * from content_approval_decisions order by post_id')
    res.json({ decisions: rows.map(mapRow) })
  } catch (err) {
    next(err)
  }
})

// PUT /api/content-approval-decisions/:postId — upsert one post's current
// decision and log it to the post's comment thread.
router.put('/:postId', rateLimiter({ windowMs: 10 * 60 * 1000, max: 30 }), async (req, res, next) => {
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
    const reviewer = resolveReviewer(req)
    if (reviewer.error) return res.status(400).json({ error: reviewer.error })

    const { rows } = await db.query(
      `insert into content_approval_decisions (post_id, status, feedback, reviewer, reviewer_id, updated_at)
       values ($1, $2, $3, $4, $5, now())
       on conflict (post_id) do update
         set status = excluded.status, feedback = excluded.feedback,
             reviewer = excluded.reviewer, reviewer_id = excluded.reviewer_id,
             updated_at = now()
       returning *`,
      [postId, status, feedback, reviewer.name, reviewer.id]
    )
    // Each decision is also kept in the post's comment thread, so earlier
    // decisions and feedback stay visible after a newer one replaces them.
    const { rows: entry } = await db.query(
      `insert into content_approval_comments (post_id, author, author_id, status, body)
       values ($1, $2, $3, $4, $5) returning *`,
      // A reset to '' is logged as 'pending' so the thread shows the post was
      // sent back for review, rather than reading as plain feedback.
      [postId, reviewer.name, reviewer.id, status || 'pending', feedback]
    )
    res.json({ decision: mapRow(rows[0]), comment: mapComment(entry[0]) })
  } catch (err) {
    next(err)
  }
})

module.exports = router
module.exports.validateComment = validateComment
module.exports.POST_IDS = POST_IDS
