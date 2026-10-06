const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const path = require('path')
const { extractEviSmartRepMtd, extractEviSmartTotals, applyEviSmartMtdFallback } = require('../../src/services/evidentReport/parseEvident')
const { pickMtdSource, summarizeBilledRows } = require('../../src/services/salesRepDailyReport')
const { buildCombinedLeadershipEmail } = require('../../src/services/evidentReport/buildReport')
const { parseAndAggregate, applyEmailMtdTotals } = require('../../src/services/evidentReport/parseEvident')

// Real "MTD by sales rep" tables from four real EviSmart Daily Sales Report emails.
const REAL = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures/evismart-rep-mtd-tables.json'), 'utf8'))

test('reads the by-rep table from the Oct 5 layout ("James (Delaney)", with a "No rep (N/A)" row)', () => {
  assert.deepEqual(extractEviSmartRepMtd(REAL.oct5.repTable), {
    billed: { james: 0, william: 569.96, na: 20457.99, company: 21027.95 },
    booked: { james: 261, william: 532.49, na: 20813.5, company: 21606.99 },
  })
})

test('reads the Oct 2 layout', () => {
  const r = extractEviSmartRepMtd(REAL.oct2.repTable)
  assert.deepEqual(r.booked, { james: 0, william: 272.49, na: 14089.82, company: 14362.31 })
  assert.deepEqual(r.billed, { james: 0, william: 569.96, na: 12280.82, company: 12850.78 })
})

test('older layouts ("Delaney, James", no N/A row) work, and N/A is the company total minus the two reps', () => {
  const oct1 = extractEviSmartRepMtd(REAL.oct1.repTable)
  assert.deepEqual(oct1.booked, { james: 0, william: 77.49, na: 9673.85, company: 9751.34 })
  assert.deepEqual(oct1.billed, { james: 0, william: 569.96, na: 8154.01, company: 8723.97 })
  const sep30 = extractEviSmartRepMtd(REAL.sep30.repTable)
  assert.deepEqual(sep30.booked, { james: 1855.42, william: 2468.33, na: 163629.81, company: 167953.56 })
  assert.deepEqual(sep30.billed, { james: 2130.42, william: 1409.88, na: 166515.83, company: 170056.13 })
})

test('no by-rep table in the email means null, never zeros', () => {
  assert.equal(extractEviSmartRepMtd('<html><table><tr><td>Daily Booked</td><td>1</td></tr></table></html>'), null)
  assert.equal(extractEviSmartRepMtd(''), null)
})

test('extractEviSmartTotals carries the by-rep table along with the totals', () => {
  const base = fs.readFileSync(path.join(__dirname, 'fixtures/evismart-daily-sales-report-sep23-eod.html'), 'utf8')
  const without = extractEviSmartTotals(base)
  assert.equal(without.repMtd, null)
  const withRep = extractEviSmartTotals(base + REAL.oct5.repTable)
  assert.equal(withRep.repMtd.billed.william, 569.96)
  assert.equal(withRep.dailyBilledValue, without.dailyBilledValue, 'the other totals are unchanged')
})

const es = () => ({ repMtd: extractEviSmartRepMtd(REAL.oct5.repTable) })
const agg = (missing) => ({ missing, companyMtdBooked: 0, companyMtdBookedByRep: null, companyMtdBilled: 0, companyMtdBilledByRep: null })

test('when Evident\'s two MTD emails are missing, the figures come from EviSmart\'s #12/#40 table and are no longer reported missing', () => {
  const out = applyEviSmartMtdFallback(agg(['MTD Booked Daily Update', 'Daily MTD Total Billed', 'Cases Currently In Progress']), es())
  assert.equal(out.companyMtdBooked, 21606.99)
  assert.deepEqual(out.companyMtdBookedByRep, { na: 20813.5, james: 261, william: 532.49 })
  assert.equal(out.companyMtdBilled, 21027.95)
  assert.deepEqual(out.companyMtdBilledByRep, { na: 20457.99, james: 0, william: 569.96 })
  assert.deepEqual(out.missing, ['Cases Currently In Progress'], 'only the report nothing was substituted for stays missing')
})

