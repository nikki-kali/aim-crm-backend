const test = require('node:test')
const assert = require('node:assert/strict')
const { extractRepColumns, parseAndAggregate, applyEmailMtdTotals, classify } = require('../../src/services/evidentReport/parseEvident')
const { pickMtdByRepAsOf, applySalesFromEvidentMtd, lastDayOfPriorMonth } = require('../../src/services/salesRepDailyReport')
const { applyEvidentMtdToGoals } = require('../../src/services/evidentReport')

const table = (headers, totals) => `<table><tr>${headers.map((h) => `<td>${h}</td>`).join('')}</tr>` +
  `<tr>${totals.map((v) => `<td>${v}</td>`).join('')}</tr></table>`
const REP3 = ['N/A', 'Delaney, James', 'Alexander, WIlliam']

// Real Oct 1 2026 "MTD Booked Daily Update": James had nothing booked yet,
// so Evident left his column out entirely.
const OCT1_HEADERS = ['Ref', 'Customer', 'Sales Value (Total)', 'N/A', 'Alexander, WIlliam']
const OCT1_TOTALS = { Ref: '', Customer: '', 'Sales Value (Total)': '9751.34', 'N/A': '9673.85', 'Alexander, WIlliam': '77.49' }

test('extractRepColumns counts a rep column Evident left out as $0 instead of discarding every rep', () => {
  assert.deepEqual(extractRepColumns(OCT1_HEADERS, OCT1_TOTALS), { na: 9673.85, james: 0, william: 77.49 })
})

test('extractRepColumns still returns null when a table has no rep columns at all', () => {
  assert.equal(extractRepColumns(['Ref', 'Customer', 'Sales Value (Total)'], { Ref: '', Customer: '', 'Sales Value (Total)': '10' }), null)
})

const MSGS = [
  { subject: 'Daily MTD Total Billed', date: '2026-10-01', html: table(['Ref', 'Company', 'Sales Value (Total Billed)', ...REP3], ['', '', '8723.97', '8154.01', '', '569.96']) },
  { subject: 'Daily MTD Total Billed', date: '2026-09-30', html: table(['Ref', 'Company', 'Sales Value (Total Billed)', ...REP3], ['', '', '170056.13', '166515.83', '2130.42', '1409.88']) },
  { subject: 'MTD Booked Daily Update', date: '2026-10-01', html: table(OCT1_HEADERS, ['', '', '9751.34', '9673.85', '77.49']) },
  { subject: 'MTD Booked Daily Update', date: '2026-09-30', html: table(['Ref', 'Customer', 'Sales Value (Total)', ...REP3], ['', '', '167953.56', '163629.81', '1855.42', '2468.33']) },
]

test('pickMtdByRepAsOf: billed (sales) uses the "Daily MTD Total Billed" email — Oct 1 William $569.96 (Elizabeth: sales = billed)', () => {
  assert.deepEqual(pickMtdByRepAsOf(MSGS, '2026-10-01', 'billed'), { na: 8154.01, james: 0, william: 569.96 })
  assert.deepEqual(pickMtdByRepAsOf(MSGS, '2026-09-30', 'billed'), { na: 166515.83, james: 2130.42, william: 1409.88 })
})

test('pickMtdByRepAsOf: booked uses "MTD Booked Daily Update", latest on or before the date, never the previous month', () => {
  assert.deepEqual(pickMtdByRepAsOf(MSGS, '2026-10-01', 'booked'), { na: 9673.85, james: 0, william: 77.49 })
  assert.deepEqual(pickMtdByRepAsOf(MSGS, '2026-10-05', 'booked'), { na: 9673.85, james: 0, william: 77.49 })
  assert.equal(pickMtdByRepAsOf(MSGS.filter((m) => m.date !== '2026-10-01'), '2026-10-01', 'booked'), null)
})

