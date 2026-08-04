const db = require('../config/db')

// Shared by the manual "Convert" button (routes/leads.js) and the workflow
// engine's convert_to_client node — extracted so both stay in sync rather
// than duplicating the client-creation/activity-logging logic.
async function convertLeadToClient(leadId, { actorId = null } = {}) {
  const { rows: leadRows } = await db.query('SELECT * FROM leads WHERE id=$1', [leadId])
  const lead = leadRows[0]
  if (!lead) return { notFound: true }
  if (lead.converted_to_client_id) return { alreadyConverted: true, clientId: lead.converted_to_client_id }

  const { rows: clientRows } = await db.query(
    `INSERT INTO clients (doctor_name, clinic_name, brand, phone, email, referral_source,
     lead_source, notes, original_lead_id, assigned_to, total_revenue, case_count, created_at, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$6,$7,$8,$9,$10,0,NOW(),NOW()) RETURNING *`,
    [lead.doctor_name, lead.clinic_name || '', lead.brand || 'Aim Dental',
     lead.phone || '', lead.email || '', lead.referral_source || lead.lead_source || '',
     lead.notes || '', lead.id, lead.assigned_to, Number(lead.estimated_value) || 0]
  )
  const client = clientRows[0]

  await db.query(
    `UPDATE leads SET converted_to_client_id=$1, status='Won', updated_at=NOW() WHERE id=$2`,
    [client.id, lead.id]
  )

  await db.query(
    `INSERT INTO activities (entity_type, entity_id, type, description, created_by) VALUES
     ('lead',$1,'converted','Lead converted to client',$3),
     ('client',$2,'converted','Client created from lead conversion',$3)`,
    [lead.id, client.id, actorId]
  ).catch(() => {})

  return { client }
}

module.exports = { convertLeadToClient }
