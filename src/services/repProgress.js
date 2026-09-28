const db = require('../config/db')
const { isScopedRole } = require('../utils/roles')
const { computeProgress } = require('./goalProgress')
const { repCoachMessage } = require('./email')
const { businessDaysLeftInMonth } = require('./salesRepDailyReport')
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

// Looks up the goals row (if any) covering a given reference date for
// one metric - same "period_start <= date <= period_end" match already
// used by salesRepDailyReport.js's computeMonthlySalesGoal/
// computeMonthlyDoctorsGoal, applied here once per Q4 month instead of
// just the current one.
async function fetchGoalRow(repId, metric, referenceDate) {
  const { rows: [row] } = await db.query(
    `SELECT * FROM goals WHERE rep_id=$1 AND metric=$2 AND period_start <= $3 AND period_end >= $3 ORDER BY created_at DESC LIMIT 1`,
    [repId, metric, referenceDate]
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
  const { rows: [rep] } = await db.query(`SELECT id, name FROM users WHERE id=$1`, [repId])
  if (!rep) throw Object.assign(new Error('Rep not found'), { status: 404 })

  const months = []
  for (const m of Q4_MONTHS) {
    const [salesRow, doctorsRow] = await Promise.all([
      fetchGoalRow(repId, 'monthly_revenue', m.period_start),
      fetchGoalRow(repId, 'new_doctors', m.period_start),
    ])
    const salesGoal = salesRow ? await computeProgress(salesRow) : null
    const doctorsGoal = doctorsRow ? await computeProgress(doctorsRow) : null
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
