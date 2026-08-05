const db = require('../config/db')
const { sendEmail } = require('./email')
const { scoreFromLead } = require('./scoring')
const { convertLeadToClient } = require('./leadConversion')

// Fields a workflow is allowed to set via the generic "Update Field" node —
// whitelisted since the field name comes from admin-authored workflow JSON
// and gets interpolated into a column name, not a parameterized value.
const UPDATABLE_LEAD_FIELDS = ['phone', 'email', 'clinic_name', 'notes', 'estimated_value', 'referral_source', 'intent_level']

// Guards a single tick against a cyclic node graph looping forever.
const MAX_STEPS_PER_TICK = 25

async function getEntity(entityType, entityId) {
  const table = entityType === 'case' ? 'cases' : 'leads'
  const { rows } = await db.query(`SELECT * FROM ${table} WHERE id=$1`, [entityId])
  return rows[0] || null
}

function outgoingEdges(edges, nodeId) {
  return edges.filter((e) => e.source === nodeId)
}

async function logRun(enrollmentId, nodeId, nodeType, result) {
  await db.query(
    `INSERT INTO workflow_runs (enrollment_id, node_id, node_type, result) VALUES ($1,$2,$3,$4)`,
    [enrollmentId, nodeId, nodeType, result]
  ).catch(() => {})
}

// ---- trigger detection ----
// Each detector returns entities *currently* matching the trigger's
// condition; the workflow_enrollments unique(workflow_id, entity_id)
// constraint (enforced via ON CONFLICT DO NOTHING below) makes this
// idempotent across ticks without needing to track a "since last tick"
// cursor — the same query-and-diff-by-enrollment approach services/automations.js
// already uses for cold_lead/case_due, just persisted instead of alert-only.
//
// Each query is capped (ENROLL_BATCH_LIMIT) and ordered oldest-signal-first.
// Without a cap, activating a threshold trigger (e.g. "no contact in 14+
// days") against an existing backlog would enroll and process every
// matching record in one tick — flooding alerts/emails/tasks all at once
// instead of trickling in. Capping means a large backlog just drains a
// batch at a time across ticks instead.
const ENROLL_BATCH_LIMIT = 50
const TRIGGER_QUERIES = {
  new_lead_created: async () => {
    const { rows } = await db.query(
      `SELECT id FROM leads WHERE status NOT IN ('Won','Lost') ORDER BY created_at ASC LIMIT ${ENROLL_BATCH_LIMIT}`
    )
    return rows.map((r) => ({ entityType: 'lead', entityId: r.id }))
  },
  lead_score_changed: async (config) => {
    const minScore = Number(config?.min_score) || 70
    const { rows } = await db.query(
      `SELECT id FROM leads WHERE ai_score >= $1 AND status NOT IN ('Won','Lost') ORDER BY ai_score DESC LIMIT ${ENROLL_BATCH_LIMIT}`,
      [minScore]
    )
    return rows.map((r) => ({ entityType: 'lead', entityId: r.id }))
  },
  no_contact_days: async (config) => {
    const days = Number(config?.days) || 14
    const threshold = new Date(Date.now() - days * 86400000).toISOString()
    const { rows } = await db.query(
      `SELECT id FROM leads WHERE status NOT IN ('Won','Lost') AND COALESCE(last_contacted_at, created_at) < $1
       ORDER BY COALESCE(last_contacted_at, created_at) ASC LIMIT ${ENROLL_BATCH_LIMIT}`,
      [threshold]
    )
    return rows.map((r) => ({ entityType: 'lead', entityId: r.id }))
  },
  case_status_changed: async (config) => {
    const status = config?.status || 'Case Received'
    const { rows } = await db.query(
      `SELECT id FROM cases WHERE status=$1 ORDER BY updated_at ASC LIMIT ${ENROLL_BATCH_LIMIT}`,
      [status]
    )
    return rows.map((r) => ({ entityType: 'case', entityId: r.id }))
  },
  case_due_soon: async (config) => {
    const days = Number(config?.days) || 2
    const today = new Date().toISOString().split('T')[0]
    const upto = new Date(Date.now() + days * 86400000).toISOString().split('T')[0]
    const { rows } = await db.query(
      `SELECT id FROM cases WHERE status != 'Delivered' AND due_date >= $1 AND due_date <= $2
       ORDER BY due_date ASC LIMIT ${ENROLL_BATCH_LIMIT}`,
      [today, upto]
    )
    return rows.map((r) => ({ entityType: 'case', entityId: r.id }))
  },
  pickup_received: async () => {
    const { rows } = await db.query(
      `SELECT id FROM leads WHERE case_interest='Schedule Pickup' AND pickup_status='received'
       ORDER BY pickup_received_at ASC LIMIT ${ENROLL_BATCH_LIMIT}`
    )
    return rows.map((r) => ({ entityType: 'lead', entityId: r.id }))
  },
}

