const test = require('node:test')
const assert = require('node:assert/strict')
const { buildCombinedLeadershipEmail } = require('../../src/services/evidentReport/buildReport')
const { applyEmailMtdTotals, parseAndAggregate } = require('../../src/services/evidentReport/parseEvident')

// Built from the real parser (empty input) so every field the template
// reads exists, then set to the real Oct 2 figures.
const agg = () => {
  const a = parseAndAggregate([], { runDate: '2026-10-02' })
  a.missing = []
  Object.assign(a, {
    companyDailyBooked: 4775.97, companyDailyBookedCount: 9, companyDailyBilled: 4126.81,
    companyMtdBooked: 14362.31, companyMtdBilled: 12850.78, companyYtdBilled: 395713.21,
    companyMtdBookedByRep: { na: 14089.82, james: 0, william: 272.49 },
    companyMtdBilledByRep: { na: 12280.82, james: 0, william: 569.96 },
  })
  a.eviSmart = applyEmailMtdTotals(null, a)
  a.eviSmart.lastMonth = { monthName: 'September', booked: 167953.56, billed: 170056.13 }
  return a
}

test('with no EviSmart email the dashboard still shows the Evident-sourced company totals, and says only Daily Billed is unavailable', () => {
  const { html } = buildCombinedLeadershipEmail(agg(), [], [], {})
  const text = html.replace(/<style[\s\S]*?<\/style>/gi, '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ')
  assert.match(text, /\$14,362\.31/)
  assert.match(text, /\$12,850\.78/)
  assert.match(text, /\$4,775\.97/)
  assert.match(text, /Daily Billed isn't available/)
  assert.doesNotMatch(text, /Daily\/MTD\/YTD Booked and Billed figures below aren't available/)
})

test('if Evident\'s MTD booked email is missing, the month comparison shows a notice instead of a made-up total', () => {
  const a = agg()
  a.missing = ['MTD Booked Daily Update']
  a.eviSmart = applyEmailMtdTotals(null, a)
  a.eviSmart.lastMonth = { monthName: 'September', booked: 1, billed: 1 }
  const { html } = buildCombinedLeadershipEmail(a, [], [], {})
  assert.match(html, /booked or billed total wasn't available/)
})

test('the "missing reports" banner only names reports whose figures are shown; a missing WIP report no longer raises a false warning', () => {
  const a = agg()
  a.missing = ['Cases Currently In Progress']
  assert.doesNotMatch(buildCombinedLeadershipEmail(a, [], [], {}).html, /Heads up: today's figures are missing/)
  a.missing = ['Cases Currently In Progress', 'Daily Billed Report - Nadine']
  const real = buildCombinedLeadershipEmail(a, [], [], {}).html
  assert.match(real, /missing 1 of the 4 Evident reports they come from \(Daily Billed Report - Nadine\)/)
  assert.doesNotMatch(real, /Cases Currently In Progress/)
})
