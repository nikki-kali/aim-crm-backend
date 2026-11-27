// scripts/backfill-evident-history.js
// One-time load of the full Evident case history into the CRM (user,
// 2026-11-28), from Cowork's Evident exports (tab-separated text saved as
// .xls, one header row, totals row last):
//   --cases=<file>    all 2026 cases: Ref, Case Number (patient), Customer Code,
//                     Customer Name, Salesperson, Product Name, Sales Value
//                     (Product), Sales Value (Total), First Booking, First
//                     Arrival, then one column per status (the current one is filled)
//   --invoices=<file> Ref, Case Number, Last (Invoice), Customer Code, Customer
//                     Name, Product Name, Salesperson, Sales Value (Total Billed)
//   --ship=<file>[,<file>] Ref, Case Number, Customer Code, Product Name, First
//                     Booking, First Arrival, Date Completed, Last (Shipping);
//                     one row per workflow task, so a case repeats
//   --asof=YYYY-MM-DD the day the exports were taken; invoice dates after it
//                     are Evident's $0 placeholders and are not kept
// Modes: no flag = dry run (reads only, prints what would change);
//        --ref=10101 --apply = that one case only; --apply = everything.
// Split lines on tabs, never a CSV reader: patient names contain quote marks.
require('dotenv').config({ quiet: true })
const fs = require('fs')
const db = require('../src/config/db')
const { normalizeDoctorName, resolveRepId, isTestAccount } = require('../src/services/evidentCrmSync')
const { syncClientRevenue } = require('../src/services/clientRevenue')

// Clients whose revenue was entered by hand and have no cases (2026-08-31):
// never recomputed. See memory/client-revenue-autosync-fix.
const PROTECTED_CLIENTS = new Set(['Dr. Carlos Mendez', 'Dr. Helen Park', 'Dr. Patricia Walsh', 'Dr. Robert Kim', 'Dr. Thomas Grant', 'Dr. Yuki Tanaka'])

// Evident customers whose CRM client already exists under another spelling
// (checked by hand, 2026-11-28): Evident's "Chemed Chemed Health" is the CRM's
// "Chemed Health".
const CLIENT_FOR_CODE = { KH2237: 'Chemed Health' }

const STATUS_TO_STAGE = {
  Input: 'Case Received', New: 'Case Received',
  Arrived: 'In Production', Held: 'In Production',
  Complete: 'Ready for Dispatch',
  Sent: 'Completed', Cancelled: 'Completed',
}
const EVIDENT_STATUSES = ['Arrived', 'Cancelled', 'Complete', 'Held', 'Input', 'New', 'Sent']

function args() {
  const out = {}
  for (const a of process.argv.slice(2)) {
    const [k, ...v] = a.replace(/^--/, '').split('=')
    out[k] = v.length ? v.join('=') : true
  }
  return out
}

function readTsv(file) {
  const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/).map((l) => l.split('\t'))
  const headers = lines[0].map((h) => h.trim())
  const rows = lines.slice(1).filter((r) => (r[0] || '').trim() !== '')
  const col = (name) => {
    const i = headers.indexOf(name)
    if (i < 0) throw new Error(`${file}: no "${name}" column (has: ${headers.join(', ')})`)
    return i
  }
  return { headers, rows, col }
}

const num = (s) => {
  const n = parseFloat(String(s || '').replace(/[,$]/g, '').trim())
  return Number.isNaN(n) ? 0 : n
}
const day = (s) => (/^\d{4}-\d{2}-\d{2}/.test(String(s || '').trim()) ? String(s).trim().slice(0, 10) : null)
const round2 = (n) => Math.round(n * 100) / 100
const brandFromCode = (code) => (/^KH/i.test(code || '') ? 'Kings Highway' : 'Aim Dental')

