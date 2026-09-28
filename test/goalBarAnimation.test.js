const test = require('node:test')
const assert = require('node:assert/strict')
const {
  ease, goalBarFrameValues, renderGoalBarFrameHtml, framePlan,
  salesGoalFrameInput, doctorsGoalFrameInput, casesGoalFrameInput,
  COUNT_FRAMES, FRAME_DELAY_MS, HOLD_MS,
} = require('../src/services/goalBarAnimation')

test('ease starts and ends exactly at 0 and 1, and is monotonically increasing', () => {
  assert.equal(ease(0), 0)
  assert.equal(ease(1), 1)
  let prev = -1
  for (let i = 0; i <= 20; i++) {
    const t = ease(i / 20)
    assert.ok(t >= prev, `ease should be monotonic, got ${t} after ${prev}`)
    prev = t
  }
})

test('goalBarFrameValues interpolates value and pct linearly with progress', () => {
  const goal = { current_value: 100, target: 200 }
  assert.deepEqual(goalBarFrameValues(goal, 0), { value: 0, pct: 0 })
  assert.deepEqual(goalBarFrameValues(goal, 0.5), { value: 50, pct: 25 })
  assert.deepEqual(goalBarFrameValues(goal, 1), { value: 100, pct: 50 })
})

test('goalBarFrameValues caps pct at 100 even when current_value exceeds target', () => {
  const goal = { current_value: 500, target: 100 }
  const { pct } = goalBarFrameValues(goal, 1)
  assert.equal(pct, 100)
})

test('goalBarFrameValues never divides by zero when target is 0', () => {
  const goal = { current_value: 10, target: 0 }
  const { pct } = goalBarFrameValues(goal, 1)
  assert.equal(pct, 0)
})

test('framePlan holds only the final frame for HOLD_MS, every other frame for FRAME_DELAY_MS', () => {
  const { progresses, delaysMs } = framePlan()
  assert.equal(progresses.length, COUNT_FRAMES + 1)
  assert.equal(delaysMs.length, progresses.length)
  assert.equal(progresses[progresses.length - 1], 1)
  assert.equal(delaysMs[delaysMs.length - 1], HOLD_MS)
  assert.ok(delaysMs.slice(0, -1).every((d) => d === FRAME_DELAY_MS))
})

test('renderGoalBarFrameHtml renders one card per goal, with real formatted values and no orphaned templating', () => {
  const goals = [
    salesGoalFrameInput({ current_value: 15000, target: 30000 }),
    doctorsGoalFrameInput({ current_value: 4, target: 16 }),
  ]
  const { html, width, height } = renderGoalBarFrameHtml(goals, 0.5, { width: 600 })
  assert.equal(width, 600)
  assert.ok(height > 0)
  assert.match(html, /Monthly Sales/)
  assert.match(html, /New Doctors This Month/)
  assert.match(html, /\$7,500/) // 15000 * 0.5, real formatted dollar value
  assert.match(html, /of \$30,000/)
  assert.doesNotMatch(html, /\$\{/, 'no unresolved template placeholders')
  assert.doesNotMatch(html, /undefined|NaN/)
})

test('renderGoalBarFrameHtml at progress=1 shows the true final values, matching current_value exactly', () => {
  const goals = [casesGoalFrameInput({ current_value: 612, target: 900 })]
  const { html } = renderGoalBarFrameHtml(goals, 1)
  assert.match(html, />612</)
  assert.match(html, /68%/) // 612/900 rounded
})

test('salesGoalFrameInput/doctorsGoalFrameInput/casesGoalFrameInput return null for a missing goal (so a rep with only 2 goals gets 2 bars, not a broken 3rd)', () => {
  assert.equal(salesGoalFrameInput(null), null)
  assert.equal(doctorsGoalFrameInput(undefined), null)
  assert.equal(casesGoalFrameInput(null), null)
})
