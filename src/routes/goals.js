const express = require('express')
const db = require('../config/db')
const auth = require('../middleware/auth')
const requireAdmin = require('../middleware/requireAdmin')
const { sendEmail } = require('../services/email')

const router = express.Router()

const METRIC_LABELS = {
  leads_won: 'Leads Won',
  leads_contacted: 'Leads Contacted',
  proposals_sent: 'Proposals Sent',
  conversion_rate: '% Conversion Rate',
}

async function computeProgress(goal) {
  const { rep_id, metric, target, period_start, period_end } = goal
  let current = 0

  if (metric === 'leads_won') {
    const { rows: [r] } = await db.query(
      `SELECT COUNT(*) AS val FROM leads WHERE assigned_to=$1 AND status='Won' AND updated_at::date BETWEEN $2 AND $3`,
      [rep_id, period_start, period_end]
    )
    current = Number(r.val)
  } else if (metric === 'leads_contacted') {
    const { rows: [r] } = await db.query(
      `SELECT COUNT(*) AS val FROM leads WHERE assigned_to=$1 AND status IN ('Contacted','Proposal','Won') AND updated_at::date BETWEEN $2 AND $3`,
      [rep_id, period_start, period_end]
    )
    current = Number(r.val)
  } else if (metric === 'proposals_sent') {
    const { rows: [r] } = await db.query(
      `SELECT COUNT(*) AS val FROM leads WHERE assigned_to=$1 AND status IN ('Proposal','Won') AND updated_at::date BETWEEN $2 AND $3`,
      [rep_id, period_start, period_end]
    )
    current = Number(r.val)
  } else if (metric === 'conversion_rate') {
    const { rows: [r] } = await db.query(
      `SELECT COUNT(*) AS total, COUNT(*) FILTER (WHERE status='Won') AS won
       FROM leads WHERE assigned_to=$1 AND created_at::date BETWEEN $2 AND $3`,
      [rep_id, period_start, period_end]
    )
    const total = Number(r.total)
    current = total > 0 ? Math.round(Number(r.won) * 100 / total) : 0
  }

  const pct = Number(target) > 0 ? Math.min(Math.round((current / Number(target)) * 100), 100) : 0
  return { ...goal, current_value: current, progress_pct: pct }
}

