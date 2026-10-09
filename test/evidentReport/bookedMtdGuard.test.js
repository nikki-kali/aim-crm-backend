const test = require('node:test')
const assert = require('node:assert/strict')
const { checkBookedMtd, previousWeekday, sameMonth } = require('../../src/services/evidentReport/bookedMtdGuard')

// Real figures: company "MTD Booked Daily Update" and the day's booked total.
test('Oct 7 (real): 29,631.30 + 6,743.51 booked = 36,803.29 reported, plausible', () => {
  assert.equal(checkBookedMtd({ mtd: 36803.29, prevMtd: 29631.3, dailyBooked: 6743.51 }).ok, true)
})

test('Oct 8 (real): Evident reported 485,192.03 after 36,803.29 with only 7,457.74 booked that day, rejected', () => {
  const r = checkBookedMtd({ mtd: 485192.03, prevMtd: 36803.29, dailyBooked: 7457.74 })
  assert.equal(r.ok, false)
  assert.match(r.reason, /485,192\.03/)
  assert.ok(Math.abs(r.expected - 44261.03) < 0.01)
})

test('small revisions either way are tolerated', () => {
  assert.equal(checkBookedMtd({ mtd: 44800, prevMtd: 36803.29, dailyBooked: 7457.74 }).ok, true)  // a few hundred up
  assert.equal(checkBookedMtd({ mtd: 36000, prevMtd: 36803.29, dailyBooked: 0 }).ok, true)        // small cancellation
})

test('a big drop is rejected (month-to-date cannot fall by 10 percent or more)', () => {
  assert.equal(checkBookedMtd({ mtd: 30000, prevMtd: 36803.29, dailyBooked: 7000 }).ok, false)
})

test('no previous reading (first business day, or a holiday gap): a sane figure passes and an impossible one fails', () => {
  assert.equal(checkBookedMtd({ mtd: 6800, prevMtd: null, dailyBooked: 6743.51 }).ok, true)
  assert.equal(checkBookedMtd({ mtd: 485192.03, prevMtd: null, dailyBooked: 7457.74 }).ok, false)
})

test('a missing or non-numeric figure is not "implausible", it is left to the existing missing-report handling', () => {
  assert.equal(checkBookedMtd({ mtd: null, prevMtd: 1000, dailyBooked: 10 }).ok, true)
  assert.equal(checkBookedMtd({ mtd: NaN, prevMtd: 1000, dailyBooked: 10 }).ok, false)
})

test('unknown daily booked uses a generous flat ceiling instead of failing everything', () => {
  assert.equal(checkBookedMtd({ mtd: 40000, prevMtd: 36803.29, dailyBooked: null }).ok, true)
  assert.equal(checkBookedMtd({ mtd: 485192.03, prevMtd: 36803.29, dailyBooked: null }).ok, false)
})

test('previousWeekday skips weekends', () => {
  assert.equal(previousWeekday('2026-10-08'), '2026-10-07')
  assert.equal(previousWeekday('2026-10-12'), '2026-10-09') // Monday -> Friday
  assert.equal(previousWeekday('2026-10-05'), '2026-10-02')
})

test('sameMonth', () => {
  assert.equal(sameMonth('2026-10-01', '2026-10-30'), true)
  assert.equal(sameMonth('2026-09-30', '2026-10-01'), false)
})

const { applyBookedMtdGuard } = require('../../src/services/evidentReport/bookedMtdGuard')
const { buildCombinedLeadershipEmail } = require('../../src/services/evidentReport/buildReport')

const agg = (over = {}) => ({
  missing: [], companyMtdBooked: 485192.03, companyMtdBookedByRep: { na: 471803.5, james: 5360.43, william: 8028.1 },
  companyDailyBooked: 7457.74, ...over,
})

test('applyBookedMtdGuard rejects the real Oct 8 reading: figure cleared, marked missing, reason kept', async () => {
  const a = agg()
  const rej = await applyBookedMtdGuard(a, '2026-10-08', async () => 36803.29)
  assert.ok(rej)
  assert.deepEqual(a.missing, ['MTD Booked Daily Update'])
  assert.equal(a.companyMtdBooked, 0)
  assert.equal(a.companyMtdBookedByRep, null)
  assert.equal(a.bookedMtdRejected.reported, 485192.03)
})