async function detectNewEnrollments() {
  const { rows: workflows } = await db.query(`SELECT * FROM workflows WHERE active=true`)
  let enrolled = 0
  for (const wf of workflows) {
    const detector = TRIGGER_QUERIES[wf.trigger_type]
    if (!detector) continue
    const candidates = await detector(wf.trigger_config).catch(() => [])
    for (const c of candidates) {
      const { rowCount } = await db.query(
        `INSERT INTO workflow_enrollments (workflow_id, entity_type, entity_id, status)
         VALUES ($1,$2,$3,'active') ON CONFLICT (workflow_id, entity_id) DO NOTHING`,
        [wf.id, c.entityType, c.entityId]
      )
      enrolled += rowCount
    }
  }
  return enrolled
}

// ---- node execution ----

function evalCondition(entity, data) {
  const actual = entity?.[data.field]
  switch (data.operator) {
    case 'equals': return String(actual ?? '') === String(data.value ?? '')
    case 'not_equals': return String(actual ?? '') !== String(data.value ?? '')
    case 'contains': return String(actual ?? '').toLowerCase().includes(String(data.value ?? '').toLowerCase())
    case 'greater_than': return Number(actual) > Number(data.value)
    case 'less_than': return Number(actual) < Number(data.value)
    default: return false
  }
}

