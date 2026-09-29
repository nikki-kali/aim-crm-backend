const test = require('node:test')
const assert = require('node:assert/strict')
const { buildSuggestedSteps, buildQuarterPacingLine, currentMonthEntry } = require('../src/services/repProgressSuggestions')

const OCT = { month: 'October', period_start: '2026-10-01', period_end: '2026-10-31' }
const NOV = { month: 'November', period_start: '2026-11-01', period_end: '2026-11-30' }
const DEC = { month: 'December', period_start: '2026-12-01', period_end: '2026-12-31' }

test('currentMonthEntry finds the month whose window contains todayStr', () => {
  const months = [OCT, NOV, DEC]
  assert.equal(currentMonthEntry(months, '2026-11-15').month, 'November')
  assert.equal(currentMonthEntry(months, '2026-09-30'), null)
})

test('buildSuggestedSteps: no goals set yet for the current month says so and stops', () => {
  const months = [{ ...OCT, salesGoal: null, doctorsGoal: null }, NOV, DEC]
  const steps = buildSuggestedSteps(months, '2026-10-05')
  assert.deepEqual(steps, ["Monthly targets for October haven't been entered yet."])
})

test('buildSuggestedSteps: real gap produces a $/day sales step and a doctors/week step', () => {
  const months = [{
    ...OCT,
    salesGoal: { current_value: 5000, target: 15000, progress_pct: 33 },
    doctorsGoal: { current_value: 4, target: 12, progress_pct: 33 },
  }, NOV, DEC]
  const steps = buildSuggestedSteps(months, '2026-10-05')
  assert.equal(steps.length, 2)
  assert.match(steps[0], /You need about \$\d[\d,]* ?\/day in sales to hit your October goal\./)
  assert.match(steps[1], /About \d+ new doctors? a week gets you to your October goal\./)
})

test('buildSuggestedSteps: a goal already met celebrates instead of showing a gap', () => {
  const months = [{
    ...OCT,
    salesGoal: { current_value: 16000, target: 15000, progress_pct: 100 },
    doctorsGoal: { current_value: 12, target: 12, progress_pct: 100 },
  }, NOV, DEC]
  const steps = buildSuggestedSteps(months, '2026-10-20')
  assert.equal(steps.length, 2)
  assert.match(steps[0], /October sales goal reached/)
  assert.match(steps[1], /October new-doctors goal reached/)
})

test('buildSuggestedSteps: zero business days left in the month never divides by zero', () => {
  const months = [OCT, NOV, {
    ...DEC,
    salesGoal: { current_value: 5000, target: 15000, progress_pct: 33 },
    doctorsGoal: { current_value: 4, target: 8, progress_pct: 50 },
  }]
  const steps = buildSuggestedSteps(months, '2026-12-31')
  assert.equal(steps.length, 2)
  assert.doesNotMatch(steps.join(' '), /Infinity|NaN/)
  // With zero business days left, the doctors line must match the sales
  // line's "no time left" framing, not a weekly rate that implies there's
  // still a week to work with - a real contradiction the review caught.
  assert.match(steps[1], /December new-doctors goal: 4 short with no business days left\./)
})

test('buildSuggestedSteps: outside any Q4 month returns no steps', () => {
  assert.deepEqual(buildSuggestedSteps([OCT, NOV, DEC], '2026-09-15'), [])
})

test('buildQuarterPacingLine: null before any month has ended', () => {
  const months = [
    { ...OCT, salesGoal: { current_value: 5000, target: 15000, progress_pct: 33 } },
    { ...NOV, salesGoal: null },
    { ...DEC, salesGoal: null },
  ]
  assert.equal(buildQuarterPacingLine(months, '2026-10-15'), null)
})

test('buildQuarterPacingLine: sums completed months only, once October has ended', () => {
  const months = [
    { ...OCT, salesGoal: { current_value: 14000, target: 15000, progress_pct: 93 } },
    { ...NOV, salesGoal: { current_value: 5000, target: 20000, progress_pct: 25 } },
    { ...DEC, salesGoal: null },
  ]
  assert.equal(buildQuarterPacingLine(months, '2026-11-05'), "You're pacing at 93% of your total Q4 sales goal so far.")
})
