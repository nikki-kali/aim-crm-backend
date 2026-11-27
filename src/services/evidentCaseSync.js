// Daily Evident -> CRM case sync (user, 2026-11-28): keeps the CRM's copy of
// every Evident case current from four reports Cowork set up for the CRM on
// 2026-11-25 (all to media@, Mon-Sun):
//   Cases Booked Today - AIM CRM (#120, 19:00 Central): each case booked that day
//   Cases Sent Today - AIM CRM   (#121, 22:00): each case with a shipping date that day
//   Open Cases - AIM CRM         (#122, 22:00): every case not Sent or Cancelled
//   Invoices Today - AIM CRM     (#123, 19:00): each case billed that day; total = #118
// Each case report has one row per case (Ref first), the case's current status
// as a filled column under its status name (Arrived, Held, ...), and a totals row
// with a blank Ref. Replaces the arrivals-and-billing sync in evidentCrmSync.js,
// which could not see status changes.
//
// The work is split in two so it can be checked before anything is written:
// planEvidentDay() decides every change from the emails and the CRM's current
// cases (pure), applyEvidentPlan() writes them.
const db = require('../config/db')
const { parseTable } = require('./evidentReport/parseEvident')
const { fetchEvidentEmailsInRange } = require('./evidentReport/gmailFetch')
const { normalizeDoctorName, resolveRepId, isTestAccount, gmailDateBounds } = require('./evidentCrmSync')
const { syncClientRevenue } = require('./clientRevenue')

const REPORT_SUBJECTS = {
  booked: 'Cases Booked Today - AIM CRM',
  sent: 'Cases Sent Today - AIM CRM',
  open: 'Open Cases - AIM CRM',
  invoices: 'Invoices Today - AIM CRM',
}

const EVIDENT_STATUSES = ['Input', 'New', 'Arrived', 'Held', 'Complete', 'Sent', 'Cancelled']
// "Closed": the case left Open Cases without showing up in Cases Sent Today
// (sent on a day whose email never came, or cancelled). Never treated as Sent.
const CLOSED_STATUSES = new Set(['Sent', 'Cancelled', 'Closed'])
const isOpen = (s) => Boolean(s) && !CLOSED_STATUSES.has(s)

// The CRM's own stages (lib/cases.js STAGES) for each Evident status.
const STATUS_TO_STAGE = {
  Input: 'Case Received', New: 'Case Received',
  Arrived: 'In Production', Held: 'In Production',
  Complete: 'Ready for Dispatch',
  Sent: 'Completed', Cancelled: 'Completed', Closed: 'Completed',
}

// Clients whose revenue was entered by hand and have no cases (2026-08-31):
// never recomputed.
const PROTECTED_CLIENTS = new Set(['Dr. Carlos Mendez', 'Dr. Helen Park', 'Dr. Patricia Walsh', 'Dr. Robert Kim', 'Dr. Thomas Grant', 'Dr. Yuki Tanaka'])
// Evident customers whose CRM client exists under another spelling (2026-11-28).
const CLIENT_FOR_CODE = { KH2237: 'Chemed Health' }

// The full history was loaded from exports taken on this day (2026-11-28 run of
// scripts/backfill-evident-history.js); billing on or before it is already in
// cases.billed_value, so only later invoice days add to it.
const HISTORY_LOADED_THROUGH = '2026-11-25'

// If Open Cases lists fewer than this share of the cases the CRM has open, the
// email is treated as broken and no case is closed from it.
const MIN_OPEN_SHARE = 0.5

const num = (s) => {
  const n = parseFloat(String(s == null ? '' : s).replace(/[,$]/g, '').trim())
  return Number.isNaN(n) ? 0 : n
}
const day = (s) => (/^\d{4}-\d{2}-\d{2}/.test(String(s || '').trim()) ? String(s).trim().slice(0, 10) : null)
const round2 = (n) => Math.round(n * 100) / 100
const brandFromCode = (code) => (/^KH/i.test(code || '') ? 'Kings Highway' : 'Aim Dental')

