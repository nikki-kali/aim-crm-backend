const express = require('express')
const db = require('../config/db')
const auth = require('../middleware/auth')
const requireAdmin = require('../middleware/requireAdmin')
const { generateCaseNumber } = require('../utils/caseNumber')
const { sendEmail } = require('../services/email')
const { convertLeadToClient } = require('../services/leadConversion')
const { STAGES } = require('../constants/caseStages')

const router = express.Router()

function renderTemplate(template, vars) {
  let out = template
  for (const [k, v] of Object.entries(vars)) {
    out = out.replace(new RegExp(`{{${k}}}`, 'g'), v || '')
  }
  return out
}

function caseEmailWrapper(content) {
  return `<!DOCTYPE html>
<html><body style="margin:0;padding:0;background:#f9fafb;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif">
<div style="max-width:600px;margin:40px auto;background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,.1)">
  <div style="background:linear-gradient(135deg,#06babe,#207290);padding:20px 32px">
    <span style="color:#fff;font-weight:700;font-size:16px">Aim Dental Laboratory</span>
  </div>
  <div style="padding:28px 32px">${content}</div>
  <div style="background:#f9fafb;padding:16px 32px;font-size:12px;color:#9ca3af;border-top:1px solid #f3f4f6">
    Aim Dental Laboratory · Lab case notification
  </div>
</div></body></html>`
}

async function sendCaseNotification(caseRow, newStage) {
  try {
    // Get template
    const { rows: tplRows } = await db.query(
      'SELECT * FROM email_templates WHERE stage=$1 AND enabled=true', [newStage]
    )
    if (!tplRows[0]) return
    const tpl = tplRows[0]

    // Get doctor email from case or clients table
    const doctorEmail = caseRow.doctor_email
    if (!doctorEmail) return

    const vars = {
      case_number: caseRow.case_number || '',
      case_type: caseRow.case_type || '',
      patient: caseRow.patient || 'your patient',
      doctor_name: caseRow.client_name || 'Doctor',
      assigned_technician: caseRow.assigned_technician || 'our team',
      tracking_number: caseRow.tracking_number || '',
      due_date: caseRow.due_date ? new Date(caseRow.due_date).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' }) : '',
      est_completion_date: caseRow.est_completion_date ? new Date(caseRow.est_completion_date).toLocaleDateString('en-US', { month: 'long', day: 'numeric' }) : '',
      brand: caseRow.brand || 'Aim Dental',
      completed_date: new Date().toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' }),
    }

    const subject = renderTemplate(tpl.subject, vars)
    const bodyHtml = renderTemplate(tpl.body_html, vars)
    await sendEmail({ to: doctorEmail, subject, html: caseEmailWrapper(bodyHtml) })

    // Log to email_log
    await db.query(
      `UPDATE cases SET email_log = email_log || $1::jsonb WHERE id=$2`,
      [JSON.stringify([{ stage: newStage, sent_at: new Date().toISOString(), to: doctorEmail }]), caseRow.id]
    )
  } catch (e) {
    console.error('[case notification]', e.message)
  }
}

const REMOVABLE_TYPES = ['Dentures', 'Partial']

function outsourcingShipmentEmail(cases, trackingNumber) {
  const rows = cases.map(c => `
    <tr>
      <td style="padding:8px 12px;border-bottom:1px solid #f3f4f6;font-family:monospace">${c.case_number}</td>
      <td style="padding:8px 12px;border-bottom:1px solid #f3f4f6">${c.patient || '—'}</td>
      <td style="padding:8px 12px;border-bottom:1px solid #f3f4f6">${c.product || c.case_type || '—'}</td>
      <td style="padding:8px 12px;border-bottom:1px solid #f3f4f6">${c.tooth_numbers || '—'}</td>
      <td style="padding:8px 12px;border-bottom:1px solid #f3f4f6">${c.quantity ?? 1}</td>
      <td style="padding:8px 12px;border-bottom:1px solid #f3f4f6">${c.shade || '—'}</td>
      <td style="padding:8px 12px;border-bottom:1px solid #f3f4f6">${c.outsourcing_return_date ? new Date(c.outsourcing_return_date).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '—'}</td>
    </tr>`).join('')

  return caseEmailWrapper(`
    <p style="margin:0 0 16px;font-size:14px;color:#111">
      ${cases.length} case${cases.length !== 1 ? 's' : ''} shipped — tracking number <strong>${trackingNumber}</strong>.
    </p>
    <table style="width:100%;border-collapse:collapse;font-size:13px">
      <thead>
        <tr style="background:#f9fafb">
          ${['Case #', 'Patient', 'Product', 'Tooth #', 'Qty', 'Shade', 'Return By'].map(h =>
            `<th style="text-align:left;padding:8px 12px;border-bottom:2px solid #e5e7eb;color:#6b7280;font-size:11px;text-transform:uppercase">${h}</th>`
          ).join('')}
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
  `)
}

