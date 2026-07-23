const db = require('../config/db')
const { sendEmail, pickupDispatchedEmail, pickupReceivedEmail } = require('./email')

const STAGE_ORDER = { requested: 0, dispatched: 1, received: 2 }
const STAGE_COLUMN = { dispatched: 'pickup_dispatched_at', received: 'pickup_received_at' }
const STAGE_EMAIL = {
  dispatched: { subject: 'AIM Dental Laboratory — your pickup is on the way', build: pickupDispatchedEmail },
  received: { subject: 'AIM Dental Laboratory — case received', build: pickupReceivedEmail },
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

  return { lead: updated }
}

module.exports = { advancePickupStage }
