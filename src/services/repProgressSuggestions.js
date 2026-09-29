const { businessDaysLeftInMonth } = require('./salesRepDailyReport')

// Finds the entry in `months` whose [period_start, period_end] window
// contains todayStr, or null if today falls outside all of them (e.g.
// before October or after December).
function currentMonthEntry(months, todayStr) {
  return months.find((m) => todayStr >= m.period_start && todayStr <= m.period_end) || null
}

// Concrete, deterministic next-step text for the CURRENT calendar month
// only - the other two Q4 months are either already over or haven't
// started, so a numeric "you need X/day" target isn't actionable for
// them. Never a live AI call (see spec). Returns [] when today isn't
// inside any Q4 month at all.
function buildSuggestedSteps(months, todayStr) {
  const cur = currentMonthEntry(months, todayStr)
  if (!cur) return []
  const { month, salesGoal, doctorsGoal } = cur

  if (!salesGoal && !doctorsGoal) {
    return [`Monthly targets for ${month} haven't been entered yet.`]
  }

  const steps = []
  const daysLeft = businessDaysLeftInMonth(todayStr)

  if (salesGoal) {
    const remaining = Number(salesGoal.target) - Number(salesGoal.current_value)
    if (remaining <= 0) {
      steps.push(`${month} sales goal reached. Great work.`)
    } else if (daysLeft > 0) {
      const perDay = Math.ceil(remaining / daysLeft)
      steps.push(`You need about $${perDay.toLocaleString('en-US')}/day in sales to hit your ${month} goal.`)
    } else {
      steps.push(`${month} sales goal: $${Math.round(remaining).toLocaleString('en-US')} short with no business days left.`)
    }
  }

  if (doctorsGoal) {
    const remaining = Number(doctorsGoal.target) - Number(doctorsGoal.current_value)
    if (remaining <= 0) {
      steps.push(`${month} new-doctors goal reached. Great work.`)
    } else if (daysLeft > 0) {
      const weeksLeft = Math.max(1, Math.ceil(daysLeft / 5))
      const perWeek = Math.ceil(remaining / weeksLeft)
      steps.push(`About ${perWeek} new doctor${perWeek === 1 ? '' : 's'} a week gets you to your ${month} goal.`)
    } else {
      // Same "no time left" framing as the sales branch above - a
      // weekly-rate suggestion here would silently contradict that line
      // (review finding, 2026-09-29).
      steps.push(`${month} new-doctors goal: ${remaining} short with no business days left.`)
    }
  }

  return steps
}

// A one-line quarter-pacing summary, added to the coach message once at
// least one Q4 month has fully ended (todayStr > that month's
// period_end) and has real sales-goal data. Sums only ENDED months so a
// partially-through month never drags the percentage down unfairly.
// Returns null before any month has ended, or if no ended month has a
// sales goal set.
function buildQuarterPacingLine(months, todayStr) {
  const completed = months.filter((m) => todayStr > m.period_end && m.salesGoal)
  if (completed.length === 0) return null
  const totalCurrent = completed.reduce((sum, m) => sum + Number(m.salesGoal.current_value), 0)
  const totalTarget = completed.reduce((sum, m) => sum + Number(m.salesGoal.target), 0)
  if (totalTarget <= 0) return null
  const pct = Math.round((totalCurrent / totalTarget) * 100)
  return `You're pacing at ${pct}% of your total Q4 sales goal so far.`
}

module.exports = { currentMonthEntry, buildSuggestedSteps, buildQuarterPacingLine }