// Executes one non-branching action node; returns a short human-readable
// result string that's stored on workflow_runs for the Run History tab.
async function executeAction(node, entity, enrollment) {
  const data = node.data || {}
  const isLead = enrollment.entity_type === 'lead'

  switch (node.type) {
    case 'send_email': {
      const to = data.to === 'assigned_rep'
        ? (await db.query('SELECT email FROM users WHERE id=$1', [entity.assigned_to]).catch(() => ({ rows: [] }))).rows[0]?.email
        : (entity.email || entity.doctor_email)
      if (!to) return 'Skipped — no recipient email on file'
      await sendEmail({ to, subject: data.subject || 'Update from Aim Dental CRM', html: data.body || '<p></p>' })
      return `Email sent to ${to}`
    }
    case 'notify_rep': {
      // Targets the entity's assigned rep individually if they're a sales_rep
      // (see services/automations.js for the same convention); otherwise
      // falls back to the company-wide digest view (user_id NULL, admin-only)
      // since cases have no owner and staff don't get lead notifications.
      let userId = null
      if (isLead && entity.assigned_to) {
        const { rows: repCheck } = await db.query(`SELECT id FROM users WHERE id=$1 AND role='sales_rep'`, [entity.assigned_to])
        if (repCheck.length) userId = entity.assigned_to
      }
      await db.query(
        `INSERT INTO alerts (type, title, message, metadata, user_id) VALUES ('workflow',$1,$2,$3,$4)`,
        [data.title || 'Workflow notification',
         data.message || `Workflow step for ${entity.doctor_name || entity.case_number || entity.id}`,
         JSON.stringify({ entityType: enrollment.entity_type, entityId: enrollment.entity_id }),
         userId]
      )
      return userId ? 'Rep notified' : 'Notification created (visible to admins)'
    }
    case 'add_tag': {
      if (!isLead) return 'Skipped — tags only apply to leads'
      await db.query(
        `UPDATE leads SET tags = array_append(tags, $1) WHERE id=$2 AND NOT ($1 = ANY(tags))`,
        [data.tag, entity.id]
      )
      return `Tagged "${data.tag}"`
    }
    case 'update_status': {
      const table = isLead ? 'leads' : 'cases'
      await db.query(`UPDATE ${table} SET status=$1, updated_at=NOW() WHERE id=$2`, [data.status, entity.id])
      return `Status set to ${data.status}`
    }
    case 'create_task': {
      await db.query(
        `INSERT INTO tasks (entity_type, entity_id, title, notes, due_date, assigned_to, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,NULL)`,
        [enrollment.entity_type, entity.id, data.title || 'Follow up', data.notes || '',
         data.due_in_days ? new Date(Date.now() + Number(data.due_in_days) * 86400000).toISOString().slice(0, 10) : null,
         data.assigned_to || (isLead ? entity.assigned_to : null) || null]
      )
      return 'Task created'
    }
    case 'assign_rep': {
      if (!isLead) return 'Skipped — assign only applies to leads'
      await db.query(`UPDATE leads SET assigned_to=$1 WHERE id=$2`, [data.assigned_to, entity.id])
      return 'Rep assigned'
    }
    case 'round_robin_assign': {
      if (!isLead) return 'Skipped — assignment only applies to leads'
      const { rows: reps } = await db.query(`SELECT id, name FROM users WHERE role IN ('staff','sales_rep') ORDER BY name`)
      if (!reps.length) return 'Skipped — no reps to assign'
      const { rows: counts } = await db.query(
        `SELECT assigned_to, COUNT(*) AS n FROM leads WHERE status NOT IN ('Won','Lost') AND is_archived=false AND assigned_to IS NOT NULL GROUP BY assigned_to`
      )
      const loadByRep = Object.fromEntries(counts.map((c) => [c.assigned_to, Number(c.n)]))
      const pick = reps.reduce((best, r) => ((loadByRep[r.id] || 0) < (loadByRep[best.id] || 0) ? r : best), reps[0])
      await db.query(`UPDATE leads SET assigned_to=$1 WHERE id=$2`, [pick.id, entity.id])
      return `Assigned to ${pick.name} (round robin)`
    }
    case 'update_field': {
      if (!isLead) return 'Skipped — field updates only apply to leads'
      if (!UPDATABLE_LEAD_FIELDS.includes(data.field)) return `Skipped — "${data.field}" isn't an updatable field`
      await db.query(`UPDATE leads SET ${data.field}=$1, updated_at=NOW() WHERE id=$2`, [data.value ?? '', entity.id])
      return `${data.field} set to "${data.value ?? ''}"`
    }
    case 'remove_tag': {
      if (!isLead) return 'Skipped — tags only apply to leads'
      await db.query(`UPDATE leads SET tags = array_remove(tags, $1) WHERE id=$2`, [data.tag, entity.id])
      return `Removed tag "${data.tag}"`
    }
    case 'archive_lead': {
      if (!isLead) return 'Skipped — archiving only applies to leads'
      await db.query(`UPDATE leads SET is_archived=true, updated_at=NOW() WHERE id=$1`, [entity.id])
      return 'Lead archived'
    }
    case 'recalculate_score': {
      if (!isLead) return 'Skipped — AI score only applies to leads'
      const score = scoreFromLead(entity)
      await db.query(`UPDATE leads SET ai_score=$1 WHERE id=$2`, [score, entity.id])
      return `AI score recalculated: ${score}`
    }
    case 'convert_to_client': {
      if (!isLead) return 'Skipped — conversion only applies to leads'
      const result = await convertLeadToClient(entity.id, {})
      if (result.alreadyConverted) return 'Already converted to a client'
      return `Converted to client "${result.client.doctor_name}"`
    }
    case 'create_note': {
      await db.query(
        `INSERT INTO activities (entity_type, entity_id, type, description, created_by) VALUES ($1,$2,'note',$3,NULL)`,
        [enrollment.entity_type, entity.id, data.text || 'Automated note']
      )
      return 'Note added'
    }
    case 'webhook': {
      if (!data.url) return 'Skipped — no webhook URL set'
      try {
        const controller = new AbortController()
        const timeout = setTimeout(() => controller.abort(), 10000)
        const res = await fetch(data.url, {
          method: data.method || 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ entity_type: enrollment.entity_type, entity_id: entity.id, entity }),
          signal: controller.signal,
        })
        clearTimeout(timeout)
        return `Webhook called (${res.status})`
      } catch (err) {
        return `Webhook failed: ${err.message}`
      }
    }
    default:
      return 'No-op'
  }
}