test('Evident\'s own email always wins when it arrived; only the missing one is filled', () => {
  const only = applyEviSmartMtdFallback({ ...agg(['Daily MTD Total Billed']), companyMtdBooked: 5, companyMtdBookedByRep: { na: 1, james: 2, william: 2 } }, es())
  assert.equal(only.companyMtdBooked, 5)
  assert.deepEqual(only.companyMtdBookedByRep, { na: 1, james: 2, william: 2 })
  assert.equal(only.companyMtdBilled, 21027.95)
})

test('with no EviSmart table the aggregate is returned unchanged', () => {
  const a = agg(['MTD Booked Daily Update'])
  assert.deepEqual(applyEviSmartMtdFallback(a, null), a)
  assert.deepEqual(applyEviSmartMtdFallback(a, { repMtd: null }), a)
})

test('pickMtdSource: the report day\'s own Evident email, then EviSmart, then (last resort) an older Evident email', () => {
  const ev = { na: 1, james: 1, william: 1 }, evi = { na: 2, james: 2, william: 2 }, old = { na: 3, james: 3, william: 3 }
  assert.equal(pickMtdSource({ exact: ev, eviSmart: evi, older: old }), ev)
  assert.equal(pickMtdSource({ exact: null, eviSmart: evi, older: old }), evi)
  assert.equal(pickMtdSource({ exact: null, eviSmart: null, older: old }), old)
  assert.equal(pickMtdSource({ exact: null, eviSmart: null, older: null }), null)
})

test('cases billed counts only rows actually invoiced; a row with a value but no billed amount is not a billed case', () => {
  const rows = [
    { ref: '6348', value: 65, billedValue: 0 }, { ref: '6349', value: 65, billedValue: 0 },
    { ref: '6786', value: 0, billedValue: 0 }, { ref: '6001', value: 100, billedValue: 100 }, { ref: '6002', value: 80, billedValue: 75.5 },
  ]
  assert.deepEqual(summarizeBilledRows(rows), { count: 2, value: 175.5 })
  assert.deepEqual(summarizeBilledRows([]), { count: 0, value: 0 })
})

test('the Leadership Dashboard rep card does not count uninvoiced rows as "billed" either (real Oct 5 William rows)', () => {
  const a = parseAndAggregate([], { runDate: '2026-10-05' })
  a.missing = []
  Object.assign(a, {
    companyDailyBooked: 6841.05, companyDailyBookedCount: 75, companyDailyBilled: 8127.17, companyMtdBooked: 21606.99, companyMtdBilled: 21027.95, companyYtdBilled: 1,
    companyMtdBookedByRep: { na: 20813.5, james: 261, william: 532.49 }, companyMtdBilledByRep: { na: 20457.99, james: 0, william: 569.96 },
    companyDailyBookedRows: [{ ref: '6786', customerName: 'Dr. KELLY J HWANG', value: 0, salesperson: 'william' }],
    companyDailyBilledRows: [6348, 6349, 6350, 6351, 6786].map((ref) => ({ ref: String(ref), customerName: 'x', value: 65, billedValue: 0, salesperson: 'william' })),
  })
  a.eviSmart = applyEmailMtdTotals({ dailyBilledValue: 8127.17 }, a)
  a.eviSmart.lastMonth = { monthName: 'September', booked: 1, billed: 1 }
  const { html } = buildCombinedLeadershipEmail(a, [], [], {})
  const text = html.replace(/<style[\s\S]*?<\/style>/gi, '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ')
  const william = (text.match(/William Alexander Total Daily Booked[\s\S]{0,140}/) || [''])[0]
  assert.match(william, /Total Daily Billed 0 \$0\.00/)
  assert.match(william, /MTD Booked \$532\.49 MTD Billed \$569\.96/)
})