// The table of one case report as { cases, total, consistent }, or null when the
// email has no readable table with a Ref column. Columns are found by header, so
// a report without (say) Last (Shipping) still reads; missing fields are null.
function parseCaseReport(html) {
  const table = parseTable(String(html || ''))
  if (!table) return null
  const h = table.headers.map((x) => x.trim())
  const at = (name) => h.indexOf(name)
  const ref = at('Ref')
  if (ref < 0) return null
  const col = {
    patient: at('Case Number'), code: at('Customer Code'), name: at('Customer Name'),
    salesperson: at('Salesperson'), product: at('Product Name'), value: at('Sales Value (Total)'),
    booked: at('First Booking'), arrived: at('First Arrival'), ship: at('Last (Shipping)'),
  }
  const statusCols = EVIDENT_STATUSES.map((s) => [s, at(s)]).filter(([, i]) => i >= 0)
  const get = (r, i) => (i >= 0 ? String(r[i] == null ? '' : r[i]).trim() : null)
  const cases = []
  let totalRow = null
  for (const r of table.rows) {
    if (get(r, ref) === '') { totalRow = r; continue }
    const status = (statusCols.find(([, i]) => get(r, i) !== '') || [null])[0]
    cases.push({
      ref: get(r, ref),
      patient: get(r, col.patient),
      code: get(r, col.code),
      customerName: get(r, col.name),
      salesperson: get(r, col.salesperson),
      product: get(r, col.product),
      value: col.value >= 0 ? num(get(r, col.value)) : null,
      bookedOn: day(get(r, col.booked)),
      arrivedOn: day(get(r, col.arrived)),
      shipDate: day(get(r, col.ship)),
      evidentStatus: status,
    })
  }
  const sum = round2(cases.reduce((n, c) => n + (c.value || 0), 0))
  const total = totalRow && col.value >= 0 ? num(totalRow[col.value]) : null
  return { cases, total, consistent: total === null || Math.abs(total - sum) <= 0.05 }
}

// Invoices Today: [{ ref, code, amount, invoiceDate }] plus its totals row.
function parseInvoiceReport(html) {
  const table = parseTable(String(html || ''))
  if (!table) return null
  const h = table.headers.map((x) => x.trim())
  const ref = h.indexOf('Ref')
  const amount = h.indexOf('Sales Value (Total Billed)')
  const date = h.indexOf('Last (Invoice)')
  const code = h.indexOf('Customer Code')
  if (ref < 0 || amount < 0) return null
  const rows = []
  let totalRow = null
  for (const r of table.rows) {
    const x = String(r[ref] == null ? '' : r[ref]).trim()
    if (x === '') { totalRow = r; continue }
    rows.push({ ref: x, code: code >= 0 ? String(r[code] || '').trim() : null, amount: num(r[amount]), invoiceDate: date >= 0 ? day(r[date]) : null })
  }
  const sum = round2(rows.reduce((n, r) => n + r.amount, 0))
  const total = totalRow ? num(totalRow[amount]) : null
  return { rows, total, consistent: total === null || Math.abs(total - sum) <= 0.05 }
}

// Every change for one Evident business day, worked out from that day's four
// reports and the CRM's current cases (Map ref -> { evident_status }).
// Reports are applied in the order booked, sent, open: Open Cases is the
// evening's full snapshot, so it has the last word on an open case's status.
function planEvidentDay({ date, booked = null, sent = null, open = null, invoices = null, current = new Map() }) {
  const merged = new Map()
  const notes = []
  const take = (report, source) => {
    if (!report) return
    if (!report.consistent) notes.push(`${source}: the rows do not add up to the report's own total; used anyway`)
    for (const c of report.cases) {
      const prev = merged.get(c.ref) || { ref: c.ref }
      const next = { ...prev }
      for (const [k, v] of Object.entries(c)) if (v !== null && v !== '' && v !== undefined) next[k] = v
      if (c.evidentStatus) next.statusSource = source
      merged.set(c.ref, next)
    }
  }
  take(booked, 'booked-today')
  take(sent, 'sent-today')
  take(open, 'open-cases')

  const skipped = []
  const upserts = []
  for (const rec of merged.values()) {
    if (isTestAccount(rec.customerName, rec.code)) { skipped.push({ ref: rec.ref, why: 'test account' }); continue }
    const cur = current.get(rec.ref)
    if (!cur && !rec.customerName) { skipped.push({ ref: rec.ref, why: 'no doctor name in Evident' }); continue }
    if (rec.evidentStatus === 'Cancelled') rec.value = 0
    upserts.push({ ...rec, exists: Boolean(cur), fromStatus: cur ? cur.evident_status || null : null })
  }

  // Cases the CRM has open that tonight's Open Cases no longer lists, and that
  // weren't in Cases Sent Today either, are closed (see "Closed" above). Only
  // from an Open Cases email that looks whole.
  const closures = []
  if (open) {
    const openRefs = new Set(open.cases.map((c) => c.ref))
    // A case with no Evident status yet (in the CRM but not in the 2026-11-25
    // export) counts as open until Evident's open list says otherwise.
    const crmOpen = [...current.entries()].filter(([, c]) => isOpen(c.evident_status) || !c.evident_status)
    const looksWhole = open.consistent && openRefs.size >= Math.floor(crmOpen.length * MIN_OPEN_SHARE)
    if (!looksWhole) {
      notes.push(`open-cases: lists ${openRefs.size} cases against ${crmOpen.length} open in the CRM; no case was closed from it`)
    } else {
      for (const [ref, c] of crmOpen) {
        if (openRefs.has(ref)) continue
        const m = merged.get(ref)
        if (m && m.evidentStatus && !isOpen(m.evidentStatus)) continue // Sent/Cancelled today, already an upsert
        closures.push({ ref, fromStatus: c.evident_status })
      }
    }
  }

  const invoiceRows = invoices ? invoices.rows.map((r) => ({ ...r, invoiceDate: r.invoiceDate || date })) : []
  if (invoices && !invoices.consistent) notes.push('invoices-today: the rows do not add up to the report\'s own total')
  return { date, upserts, closures, invoiceRows, skipped, notes }
}

