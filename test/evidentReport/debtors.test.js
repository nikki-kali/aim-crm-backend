const test = require('node:test')
const assert = require('node:assert/strict')
const { parseDebtors, latestDebtors } = require('../../src/services/evidentReport/debtors')
const { debtorsSection } = require('../../src/services/evidentReport/buildReport')

// Synthetic email in the same shape as Evident's "This Month" summary
// (made-up numbers, no real report committed).
const email = (total, current, d30, d60, d90, when = '03 Mar 2026 04:00') => `<div>Dental lab<br>${when}<br>This Month - 03 Mar 2026</div>
<h3>Accounts</h3><p>Receipts: <b>0 (0) = 1,111</b><br>Invoices: <b>22 (3) = 2,222</b><br>Credits: <b>0 (0) = 5</b></p>
<h3>Debtors</h3><p>Total: <b>${total}</b><br>Current: <b>${current}</b><br>30 Day: <b>${d30}</b><br>60 Day: <b>${d60}</b><br>90 Day: <b>${d90}</b></p>
<h3>WIP</h3><p>New Jobs: <b>700 (9)</b><br>In Lab: <b>6,000+100 (50)</b></p>
<p>Legend: todays transaction value (todays transaction count) = months transaction value</p>`

test('Debtors: reads Total and the aged buckets, ignores Accounts and WIP', () => {
  assert.deepEqual(parseDebtors(email('10,000', '4,000', '3,000', '2,000', '1,000')), {
    total: 10000, current: 4000, d30: 3000, d60: 2000, d90: 1000, asOf: '03 Mar 2026',
  })
})

test('Debtors: plain-text layout with asterisks works too', () => {
  const text = 'Dental lab\n09 Mar 2026 17:09\n### Accounts Receipts: *0 (0) = 50*\n### Debtors Total: *9,500*\nCurrent: *5,000*\n30 Day: *2,000*\n60 Day: *1,500*\n90 Day: *1,000*\n### WIP New Jobs: *7 (9)*'
  const d = parseDebtors(text)
  assert.equal(d.total, 9500)
  assert.equal(d.d90, 1000)
  assert.equal(d.asOf, '09 Mar 2026')
})

test('Debtors: no Debtors line means null', () => {
  assert.equal(parseDebtors('<p>Daily Booking Report</p>'), null)
  assert.equal(latestDebtors([]), null)
})

test('Debtors: the newest email wins', () => {
  const older = { html: email('1,000', '1,000', '0', '0', '0', '02 Mar 2026 04:00'), date: '2026-03-02', internalDate: 1 }
  const newer = { html: email('2,000', '2,000', '0', '0', '0', '03 Mar 2026 04:00'), date: '2026-03-03', internalDate: 2 }
  assert.equal(latestDebtors([older, newer]).total, 2000)
  assert.equal(latestDebtors([newer, older]).asOf, '03 Mar 2026')
})

test('Debtors card: red total and buckets; a missing email says so; not looked up shows nothing', () => {
  const html = debtorsSection(parseDebtors(email('10,000', '4,000', '3,000', '2,000', '1,000')))
  assert.match(html, /Outstanding to collect \(Debtors\)/)
  assert.match(html, /\$10,000/)
  assert.match(html, /90 Day[\s\S]*\$1,000/)
  assert.match(html, /#c8102e/)
  assert.match(debtorsSection(null), /did not come through/)
  assert.equal(debtorsSection(undefined), '')
})
