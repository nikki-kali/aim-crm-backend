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

module.exports = { syncClientRevenue }