function buildRecords({ cases, invoices, ship, asof }) {
  const c = readTsv(cases)
  const statusCols = EVIDENT_STATUSES.filter((s) => c.headers.includes(s)).map((s) => [s, c.col(s)])
  const records = new Map()
  for (const r of c.rows) {
    const ref = r[c.col('Ref')].trim()
    const status = (statusCols.find(([, i]) => String(r[i] || '').trim() !== '') || [null])[0]
    records.set(ref, {
      ref,
      patient: (r[c.col('Case Number')] || '').trim(),
      code: (r[c.col('Customer Code')] || '').trim(),
      customerName: (r[c.col('Customer Name')] || '').trim(),
      salesperson: (r[c.col('Salesperson')] || '').trim(),
      product: (r[c.col('Product Name')] || '').trim(),
      value: num(r[c.col('Sales Value (Total)')]),
      bookedOn: day(r[c.col('First Booking')]),
      arrivedOn: day(r[c.col('First Arrival')]),
      evidentStatus: status,
      billed: 0, lastInvoiceDate: null, shipDate: null, completedAt: null,
    })
  }
  const inv = readTsv(invoices)
  for (const r of inv.rows) {
    const rec = records.get(r[inv.col('Ref')].trim())
    if (!rec) continue
    rec.billed = num(r[inv.col('Sales Value (Total Billed)')])
    const d = day(r[inv.col('Last (Invoice)')])
    rec.lastInvoiceDate = d && d <= asof ? d : null
  }
  for (const file of ship) {
    const s = readTsv(file)
    for (const r of s.rows) {
      const rec = records.get(r[s.col('Ref')].trim())
      if (!rec) continue
      const sd = day(r[s.col('Last (Shipping)')])
      if (sd && (!rec.shipDate || sd > rec.shipDate)) rec.shipDate = sd
      const dc = String(r[s.col('Date Completed')] || '').trim()
      if (/^\d{4}-\d{2}-\d{2}/.test(dc) && (!rec.completedAt || dc > rec.completedAt)) rec.completedAt = dc
    }
  }
  for (const rec of records.values()) {
    if (rec.evidentStatus === 'Cancelled') { rec.value = 0; rec.billed = 0 }
    rec.stage = STATUS_TO_STAGE[rec.evidentStatus] || 'In Production'
    rec.wip = round2(Math.max(rec.value - rec.billed, 0))
  }
  return records
}

