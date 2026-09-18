// Shared with routes/goals.js (the Goals UI's own progress display) and
// evidentReport/index.js (the Leadership Report's Report #3 goal-progress
// section, added 2026-09-19) — extracted here rather than duplicated
// per this codebase's own convention of keeping real business logic in
// one place (see leadConversion.js) instead of small isolated helpers.
const db = require('../config/db')

const METRIC_LABELS = {
  leads_created: 'Leads Added',
  leads_won: 'Leads Won',
  leads_contacted: 'Leads Contacted',
  proposals_sent: 'Proposals Sent',
  conversion_rate: '% Conversion Rate',
  new_doctors: 'New Doctors',
  monthly_revenue: 'Revenue',
}

async function computeProgress(goal) {
  const { rep_id, metric, target, period_start, period_end } = goal
  let current = 0

  if (metric === 'leads_created') {
    const { rows: [r] } = await db.query(
      `SELECT COUNT(*) AS val FROM leads WHERE assigned_to=$1 AND created_at::date BETWEEN $2 AND $3`,
      [rep_id, period_start, period_end]
    )
    current = Number(r.val)
  } else if (metric === 'leads_won') {
    const { rows: [r] } = await db.query(
      `SELECT COUNT(*) AS val FROM leads WHERE assigned_to=$1 AND status='Won' AND updated_at::date BETWEEN $2 AND $3`,
      [rep_id, period_start, period_end]
    )
    current = Number(r.val)
  } else if (metric === 'leads_contacted') {
    const { rows: [r] } = await db.query(
      `SELECT COUNT(*) AS val FROM leads WHERE assigned_to=$1 AND status IN ('Contacted','Proposal','Won') AND updated_at::date BETWEEN $2 AND $3`,
      [rep_id, period_start, period_end]
    )
    current = Number(r.val)
  } else if (metric === 'proposals_sent') {
    const { rows: [r] } = await db.query(
      `SELECT COUNT(*) AS val FROM leads WHERE assigned_to=$1 AND status IN ('Proposal','Won') AND updated_at::date BETWEEN $2 AND $3`,
      [rep_id, period_start, period_end]
    )
    current = Number(r.val)
  } else if (metric === 'conversion_rate') {
    const { rows: [r] } = await db.query(
      `SELECT COUNT(*) AS total, COUNT(*) FILTER (WHERE status='Won') AS won
       FROM leads WHERE assigned_to=$1 AND created_at::date BETWEEN $2 AND $3`,
      [rep_id, period_start, period_end]
    )
    const total = Number(r.total)
    current = total > 0 ? Math.round(Number(r.won) * 100 / total) : 0
  } else if (metric === 'new_doctors') {
    const { rows: [r] } = await db.query(
      `SELECT COUNT(*) AS val FROM clients WHERE assigned_to=$1 AND created_at::date BETWEEN $2 AND $3`,
      [rep_id, period_start, period_end]
    )
    current = Number(r.val)
  } else if (metric === 'monthly_revenue') {
    // Real case revenue only, never leads.estimated_value (see CLAUDE.md) —
    // same cases-joined-to-clients-by-doctor_name pattern GET
    // /reports/team-comparison already uses for a rep's sales_value.
    const { rows: [r] } = await db.query(
      `SELECT COALESCE(SUM(c.value), 0) AS val
       FROM cases c JOIN clients cl ON cl.doctor_name = c.client_name
       WHERE cl.assigned_to=$1 AND c.created_at::date BETWEEN $2 AND $3`,
      [rep_id, period_start, period_end]
    )
    current = Number(r.val)
  }

  const pct = Number(target) > 0 ? Math.min(Math.round((current / Number(target)) * 100), 100) : 0
  return { ...goal, current_value: current, progress_pct: pct }
}

module.exports = { METRIC_LABELS, computeProgress }