// POST /api/goals — admin creates goal, emails rep + in-app notification
router.post('/', auth, requireAdmin, async (req, res, next) => {
  try {
    const { rep_id, title, metric, target, period, period_start, period_end } = req.body
    if (!rep_id || !title || !metric || !target || !period_start || !period_end) {
      return res.status(400).json({ error: 'rep_id, title, metric, target, period_start, period_end are required' })
    }

    const { rows } = await db.query(
      `INSERT INTO goals (rep_id, title, metric, target, period, period_start, period_end, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [rep_id, title, metric, Number(target), period || 'monthly', period_start, period_end, req.user.id]
    )
    const goal = rows[0]

    await db.query(
      `INSERT INTO goal_notifications (rep_id, goal_id, message) VALUES ($1,$2,$3)`,
      [rep_id, goal.id, `New goal assigned: "${title}" — target ${target} ${(METRIC_LABELS[metric] || metric)} by ${period_end}`]
    ).catch(() => {})

    const { rows: repRows } = await db.query('SELECT email, name FROM users WHERE id=$1', [rep_id])
    if (repRows[0]) {
      const rep = repRows[0]
      await sendEmail({
        to: rep.email,
        subject: `New Goal Assigned: ${title}`,
        html: `
          <div style="font-family:-apple-system,sans-serif;max-width:520px;margin:auto">
            <div style="background:linear-gradient(135deg,#06babe,#207290);padding:24px 28px;border-radius:12px 12px 0 0">
              <h1 style="color:#fff;margin:0;font-size:18px">New Goal Assigned</h1>
            </div>
            <div style="background:#fff;padding:24px 28px;border:1px solid #f3f4f6;border-top:none;border-radius:0 0 12px 12px">
              <p style="color:#374151">Hi ${rep.name || rep.email},</p>
              <p style="color:#374151">A new goal has been set for you by <strong>${req.user.name || 'Admin'}</strong>:</p>
              <div style="background:#f9fafb;border-radius:10px;padding:16px;margin:16px 0">
                <p style="margin:0 0 8px;font-size:16px;font-weight:700;color:#111">${title}</p>
                <p style="margin:0;color:#6b7280;font-size:14px">Target: <strong style="color:#06babe">${target} ${METRIC_LABELS[metric] || metric}</strong></p>
                <p style="margin:4px 0 0;color:#6b7280;font-size:14px">Period: ${period_start} → ${period_end}</p>
              </div>
              <p style="color:#6b7280;font-size:13px">Log into the CRM to track your progress.</p>
            </div>
          </div>
        `
      }).catch(() => {})
    }

    res.status(201).json(goal)
  } catch (err) { next(err) }
})

// GET /api/goals/all — admin: all goals with live progress
router.get('/all', auth, requireAdmin, async (req, res, next) => {
  try {
    const { rows } = await db.query(
      `SELECT g.*, u.name AS rep_name, u.email AS rep_email
       FROM goals g JOIN users u ON u.id = g.rep_id
       ORDER BY g.created_at DESC`
    )
    const withProgress = await Promise.all(rows.map(computeProgress))
    res.json(withProgress)
  } catch (err) { next(err) }
})

// GET /api/goals/mine — rep: admin-set + personal goals with progress
router.get('/mine', auth, async (req, res, next) => {
  try {
    const [goalsRes, personalRes] = await Promise.all([
      db.query(`SELECT g.* FROM goals g WHERE g.rep_id=$1 ORDER BY g.created_at DESC`, [req.user.id]),
      db.query(`SELECT * FROM personal_goals WHERE rep_id=$1 ORDER BY created_at DESC`, [req.user.id]),
    ])
    const [adminGoals, personalGoals] = await Promise.all([
      Promise.all(goalsRes.rows.map(computeProgress)),
      Promise.all(personalRes.rows.map(computeProgress)),
    ])
    res.json({ admin_goals: adminGoals, personal_goals: personalGoals })
  } catch (err) { next(err) }
})

// DELETE /api/goals/:id — admin only
router.delete('/:id', auth, requireAdmin, async (req, res, next) => {
  try {
    await db.query('DELETE FROM goals WHERE id=$1', [req.params.id])
    res.json({ success: true })
  } catch (err) { next(err) }
})

// POST /api/goals/personal — rep creates own goal
router.post('/personal', auth, async (req, res, next) => {
  try {
    const { title, metric, target, period, period_start, period_end } = req.body
    if (!title || !metric || !target || !period_start || !period_end) {
      return res.status(400).json({ error: 'title, metric, target, period_start, period_end are required' })
    }
    const { rows } = await db.query(
      `INSERT INTO personal_goals (rep_id, title, metric, target, period, period_start, period_end)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [req.user.id, title, metric, Number(target), period || 'monthly', period_start, period_end]
    )
    res.status(201).json(rows[0])
  } catch (err) { next(err) }
})

// DELETE /api/goals/personal/:id
router.delete('/personal/:id', auth, async (req, res, next) => {
  try {
    const ownerClause = req.user.role === 'admin' ? '' : 'AND rep_id=$2'
    const params = req.user.role === 'admin' ? [req.params.id] : [req.params.id, req.user.id]
    await db.query(`DELETE FROM personal_goals WHERE id=$1 ${ownerClause}`, params)
    res.json({ success: true })
  } catch (err) { next(err) }
})

// GET /api/goals/notifications — unread in-app notifications for current user
router.get('/notifications', auth, async (req, res, next) => {
  try {
    const { rows } = await db.query(
      `SELECT * FROM goal_notifications WHERE rep_id=$1 AND is_read=false ORDER BY created_at DESC`,
      [req.user.id]
    )
    res.json(rows)
  } catch (err) { next(err) }
})

// PUT /api/goals/notifications/:id/read
router.put('/notifications/:id/read', auth, async (req, res, next) => {
  try {
    await db.query(
      'UPDATE goal_notifications SET is_read=true WHERE id=$1 AND rep_id=$2',
      [req.params.id, req.user.id]
    )
    res.json({ success: true })
  } catch (err) { next(err) }
})

module.exports = router
