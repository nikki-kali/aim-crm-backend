const test = require('node:test')
const assert = require('node:assert')
const { remakeCost } = require('../src/services/growthAudit/calc')
const { templateReport } = require('../src/services/growthAudit/report')
const { reportEmail } = require('../src/services/growthAudit/email')
const { stateFromAddress } = require('../src/routes/growthAudit')

test('remakeCost matches the website preview for the sample entry', () => {
  // 40 units, 3 remakes, 45 min at $700/hr, free remakes: the explainer's example.
  const c = remakeCost({ unitsPerMonth: 40, remakesPerMonth: 3, minutesPerRemake: 45, chairHourValue: 700, labFeePerRemake: 0 })
  assert.strictEqual(c.annualRemakes, 36)
  assert.strictEqual(c.total, 18900)
  assert.strictEqual(c.rate, 0.075)
  assert.strictEqual(c.aboveBenchmark, true)
  assert.strictEqual(c.scenarios[1].saved, 9450)
})

test('remakeCost ignores junk and clamps remakes to units', () => {
  const c = remakeCost({ unitsPerMonth: '10', remakesPerMonth: 50, minutesPerRemake: 'abc', chairHourValue: -5, labFeePerRemake: null })
  assert.strictEqual(c.inputs.remakes, 10)
  assert.strictEqual(c.inputs.minutes, 0)
  assert.strictEqual(c.total, 0)
})

test('stateFromAddress reads codes and spelled-out states', () => {
  assert.strictEqual(stateFromAddress('802 Myrtle Ave, Brooklyn, NY 11206'), 'NY')
  assert.strictEqual(stateFromAddress('123 Main St, Los Angeles, CA'), 'CA')
  assert.strictEqual(stateFromAddress('55 Ocean Blvd, Miami Florida 33101'), 'FL')
  assert.strictEqual(stateFromAddress('12 Elm St Springfield'), null)
})

test('report email escapes input and contains no em dashes', () => {
  const cost = remakeCost({ unitsPerMonth: 40, remakesPerMonth: 3, minutesPerRemake: 45, chairHourValue: 600, labFeePerRemake: 90 })
  const html = reportEmail({
    practice: '<script>x</script> Dental',
    cost,
    report: templateReport({ cost, pains: ['Shade'] }),
    contact: { name: 'James Delaney', firstName: 'James', region: 'New York City metro', email: 'james@aimdentallab.com', phone: '347-863-9787', phoneTel: '+13478639787' },
    repId: 'james',
  })
  assert.ok(!html.includes('<script>x</script>'))
  assert.ok(!/[—–]/.test(html))
  assert.ok(html.includes('utm_source=growth-audit-report'))
})