// POST /api/cases/ship-to-outsourcing — batch-notify the outsourcing lab for
// packed Removable cases (Dentures/Partial), mirroring the spreadsheet +
// tracking-number email the lab currently builds and sends by hand.
router.post('/ship-to-outsourcing', auth, async (req, res, next) => {
  try {
    const { case_ids, tracking_number } = req.body
    if (!Array.isArray(case_ids) || case_ids.length === 0) {
      return res.status(400).json({ error: 'case_ids is required' })
    }
    if (!tracking_number?.trim()) {
      return res.status(400).json({ error: 'tracking_number is required' })
    }
    if (!process.env.OUTSOURCING_LAB_EMAIL) {
      return res.status(500).json({ error: 'OUTSOURCING_LAB_EMAIL is not configured' })
    }

    const { rows: cases } = await db.query(
      `SELECT * FROM cases WHERE id = ANY($1::uuid[])`, [case_ids]
    )
    if (cases.length === 0) return res.status(404).json({ error: 'No matching cases found' })

    const notRemovable = cases.filter(c => !REMOVABLE_TYPES.includes(c.case_type))
    if (notRemovable.length > 0) {
      return res.status(400).json({
        error: `Only Removable cases (Dentures/Partial) can be shipped to the outsourcing lab. Not removable: ${notRemovable.map(c => c.case_number).join(', ')}`,
      })
    }

    await sendEmail({
      to: process.env.OUTSOURCING_LAB_EMAIL,
      subject: `Case Shipment — ${cases.length} case${cases.length !== 1 ? 's' : ''} — Tracking #${tracking_number.trim()}`,
      html: outsourcingShipmentEmail(cases, tracking_number.trim()),
    })

    const { rows: updated } = await db.query(
      `UPDATE cases SET outsourcing_tracking_number=$1, shipped_to_outsourcing_at=NOW()
       WHERE id = ANY($2::uuid[]) RETURNING *`,
      [tracking_number.trim(), case_ids]
    )

    res.json({ success: true, count: updated.length, cases: updated })
  } catch (err) { next(err) }
})

