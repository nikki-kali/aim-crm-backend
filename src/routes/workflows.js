const express = require('express')
const db = require('../config/db')
const auth = require('../middleware/auth')
const { runEngineTick } = require('../services/workflowEngine')

const router = express.Router()

// Starter graphs for the "+ Use template" flow — one per supported trigger
// type (see workflowEngine.js's TRIGGER_QUERIES) rather than a literal port
// of the old 4 hardcoded automations: win_streak has no single entity to
// enroll (it's a global aggregate, not a per-lead condition) and
// lost_recovery's "Lost 30+ days ago" condition isn't one of the trigger
// types carried over, so both are left out in favor of one template per
// trigger this engine actually supports.
const TEMPLATES = [
  {
    key: 'cold_lead_followup',
    name: 'Cold Lead Follow-up',
    description: 'Notify a rep when a lead has had no contact in 14+ days.',
    trigger_type: 'no_contact_days',
    trigger_config: { days: 14 },
    nodes: [
      { id: 'trigger', type: 'trigger', position: { x: 250, y: 50 }, data: { label: 'No contact in 14+ days' } },
      { id: 'notify1', type: 'notify_rep', position: { x: 250, y: 200 }, data: { title: 'Cold Lead', message: 'This lead has had no contact in 14+ days — reach out today.' } },
    ],
    edges: [{ id: 'e1', source: 'trigger', target: 'notify1' }],
  },
  {
    key: 'case_due_reminder',
    name: 'Case Due Reminder',
    description: 'Notify a rep when a case is due within 2 days and not yet delivered.',
    trigger_type: 'case_due_soon',
    trigger_config: { days: 2 },
    nodes: [
      { id: 'trigger', type: 'trigger', position: { x: 250, y: 50 }, data: { label: 'Case due within 2 days' } },
      { id: 'notify1', type: 'notify_rep', position: { x: 250, y: 200 }, data: { title: 'Case Due Soon', message: 'This case is due within 2 days — check status.' } },
    ],
    edges: [{ id: 'e1', source: 'trigger', target: 'notify1' }],
  },
  {
    key: 'pickup_received_confirmation',
    name: 'Pickup Received Confirmation',
    description: 'Create a follow-up task once a case pickup is marked received.',
    trigger_type: 'pickup_received',
    trigger_config: {},
    nodes: [
      { id: 'trigger', type: 'trigger', position: { x: 250, y: 50 }, data: { label: 'Pickup marked received' } },
      { id: 'task1', type: 'create_task', position: { x: 250, y: 200 }, data: { title: 'Confirm case details from pickup', due_in_days: 1 } },
    ],
    edges: [{ id: 'e1', source: 'trigger', target: 'task1' }],
  },
  {
    key: 'welcome_new_lead',
    name: 'Welcome New Lead',
    description: 'Create a same-day follow-up task whenever a new lead comes in.',
    trigger_type: 'new_lead_created',
    trigger_config: {},
    nodes: [
      { id: 'trigger', type: 'trigger', position: { x: 250, y: 50 }, data: { label: 'New lead created' } },
      { id: 'task1', type: 'create_task', position: { x: 250, y: 200 }, data: { title: 'Reach out to new lead', due_in_days: 0 } },
    ],
    edges: [{ id: 'e1', source: 'trigger', target: 'task1' }],
  },
  {
    key: 'hot_lead_alert',
    name: 'Hot Lead Alert',
    description: 'Notify a rep the moment a lead’s AI score reaches 80+.',
    trigger_type: 'lead_score_changed',
    trigger_config: { min_score: 80 },
    nodes: [
      { id: 'trigger', type: 'trigger', position: { x: 250, y: 50 }, data: { label: 'AI score ≥ 80' } },
      { id: 'notify1', type: 'notify_rep', position: { x: 250, y: 200 }, data: { title: 'Hot Lead', message: 'This lead just crossed an AI score of 80 — prioritize it.' } },
    ],
    edges: [{ id: 'e1', source: 'trigger', target: 'notify1' }],
  },
  {
    key: 'case_received_task',
    name: 'Case Received Task',
    description: 'Create a task whenever a case enters the Case Received stage.',
    trigger_type: 'case_status_changed',
    trigger_config: { status: 'Case Received' },
    nodes: [
      { id: 'trigger', type: 'trigger', position: { x: 250, y: 50 }, data: { label: 'Case status: Case Received' } },
      { id: 'task1', type: 'create_task', position: { x: 250, y: 200 }, data: { title: 'Log in new case', due_in_days: 0 } },
    ],
    edges: [{ id: 'e1', source: 'trigger', target: 'task1' }],
  },
]