// Writes a plan. Returns counts. `rollback: true` runs every write and then
// undoes it (to check the SQL against the real database without changing it).
async function applyEvidentPlan(plan, { rollback = false } = {}) {
  const out = { inserted: 0, updated: 0, statusChanges: 0, closed: 0, invoiceDays: 0, billedAdded: 0, newClients: [] }
  const touched = new Set()
  const client = await db.connect()
  try {
    await client.query('BEGIN')
    const event = (caseId, ref, from, to, source) => client.query(
      `INSERT INTO case_status_events (case_id, evident_case_number, from_status, to_status, status_date, source)
       VALUES ($1,$2,$3,$4,$5,$6)`, [caseId, ref, from, to, plan.date, source])

    for (const r of plan.upserts) {
      const stage = r.evidentStatus ? STATUS_TO_STAGE[r.evidentStatus] : null
      if (r.exists) {
        const { rows } = await client.query(
          `UPDATE cases SET
             patient = COALESCE(NULLIF($2,''), patient), product = COALESCE(NULLIF($3,''), product),
             value = COALESCE($4, value), evident_customer_code = COALESCE(NULLIF($5,''), evident_customer_code),
             booked_on = COALESCE($6, booked_on), arrived_on = COALESCE($7, arrived_on), ship_date = COALESCE($8, ship_date),
             evident_status = COALESCE($9, evident_status), status = COALESCE($10, status),
             wip_value = GREATEST(COALESCE($4, value) - COALESCE(billed_value,0), 0),
             evident_synced_at = NOW(), updated_at = NOW()
           WHERE evident_case_number = $1
           RETURNING id, client_name`,
          [r.ref, r.patient, r.product, r.value, r.code, r.bookedOn, r.arrivedOn, r.shipDate, r.evidentStatus, stage])
        if (!rows[0]) continue
        out.updated++
        touched.add(rows[0].client_name)
        if (r.evidentStatus && r.evidentStatus !== r.fromStatus) {
          out.statusChanges++
          await event(rows[0].id, r.ref, r.fromStatus, r.evidentStatus, r.statusSource)
        }
        continue
      }
      // A case new to the CRM: file it under its doctor, creating the doctor if needed.
      const { rows: clients } = await client.query('SELECT doctor_name FROM clients')
      let clientName = CLIENT_FOR_CODE[r.code] || (clients.find((c) => normalizeDoctorName(c.doctor_name) === normalizeDoctorName(r.customerName)) || {}).doctor_name
      if (!clientName) {
        clientName = r.customerName
        await client.query(
          `INSERT INTO clients (doctor_name, brand, total_revenue, case_count, assigned_to, evident_customer_code, created_at, updated_at)
           VALUES ($1,$2,0,0,$3,$4,NOW(),NOW())`,
          [clientName, brandFromCode(r.code), await resolveRepId(r.salesperson), r.code || null])
        out.newClients.push(`${r.code} ${clientName}`)
      }
      const value = r.value || 0
      const { rows } = await client.query(
        `INSERT INTO cases (case_number, evident_case_number, client_name, brand, case_type, patient, product, value, billed_value, wip_value,
           status, evident_status, evident_customer_code, booked_on, arrived_on, ship_date, stage_history, evident_synced_at, created_at, updated_at)
         VALUES ($1,$2,$3,$4,'Other',$5,$6,$7,0,$7,$8,$9,$10,$11,$12,$13,'[]'::jsonb,NOW(),$14::timestamptz,NOW())
         RETURNING id`,
        [`EVD-${r.ref}`, r.ref, clientName, brandFromCode(r.code), r.patient || '', r.product || '', value,
          stage || 'In Production', r.evidentStatus, r.code || null, r.bookedOn, r.arrivedOn, r.shipDate,
          `${r.bookedOn || r.arrivedOn || plan.date}T00:00:00Z`])
      out.inserted++
      touched.add(clientName)
      if (r.evidentStatus) { out.statusChanges++; await event(rows[0].id, r.ref, null, r.evidentStatus, r.statusSource) }
    }

    for (const c of plan.closures) {
      const { rows } = await client.query(
        `UPDATE cases SET evident_status='Closed', status='Completed', wip_value=0, evident_synced_at=NOW(), updated_at=NOW()
         WHERE evident_case_number=$1 RETURNING id, client_name`, [c.ref])
      if (!rows[0]) continue
      out.closed++
      touched.add(rows[0].client_name)
      await event(rows[0].id, c.ref, c.fromStatus, 'Closed', 'open-cases')
    }

    // Billing: one row per case per day; a resent day's email replaces its rows,
    // and only the change is added to the case's billed total.
    for (const inv of plan.invoiceRows) {
      const { rows } = await client.query(
        `WITH old AS (SELECT amount FROM evident_invoice_days WHERE evident_case_number=$1 AND invoice_date=$2),
              up AS (INSERT INTO evident_invoice_days (evident_case_number, invoice_date, amount, customer_code, updated_at)
                     VALUES ($1,$2,$3,$4,NOW())
                     ON CONFLICT (evident_case_number, invoice_date) DO UPDATE SET amount=EXCLUDED.amount, customer_code=EXCLUDED.customer_code, updated_at=NOW()
                     RETURNING amount)
         SELECT (SELECT amount FROM up) - COALESCE((SELECT amount FROM old), 0) AS delta`,
        [inv.ref, inv.invoiceDate, inv.amount, inv.code || null])
      out.invoiceDays++
      const delta = Number(rows[0].delta) || 0
      if (inv.invoiceDate <= HISTORY_LOADED_THROUGH) continue
      const { rows: upd } = await client.query(
        `UPDATE cases SET billed_value = COALESCE(billed_value,0) + $2,
           wip_value = GREATEST(value - (COALESCE(billed_value,0) + $2), 0),
           last_invoice_date = GREATEST(COALESCE(last_invoice_date, $3::date), $3::date), updated_at = NOW()
         WHERE evident_case_number=$1 RETURNING client_name`, [inv.ref, delta, inv.invoiceDate])
      if (upd[0]) { out.billedAdded = round2(out.billedAdded + delta); touched.add(upd[0].client_name) }
    }
    await client.query(rollback ? 'ROLLBACK' : 'COMMIT')
  } catch (err) {
    await client.query('ROLLBACK')
    throw err
  } finally {
    client.release()
  }
  if (rollback) return out
  for (const name of touched) if (name && !PROTECTED_CLIENTS.has(name)) await syncClientRevenue(name)
  return out
}

