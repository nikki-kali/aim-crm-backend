const db = require('../config/db')
const { extractBookingRows, extractBilledRows, parseTable, findCol, rowToObj } = require('./evidentReport/parseEvident')
const { fetchEvidentEmailsInRange } = require('./evidentReport/gmailFetch')
const { syncClientRevenue } = require('./clientRevenue')

// Same lowercase/strip-punctuation/collapse-whitespace normalization
// salesRepDailyReport.js already uses for its own doctor-name matching —
// duplicated here rather than shared, matching this codebase's convention
// for small isolated helpers (see CLAUDE.md's note on this pattern).
function normalizeDoctorName(name) {
  return (name || '').toLowerCase().replace(/[.,]/g, '').replace(/\s+/g, ' ').trim()
}

// Only two real reps exist in this CRM today — this fixed mapping doesn't
// need to anticipate a third. Any Salesperson value this doesn't
// recognize (blank, a typo, someone new) resolves to unassigned via
// resolveRepId's own fallback below, never an error.
const SALESPERSON_TO_REP_EMAIL = {
  james: 'james@aimdentallab.com',
  william: 'williama@aimdentallab.com',
}

// Resolves an Evident "Salesperson" cell to a real users.id, or null for
// the unassigned/"N/A" case — blank, unrecognized, or the rep genuinely
// not existing in this CRM (shouldn't happen, but never throws over it).
async function resolveRepId(salesperson) {
  const email = SALESPERSON_TO_REP_EMAIL[(salesperson || '').trim().toLowerCase()]
  if (!email) return null
  const { rows } = await db.query(`SELECT id FROM users WHERE email=$1`, [email])
  return rows[0] ? rows[0].id : null
}

// Aim-brand codes look like "A1234"/"A4106"; Kings Highway codes look
// like "KH2132". Evident's own reports don't have a brand field, but the
// Customer Code prefix reliably signals it (verified against real data
// throughout this session) — the existing manual import-evident route
// (cases.js) never derived this and just hardcodes 'Aim Dental' for every
// row; this sync gets it right since Customer Code is already available
// here as part of the raw row (see resolveClientName below).
function brandFromCustomerCode(customerCode) {
  return /^KH/i.test((customerCode || '').trim()) ? 'Kings Highway' : 'Aim Dental'
}

// Finds the existing client by normalized-name match, or creates one.
// Returns { clientName, created } — clientName is the EXACT stored
// clients.doctor_name to use as cases.client_name (matched or
// newly-created; every other join in this codebase relies on that exact
// string match — see cases.js's import-evident route, which this
// mirrors), and `created` tells the caller whether to count this toward
// summary.clientsCreated. assigned_to is set from the resolved repId (see
// resolveRepId above) — null for the N/A bucket, per this feature's
// Global Constraint.
async function resolveClientName(rawDoctorName, customerCode, repId) {
  const doctorName = (rawDoctorName || '').trim()
  if (!doctorName) return { clientName: null, created: false }
  const normalized = normalizeDoctorName(doctorName)

  const { rows } = await db.query(`SELECT doctor_name FROM clients`)
  const match = rows.find((r) => normalizeDoctorName(r.doctor_name) === normalized)
  if (match) return { clientName: match.doctor_name, created: false }

  const brand = brandFromCustomerCode(customerCode)
  await db.query(
    `INSERT INTO clients (doctor_name, brand, total_revenue, case_count, assigned_to, created_at, updated_at)
     VALUES ($1,$2,0,0,$3,NOW(),NOW())`,
    [doctorName, brand, repId]
  )
  return { clientName: doctorName, created: true }
}