// POST /api/cases/import-evident — bulk-import a "Booked Cases" export from
// Evident (the lab's separate production system) so real case sales value
// (Billed vs. WIP) lands in the CRM, feeding the rep dashboard's Sales
// Value KPI and the weekly report email (see reports.js's my-summary sales
// query, which sums cases.value grouped by cases.status via clients.assigned_to
// — cases have no assigned_to of their own). Evident's own export is
// already filtered to one rep at a time (no rep column in the file), so
// the admin doing the import picks which rep via `rep_id`.
//
// Upserts by evident_case_number (Evident's "Ref") so re-importing the same
// or an overlapping weekly export is idempotent rather than creating
// duplicates. client_name is written back using the *matched* client's
// exact doctor_name (not the raw CSV text) when one already exists, since
// every other join in this codebase (clients.js, the CaseTimeline pickup
// lookup, reports.js's sales query) relies on an exact string match between
// cases.client_name and clients.doctor_name.
router.post('/import-evident', auth, requireAdmin, async (req, res, next) => {
  try {
    const { rep_id, rows } = req.body
    if (!rep_id) return res.status(400).json({ error: 'rep_id is required' })
    if (!Array.isArray(rows) || rows.length === 0) return res.status(400).json({ error: 'No rows provided' })

    const { rows: repRows } = await db.query(
      `SELECT id FROM users WHERE id=$1 AND role IN ('staff','sales_rep')`, [rep_id]
    )
    if (!repRows[0]) return res.status(400).json({ error: 'rep_id must be an existing staff/sales_rep user' })

    let createdCases = 0, updatedCases = 0, createdClients = 0, skipped = 0
    const conflicts = []

    for (const row of rows) {
      const doctorName = (row.customer_name || '').trim()
      const billed = Number(row.billed) || 0
      const wip = Number(row.wip) || 0
      const total = Number(row.total) || billed + wip
      if (!doctorName || total <= 0) { skipped++; continue }

      const { rows: clientMatch } = await db.query(
        `SELECT id, doctor_name, assigned_to FROM clients WHERE LOWER(doctor_name) = LOWER($1) LIMIT 1`,
        [doctorName]
      )
      let clientName = doctorName
      if (clientMatch[0]) {
        clientName = clientMatch[0].doctor_name
        if (!clientMatch[0].assigned_to) {
          await db.query(`UPDATE clients SET assigned_to=$1, updated_at=NOW() WHERE id=$2`, [rep_id, clientMatch[0].id])
        } else if (clientMatch[0].assigned_to !== rep_id) {
          conflicts.push({ doctor_name: clientName, reason: 'Already assigned to a different rep — case imported, client left as-is' })
        }
      } else {
        await db.query(
          `INSERT INTO clients (doctor_name, brand, total_revenue, case_count, assigned_to, created_at, updated_at)
           VALUES ($1,'Aim Dental',0,0,$2,NOW(),NOW())`,
          [doctorName, rep_id]
        )
        createdClients++
      }

      // Each Evident row is billed OR still-WIP, never a split within one
      // row (matches the screenshot: only one of the two columns is ever
      // populated per case) — 'Completed' is the CRM's only terminal stage,
      // so it's the natural stand-in for "billed".
      const status = billed > 0 ? 'Completed' : 'In Production'
      const firstArrival = row.first_arrival ? new Date(row.first_arrival) : null
      const createdAt = firstArrival && !isNaN(firstArrival) ? firstArrival.toISOString() : null
      const evidentRef = row.ref ? String(row.ref).trim() : null

      const existing = evidentRef
        ? (await db.query(`SELECT id FROM cases WHERE evident_case_number=$1`, [evidentRef])).rows[0]
        : null

      if (existing) {
        await db.query(
          `UPDATE cases SET client_name=$1, patient=$2, product=$3, billed_value=$4, wip_value=$5,
           value=$6, status=$7, created_at=COALESCE($8::timestamptz, created_at), updated_at=NOW()
           WHERE id=$9`,
          [clientName, row.patient || '', row.product_name || '', billed, wip, total, status, createdAt, existing.id]
        )
        updatedCases++
      } else {
        await db.query(
          `INSERT INTO cases (case_number, client_name, brand, case_type, patient, value, billed_value,
           wip_value, status, evident_case_number, product, stage_history, created_at, updated_at)
           VALUES ($1,$2,'Aim Dental','Other',$3,$4,$5,$6,$7,$8,$9,'[]'::jsonb,COALESCE($10::timestamptz,NOW()),NOW())`,
          [`EVD-${evidentRef || Date.now()}`, clientName, row.patient || '', total, billed, wip,
           status, evidentRef, row.product_name || '', createdAt]
        )
        createdCases++
      }
    }

    res.json({ createdCases, updatedCases, createdClients, skipped, conflicts })
  } catch (err) { next(err) }
})