// After a day is applied: does the CRM agree with that day's reports? Each
// mismatch is a plain sentence for the alert email.
async function checkEvidentDay(plan, reports) {
  const problems = []
  for (const [key, subject] of Object.entries(REPORT_SUBJECTS)) {
    if (!reports[key]) problems.push(`No "${subject}" email for ${plan.date}.`)
  }
  const skippedRefs = new Set(plan.skipped.map((s) => s.ref))
  if (reports.booked) {
    const refs = reports.booked.cases.map((c) => c.ref).filter((r) => !skippedRefs.has(r))
    const { rows } = await db.query('SELECT COUNT(*)::int AS n FROM cases WHERE evident_case_number = ANY($1)', [refs])
    if (rows[0].n !== refs.length) problems.push(`Cases Booked Today lists ${refs.length} cases; ${rows[0].n} are in the CRM.`)
  }
  if (reports.open) {
    const refs = new Set(reports.open.cases.map((c) => c.ref).filter((r) => !skippedRefs.has(r)))
    const { rows } = await db.query(`SELECT evident_case_number AS ref FROM cases WHERE evident_status IS NOT NULL AND evident_status NOT IN ('Sent','Cancelled','Closed')`)
    const crm = new Set(rows.map((r) => r.ref))
    const notInCrm = [...refs].filter((r) => !crm.has(r))
    const notInEvident = [...crm].filter((r) => !refs.has(r))
    if (notInCrm.length || notInEvident.length) {
      problems.push(`Open cases: Evident lists ${refs.size}, the CRM has ${crm.size} open` +
        `${notInCrm.length ? `; open in Evident only: ${notInCrm.slice(0, 15).join(', ')}` : ''}` +
        `${notInEvident.length ? `; open in the CRM only: ${notInEvident.slice(0, 15).join(', ')}` : ''}.`)
    }
  }
  if (reports.invoices && reports.invoices.total !== null) {
    const { rows } = await db.query('SELECT COALESCE(SUM(amount),0)::numeric AS t FROM evident_invoice_days WHERE invoice_date=$1', [plan.date])
    const crmTotal = round2(Number(rows[0].t))
    if (Math.abs(crmTotal - reports.invoices.total) > 0.05) problems.push(`Billing on ${plan.date}: Invoices Today says $${reports.invoices.total.toFixed(2)}, the CRM has $${crmTotal.toFixed(2)}.`)
  }
  return problems.concat(plan.notes)
}

