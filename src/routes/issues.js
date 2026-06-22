const express = require('express')
const db = require('../config/db')
const auth = require('../middleware/auth')
const requireAdmin = require('../middleware/requireAdmin')
const { sendEmail } = require('../services/email')

const router = express.Router()

// GET /api/issues?status=Identified|Discussed|Solved
// Without status param: returns all non-Solved issues
router.get('/', auth, async (req, res, next) => {
  try {
    const { status } = req.query
    const params = []
    const where = status
      ? (params.push(status), `WHERE i.status = $1`)
      : `WHERE i.status != 'Solved'`

    const { rows } = await db.query(`
      SELECT i.*,
        rb.name AS raised_by_name,
        ou.name AS owner_name,
        r.title AS rock_title,
        (SELECT COUNT(*) FROM issue_comments ic WHERE ic.issue_id = i.id)::int AS comment_count
      FROM issues i
      LEFT JOIN users rb ON rb.id = i.raised_by
      LEFT JOIN users ou ON ou.id = i.owner_id
      LEFT JOIN rocks r ON r.id = i.rock_id
      ${where}
      ORDER BY
        CASE i.priority WHEN 'High' THEN 0 WHEN 'Medium' THEN 1 ELSE 2 END,
        i.created_at DESC
    `, params)

    res.json(rows)
  } catch (err) { next(err) }
})

// GET /api/issues/:id/comments
router.get('/:id/comments', auth, async (req, res, next) => {
  try {
    const { rows } = await db.query(`
      SELECT ic.*, u.name AS user_name
      FROM issue_comments ic
      LEFT JOIN users u ON u.id = ic.user_id
      WHERE ic.issue_id = $1
      ORDER BY ic.created_at ASC
    `, [req.params.id])
    res.json(rows)
  } catch (err) { next(err) }
})

// POST /api/issues
router.post('/', auth, async (req, res, next) => {
  try {
    const { title, description, priority, rock_id, owner_id } = req.body
    if (!title?.trim()) return res.status(400).json({ error: 'Title required' })

    const { rows } = await db.query(`
      INSERT INTO issues (title, description, raised_by, owner_id, priority, status, rock_id)
      VALUES ($1, $2, $3, $4, $5, 'Identified', $6)
      RETURNING *
    `, [title.trim(), description || null, req.user.id, owner_id || null, priority || 'Medium', rock_id || null])

    const issue = rows[0]

    // Alert all admins
    await db.query(
      `INSERT INTO alerts (type, title, message, metadata) VALUES ($1,$2,$3,$4)`,
      ['eos_issue', 'New Issue Raised',
        `${req.user.name || 'Someone'} raised an issue: "${title.trim()}"`,
        JSON.stringify({ issue_id: issue.id })]
    ).catch(console.error)

    res.status(201).json(issue)
  } catch (err) { next(err) }
})

// PUT /api/issues/:id — advance IDS status or update fields
router.put('/:id', auth, async (req, res, next) => {
  try {
    const { status, discussion_notes, solution_notes, priority, owner_id } = req.body

    const { rows: [existing] } = await db.query('SELECT * FROM issues WHERE id=$1', [req.params.id])
    if (!existing) return res.status(404).json({ error: 'Issue not found' })

    if (status === 'Solved' && req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Only admins can resolve issues' })
    }

    const beingSolved = status === 'Solved' && existing.status !== 'Solved'

    const { rows } = await db.query(`
      UPDATE issues SET
        status           = COALESCE($1, status),
        discussion_notes = COALESCE($2, discussion_notes),
        solution_notes   = COALESCE($3, solution_notes),
        priority         = COALESCE($4, priority),
        owner_id         = COALESCE($5, owner_id),
        solved_at        = CASE WHEN $6 THEN NOW() ELSE solved_at END,
        updated_at       = NOW()
      WHERE id = $7
      RETURNING *
    `, [
      status || null,
      discussion_notes || null,
      solution_notes || null,
      priority || null,
      owner_id || null,
      beingSolved,
      req.params.id,
    ])

    const updated = rows[0]

    // Notify raiser when solved
    if (beingSolved && existing.raised_by && existing.raised_by !== req.user.id) {
      const { rows: [raiser] } = await db.query(
        'SELECT name, email FROM users WHERE id=$1', [existing.raised_by]
      )
      if (raiser?.email) {
        const html = `<!DOCTYPE html><html><body style="margin:0;padding:0;background:#f9fafb;font-family:-apple-system,sans-serif">
<div style="max-width:540px;margin:40px auto;background:#fff;border-radius:16px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,.08)">
  <div style="background:linear-gradient(135deg,#06babe,#207290);padding:24px 32px">
    <p style="color:rgba(255,255,255,0.8);font-size:12px;margin:0 0 4px">Aim Dental CRM — EOS Issues</p>
    <h1 style="color:#fff;margin:0;font-size:20px;font-weight:700">Issue Resolved</h1>
  </div>
  <div style="padding:28px 32px">
    <h2 style="font-size:16px;color:#111;margin:0 0 12px">${existing.title}</h2>
    ${updated.solution_notes ? `<div style="background:#f0fdf4;border:1px solid #bbf7d0;border-radius:8px;padding:14px 18px;margin-bottom:20px"><p style="margin:0;font-size:13px;color:#166534"><strong>Solution:</strong> ${updated.solution_notes}</p></div>` : ''}
    <a href="${process.env.FRONTEND_URL||''}/eos" style="display:inline-block;background:#06babe;color:#fff;padding:10px 24px;border-radius:8px;text-decoration:none;font-weight:600;font-size:13px">View in EOS →</a>
  </div>
  <div style="background:#f9fafb;padding:14px 32px;font-size:11px;color:#9ca3af;border-top:1px solid #f3f4f6">Aim Dental CRM · EOS Issues</div>
</div></body></html>`
        await sendEmail({ to: raiser.email, subject: `Issue Resolved — ${existing.title}`, html }).catch(console.error)
      }
      await db.query(
        `INSERT INTO alerts (type, title, message, metadata) VALUES ($1,$2,$3,$4)`,
        ['eos_issue', 'Issue Resolved',
          `The issue "${existing.title}" has been marked as Solved.`,
          JSON.stringify({ issue_id: existing.id })]
      ).catch(console.error)
    }

    res.json(updated)
  } catch (err) { next(err) }
})

// POST /api/issues/:id/comments
router.post('/:id/comments', auth, async (req, res, next) => {
  try {
    const { comment } = req.body
    if (!comment?.trim()) return res.status(400).json({ error: 'Comment required' })

    const { rows } = await db.query(`
      INSERT INTO issue_comments (issue_id, user_id, comment)
      VALUES ($1, $2, $3)
      RETURNING *, (SELECT name FROM users WHERE id = $2) AS user_name
    `, [req.params.id, req.user.id, comment.trim()])

    res.status(201).json(rows[0])
  } catch (err) { next(err) }
})

// DELETE /api/issues/:id — admin only
router.delete('/:id', auth, requireAdmin, async (req, res, next) => {
  try {
    await db.query('DELETE FROM issues WHERE id=$1', [req.params.id])
    res.json({ success: true })
  } catch (err) { next(err) }
})

module.exports = router
