const test = require('node:test')
const assert = require('node:assert/strict')
const { parseThisMonth, thisMonthFor, parseNewJobsTotal, newJobsFor, labTotalsFor } = require('../../src/services/evidentReport/labTotals')

// Synthetic "This Month" emails in Evident's layout (made-up numbers; no real
// report committed).
const thisMonth = ({ date = '10 Mar 2026', when = '10 Mar 2026 04:01', receipts = '0 (0) = 1,000', invoices = '0 (0) = 2,000', hold = '300 (4)', lab = '6,000+100 (50)' } = {}) =>
  `<STYLE>.title{font-size:14pt}</STYLE><DIV class=text>Dental lab</DIV><DIV class=text>${when}</DIV><DIV class=title>This Month - ${date} </DIV>
<H3>Accounts</H3>Receipts: <B>${receipts}</B><BR>Invoices: <B>${invoices}</B><BR>Credits: <B>0 (0) = 5</B>
<H3>Debtors</H3>Total: <B>9,000</B><BR>Current: <B>4,000</B><BR>30 Day: <B>3,000</B><BR>60 Day: <B>1,500</B><BR>90 Day: <B>500</B>
<H3>WIP</H3>New Jobs: <B>0 (0)</B><BR>On Hold: <B>${hold}</B><BR>Try-In: <B>0 (0)</B><BR>In Lab: <B>${lab}</B>
Legend: todays transaction value (todays transaction count) = months transaction value`

const msg = (html, internalDate, extra = {}) => ({ subject: 'This Month', html, internalDate, ...extra })

test('This Month: reads Receipts, Invoices, In Lab, On Hold, Debtors and its own date', () => {
  const p = parseThisMonth(thisMonth())
  assert.equal(p.reportDate, '2026-03-10')
  assert.equal(p.generatedHour, 4)
  assert.deepEqual(p.receipts, { day: 0, dayCount: 0, mtd: 1000 })
  assert.deepEqual(p.invoiced, { day: 0, dayCount: 0, mtd: 2000 })
  assert.deepEqual(p.inLab, { thisMonth: 6000, nextMonth: 100, count: 50 })
  assert.deepEqual(p.onHold, { value: 300, count: 4 })
  assert.equal(p.debtors.total, 9000)
})

test('This Month: an email without it is null', () => {
  assert.equal(parseThisMonth('<p>Daily Booking Report</p>'), null)
})

test('evening email for the day gives the day and the month directly', () => {
  const ev = thisMonth({ when: '10 Mar 2026 22:00', receipts: '250 (2) = 1,250', invoices: '400 (6) = 2,400' })
  const r = thisMonthFor([msg(ev, 2)], '2026-03-10')
  assert.equal(r.source, 'evening')
  assert.deepEqual(r.receipts, { day: 250, mtd: 1250 })
  assert.deepEqual(r.invoiced, { day: 400, mtd: 2400 })
})

test('without an evening email: next morning gives the month, the day is the change since that morning', () => {
  const before = thisMonth({ date: '10 Mar 2026', when: '10 Mar 2026 04:01', receipts: '0 (0) = 1,000', invoices: '0 (0) = 2,000' })
  const after = thisMonth({ date: '11 Mar 2026', when: '11 Mar 2026 04:01', receipts: '0 (0) = 1,600', invoices: '0 (0) = 2,900', hold: '310 (5)' })
  const r = thisMonthFor([msg(after, 2), msg(before, 1)], '2026-03-10')
  assert.equal(r.source, 'morning')
  assert.deepEqual(r.receipts, { day: 600, mtd: 1600 })
  assert.deepEqual(r.invoiced, { day: 900, mtd: 2900 })
  assert.deepEqual(r.onHold, { value: 310, count: 5 }) // from the later email
})

test('without the earlier morning email the day is null, never zero', () => {
  const after = thisMonth({ date: '11 Mar 2026', when: '11 Mar 2026 04:01' })
  const r = thisMonthFor([msg(after, 2)], '2026-03-10')
  assert.equal(r.receipts.day, null)
  assert.equal(r.receipts.mtd, 1000)
})

test('a next-month morning email is not used for the last day of a month', () => {
  const nextMonth = thisMonth({ date: '01 Apr 2026', when: '01 Apr 2026 04:01' })
  assert.equal(thisMonthFor([msg(nextMonth, 2)], '2026-03-31'), null)
})

