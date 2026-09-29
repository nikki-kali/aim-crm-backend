const db = require('../config/db')
const { isScopedRole } = require('../utils/roles')
const { computeProgress } = require('./goalProgress')
const { repCoachMessage } = require('./email')
const { businessDaysLeftInMonth, computeMonthlySalesGoal, computeMonthlyDoctorsGoal } = require('./salesRepDailyReport')
const { currentMonthEntry, buildSuggestedSteps, buildQuarterPacingLine } = require('./repProgressSuggestions')

// Fixed Q4 2026 window (user instruction, 2026-09-29). Exported so
// callers and tests share the exact same date literals rather than
// recomputing or duplicating them.
const Q4_MONTHS = [
  { month: 'October', period_start: '2026-10-01', period_end: '2026-10-31' },
  { month: 'November', period_start: '2026-11-01', period_end: '2026-11-30' },
  { month: 'December', period_start: '2026-12-01', period_end: '2026-12-31' },
]

// A scoped role (staff/sales_rep) may only ever view their own progress;
// an admin may view any rep_id (or their own, when none is given).
// Throws rather than returning null so route handlers can funnel it
// straight into Express's next(err) -> the existing centralized
// errorHandler.js, which already reads err.status (see that file).
function resolveViewableRepId(user, queryRepId) {
  if (isScopedRole(user.role)) {
    if (queryRepId && queryRepId !== user.id) {
      throw Object.assign(new Error("You don't have access to this rep's progress"), { status: 403 })
    }
    return user.id
  }
  return queryRepId || user.id
}

// Looks up the goals row (if any) that fits ENTIRELY inside one Q4
// calendar month for one metric - requires period_start/period_end to
// sit within [monthStart, monthEnd], not just overlap it. A row that
// merely overlaps (e.g. one Oct 1-Dec 31 quarterly row, which
// GoalsBoard.jsx's editable period dates allow someone to enter by
// mistake, or intentionally for a quarterly goal) would otherwise match
// every Q4 month's lookup and show the same figure three times with no
// way to tell them apart (review finding, 2026-09-29) - this page shows
// per-MONTH targets, so only a row scoped to that specific month counts.
async function fetchGoalRow(repId, metric, monthStart, monthEnd) {
  const { rows: [row] } = await db.query(
    `SELECT * FROM goals WHERE rep_id=$1 AND metric=$2 AND period_start >= $3 AND period_end <= $4 ORDER BY created_at DESC LIMIT 1`,
    [repId, metric, monthStart, monthEnd]
  )
  return row || null
}

// The full response for the progress page: real Q4 goals-vs-progress
// for all three months (whichever have a goals row - see Q4_MONTHS
// above and the spec's "target not set yet" requirement for the rest),
// deterministic suggested steps for the current month, and a coach
// message (the same repCoachMessage the daily email already uses, so
// the two surfaces never disagree).
async function fetchRepQ4Progress(repId, todayStr) {
  const { rows: [rep] } = await db.query(`SELECT id, name, email FROM users WHERE id=$1`, [repId])
  if (!rep) throw Object.assign(new Error('Rep not found'), { status: 404 })

  const months = []
  for (const m of Q4_MONTHS) {
    const isCurrent = todayStr >= m.period_start && todayStr <= m.period_end
    let salesGoal, doctorsGoal
    if (isCurrent) {
      // For the CURRENT month, reuse the exact same fallback-aware
      // lookups the daily email uses (computeMonthlySalesGoal/
      // computeMonthlyDoctorsGoal - both fall back to a flat default
      // target when no real goals row exists yet) so this page's coach
      // message and bars genuinely "match today's email exactly, no
      // drift" as the spec promises - a raw row-only lookup here would
      // show "not set yet" while the email shows a real number for the
      // same day (review finding, 2026-09-29). Future/past Q4 months
      // keep the strict real-rows-only lookup below: no fabricated
      // numbers for a quarter that hasn't been entered yet.
      ;[salesGoal, doctorsGoal] = await Promise.all([
        computeMonthlySalesGoal(rep.email, todayStr),
        computeMonthlyDoctorsGoal(rep.email, todayStr),
      ])
    } else {
      const [salesRow, doctorsRow] = await Promise.all([
        fetchGoalRow(repId, 'monthly_revenue', m.period_start, m.period_end),
        fetchGoalRow(repId, 'new_doctors', m.period_start, m.period_end),
      ])
      salesGoal = salesRow ? await computeProgress(salesRow) : null
      doctorsGoal = doctorsRow ? await computeProgress(doctorsRow) : null
    }
    months.push({ month: m.month, period_start: m.period_start, period_end: m.period_end, salesGoal, doctorsGoal })
  }

  const suggestedSteps = buildSuggestedSteps(months, todayStr)
  const quarterPacing = buildQuarterPacingLine(months, todayStr)

  let coachMessage = ''
  const cur = currentMonthEntry(months, todayStr)
  if (cur && (cur.salesGoal || cur.doctorsGoal)) {
    const firstName = (rep.name || '').split(' ')[0] || 'there'
    const daysLeft = businessDaysLeftInMonth(todayStr)
    const dayOfMonth = Number(todayStr.slice(8, 10))
    coachMessage = repCoachMessage({ firstName, salesGoal: cur.salesGoal, doctorsGoal: cur.doctorsGoal, daysLeft, dayOfMonth })
  }
  if (quarterPacing) coachMessage = coachMessage ? `${coachMessage} ${quarterPacing}` : quarterPacing

  return { repName: rep.name, quarter: 'Q4 2026', months, suggestedSteps, coachMessage }
}

module.exports = { resolveViewableRepId, fetchRepQ4Progress, Q4_MONTHS }
