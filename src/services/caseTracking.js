// Helpers for the public "Track Your Case" lookup (routes/trackCase.js) when
// the case is an Evident case (case_number "EVD-<ref>", kept in step with
// Evident by services/evidentCaseSync.js).
//
// Doctors know an Evident case by its plain number (10150), so that is what
// they type. Evident cases rarely carry the doctor's email or phone, so the
// "on file" check also accepts the practice's email or phone from clients
// (matched by Evident customer code). The response shows only Evident's own
// steps, not the CRM's longer stage list, so the page never ticks a step the
// lab never reported.

const EVIDENT_STAGES = ['Case Received', 'In Production', 'Ready to Ship', 'Shipped']

const STATUS_TO_PUBLIC = {
  Input: 'Case Received',
  New: 'Case Received',
  Arrived: 'In Production',
  Held: 'In Production',
  Complete: 'Ready to Ship',
  Sent: 'Shipped',
  Cancelled: 'Cancelled',
  Closed: 'Closed',
}

// For the few Evident cases whose Evident status is not known yet.
const CRM_STATUS_TO_PUBLIC = {
  'Case Received': 'Case Received',
  'In Production': 'In Production',
  'Ready for Dispatch': 'Ready to Ship',
  Completed: 'Closed',
}

const OPEN_PUBLIC = new Set(['Case Received', 'In Production', 'Ready to Ship'])

// "10150", "#10150", "EVD-10150", "evd 10150" -> "10150"; anything else -> null.
function evidentRefFromInput(input) {
  const m = String(input || '').trim().match(/^(?:evd[-\s]?|#)?\s*(\d{3,7})$/i)
  return m ? m[1] : null
}

const digitsOnly = (v) => String(v || '').replace(/\D/g, '')

// Phone numbers match on their last 10 digits, so "+1 (718) 854-3900" and
// "7188543900" are the same number. Fewer than 7 digits never matches.
function phoneKey(v) {
  const d = digitsOnly(v)
  if (d.length < 7) return null
  return d.length > 10 ? d.slice(-10) : d
}

function contactMatches(input, { emails = [], phones = [] }) {
  const text = String(input || '').trim().toLowerCase()
  if (!text) return false
  if (text.includes('@')) return emails.some((e) => e && e.trim().toLowerCase() === text)
  const key = phoneKey(text)
  return !!key && phones.some((p) => phoneKey(p) === key)
}

// pg gives DATE columns back as JS Dates at local midnight; the page parses
// what it gets with new Date(), which would show a bare "2026-12-09" as Dec 8
// in New York. A local-noon timestamp shows the right day everywhere.
function pageDate(value) {
  if (!value) return null
  const s = value instanceof Date
    ? `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, '0')}-${String(value.getDate()).padStart(2, '0')}`
    : String(value).slice(0, 10)
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? `${s}T12:00:00` : null
}

const dayOf = (v) => (pageDate(v) || '').slice(0, 10) || null

// What the page shows for an Evident case. `row` is the cases row; `events`
// are its case_status_events rows (to_status, status_date), oldest first.
// `today` is YYYY-MM-DD (New York).
function evidentTrackingView(row, events = [], today) {
  const status = row.evident_status
    ? STATUS_TO_PUBLIC[row.evident_status] || 'In Production'
    : CRM_STATUS_TO_PUBLIC[row.status] || 'In Production'

  const at = {}
  const set = (stage, date) => { if (date && !at[stage]) at[stage] = date }
  set('Case Received', row.booked_on || row.arrived_on)
  set('In Production', row.arrived_on)
  for (const e of events) {
    const stage = STATUS_TO_PUBLIC[e.to_status]
    if (EVIDENT_STAGES.includes(stage)) at[stage] = e.status_date // latest wins
  }
  if (status === 'Shipped' && row.ship_date) at.Shipped = row.ship_date

  // Steps after the current one never carry a date (a case sent back to the
  // lab, for example, is "In Production" again).
  const reached = EVIDENT_STAGES.indexOf(status)
  const history = EVIDENT_STAGES
    .filter((stage, i) => at[stage] && (reached < 0 ? false : i <= reached))
    .map((stage) => ({ stage, changedAt: pageDate(at[stage]) }))

  // The planned ship date, only while the case is open and the date is
  // still ahead (a passed date would mislead).
  const plan = dayOf(row.ship_date)
  const estCompletionDate = OPEN_PUBLIC.has(status) && plan && (!today || plan >= today) ? pageDate(plan) : null

  return {
    caseNumber: row.evident_case_number,
    status,
    dueDate: null, // Evident's due date is not available to us
    estCompletionDate,
    onHold: row.evident_status === 'Held',
    stages: EVIDENT_STAGES,
    history,
    pickup: null,
  }
}

module.exports = {
  EVIDENT_STAGES,
  evidentRefFromInput,
  contactMatches,
  phoneKey,
  pageDate,
  evidentTrackingView,
}