// Synthetic "Booked Today/This Month - AIM CRM" email: rows per rep + totals.
const newJobs = (rows, total) => `<table><tr><td>Sales Rep</td><td>Sales Value (Product)</td><td>Cases (Total)</td></tr>
${rows.map((r) => `<tr><td>${r[0]}</td><td>${r[1]}</td><td>${r[2]}</td></tr>`).join('')}
<tr><td></td><td>${total[0]}</td><td>${total[1]}</td></tr></table>`

test('New Jobs: reads only the totals row', () => {
  assert.deepEqual(parseNewJobsTotal(newJobs([['Rep A', '100.50', '2'], ['', '20.00', '1']], ['120.50', '3'])), { value: 120.5, count: 3 })
})

test('New Jobs: day and month from that evening\'s two emails', () => {
  const msgs = [
    { subject: 'Booked Today - AIM CRM', date: '2026-03-10', internalDate: 5, html: newJobs([['Rep A', '500', '5']], ['500', '5']) },
    { subject: 'Booked This Month - AIM CRM', date: '2026-03-10', internalDate: 5, html: newJobs([['Rep A', '9,000', '80']], ['9,000', '80']) },
    { subject: 'Booked Today - AIM CRM', date: '2026-03-09', internalDate: 4, html: newJobs([['Rep A', '1', '1']], ['1', '1']) },
  ]
  assert.deepEqual(newJobsFor(msgs, '2026-03-10'), { day: { value: 500, count: 5 }, mtd: { value: 9000, count: 80 } })
  assert.equal(newJobsFor(msgs, '2026-03-11'), null)
})

test('labTotalsFor: missing sources stay null', () => {
  const t = labTotalsFor({ runDate: '2026-03-10' })
  assert.equal(t.newJobs, null)
  assert.equal(t.receipts, null)
  assert.equal(t.inLab, null)
})

test('New Jobs comes from the evening This Month email (WIP New Jobs line, day only)', () => {
  const html = `<DIV>12 Nov 2026 22:01</DIV><DIV class=title>This Month - 12 Nov 2026 </DIV>
<H3>Accounts</H3>Receipts: <B>5,147 (4) = 67,461</B><BR>Invoices: <B>7,274 (98) = 71,012</B><BR>
<H3>Debtors</H3>Total: <B>303,635</B><BR>
<H3>WIP</H3>New Jobs: <B>7,336 (60)</B><BR>On Hold: <B>1,409 (22)</B><BR>In Lab: <B>64,085+1,405 (540)</B>`
  const morning = html.replace('12 Nov 2026 22:01', '13 Nov 2026 04:00').replace('This Month - 12 Nov', 'This Month - 13 Nov').replace('7,336 (60)', '0 (0)')
  const t = labTotalsFor({ thisMonthMessages: [{ html, internalDate: 1 }], runDate: '2026-11-12' })
  assert.deepEqual(t.newJobs, { day: { value: 7336, count: 60, source: 'thisMonth' }, mtd: null })
  // Since 2026-11-24 the day comes from Report 10's "Booked Today" email first.
  const noEvening = labTotalsFor({ thisMonthMessages: [{ html: morning, internalDate: 2 }], evidentMessages: [{ subject: 'Booked Today - AIM CRM', date: '2026-11-12', html: '<table><tr><td>Sales Value</td><td>Cases</td></tr><tr><td>5</td><td>1</td></tr><tr><td>7,000</td><td>58</td></tr></table>' }], runDate: '2026-11-12' })
  assert.deepEqual(noEvening.newJobs, { day: { value: 7000, count: 58, source: 'report10' }, mtd: null })
  // With the 11 PM "Booked This Month" email, the month total comes from it.
  const withMonth = labTotalsFor({ thisMonthMessages: [{ html, internalDate: 1 }], evidentMessages: [{ subject: 'Booked This Month - AIM CRM', date: '2026-11-12', html: newJobs([['Rep A', '90,000', '900']], ['90,123.65', '930']) }], runDate: '2026-11-12' })
  assert.deepEqual(withMonth.newJobs, { day: { value: 7336, count: 60, source: 'thisMonth' }, mtd: { value: 90123.65, count: 930, source: 'report114' } })
})