// GET /api/cases — left-joins the originating pickup lead's own pickup_*
// columns (requested/dispatched/received timestamps) when a case came
// from a Schedule Pickup lead (original_lead_id set) — powers the Case
// Detail modal's combined pickup + production timeline. Null for any
// case created directly (not from a pickup), which the frontend uses to
// hide that section entirely rather than show empty pickup fields.
// l.created_at (the "Requested" stage — pickupStatus.js has no
// pickup_requested_at column, that stage is just the lead's own
// creation time) is aliased to pickup_requested_at since cases already
// has its own created_at — an unaliased duplicate column name would
// silently collide in the resulting JSON row.
// ?rep=<user id> — admin-only drill-down (Rep Detail page): a case has no
// assigned_to of its own, so "this rep's cases" means cases whose
// client_name matches one of that rep's clients (same clients.assigned_to
// join reports.js's team-comparison already uses for the count-only
// version of this).
router.get('/', auth, async (req, res, next) => {
  try {
    const { rep } = req.query
    const params = []
    let repJoin = ''
    let repWhere = ''
    if (rep) {
      params.push(rep)
      repJoin = `JOIN clients cl ON cl.doctor_name = c.client_name`
      repWhere = `WHERE cl.assigned_to = $${params.length}`
    }
    const { rows } = await db.query(
      `SELECT c.*, l.pickup_status, l.created_at AS pickup_requested_at,
              l.pickup_dispatched_at, l.pickup_received_at,
              l.pickup_date, l.pickup_window
       FROM cases c
       LEFT JOIN leads l ON l.id = c.original_lead_id
       ${repJoin}
       ${repWhere}
       ORDER BY c.due_date ASC NULLS LAST`,
      params
    )
    res.json(rows)
  } catch (err) { next(err) }
})

// GET /api/cases/stages — returns stage counts for dashboard
router.get('/stages', auth, async (req, res, next) => {
  try {
    const { rows } = await db.query(
      `SELECT status, COUNT(*) AS count FROM cases
       WHERE status != 'Completed' GROUP BY status`
    )
    res.json(rows)
  } catch (err) { next(err) }
})

// POST /api/cases
router.post('/', auth, async (req, res, next) => {
  try {
    const d = req.body
    if (!d.client_name?.trim()) return res.status(400).json({ error: 'Client name is required' })
    if (!d.due_date) return res.status(400).json({ error: 'Due date is required' })
    const caseNumber = d.case_number?.trim() || await generateCaseNumber(d.brand || 'Aim Dental')
    const stage = d.status && STAGES.includes(d.status) ? d.status : 'Case Received'
    const stageHistory = [{ stage, changed_at: new Date().toISOString(), changed_by: req.user.id }]

    const { rows } = await db.query(
      `INSERT INTO cases (case_number, client_name, brand, case_type, patient,
       assigned_technician, tracking_number, due_date, est_completion_date, value,
       priority, status, notes, doctor_email, doctor_phone, stage_history,
       product, tooth_numbers, quantity, shade, special_instructions, evident_case_number,
       sterilized_by, sterilized_at, entered_by, entered_at,
       plaster_checked_by, plaster_checked_at, delivered_by, delivered_at, packed_by, packed_at,
       outsourcing_return_date, outsourcing_tracking_number, shipped_to_outsourcing_at,
       original_lead_id, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16::jsonb,
       $17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30,$31,$32,$33,$34,$35,$36,
       NOW(),NOW()) RETURNING *`,
      [caseNumber, d.client_name.trim(), d.brand || 'Aim Dental', d.case_type || 'Crown & Bridge',
       d.patient || '', d.assigned_technician || '', d.tracking_number || '',
       d.due_date, d.est_completion_date || null, Number(d.value) || 0,
       d.priority || 'Normal', stage, d.notes || '',
       d.doctor_email || '', d.doctor_phone || '', JSON.stringify(stageHistory),
       d.product || '', d.tooth_numbers || '', Number(d.quantity) || 1, d.shade || '',
       d.special_instructions || '', d.evident_case_number || '',
       d.sterilized_by || '', d.sterilized_at || null, d.entered_by || '', d.entered_at || null,
       d.plaster_checked_by || '', d.plaster_checked_at || null,
       d.delivered_by || '', d.delivered_at || null, d.packed_by || '', d.packed_at || null,
       d.outsourcing_return_date || null, d.outsourcing_tracking_number || '',
       d.shipped_to_outsourcing_at || null, d.lead_id || null]
    )

    // A case linked to a lead (picked from the New Case client search, or
    // auto-created from a received pickup) means that lead now has a case
    // at the lab — auto-convert them to a client so they show up in the
    // Clients list. Best-effort: a failure here shouldn't block case creation.
    if (d.lead_id) {
      convertLeadToClient(d.lead_id, { actorId: req.user.id }).catch(err =>
        console.error('case create: lead-to-client conversion failed', err))
    }

    res.status(201).json(rows[0])
  } catch (err) { next(err) }
})