test('applyBookedMtdGuard leaves a good reading untouched', async () => {
  const a = agg({ companyMtdBooked: 36803.29, companyDailyBooked: 6743.51, companyMtdBookedByRep: { na: 1, james: 547.14, william: 1089.96 } })
  assert.equal(await applyBookedMtdGuard(a, '2026-10-07', async () => 29631.3), null)
  assert.deepEqual(a.missing, [])
  assert.equal(a.companyMtdBooked, 36803.29)
})

test('applyBookedMtdGuard: a failed lookup of yesterday does not block the check, and the first of a month has no previous reading', async () => {
  const a = agg()
  assert.ok(await applyBookedMtdGuard(a, '2026-10-08', async () => { throw new Error('gmail down') }))
  const first = agg({ companyMtdBooked: 6800, companyDailyBooked: 6743.51 })
  let asked = false
  assert.equal(await applyBookedMtdGuard(first, '2026-10-01', async () => { asked = true; return 999999 }), null) // prev weekday is Sept 30: different month, never asked
  assert.equal(asked, false)
})

test('applyBookedMtdGuard does nothing when the MTD email is already missing', async () => {
  const a = agg({ missing: ['MTD Booked Daily Update'], companyMtdBooked: 0 })
  assert.equal(await applyBookedMtdGuard(a, '2026-10-08', async () => 1), null)
})

const { acceptBookedByRep } = require('../../src/services/salesRepDailyReport')
const rep = (na, james, william) => ({ na, james, william })

test('rep reports: the real Oct 7 reading is accepted and the real Oct 8 reading is rejected', () => {
  assert.equal(acceptBookedByRep({ exact: rep(35166.19, 547.14, 1089.96), prev: rep(28400.83, 348, 882.47), dailyBooked: 6743.51 }), true)
  assert.equal(acceptBookedByRep({ exact: rep(471803.5, 5360.43, 8028.1), prev: rep(35166.19, 547.14, 1089.96), dailyBooked: 7457.74 }), false)
})

test('rep reports: with no previous day it still rejects the impossible figure and accepts a sane one', () => {
  assert.equal(acceptBookedByRep({ exact: rep(471803.5, 5360.43, 8028.1), prev: null, dailyBooked: 7457.74 }), false)
  assert.equal(acceptBookedByRep({ exact: rep(6000, 100, 200), prev: null, dailyBooked: 6743.51 }), true)
  assert.equal(acceptBookedByRep({ exact: null, prev: null, dailyBooked: 1 }), false)
})

test('the dashboard explains a rejected figure instead of calling it a missing report', async () => {
  const { parseAndAggregate, applyEmailMtdTotals } = require('../../src/services/evidentReport/parseEvident')
  const a = parseAndAggregate([], { runDate: '2026-10-08' })
  a.missing = []
  Object.assign(a, {
    companyDailyBooked: 7457.74, companyDailyBookedCount: 82, companyDailyBilled: 11339.34,
    companyMtdBooked: 485192.03, companyMtdBilled: 56726.56, companyYtdBilled: 439588.99,
    companyMtdBookedByRep: { na: 471803.5, james: 5360.43, william: 8028.1 },
    companyMtdBilledByRep: { na: 54531.62, james: 234, william: 1960.94 },
  })
  await applyBookedMtdGuard(a, '2026-10-08', async () => 36803.29)
  a.eviSmart = applyEmailMtdTotals(null, a)
  a.eviSmart.lastMonth = { monthName: 'September', booked: 167953.56, billed: 170056.13 }
  const { html } = buildCombinedLeadershipEmail(a, [], [], {})
  const text = html.replace(/<style[\s\S]*?<\/style>/gi, '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ')
  assert.match(text, /did not add up/)
  assert.doesNotMatch(text, /485,192|5,360|8,028/)
  assert.doesNotMatch(text, /surpassed last month/)
  assert.match(text, /56,726\.56/)   // the good figures are untouched
})
