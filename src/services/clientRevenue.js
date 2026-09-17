const db = require('../config/db')

// Cases have no client_id FK — they're linked to a client by client_name
// matching clients.doctor_name (same join every report/rep-detail query
// already uses). total_revenue/case_count on clients is a denormalized
// summary of that, so it has to be recomputed here any time a case is
// created/updated rather than incremented — a value edit or a case moving
// to a different client_name would otherwise drift the old numbers.
// No-op if no client row exists yet for this name (e.g. sync fired before
// an async lead->client conversion finished) — case writes shouldn't fail
// just because the summary can't be synced yet.
async function syncClientRevenue(clientName) {
  if (!clientName) return
  await db.query(
    `UPDATE clients cl SET
       total_revenue = sub.total_value,
       case_count = sub.total_count,
       updated_at = NOW()
     FROM (SELECT COALESCE(SUM(value),0) AS total_value, COUNT(*) AS total_count
           FROM cases WHERE client_name = $1) sub
     WHERE cl.doctor_name = $1`,
    [clientName]
  )
}

// Real, verified YTD Billed revenue from the previous system AIM/Kings
// Highway used before this CRM existed — confirmed directly by the user
// (combined across both brands; no records survive broken out by brand).
// It predates per-client `cases` tracking entirely, so there's no client
// to attribute it to and no case row to create for it. Added only here, at
// the one company-wide total the CRM reports — never folded into any
// individual client's `total_revenue`, brand breakdown, or per-rep figure,
// all of which stay exactly real/case-attributed.
const LEGACY_YTD_REVENUE_ADJUSTMENT = 1243759

// The one place "Total Revenue" is computed company-wide — every route/job
// that shows this figure should call this instead of re-running
// `SUM(total_revenue)` inline, so the legacy adjustment stays consistent
// everywhere it's shown rather than needing to be duplicated per call site.
async function getCompanyTotalRevenue() {
  const { rows } = await db.query(`SELECT COALESCE(SUM(total_revenue),0) AS total FROM clients`)
  return Number(rows[0].total) + LEGACY_YTD_REVENUE_ADJUSTMENT
}

module.exports = { syncClientRevenue, getCompanyTotalRevenue, LEGACY_YTD_REVENUE_ADJUSTMENT }