// The four reports for one Evident business day, each the newest email of
// that subject dated `date` (America/New_York), parsed; null when missing.
async function fetchEvidentDay(date) {
  const bounds = gmailDateBounds(date)
  const out = {}
  for (const [key, subject] of Object.entries(REPORT_SUBJECTS)) {
    const msgs = (await fetchEvidentEmailsInRange(`subject:"${subject}" ${bounds}`))
      .filter((m) => m.date === date && String(m.subject || '').trim().startsWith(subject))
      .sort((a, b) => (b.internalDate || 0) - (a.internalDate || 0))
    out[key] = msgs[0] ? (key === 'invoices' ? parseInvoiceReport(msgs[0].html) : parseCaseReport(msgs[0].html)) : null
  }
  return out
}

async function currentEvidentCases() {
  const { rows } = await db.query('SELECT evident_case_number, evident_status FROM cases WHERE evident_case_number IS NOT NULL')
  return new Map(rows.map((r) => [r.evident_case_number, { evident_status: r.evident_status }]))
}

// One day, start to finish. `apply: false` works everything out and writes nothing.
async function syncEvidentCasesForDate(date, { apply = true } = {}) {
  const reports = await fetchEvidentDay(date)
  const plan = planEvidentDay({ date, ...reports, current: await currentEvidentCases() })
  const changes = plan.upserts.filter((u) => u.evidentStatus && u.evidentStatus !== u.fromStatus)
  const byKind = {}
  for (const u of changes) { const k = `${u.fromStatus || 'new'} -> ${u.evidentStatus}`; byKind[k] = (byKind[k] || 0) + 1 }
  const summary = {
    date, mode: apply ? 'applied' : 'dry run',
    reportsFound: Object.fromEntries(Object.entries(reports).map(([k, v]) => [k, v ? (v.cases || v.rows).length : null])),
    newCases: plan.upserts.filter((u) => !u.exists).length,
    statusChanges: byKind,
    statusChangeExamples: changes.slice(0, 20).map((u) => `${u.ref}: ${u.fromStatus || 'new'} -> ${u.evidentStatus}`),
    closures: plan.closures.map((c) => c.ref),
    invoiceRows: plan.invoiceRows.length,
    invoiceTotal: reports.invoices ? reports.invoices.total : null,
    skipped: plan.skipped,
    notes: plan.notes,
  }
  if (!apply) return summary
  summary.applied = await applyEvidentPlan(plan)
  summary.problems = await checkEvidentDay(plan, reports)
  return summary
}

module.exports = {
  REPORT_SUBJECTS, STATUS_TO_STAGE, PROTECTED_CLIENTS, CLIENT_FOR_CODE, HISTORY_LOADED_THROUGH,
  parseCaseReport, parseInvoiceReport, planEvidentDay, applyEvidentPlan, checkEvidentDay, syncEvidentCasesForDate, isOpen,
}
