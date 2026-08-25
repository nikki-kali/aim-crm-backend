const db = require('../config/db')
const { sendEmail, unassignedLeadsReportEmail } = require('./email')

const REPORT_TO = 'media@aimdentallab.com'
const REPORT_CC = ['execassistant@aimdentallab.com', 'ben@aimdentallab.com']

const WINDOW_DAYS = 7

async function computeUnassignedLeadsReport() {
  const windowStart = new Date(Date.now() - WINDOW_DAYS * 24 * 60 * 60 * 1000)
  const windowEnd = new Date()

  const { rows } = await db.query(
    `SELECT id, doctor_name, clinic_name, brand, case_interest, phone, email,
            lead_source, referral_source, estimated_value, location, created_at
     FROM leads
     WHERE assigned_to IS NULL AND is_archived = false AND created_at >= $1
     ORDER BY created_at DESC`,
    [windowStart.toISOString()]
  )

  return { leads: rows, windowStart, windowEnd }
}

function weekRangeLabel(start, end) {
  const startLabel = start.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
  const endLabel = end.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
  return `${startLabel} – ${endLabel}`
}

async function buildUnassignedLeadsReportHtml({ test = false } = {}) {
  const { leads, windowStart, windowEnd } = await computeUnassignedLeadsReport()
  const weekLabel = weekRangeLabel(windowStart, windowEnd)
  const html = unassignedLeadsReportEmail({ leads, weekLabel, test })
  return { html, leads, weekLabel }
}

async function sendUnassignedLeadsReport({ to = REPORT_TO, cc = REPORT_CC, test = false } = {}) {
  const { html, leads, weekLabel } = await buildUnassignedLeadsReportHtml({ test })
  const subject = `${test ? 'TEST — ' : ''}Weekly Unassigned Leads Report — ${weekLabel}`
  await sendEmail({ to, cc, subject, html })
  return { sent: true, count: leads.length, weekLabel }
}

module.exports = {
  computeUnassignedLeadsReport,
  buildUnassignedLeadsReportHtml,
  sendUnassignedLeadsReport,
  REPORT_TO,
  REPORT_CC,
}