async function main() {
  const a = args()
  if (!a.cases || !a.invoices || !a.ship || !/^\d{4}-\d{2}-\d{2}$/.test(a.asof || '')) {
    throw new Error('usage: --cases=<file> --invoices=<file> --ship=<file>[,<file>] --asof=YYYY-MM-DD [--ref=<Ref>] [--apply]')
  }
  const apply = a.apply === true
  const records = buildRecords({ cases: a.cases, invoices: a.invoices, ship: String(a.ship).split(','), asof: a.asof })
  let todo = [...records.values()]
  if (a.ref) todo = todo.filter((r) => r.ref === String(a.ref))
  if (a.ref && todo.length === 0) throw new Error(`Ref ${a.ref} is not in the export`)

  const { rows: existing } = await db.query(
    `SELECT id, evident_case_number, client_name, status, value, billed_value, jsonb_array_length(COALESCE(stage_history,'[]'::jsonb)) AS stage_changes
     FROM cases WHERE evident_case_number IS NOT NULL`)
  const byRef = new Map(existing.map((r) => [r.evident_case_number, r]))
  const { rows: clientRows } = await db.query('SELECT doctor_name FROM clients')
  const clientByNorm = new Map(clientRows.map((r) => [normalizeDoctorName(r.doctor_name), r.doctor_name]))

  const summary = { inExport: records.size, considered: todo.length, testSkipped: 0, noName: 0, inserts: 0, updates: 0, statusChanges: {}, staffStageEdits: 0, newClients: new Set(), valueBefore: 0, valueAfter: 0 }
  const touched = new Set()
  const repCache = new Map()
  const repFor = async (sp) => {
    if (!repCache.has(sp)) repCache.set(sp, await resolveRepId(sp))
    return repCache.get(sp)
  }

  // One connection for the whole load, so it is all-or-nothing.
  const q = apply ? await db.connect() : db
  if (apply) await q.query('BEGIN')
  try {
    for (const rec of todo) {
      if (isTestAccount(rec.customerName, rec.code)) { summary.testSkipped++; continue }
      const cur = byRef.get(rec.ref)
      const fields = [rec.patient, rec.product, rec.value, rec.billed, rec.wip, rec.stage, rec.evidentStatus, rec.code, rec.bookedOn, rec.arrivedOn, rec.shipDate, rec.lastInvoiceDate, rec.completedAt]
      if (cur) {
        summary.updates++
        summary.valueBefore += Number(cur.value) || 0
        summary.valueAfter += rec.value
        if (cur.status !== rec.stage) { const k = `${cur.status} -> ${rec.stage}`; summary.statusChanges[k] = (summary.statusChanges[k] || 0) + 1 }
        if (Number(cur.stage_changes) > 0) summary.staffStageEdits++
        touched.add(cur.client_name)
        if (apply) {
          await q.query(
            `UPDATE cases SET patient=$1, product=$2, value=$3, billed_value=$4, wip_value=$5, status=$6,
               evident_status=$7, evident_customer_code=$8, booked_on=$9, arrived_on=$10, ship_date=$11,
               last_invoice_date=$12, evident_completed_at=$13, evident_synced_at=NOW(), updated_at=NOW()
             WHERE id=$14`,
            [...fields, cur.id])
        }
        continue
      }
      if (!rec.customerName) { summary.noName++; continue }
      let clientName = CLIENT_FOR_CODE[rec.code] || clientByNorm.get(normalizeDoctorName(rec.customerName))
      if (!clientName) {
        clientName = rec.customerName
        summary.newClients.add(`${rec.code} ${clientName}`)
        clientByNorm.set(normalizeDoctorName(clientName), clientName)
        if (apply) {
          await q.query(
            `INSERT INTO clients (doctor_name, brand, total_revenue, case_count, assigned_to, evident_customer_code, created_at, updated_at)
             VALUES ($1,$2,0,0,$3,$4,NOW(),NOW())`,
            [clientName, brandFromCode(rec.code), await repFor(rec.salesperson), rec.code || null])
        }
      }
      summary.inserts++
      summary.valueAfter += rec.value
      touched.add(clientName)
      if (apply) {
        await q.query(
          `INSERT INTO cases (case_number, client_name, brand, case_type, patient, product, value, billed_value, wip_value, status,
             evident_status, evident_customer_code, booked_on, arrived_on, ship_date, last_invoice_date, evident_completed_at,
             evident_case_number, stage_history, evident_synced_at, created_at, updated_at)
           VALUES ($14,$15,$16,'Other',$1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$17,'[]'::jsonb,NOW(),$18::timestamptz,NOW())`,
          [...fields, `EVD-${rec.ref}`, clientName, brandFromCode(rec.code), rec.ref, `${rec.bookedOn || rec.arrivedOn || a.asof}T00:00:00Z`])
      }
    }
    // Remember each client's Evident customer code (first one seen), for
    // matching contact details and future syncs by code instead of name.
    if (apply) {
      await q.query(
        `UPDATE clients cl SET evident_customer_code = sub.code
         FROM (SELECT DISTINCT ON (client_name) client_name, evident_customer_code AS code FROM cases
               WHERE evident_customer_code IS NOT NULL ORDER BY client_name, booked_on DESC NULLS LAST) sub
         WHERE cl.doctor_name = sub.client_name AND cl.evident_customer_code IS NULL`)
      await q.query('COMMIT')
    }
  } catch (err) {
    if (apply) await q.query('ROLLBACK')
    throw err
  } finally {
    if (apply) q.release()
  }
  // After the commit, so the new cases count: each touched client's revenue
  // and case count, recomputed from its cases.
  if (apply) for (const name of touched) if (name && !PROTECTED_CLIENTS.has(name)) await syncClientRevenue(name)


  const out = { ...summary, newClients: [...summary.newClients].sort(), valueBefore: round2(summary.valueBefore), valueAfter: round2(summary.valueAfter), mode: apply ? 'APPLIED' : 'DRY RUN (nothing written)' }
  if (out.newClients.length > 40) out.newClients = [...out.newClients.slice(0, 40), `... and ${out.newClients.length - 40} more`]
  console.log(JSON.stringify(out, null, 2))
  if (a.ref) console.log('case:', JSON.stringify(todo[0], null, 2))
}

main().then(() => db.end && db.end()).catch(async (e) => { console.error('FAILED:', e.message); try { await db.end() } catch { /* ignore */ } process.exit(1) })
