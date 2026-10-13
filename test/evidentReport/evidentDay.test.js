const test = require('node:test')
const assert = require('node:assert/strict')
const { buildEvidentDay, parseLastMonthVsMtd, parseNewDoctors, dailyCustomersFrom, monthIndexFromCell } = require('../../src/services/evidentReport/evidentDay')
const { classify } = require('../../src/services/evidentReport/parseEvident')

// Evident's emails: one <table>, first row the headers, <td> cells, last row
// the totals row (blank text columns). Made-up rows, no real patient data.
const table = (headers, rows) =>
  '<table>' + [headers, ...rows].map((r) => '<tr>' + r.map((c) => `<td>${c}</td>`).join('') + '</tr>').join('') + '</table>'

const RUN = '2026-10-12'
const msg = (subject, html) => ({ subject, html, date: RUN })

const bookingReport = msg('Daily Booking Report - Nadine', table(
  ['Ref', 'Case Number', 'Customer Code', 'Customer Name', 'Sales Value (Total)', 'Salesperson'],
  [
    ['1', 'PATIENT, ONE', 'A1116', 'BROOKDALE MAIN', '100.5', ''],
    ['2', 'PATIENT, TWO', 'A1116', 'BROOKDALE MAIN', '20', ''],
    ['3', 'PATIENT, THREE', 'A1164', 'Gold, Brian', '174', 'james dela'],
    ['', '', '', '', '294.5', ''],
  ]))
const billedReport = msg('Daily Billed Report - Nadine', table(
  ['Ref', 'Case Number', 'Customer Code', 'Customer Name', 'Sales Value (Total)', 'Sales Value (Total Billed)', 'Salesperson'],
  [['9', 'PATIENT, NINE', 'A1301', 'HWANG', '80', '77.49', 'william'], ['', '', '', '', '80', '77.49', '']]))
const lmBooked = msg('Last Month vs MTD Booked', table(
  ['Month', 'Cases (Total)', 'Sales Value (Total)', 'N/A', 'Delaney, James', 'Alexander, WIlliam'],
  [['2026-09', '1821', '171172.07', '168000', '1500', '1672.07'], ['2026-10', '612', '59609.02', '57174.44', '847.13', '1587.45'], ['', '2433', '230781.09', '', '', '']]))
const lmBilled = msg('Last Month vs MTD Billed', table(
  ['Month', 'Sales Value (Total Billed)', 'N/A', 'Delaney, James', 'Alexander, WIlliam'],
  [['September 2026', '169778.13', '167000', '1000', '1778.13'], ['October 2026', '66171.65', '63427.22', '446', '2298.43'], ['Total', '235949.78', '', '', '']]))
const newDoctors = (rep, rows) => msg(`New Doctors - ${rep}`, table(
  ['Customer Code', 'Customer Name', 'First Booking', 'Cases (Total)', 'Sales Value (Total)'], rows))
const ndJames = newDoctors('James', [
  ['A1119', 'Dr. Idelle Brand', '2026-10-05', '2', '310'],
  ['A4152', 'Dr. Joel Manley', '2026-09-23', '1', '90'],
  ['A1000', 'Old Doctor', '2025-01-02', '40', '9000'],
  ['', '', '', '43', '9400'],
])
const ndWilliam = newDoctors('William', [['A4154', 'Dr. Leslie Grace Lopez', '2026-09-30', '1', '50'], ['', '', '', '1', '50']])

test('month cells in any common form', () => {
  assert.equal(monthIndexFromCell('2026-10'), 9)
  assert.equal(monthIndexFromCell('10/2026'), 9)
  assert.equal(monthIndexFromCell('October 2026'), 9)
  assert.equal(monthIndexFromCell('Sep 2026'), 8)
  assert.equal(monthIndexFromCell('Total'), null)
  assert.equal(monthIndexFromCell(''), null)
})

test('Last Month vs MTD: rows are told apart by month, the total row is ignored', () => {
  const b = parseLastMonthVsMtd(lmBooked.html, RUN, 'booked')
  assert.deepEqual(b.current, { value: 59609.02, count: 612, byRep: { na: 57174.44, james: 847.13, william: 1587.45 } })
  assert.equal(b.last.value, 171172.07)
  assert.equal(b.last.count, 1821)
  const p = parseLastMonthVsMtd(lmBilled.html, RUN, 'billed')
  assert.equal(p.current.value, 66171.65)
  assert.equal(p.last.value, 169778.13)
})