// One booking-report row. Only creates a case when evident_case_number
// isn't already known — if it's already in the CRM (from an earlier run,
// or this same day's report re-processed), this is a no-op: booking rows
// never overwrite an already-billed case's status, which billed-row
// processing (below) owns. `customerCode` isn't in extractBookingRows'
// return shape (Task 1's ref/customerName/value/salesperson) — this
// function reads it from the raw row via a second, small lookup baked
// into syncCasesForDate below, not duplicated here.
async function upsertBookingRow(row, customerCode, dateStr) {
  const existing = await db.query(`SELECT id FROM cases WHERE evident_case_number=$1`, [row.ref])
  if (existing.rows[0]) return { created: false, clientName: null, clientCreated: false }

  const repId = await resolveRepId(row.salesperson)
  const { clientName, created: clientCreated } = await resolveClientName(row.customerName, customerCode, repId)
  // resolveClientName couldn't resolve a doctor name for this row (blank
  // customerName) — a real, trackable drop, distinct from the
  // already-exists no-op above (which also has clientName: null but isn't
  // a skip). Flagged explicitly so syncCasesForDate's summary.skipped
  // stays an honest count of rows that never became a case, rather than
  // conflating it with idempotent re-runs.
  if (!clientName) return { created: false, clientName: null, clientCreated: false, skipped: true }

  const brand = brandFromCustomerCode(customerCode)
  await db.query(
    `INSERT INTO cases (case_number, client_name, brand, case_type, patient, value, billed_value,
     wip_value, status, evident_case_number, product, stage_history, created_at, updated_at)
     VALUES ($1,$2,$3,'Other','',$4,0,$4,'In Production',$5,'','[]'::jsonb,$6::timestamptz,NOW())`,
    [`EVD-${row.ref}`, clientName, brand, row.value, row.ref, `${dateStr}T00:00:00Z`]
  )
  return { created: true, clientName, clientCreated }
}

// One billed-report row. Updates the existing case if booking already
// created it (the normal case — booking day and billing day are usually
// different, often weeks apart, and booking always runs first). Creates
// it from the billed row alone otherwise — an honest, documented
// limitation for a case whose original booking predates this pipeline's
// coverage (see the spec's "why chronological order matters" section),
// using the billed date as a fallback created_at.
async function upsertBilledRow(row, customerCode, dateStr) {
  const existing = await db.query(`SELECT id, client_name FROM cases WHERE evident_case_number=$1`, [row.ref])
  const status = row.billedValue > 0 ? 'Completed' : 'In Production'
  const wip = Math.max(row.value - row.billedValue, 0)

  if (existing.rows[0]) {
    await db.query(
      `UPDATE cases SET billed_value=$1, wip_value=$2, status=$3, updated_at=NOW() WHERE id=$4`,
      [row.billedValue, wip, status, existing.rows[0].id]
    )
    return { created: false, updated: true, clientName: existing.rows[0].client_name, clientCreated: false }
  }

  const repId = await resolveRepId(row.salesperson)
  const { clientName, created: clientCreated } = await resolveClientName(row.customerName, customerCode, repId)
  // Same distinction as upsertBookingRow above: this is a genuine drop
  // (blank doctor name), not the already-exists/updated no-op handled
  // above, so it's the one flagged into summary.skipped.
  if (!clientName) return { created: false, updated: false, clientName: null, clientCreated: false, skipped: true }

  const brand = brandFromCustomerCode(customerCode)
  await db.query(
    `INSERT INTO cases (case_number, client_name, brand, case_type, patient, value, billed_value,
     wip_value, status, evident_case_number, product, stage_history, created_at, updated_at)
     VALUES ($1,$2,$3,'Other','',$4,$5,$6,$7,$8,'','[]'::jsonb,$9::timestamptz,NOW())`,
    [`EVD-${row.ref}`, clientName, brand, row.value, row.billedValue, wip, status, row.ref, `${dateStr}T00:00:00Z`]
  )
  return { created: true, updated: false, clientName, clientCreated }
}

