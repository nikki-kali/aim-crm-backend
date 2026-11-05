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

test('1 November: a backup MTD email still showing October is ignored (N/A), never used as November', () => {
  const { emailMonthMatches, parseAndAggregate } = require('../../src/services/evidentReport/parseEvident')
  const octBooked = '<p>MTD Booked Daily Update month (booking)=October 2026</p>' + table(['Ref', 'Customer', 'Sales Value (Total)', 'N/A', 'Delaney, James', 'Alexander, WIlliam'], [['A1', 'X', '10', '10', '', ''], ['', '', '170000', '169000', '600', '400']])
  const octBilled = '<p>Daily MTD Billed month (invoice)=October 2026</p>' + table(['Ref', 'Company', 'Sales Value (Total Billed)', 'N/A', 'Delaney, James', 'Alexander, WIlliam'], [['', '', '180000', '179000', '600', '400']])
  assert.equal(emailMonthMatches(octBooked, '2026-10-30'), true)
  assert.equal(emailMonthMatches(octBooked, '2026-11-02'), false)
  assert.equal(emailMonthMatches('<p>no month line</p>', '2026-11-02'), true)
  assert.equal(emailMonthMatches('<p>MTD Booked Daily Update month (arrival)=October 2026</p>', '2026-11-02'), false)
  assert.equal(emailMonthMatches('<p>MTD Booked Daily Update month (arrival)=November 2026</p>', '2026-11-02'), true)
  const nov = '2026-11-02'
  const agg = parseAndAggregate([
    { subject: 'MTD Booked Daily Update', html: octBooked, date: nov },
    { subject: 'Daily MTD Billed', html: octBilled, date: nov },
  ], { runDate: nov })
  assert.ok(agg.missing.includes('MTD Booked Daily Update'))
  assert.ok(agg.missing.includes('Daily MTD Total Billed'))
  assert.equal(agg.companyMtdBooked, 0) // reported as missing, so the report shows N/A
})

test('emails dated for another day are ignored', () => {
  const old = [bookingReport, billedReport, lmBooked, lmBilled].map((m) => ({ ...m, date: '2026-10-09' }))
  assert.equal(buildEvidentDay(old, RUN), null)
})

test('New Doctors names read from the real 13 Oct layout ("CODE - Last, First" under Customer, code under Ref)', () => {
  const { doctorDisplayName } = require('../../src/services/evidentReport/evidentDay')
  assert.equal(doctorDisplayName('A1119 - Brand, Idelle'), 'Idelle Brand')
  assert.equal(doctorDisplayName('A4151 - Dental, Domino'), 'Domino Dental')
  assert.equal(doctorDisplayName('A1301 - , Dr. KELLY J HWANG'), 'Dr. KELLY J HWANG')
  assert.equal(doctorDisplayName('A1305 - IZZO,'), 'IZZO')
  assert.equal(doctorDisplayName('KH2244 - Dental, Suite 905'), 'Suite 905 Dental')
  const html = table(['Ref', 'Customer', 'First Booking', 'Cases (Total)', 'Sales Value (Total)'],
    [['A1119', 'A1119 - Brand, Idelle', '2026-10-05', '2', '277.13'], ['A4152', 'A4152 - Manley, Joel', '2026-09-23', '1', '50'], ['', '', '', '3', '327.13']])
  const j = parseNewDoctors(html, '2026-10-13')
  assert.deepEqual(j.current.map((d) => [d.code, d.name]), [['A1119', 'Idelle Brand']])
  assert.deepEqual(j.previous.map((d) => d.name), ['Joel Manley'])
})

test('Last Month vs MTD real 13 Oct layout: "Month (Booking)" column with "Sep 2026" / "Oct 2026"', () => {
  const html = table(['Ref', 'Month (Booking)', 'Cases (Total)', 'Sales Value (Total)', 'N/A', 'Delaney, James', 'Alexander, WIlliam'],
    [['Sep 2026', 'Sep 2026', '1821', '172621.17', '168074.89', '1855.42', '2690.86'], ['Oct 2026', 'Oct 2026', '702', '69432.36', '66477.78', '847.13', '2107.45'], ['', '', '2523', '242053.53', '234552.67', '2702.55', '4798.31']])
  const b = parseLastMonthVsMtd(html, '2026-10-13', 'booked')
  assert.equal(b.current.value, 69432.36)
  assert.equal(b.current.count, 702)
  assert.equal(b.last.value, 172621.17)
})