test('New Doctors: this month and last month only, by first booking date', () => {
  const j = parseNewDoctors(ndJames.html, RUN)
  assert.deepEqual(j.current.map((d) => [d.code, d.name, d.firstCaseIso, d.cases]), [['A1119', 'Dr. Idelle Brand', '2026-10-05', 2]])
  assert.deepEqual(j.previous.map((d) => d.name), ['Dr. Joel Manley'])
  const w = parseNewDoctors(ndWilliam.html, RUN)
  assert.deepEqual(w.current, [])
  assert.deepEqual(w.previous.map((d) => d.name), ['Dr. Leslie Grace Lopez'])
})

test('daily customers are grouped by customer and never carry the Case Number (patient) column', () => {
  const rows = dailyCustomersFrom(bookingReport.html)
  assert.deepEqual(rows, [
    { name: 'A1116 - BROOKDALE MAIN', count: 2, value: 120.5 },
    { name: 'A1164 - Gold, Brian', count: 1, value: 174 },
  ])
  assert.equal(JSON.stringify(rows).includes('PATIENT'), false)
})

test('a full weekday: every figure comes from the Evident emails, in the EviSmart shape', () => {
  const day = buildEvidentDay([bookingReport, billedReport, lmBooked, lmBilled, ndJames, ndWilliam], RUN)
  assert.equal(day.totals.dailyBookedValue, 294.5)
  assert.equal(day.totals.dailyBookedCount, 3)
  assert.equal(day.totals.dailyBilledValue, 77.49)
  assert.equal(day.totals.mtdBookedValue, 59609.02)
  assert.equal(day.totals.mtdBookedCount, 612)
  assert.equal(day.totals.mtdBilledValue, 66171.65)
  assert.deepEqual(day.totals.repMtd, {
    booked: { james: 847.13, william: 1587.45, na: 57174.44, company: 59609.02 },
    billed: { james: 446, william: 2298.43, na: 63427.22, company: 66171.65 },
  })
  assert.deepEqual(day.extras.lastMonth, { monthName: 'September', bookedCount: 1821, booked: 171172.07, billed: 169778.13 })
  assert.equal(day.extras.newDoctors.james.length, 1)
  assert.deepEqual(day.extras.newDoctors.william, [])
})

test('Friday: no MTD Booked Daily Update / Daily MTD Billed, month to date still comes from Last Month vs MTD', () => {
  const day = buildEvidentDay([bookingReport, billedReport, lmBooked, lmBilled], RUN)
  assert.equal(day.totals.mtdBookedValue, 59609.02)
  assert.equal(day.totals.mtdBilledValue, 66171.65)
  assert.equal(day.extras.newDoctors, null) // no New Doctors emails: the CRM count is kept, never zero
})

test('without Last Month vs MTD, the dedicated MTD emails are used (old subject or the renamed one)', () => {
  const mtdBooked = msg('MTD Booked Daily Update', table(['Ref', 'Customer', 'Sales Value (Total)', 'N/A', 'Delaney, James', 'Alexander, WIlliam'], [['A1', 'X', '10', '10', '', ''], ['', '', '500', '400', '60', '40']]))
  const mtdBilled = msg('Daily MTD Billed', table(['Ref', 'Company', 'Sales Value (Total Billed)', 'N/A', 'Delaney, James', 'Alexander, WIlliam'], [['KINGS', 'KINGS', '100', '100', '', ''], ['', '', '300', '250', '30', '20']]))
  assert.equal(classify('Daily MTD Billed').type, 'companyMtdBilled')
  assert.equal(classify('Daily MTD Total Billed').type, 'companyMtdBilled')
  const day = buildEvidentDay([bookingReport, billedReport, mtdBooked, mtdBilled], RUN)
  assert.equal(day.totals.mtdBookedValue, 500)
  assert.equal(day.totals.mtdBilledValue, 300) // the final total row, not the KINGS row
  assert.deepEqual(day.totals.repMtd.billed, { james: 30, william: 20, na: 250, company: 300 })
  assert.equal(day.extras.lastMonth, null)
})

test('not usable yet (returns null, so nothing is sent with gaps) when the daily booked or billed email is missing', () => {
  assert.equal(buildEvidentDay([billedReport, lmBooked, lmBilled], RUN), null)
  assert.equal(buildEvidentDay([bookingReport, lmBooked, lmBilled], RUN), null)
  assert.equal(buildEvidentDay([bookingReport, billedReport], RUN), null)
  assert.equal(buildEvidentDay([], RUN), null)
})

test('emails dated for another day are ignored', () => {
  const old = [bookingReport, billedReport, lmBooked, lmBilled].map((m) => ({ ...m, date: '2026-10-09' }))
  assert.equal(buildEvidentDay(old, RUN), null)
})
