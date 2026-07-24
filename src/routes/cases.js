const express = require('express')
const db = require('../config/db')
const auth = require('../middleware/auth')
const requireAdmin = require('../middleware/requireAdmin')
const { generateCaseNumber } = require('../utils/caseNumber')
const { sendEmail } = require('../services/email')

const router = express.Router()

const STAGES = [
  'Case Received', 'Awaiting Scan', 'Case Accepted',
  'In Production', 'Quality Control', 'Ready for Dispatch',
  'Dispatched', 'Completed',
]

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

// GET /api/cases
router.get('/', auth, async (req, res, next) => {
  try {
    const { rows } = await db.query('SELECT * FROM cases ORDER BY due_date ASC NULLS LAST')
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
       created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16::jsonb,
       $17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30,$31,$32,$33,$34,$35,
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
       d.shipped_to_outsourcing_at || null]
    )
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