// Walks a single enrollment forward through its node graph until it hits a
// wait node (persists wait_until, stops for this tick) or a dead end
// (marks completed). Mirrors the idempotent single-entity advance pattern
// in services/pickupStatus.js's advancePickupStage — one enrollment at a
// time, re-fetching fresh entity data on every step since earlier steps in
// the same walk may have just changed it (e.g. update_status then a
// condition reading that same status).
async function advanceOne(enrollment, workflow) {
  const nodes = workflow.nodes || []
  const edges = workflow.edges || []
  let currentId = enrollment.current_node_id
  // A 'waiting' enrollment's current_node_id always points at the wait node
  // it paused on (see the wait branch below), so on resume the first loop
  // iteration must treat that wait as already elapsed and move past it,
  // not re-trigger a fresh wait — otherwise it would pause forever.
  let resumingFromWait = enrollment.status === 'waiting'

  if (!currentId) {
    const trigger = nodes.find((n) => n.type === 'trigger')
    if (!trigger) return db.query(`UPDATE workflow_enrollments SET status='completed', updated_at=NOW() WHERE id=$1`, [enrollment.id])
    currentId = trigger.id
  }

  for (let step = 0; step < MAX_STEPS_PER_TICK; step++) {
    const currentNode = nodes.find((n) => n.id === currentId)
    if (!currentNode) {
      await db.query(`UPDATE workflow_enrollments SET status='completed', current_node_id=$1, updated_at=NOW() WHERE id=$2`, [currentId, enrollment.id])
      return
    }

    if (currentNode.type === 'wait' && !resumingFromWait) {
      let waitUntil
      let waitLabel
      if (currentNode.data?.mode === 'until_field') {
        const fieldEntity = await getEntity(enrollment.entity_type, enrollment.entity_id)
        const fieldValue = fieldEntity?.[currentNode.data?.field]
        // A missing/unparseable date can't be waited on — fall through
        // immediately rather than waiting forever on a bad field value.
        waitUntil = fieldValue && !isNaN(Date.parse(fieldValue)) ? new Date(fieldValue).toISOString() : new Date().toISOString()
        waitLabel = fieldValue ? `Waiting until ${currentNode.data.field} (${waitUntil.slice(0, 10)})` : `Skipped wait — "${currentNode.data?.field}" has no value`
      } else {
        const amount = Number(currentNode.data?.amount) || 1
        const unit = currentNode.data?.unit === 'hours' ? 3600000 : 86400000
        waitUntil = new Date(Date.now() + amount * unit).toISOString()
        waitLabel = `Waiting ${amount} ${currentNode.data?.unit || 'days'}`
      }
      await db.query(
        `UPDATE workflow_enrollments SET status='waiting', current_node_id=$1, wait_until=$2, updated_at=NOW() WHERE id=$3`,
        [currentNode.id, waitUntil, enrollment.id]
      )
      await logRun(enrollment.id, currentNode.id, 'wait', waitLabel)
      return
    }
    resumingFromWait = false

    const outgoing = outgoingEdges(edges, currentId)
    const entity = currentNode.type === 'trigger' ? null : await getEntity(enrollment.entity_type, enrollment.entity_id)
    if (currentNode.type !== 'trigger' && !entity) {
      await db.query(`UPDATE workflow_enrollments SET status='failed', updated_at=NOW() WHERE id=$1`, [enrollment.id])
      return
    }

    let nextEdge

    if (currentNode.type === 'condition') {
      const result = evalCondition(entity, currentNode.data || {})
      nextEdge = outgoing.find((e) => e.sourceHandle === (result ? 'yes' : 'no')) || outgoing[0]
      await logRun(enrollment.id, currentNode.id, 'condition', `Branch: ${result ? 'Yes' : 'No'}`)
    } else if (currentNode.type === 'router') {
      const actual = String(entity?.[currentNode.data?.field] ?? '')
      nextEdge = outgoing.find((e) => e.sourceHandle === actual) || outgoing.find((e) => e.sourceHandle === 'default') || outgoing[0]
      await logRun(enrollment.id, currentNode.id, 'router', `Routed on "${actual}"`)
    } else if (currentNode.type === 'filter') {
      const passed = evalCondition(entity, currentNode.data || {})
      await logRun(enrollment.id, currentNode.id, 'filter', passed ? 'Passed' : 'Filtered out — enrollment ended')
      if (!passed) {
        await db.query(`UPDATE workflow_enrollments SET status='completed', current_node_id=$1, updated_at=NOW() WHERE id=$2`, [currentNode.id, enrollment.id])
        return
      }
      nextEdge = outgoing[0]
    } else if (currentNode.type === 'trigger' || currentNode.type === 'wait') {
      // 'wait' only reaches here on resume, having already logged its pause
      // when it first paused — nothing further to log, just move on.
      nextEdge = outgoing[0]
    } else {
      const result = await executeAction(currentNode, entity, enrollment).catch((err) => `Error: ${err.message}`)
      await logRun(enrollment.id, currentNode.id, currentNode.type, result)
      nextEdge = outgoing[0]
    }

    if (!nextEdge) {
      await db.query(`UPDATE workflow_enrollments SET status='completed', current_node_id=$1, updated_at=NOW() WHERE id=$2`, [currentId, enrollment.id])
      return
    }
    currentId = nextEdge.target
  }

  // Hit the step cap — likely a cyclic graph. Park it as waiting 5 minutes
  // out so the next tick resumes rather than looping this tick forever.
  await db.query(
    `UPDATE workflow_enrollments SET status='waiting', current_node_id=$1, wait_until=NOW() + interval '5 minutes', updated_at=NOW() WHERE id=$2`,
    [currentId, enrollment.id]
  )
}

async function advanceEnrollments() {
  const { rows: enrollments } = await db.query(
    `SELECT * FROM workflow_enrollments
     WHERE status='active' OR (status='waiting' AND (wait_until IS NULL OR wait_until <= NOW()))`
  )
  const workflowCache = new Map()
  let advanced = 0
  for (const enrollment of enrollments) {
    let workflow = workflowCache.get(enrollment.workflow_id)
    if (!workflow) {
      const { rows } = await db.query(`SELECT * FROM workflows WHERE id=$1`, [enrollment.workflow_id])
      workflow = rows[0]
      workflowCache.set(enrollment.workflow_id, workflow)
    }
    if (!workflow || !workflow.active) continue
    await advanceOne(enrollment, workflow).catch((err) => console.error('workflowEngine advanceOne error:', err))
    advanced++
  }
  return advanced
}

async function runEngineTick() {
  const enrolled = await detectNewEnrollments().catch((err) => { console.error('workflowEngine detect error:', err); return 0 })
  const advanced = await advanceEnrollments().catch((err) => { console.error('workflowEngine advance error:', err); return 0 })
  return { enrolled, advanced }
}

module.exports = { runEngineTick, detectNewEnrollments, advanceEnrollments }