// The one function this whole feature is built around — fetches
// `dateStr`'s two company-wide Evident reports, processes every row, and
// returns a plain summary: { date, casesCreated, casesUpdated,
// clientsCreated, skipped, errors }. Never throws over a single bad row
// (logged into the returned `errors` array instead) — one malformed row
// must not abort the rest of the day, matching this codebase's
// established best-effort-per-item pattern (see
// sendAllSalesRepDailyReports). `skipped` counts rows that resolved to no
// usable doctor name (see resolveClientName/upsertBookingRow/
// upsertBilledRow's `skipped: true`) — a real, trackable drop, so
// casesCreated + casesUpdated + skipped accounts for every row a
// reconciliation run (Task 6) would want to check against the source
// email, distinct from an already-exists no-op (which isn't a drop).
// Gmail's `after:`/`before:` take YYYY/MM/DD and are date-only in the
// account's own timezone — rather than get that boundary exactly right,
// this brackets one full day of slack on each side and relies on
// fetchEvidentEmailsInRange's own per-message `date` (already computed
// correctly via internalDate converted to America/New_York) for the
// precise match below. Critically, this must NOT be `newer_than:1d` —
// that only ever finds yesterday's email, which is fine for the cron job
// (always "today") but would silently return nothing for every
// historical date the backfill script (Task 5) asks for.
function gmailDateBounds(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number)
  const after = new Date(Date.UTC(y, m - 1, d))
  after.setUTCDate(after.getUTCDate() - 1)
  const before = new Date(Date.UTC(y, m - 1, d))
  before.setUTCDate(before.getUTCDate() + 2)
  const fmt = (dt) => `${dt.getUTCFullYear()}/${String(dt.getUTCMonth() + 1).padStart(2, '0')}/${String(dt.getUTCDate()).padStart(2, '0')}`
  return `after:${fmt(after)} before:${fmt(before)}`
}

async function syncCasesForDate(dateStr) {
  const summary = { date: dateStr, casesCreated: 0, casesUpdated: 0, clientsCreated: 0, skipped: 0, errors: [] }
  const touchedClientNames = new Set()

  const dateQuery = gmailDateBounds(dateStr)
  const bookingMessages = await fetchEvidentEmailsInRange(`subject:"Daily Booking Report - Nadine" ${dateQuery}`)
  const billedMessages = await fetchEvidentEmailsInRange(`subject:"Daily Billed Report - Nadine" ${dateQuery}`)

  const bookingMsg = bookingMessages.find((m) => m.date === dateStr)
  const billedMsg = billedMessages.find((m) => m.date === dateStr)

  if (bookingMsg) {
    // customerCode lives in the raw table (Task 1's extractBookingRows
    // return shape deliberately doesn't carry it — callers that need it
    // read the table directly here, keeping the parser's public shape
    // focused on what most callers actually use).
    const table = parseTable(bookingMsg.html)
    const codeCol = table ? findCol(table.headers, 'Customer Code') : null
    const refCol = table ? findCol(table.headers, 'Ref') : null
    const codeByRef = new Map()
    if (table) {
      for (const r of table.rows.slice(0, -1)) {
        const obj = rowToObj(table.headers, r)
        codeByRef.set((obj[refCol] || '').trim(), obj[codeCol])
      }
    }

    for (const row of extractBookingRows(bookingMsg.html)) {
      try {
        const result = await upsertBookingRow(row, codeByRef.get(row.ref), dateStr)
        if (result.created) {
          summary.casesCreated++
          if (result.clientName) touchedClientNames.add(result.clientName)
        }
        if (result.clientCreated) summary.clientsCreated++
        if (result.skipped) summary.skipped++
      } catch (err) {
        summary.errors.push({ ref: row.ref, message: err.message })
      }
    }
  }

  if (billedMsg) {
    const table = parseTable(billedMsg.html)
    const codeCol = table ? findCol(table.headers, 'Customer Code') : null
    const refCol = table ? findCol(table.headers, 'Ref') : null
    const codeByRef = new Map()
    if (table) {
      for (const r of table.rows.slice(0, -1)) {
        const obj = rowToObj(table.headers, r)
        codeByRef.set((obj[refCol] || '').trim(), obj[codeCol])
      }
    }

    for (const row of extractBilledRows(billedMsg.html)) {
      try {
        const result = await upsertBilledRow(row, codeByRef.get(row.ref), dateStr)
        if (result.created) summary.casesCreated++
        if (result.updated) summary.casesUpdated++
        if (result.clientName) touchedClientNames.add(result.clientName)
        if (result.clientCreated) summary.clientsCreated++
        if (result.skipped) summary.skipped++
      } catch (err) {
        summary.errors.push({ ref: row.ref, message: err.message })
      }
    }
  }

  for (const clientName of touchedClientNames) {
    await syncClientRevenue(clientName)
  }

  return summary
}

module.exports = { normalizeDoctorName, resolveRepId, syncCasesForDate, gmailDateBounds }