test('applySalesFromEvidentMtd sets the sales goal from the Evident figure and recomputes the percent', () => {
  const goal = { metric: 'monthly_revenue', target: '15000', current_value: 154.98, progress_pct: 1 }
  assert.deepEqual(applySalesFromEvidentMtd(goal, 569.96), { ...goal, current_value: 569.96, progress_pct: 4 })
  assert.equal(applySalesFromEvidentMtd(goal, null), null, 'no Evident figure = no bar, never a CRM guess')
})

test('applyEvidentMtdToGoals sets each rep\'s Revenue goal from MTD billed and leaves other goals alone', () => {
  const repGoals = [
    { repName: 'William Alexander', goals: [
      { metric: 'monthly_revenue', target: '15000', current_value: 154.98, progress_pct: 1 },
      { metric: 'new_doctors', target: '12', current_value: 0, progress_pct: 0 },
    ] },
    { repName: 'James Delaney', goals: [{ metric: 'monthly_revenue', target: '50000', current_value: 0, progress_pct: 0 }] },
  ]
  const out = applyEvidentMtdToGoals(repGoals, { na: 8154.01, james: 0, william: 569.96 })
  assert.equal(out[0].goals[0].current_value, 569.96)
  assert.equal(out[0].goals[0].progress_pct, 4)
  assert.equal(out[0].goals[1].current_value, 0)
  assert.equal(out[1].goals[0].current_value, 0)
  assert.deepEqual(applyEvidentMtdToGoals(repGoals, null)[0].goals.map((g) => g.metric), ['new_doctors'])
})

test('"YTD Billed Cases - Nadine" is parsed as company YTD billed (sales = billed)', () => {
  assert.equal(classify('YTD Billed Cases - Nadine').type, 'companyYtdBilled')
  const agg = parseAndAggregate([{ subject: 'YTD Billed Cases - Nadine', html: table(['Ref', 'Case Number', 'Customer Name', 'Cases (Total)', 'Sales Value (Total Billed)', ...REP3], ['', '', '', '4280', '391586.399999998', '381413.43', '4538.3', '5634.67']) }], { runDate: '2026-10-01' })
  assert.equal(Math.round(agg.companyYtdBilled * 100) / 100, 391586.4)
})

test('applyEmailMtdTotals uses only the #12/#40 Evident emails for booked/MTD/YTD, never EviSmart #92/#97/#94', () => {
  const eviSmart = { dailyBookedValue: 9786.34, dailyBookedCount: 71, dailyBilledValue: 8723.97, mtdBookedValue: 9751.34, mtdBookedCount: 74, mtdBilledValue: 8723.97, ytdTotalSalesValue: 446565.08 }
  const agg = { missing: [], companyDailyBooked: 9751.34, companyDailyBookedCount: 72, companyMtdBooked: 9751.34, companyMtdBilled: 8723.97, companyYtdBilled: 391586.4 }
  const out = applyEmailMtdTotals(eviSmart, agg)
  assert.equal(out.dailyBookedValue, 9751.34, 'daily booked from the Evident booking report, not #97 ($9,786.34)')
  assert.equal(out.dailyBookedCount, 72)
  assert.equal(out.mtdBookedCount, null, 'no #92 case count')
  assert.equal(out.ytdTotalSalesValue, 391586.4, 'YTD = YTD Billed Cases, not #94 ($446,565.08)')
  assert.equal(out.dailyBilledValue, 8723.97, 'daily billed still from Customer Activity')
  const missingAll = applyEmailMtdTotals(eviSmart, { ...agg, missing: ['Daily Booking Report - Nadine', 'MTD Booked Daily Update'], companyYtdBilled: null })
  assert.equal(missingAll.dailyBookedValue, null)
  assert.equal(missingAll.mtdBookedValue, null)
  assert.equal(missingAll.ytdTotalSalesValue, null)
})

test('lastDayOfPriorMonth', () => {
  assert.equal(lastDayOfPriorMonth('2026-10-01'), '2026-09-30')
  assert.equal(lastDayOfPriorMonth('2026-03-15'), '2026-02-28')
  assert.equal(lastDayOfPriorMonth('2026-01-05'), '2025-12-31')
})
