const db = require('../config/db')
const { sendEmail, pickupDispatchedEmail, pickupReceivedEmail } = require('./email')
const { generateCaseNumber } = require('../utils/caseNumber')

const STAGE_ORDER = { requested: 0, dispatched: 1, received: 2 }
const STAGE_COLUMN = { dispatched: 'pickup_dispatched_at', received: 'pickup_received_at' }
const STAGE_EMAIL = {
  dispatched: { subject: 'AIM Dental Laboratory — your pickup is on the way', build: pickupDispatchedEmail },
  received: { subject: 'AIM Dental Laboratory — case received', build: pickupReceivedEmail },
}

// A pickup lead has no case type, product, or due date yet — staff only
// know that once the physical case is actually opened — so the case
// starts as a clearly-flagged placeholder (case_type 'Other', due in 3
// days) rather than guessing. doctor_email carries over so this case
// gets the same stage-progress emails as any manually-created one.
// One pickup may in practice contain multiple physical cases (the pickup
// form's "how many cases" field isn't persisted on the lead today), so
// this creates a single case — staff split it manually if needed.
async function createCaseFromPickupLead(lead) {
  const caseNumber = await generateCaseNumber(lead.brand || 'Aim Dental')
  const dueDate = new Date(Date.now() + 3 * 86400000).toISOString().slice(0, 10)
  const stageHistory = [{ stage: 'Case Received', changed_at: new Date().toISOString(), changed_by: null }]
  const notes = [
    'Auto-created from a Schedule Pickup lead marked Received. Confirm case type, due date, and product details — if the pickup contained more than one case, split this into separate records.',
    lead.notes || '',
  ].filter(Boolean).join('\n\n')

  await db.query(
    `INSERT INTO cases
      (case_number, client_name, brand, case_type, due_date, doctor_email, doctor_phone,
       status, notes, original_lead_id, stage_history, created_at, updated_at)
     VALUES ($1,$2,$3,'Other',$4,$5,$6,'Case Received',$7,$8,$9::jsonb,NOW(),NOW())`,
    [caseNumber, lead.doctor_name, lead.brand || 'Aim Dental', dueDate,
     lead.email || '', lead.phone || '', notes, lead.id, JSON.stringify(stageHistory)]
  )
}

// Shared by both trigger paths for stages 2/3 — the authenticated CRM
// dashboard buttons (routes/leads.js) and the public one-click links in the
// staff notification email (routes/intake.js, since the dashboard isn't in
// regular use yet). Idempotent: re-advancing to an already-reached (or
// earlier) stage is a no-op that doesn't resend the requester email, so a
// re-click or a request assigned to two people can't double-notify.
async function advancePickupStage(id, stage, { requireAssignedTo = null, actorId = null } = {}) {
  const { rows: existingRows } = await db.query('SELECT * FROM leads WHERE id=$1', [id])
  const lead = existingRows[0]
  if (!lead || lead.case_interest !== 'Schedule Pickup') return { notFound: true }
  if (requireAssignedTo && lead.assigned_to !== requireAssignedTo) return { notFound: true }
  if ((STAGE_ORDER[lead.pickup_status] || 0) >= STAGE_ORDER[stage]) return { alreadyDone: true, lead }

  const { rows } = await db.query(
    `UPDATE leads SET pickup_status=$1, ${STAGE_COLUMN[stage]}=NOW(), updated_at=NOW() WHERE id=$2 RETURNING *`,
    [stage, id]
  )
  const updated = rows[0]
  if (!updated) return { notFound: true }

  if (updated.email) {
    const { subject, build } = STAGE_EMAIL[stage]
    sendEmail({ to: updated.email, subject, html: build(updated) })
      .catch((err) => console.error(`pickup ${stage}: requester email failed`, err))
  }

  await db.query(
    `INSERT INTO activities (entity_type, entity_id, type, description, created_by) VALUES ('lead',$1,$2,$3,$4)`,
    [id, `pickup_${stage}`, `Pickup marked as ${stage}`, actorId]
  ).catch(() => {})

  if (stage === 'received') {
    createCaseFromPickupLead(updated).catch((err) => console.error('pickup received: case creation failed', err))
  }

  return { lead: updated }
}

module.exports = { advancePickupStage }