router.get('/templates', auth, (req, res) => res.json(TEMPLATES))

router.get('/', auth, async (req, res, next) => {
  try {
    const { rows } = await db.query(
      `SELECT w.*, u.name AS created_by_name,
        (SELECT COUNT(*) FROM workflow_enrollments e WHERE e.workflow_id = w.id) AS enrolled_count,
        (SELECT COUNT(*) FROM workflow_enrollments e WHERE e.workflow_id = w.id AND e.status IN ('active','waiting')) AS active_count
       FROM workflows w LEFT JOIN users u ON u.id = w.created_by
       ORDER BY w.created_at DESC`
    )
    res.json(rows)
  } catch (err) { next(err) }
})

router.get('/:id', auth, async (req, res, next) => {
  try {
    const { rows } = await db.query('SELECT * FROM workflows WHERE id=$1', [req.params.id])
    if (!rows[0]) return res.status(404).json({ error: 'Workflow not found' })
    res.json(rows[0])
  } catch (err) { next(err) }
})

router.post('/', auth, async (req, res, next) => {
  try {
    const { name, description, brand, trigger_type, trigger_config, nodes, edges } = req.body
    if (!name?.trim()) return res.status(400).json({ error: 'Name is required' })
    if (!trigger_type) return res.status(400).json({ error: 'trigger_type is required' })
    const { rows } = await db.query(
      `INSERT INTO workflows (name, description, brand, trigger_type, trigger_config, nodes, edges, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [name.trim(), description || '', brand || 'All', trigger_type, JSON.stringify(trigger_config || {}),
       JSON.stringify(nodes || []), JSON.stringify(edges || []), req.user.id]
    )
    res.status(201).json(rows[0])
  } catch (err) { next(err) }
})

router.put('/:id', auth, async (req, res, next) => {
  try {
    const { name, description, brand, trigger_type, trigger_config, nodes, edges, active } = req.body
    const { rows } = await db.query(
      `UPDATE workflows SET
        name = COALESCE($1, name),
        description = COALESCE($2, description),
        brand = COALESCE($3, brand),
        trigger_type = COALESCE($4, trigger_type),
        trigger_config = COALESCE($5, trigger_config),
        nodes = COALESCE($6, nodes),
        edges = COALESCE($7, edges),
        active = COALESCE($8, active),
        updated_at = NOW()
       WHERE id=$9 RETURNING *`,
      [name, description, brand, trigger_type,
       trigger_config !== undefined ? JSON.stringify(trigger_config) : null,
       nodes !== undefined ? JSON.stringify(nodes) : null,
       edges !== undefined ? JSON.stringify(edges) : null,
       active, req.params.id]
    )
    if (!rows[0]) return res.status(404).json({ error: 'Workflow not found' })
    res.json(rows[0])
  } catch (err) { next(err) }
})

router.delete('/:id', auth, async (req, res, next) => {
  try {
    await db.query('DELETE FROM workflows WHERE id=$1', [req.params.id])
    res.json({ success: true })
  } catch (err) { next(err) }
})

router.get('/:id/runs', auth, async (req, res, next) => {
  try {
    const { rows } = await db.query(
      `SELECT r.*, e.entity_type, e.entity_id, e.status AS enrollment_status
       FROM workflow_runs r
       JOIN workflow_enrollments e ON e.id = r.enrollment_id
       WHERE e.workflow_id = $1
       ORDER BY r.created_at DESC LIMIT 200`,
      [req.params.id]
    )
    res.json(rows)
  } catch (err) { next(err) }
})

// Manual "run now" — forces one engine tick so testing/verifying a
// just-activated workflow doesn't require waiting for the next cron tick.
router.post('/tick', auth, async (req, res, next) => {
  try {
    const result = await runEngineTick()
    res.json(result)
  } catch (err) { next(err) }
})

module.exports = router