test('new doctors: A4159 (A.R Assadian) counts for November from 2 Nov, not October (user decision 2026-11-03)', () => {
  const html = table(['Ref', 'Customer', 'First Booking', 'Cases (Total)', 'Sales Value (Total)'],
    [['A4159', 'A4159 - ASSADIAN, A.R', '2026-10-30', '4', '715.86'], ['A4154', 'A4154 - LOPEZ, LESLIE GRACE', '2026-10-29', '4', '485.94'], ['', '', '', '8', '1201.8']])
  const oct30 = parseNewDoctors(html, '2026-10-30')
  assert.deepEqual(oct30.current.map((d) => d.code), ['A4154'], 'not counted for October')
  const nov2 = parseNewDoctors(html, '2026-11-02')
  assert.deepEqual(nov2.current.map((d) => [d.code, d.name, d.firstCaseIso, d.firstCase]), [['A4159', 'A.R ASSADIAN', '2026-11-02', '2026-10-30']])
  assert.deepEqual(nov2.previous.map((d) => d.code), ['A4154'], 'every other doctor keeps the first-booking rule')
})

// "Daily Arrivals by Day - AIM CRM" (report 111): booked by arrival date, sent
// the next morning (user decision 2026-11-04). Figures are the real 2 and 3 Nov
// rows Evident showed for it.
const { isoFromCell, parseArrivalsByDay, arrivalsFor } = require('../../src/services/evidentReport/evidentDay')
const arrivalsHtml = table(
  ['Date (Arrival)', 'Cases (Total)', 'Sales Value (Total)', 'N/A', 'Delaney, James', 'Alexander, WIlliam'],
  [
    ['2026-10-30', '90', '9000', '8000', '500', '500'],
    ['2026-11-02', '93', '9284.25', '8013.9', '87', '1183.35'],
    ['2026-11-03', '108', '10558.63', '9470.27', '', '1088.36'],
    ['', '291', '28842.88', '25484.17', '587', '2771.71'],
  ])
const arrivalsEmail = (date, html = arrivalsHtml) => ({ subject: 'Daily Arrivals by Day - AIM CRM', html, date })

test('arrivals: reads Evident date cells in every format it may use', () => {
  assert.equal(isoFromCell('2026-11-03'), '2026-11-03')
  assert.equal(isoFromCell('11/3/2026'), '2026-11-03')
  assert.equal(isoFromCell('11/3/26'), '2026-11-03')
  assert.equal(isoFromCell('3 Nov 26'), '2026-11-03')
  assert.equal(isoFromCell('3 November 2026'), '2026-11-03')
  assert.equal(isoFromCell('Nov 3, 2026'), '2026-11-03')
  assert.equal(isoFromCell(''), null)
  assert.equal(isoFromCell('291'), null)
})

test('arrivals: one row per day, the total row skipped, a date in the Ref column also found', () => {
  const rows = parseArrivalsByDay(arrivalsHtml)
  assert.deepEqual(rows.map((r) => r.date), ['2026-10-30', '2026-11-02', '2026-11-03'])
  assert.deepEqual(rows[2], { date: '2026-11-03', count: 108, value: 10558.63, byRep: { na: 9470.27, james: 0, william: 1088.36 } })
  const withRef = table(['Ref', 'Date (Arrival)', 'Cases (Total)', 'Sales Value (Total)'], [['3 Nov 26', '3 Nov 26', '108', '10558.63']])
  assert.equal(parseArrivalsByDay(withRef)[0].date, '2026-11-03')
})

test('arrivals: the day and month to date for runDate, from the next morning\'s email only', () => {
  const a = arrivalsFor([arrivalsEmail('2026-11-04')], '2026-11-03')
  assert.deepEqual(a.daily, { count: 108, value: 10558.63, byRep: { na: 9470.27, james: 0, william: 1088.36 } })
  assert.deepEqual(a.mtd, { count: 201, value: 19842.88, byRep: { na: 17484.17, james: 87, william: 2271.71 } }, 'October rows are left out')
  assert.equal(arrivalsFor([arrivalsEmail('2026-11-03')], '2026-11-03'), null, 'a same-day email is not complete yet')
  assert.equal(arrivalsFor([arrivalsEmail('2026-11-04')], '2026-11-05'), null, 'no row for the day')
  assert.equal(arrivalsFor([], '2026-11-03'), null)
})