// PUT /api/cases/:id
router.put('/:id', auth, async (req, res, next) => {
  try {
    const d = req.body
    const { rows: prev } = await db.query('SELECT * FROM cases WHERE id=$1', [req.params.id])
    if (!prev[0]) return res.status(404).json({ error: 'Case not found' })

    const stageChanged = d.status && d.status !== prev[0].status && STAGES.includes(d.status)
    let stageHistory = prev[0].stage_history || []
    if (stageChanged) {
      stageHistory = [...stageHistory, { stage: d.status, changed_at: new Date().toISOString(), changed_by: req.user.id }]
    }

    const { rows } = await db.query(
      `UPDATE cases SET case_number=$1, client_name=$2, brand=$3, case_type=$4, patient=$5,
       assigned_technician=$6, tracking_number=$7, due_date=$8, est_completion_date=$9,
       value=$10, priority=$11, status=$12, notes=$13, doctor_email=$14, doctor_phone=$15,
       stage_history=$16::jsonb,
       product=$17, tooth_numbers=$18, quantity=$19, shade=$20, special_instructions=$21,
       evident_case_number=$22, sterilized_by=$23, sterilized_at=$24, entered_by=$25, entered_at=$26,
       plaster_checked_by=$27, plaster_checked_at=$28, delivered_by=$29, delivered_at=$30,
       packed_by=$31, packed_at=$32, outsourcing_return_date=$33,
       outsourcing_tracking_number=$34, shipped_to_outsourcing_at=$35,
       updated_at=NOW() WHERE id=$36 RETURNING *`,
      [d.case_number || prev[0].case_number, d.client_name, d.brand || 'Aim Dental',
       d.case_type || 'Crown & Bridge', d.patient || '', d.assigned_technician || '',
       d.tracking_number || '', d.due_date, d.est_completion_date || null,
       Number(d.value) || 0, d.priority || 'Normal', d.status || prev[0].status,
       d.notes || '', d.doctor_email || '', d.doctor_phone || '',
       JSON.stringify(stageHistory),
       d.product || '', d.tooth_numbers || '', Number(d.quantity) || 1, d.shade || '',
       d.special_instructions || '', d.evident_case_number || '',
       d.sterilized_by || '', d.sterilized_at || null, d.entered_by || '', d.entered_at || null,
       d.plaster_checked_by || '', d.plaster_checked_at || null,
       d.delivered_by || '', d.delivered_at || null, d.packed_by || '', d.packed_at || null,
       d.outsourcing_return_date || null, d.outsourcing_tracking_number || '',
       d.shipped_to_outsourcing_at || null, req.params.id]
    )

    // Send notification email if stage changed
    if (stageChanged) await sendCaseNotification(rows[0], d.status)

    // Log activity
    if (stageChanged) {
      await db.query(
        `INSERT INTO activities (entity_type, entity_id, type, description, created_by)
         VALUES ('case',$1,'stage_change',$2,$3)`,
        [req.params.id, `Stage changed to "${d.status}"`, req.user.id]
      ).catch(() => {})
    }

    res.json(rows[0])
  } catch (err) { next(err) }
})

// POST /api/cases/:id/resend-notification
router.post('/:id/resend-notification', auth, async (req, res, next) => {
  try {
    const { rows } = await db.query('SELECT * FROM cases WHERE id=$1', [req.params.id])
    if (!rows[0]) return res.status(404).json({ error: 'Case not found' })
    await sendCaseNotification(rows[0], rows[0].status)
    res.json({ success: true })
  } catch (err) { next(err) }
})

// DELETE /api/cases/:id (admin only)
router.delete('/:id', auth, requireAdmin, async (req, res, next) => {
  try {
    await db.query('DELETE FROM cases WHERE id=$1', [req.params.id])
    res.json({ success: true })
  } catch (err) { next(err) }
})

module.exports = router
