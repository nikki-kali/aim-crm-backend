const test = require('node:test')
const assert = require('node:assert')
const { labTotalsFor, report12MonthFor, newJobsMonth } = require('../../src/services/evidentReport/labTotals')
const { labTotalsSection } = require('../../src/services/evidentReport/buildReport')

const tbl = (headers, rows) => `<table><tr>${headers.map((h) => `<td>${h}</td>`).join('')}</tr>${rows.map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join('')}</tr>`).join('')}</table>`
const r12 = (basis, total, cases, date = '2026-11-24') => ({
  subject: 'MTD Booked Daily Update', date, internalDate: 9,
  html: `<p>MTD Booked Daily Update</p><p>date (${basis}) &gt;=MTD</p>` + tbl(
    ['Ref', 'Customer', 'Sales Value (Total)', 'Cases (Total)', 'Sales Value (Total Billed)', 'N/A'],
    [['A1', 'A1 - X', '100', '2', '90', '90'], ['', '', total, cases, '1', '1']],
  ),
})
const r114 = (total, cases, date = '2026-11-24') => ({ subject: 'Booked This Month - AIM CRM', date, internalDate: 5,
  html: tbl(['Ref', 'Sales Rep', 'Sales Value (Product)', 'Cases (Total)'], [['', '', '1', '1'], ['', '', total, cases]]) })
const r113 = (total, cases) => ({ subject: 'Booked Today - AIM CRM', date: '2026-11-24', internalDate: 5,
  html: tbl(['Ref', 'Sales Rep', 'Sales Value (Product)', 'Cases (Total)'], [['', '', '1', '1'], ['', '', total, cases]]) })

test('Report 12 is read only when it counts by booking date', () => {
  assert.deepEqual(report12MonthFor([r12('booked', '160,100.50', '1,600')], '2026-11-24'), { value: 160100.5, count: 1600 })
  assert.equal(report12MonthFor([r12('arrival', '163,939.78', '1582')], '2026-11-24'), null)
  assert.equal(report12MonthFor([r12('booked', '1', '1')], '2026-11-23'), null)
})

test('Report 12 is used when it agrees with report 114; a broken one falls back', () => {
  assert.equal(newJobsMonth({ value: 153168, count: 1529 }, { value: 153037.58, count: 1524 }).month.source, 'report12')
  const broken = newJobsMonth({ value: 776081.01, count: 7563 }, { value: 153037.58, count: 1524 })
  assert.equal(broken.month.source, 'report114')
  assert.equal(broken.month.value, 153037.58)
  assert.equal(broken.report12Rejected, true)
  assert.equal(newJobsMonth(null, { value: 1, count: 1 }).report12Rejected, false)
})

test('New Jobs: month from Report 12, day from Report 10 (report 113)', () => {
  const t = labTotalsFor({ evidentMessages: [r12('booked', '153,168', '1529'), r114('153,037.58', '1524'), r113('9,000', '80')], runDate: '2026-11-24' })
  assert.deepEqual(t.newJobs.mtd, { value: 153168, count: 1529, source: 'report12' })
  assert.deepEqual(t.newJobs.day, { value: 9000, count: 80, source: 'report10' }, 'no earlier Report 12 email: day from Report 10')
  assert.equal(t.report12Rejected, false)
  const html = labTotalsSection(t)
  assert.match(html, /Counted by booking date, month to date \(Report 12\)/)
  assert.match(html, /\$153,168/)
})

test('a broken Report 12 never reaches the dashboard', () => {
  const t = labTotalsFor({ evidentMessages: [r12('booked', '776,081.01', '7563'), r114('153,037.58', '1524'), r113('9,000', '80')], runDate: '2026-11-24' })
  assert.equal(t.newJobs.mtd.value, 153037.58)
  assert.equal(t.report12Rejected, true)
  const html = labTotalsSection(t)
  assert.doesNotMatch(html, /776/)
  assert.match(html, /booking-date copy of Report 10/)
})

test('the day comes from the same Report 12 run: tonight minus the previous evening', () => {
  const msgs = [
    r12('booked', '160,000.00', '1600'), r114('159,870', '1595'),
    r12('booked', '153,168', '1529', '2026-11-23'), r114('153,037.58', '1524', '2026-11-23'),
    r113('9,000', '80'),
  ]
  const t = labTotalsFor({ evidentMessages: msgs, runDate: '2026-11-24' })
  assert.deepEqual(t.newJobs.mtd, { value: 160000, count: 1600, source: 'report12' })
  assert.deepEqual(t.newJobs.day, { value: 6832, count: 71, source: 'report12' })
  const html = require('../../src/services/evidentReport/buildReport').labTotalsSection(t)
  assert.match(html, /\$6,832/)
})

test('a broken previous Report 12 email means the day falls back to Report 10', () => {
  const msgs = [
    r12('booked', '160,000.00', '1600'), r114('159,870', '1595'),
    r12('booked', '776,081.01', '7563', '2026-11-23'), r114('153,037.58', '1524', '2026-11-23'),
    r113('9,000', '80'),
  ]
  const t = labTotalsFor({ evidentMessages: msgs, runDate: '2026-11-24' })
  assert.equal(t.newJobs.mtd.source, 'report12')
  assert.deepEqual(t.newJobs.day, { value: 9000, count: 80, source: 'report10' })
})

test('first business day of the month: the day is the month so far', () => {
  const { report12DayFor } = require('../../src/services/evidentReport/labTotals')
  assert.deepEqual(report12DayFor([], '2026-12-01', { value: 5000, count: 40, source: 'report12' }), { value: 5000, count: 40, source: 'report12' })
  assert.equal(report12DayFor([], '2026-12-02', { value: 5000, count: 40, source: 'report12' }), null)
})