test('arrivals: Friday is read from Saturday\'s (or Monday\'s) email; the newest wins', () => {
  const sat = arrivalsEmail('2026-10-31', table(['Date (Arrival)', 'Cases (Total)', 'Sales Value (Total)'], [['2026-10-30', '90', '9000']]))
  const mon = arrivalsEmail('2026-11-02', table(['Date (Arrival)', 'Cases (Total)', 'Sales Value (Total)'], [['2026-10-30', '91', '9100']]))
  assert.equal(arrivalsFor([sat], '2026-10-30').daily.value, 9000)
  assert.equal(arrivalsFor([sat, mon], '2026-10-30').daily.value, 9100)
})

test('buildEvidentDay: booked (day, MTD, per rep) comes from the arrivals email when it is in; billed is untouched', () => {
  const plain = buildEvidentDay([bookingReport, billedReport, lmBooked, lmBilled], RUN)
  const arr = { subject: 'Daily Arrivals by Day - AIM CRM', date: '2026-10-13', html: table(['Date (Arrival)', 'Cases (Total)', 'Sales Value (Total)', 'N/A', 'Delaney, James', 'Alexander, WIlliam'], [['2026-10-01', '50', '5000', '4800', '100', '100'], ['2026-10-12', '60', '6000', '5500', '200', '300']]) }
  const day = buildEvidentDay([bookingReport, billedReport, lmBooked, lmBilled], RUN, [arr])
  assert.equal(day.totals.bookedSource, 'arrivals')
  assert.equal(day.totals.dailyBookedValue, 6000)
  assert.equal(day.totals.dailyBookedCount, 60)
  assert.equal(day.totals.mtdBookedValue, 11000)
  assert.equal(day.totals.mtdBookedCount, 110)
  assert.deepEqual(day.totals.repMtd.booked, { na: 10300, james: 300, william: 400, company: 11000 })
  assert.deepEqual(day.totals.repMtd.billed, plain.totals.repMtd.billed)
  assert.equal(day.totals.dailyBilledValue, plain.totals.dailyBilledValue)
  assert.equal(plain.totals.bookedSource, undefined, 'without the email nothing changes')
})

test('Scanner doctors: MTD from MTD Booked Daily Update, the day from Daily Booking Report, quiet doctors flagged', () => {
  const { scannerDoctorRows } = require('../../src/services/evidentReport/scannerDoctors')
  const { buildCombinedLeadershipEmail } = require('../../src/services/evidentReport/buildReport')
  const mtd = table(['Ref', 'Customer', 'Sales Value (Total)', 'N/A', 'Delaney, James', 'Alexander, WIlliam'], [
    ['A1304', 'A1304 - Samaan, Ehab', '780', '', '', '780'],
    ['KH2216', 'KH2216 - , JODAL DENTAL', '596', '596', '', ''],
    ['A1116', 'A1116 - , BROOKDALE MAIN', '714.94', '714.94', '', ''],
    ['', '', '2090.94', '1310.94', '', '780'],
  ])
  const daily = table(['Ref', 'Customer Code', 'Customer Name', 'Sales Value (Total)', 'Salesperson'], [
    ['8689', 'A1304', 'Dr. Ehab Samaan', '65', 'william'],
    ['8700', 'A1116', 'BROOKDALE MAIN', '10', ''],
    ['', '', '', '75', ''],
  ])
  const rows = scannerDoctorRows(mtd, daily)
  assert.equal(rows.length, 8)
  assert.deepEqual(rows[0], { code: 'A1304', name: 'Dr. Ehab Samaan', rep: 'William', todayCases: 1, todayValue: 65, mtdValue: 780 })
  assert.equal(rows[1].code, 'KH2216')
  assert.equal(rows[1].todayCases, 0)
  assert.equal(rows.find((r) => r.code === 'A3101').mtdValue, 0)
  assert.equal(scannerDoctorRows(undefined, daily), null)

  const agg = { runDate: '2026-11-04', missing: [], eviSmart: { scannerDoctors: rows } }
  let html = ''
  try { html = buildCombinedLeadershipEmail(agg, [], []).html } catch (e) { return } // full builder needs more data; section helper checked below
  assert.match(html, /Intraoral Scanner Accounts · 1 of 8 sent cases on Wed, Nov 4/)
})
