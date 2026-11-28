const test = require('node:test')
const assert = require('node:assert/strict')
const { parseCaseReport, parseInvoiceReport, planEvidentDay, STATUS_TO_STAGE } = require('../src/services/evidentCaseSync')
const { pendingDates, buildSyncEmail, runEvidentCrmSyncJob } = require('../src/jobs/evidentCrmSync')

// Evident's own email markup: upper-case tags, cells never closed, totals row
// with a blank Ref last (seen in the real 2026-11-25 emails).
const evidentTable = (headers, rows) =>
  '<H2>Report</H2><TABLE border=1><TR align=right>' + headers.map((h) => `<TD>${h}`).join('') +
  rows.map((r) => '<TR align=right>' + r.map((c) => `<TD>${c}`).join('')).join('') + '</TABLE>'

const CASE_HEADERS = ['Ref', 'Case Number', 'Customer Code', 'Customer Name', 'Salesperson', 'Product Name', 'Sales Value (Product)', 'Sales Value (Total)', 'First Booking', 'Last (Shipping)', 'First Arrival', 'Arrived', 'Held', 'New']
const caseRow = (ref, patient, code, name, product, value, booked, ship, status) =>
  [ref, patient, code, name, '', product, value, value, booked, ship, booked,
    status === 'Arrived' ? booked : '', status === 'Held' ? booked : '', status === 'New' ? booked : '']

const booked = evidentTable(CASE_HEADERS, [
  caseRow('10061', 'TROUCHEN, JOCELYN', 'A1199', 'KINGSBROOK JEWISH MEDICAL CTR.', 'Denture Repair', '50.99', '2026-11-25', '2026-12-02', 'Arrived'),
  caseRow('10124', 'LOPEZ, LISBELT', 'A1292', 'WYCKOFF HOSPITAL', 'BACK TO BILLING', '', '2026-11-25', '', 'Held'),
  caseRow('10140', 'TRAVTO, LISA', 'KH2120', 'Dr. Jinu Kurian', 'Zirconia Full Contour', '85', '2026-11-25', '2026-12-04', 'New'),
  ['', '', '', '', '', '', '135.99', '135.99', '', '', '', '', '', ''],
])

test('a case report reads one case per row, its status from the filled status column', () => {
  const r = parseCaseReport(booked)
  assert.equal(r.cases.length, 3)
  assert.equal(r.total, 135.99)
  assert.equal(r.consistent, true)
  assert.deepEqual(r.cases[0], {
    ref: '10061', patient: 'TROUCHEN, JOCELYN', code: 'A1199', customerName: 'KINGSBROOK JEWISH MEDICAL CTR.', salesperson: '',
    product: 'Denture Repair', value: 50.99, bookedOn: '2026-11-25', arrivedOn: '2026-11-25', shipDate: '2026-12-02', evidentStatus: 'Arrived',
  })
  assert.equal(r.cases[1].evidentStatus, 'Held')
  assert.equal(r.cases[1].shipDate, null, 'a held case has no dispatch date')
  assert.equal(r.cases[2].evidentStatus, 'New')
})

test('rows that do not add up to the totals row are flagged', () => {
  const bad = evidentTable(CASE_HEADERS, [caseRow('1', 'P', 'A1', 'X', 'Crown', '10', '2026-11-25', '', 'Arrived'), ['', '', '', '', '', '', '99', '99', '', '', '', '', '', '']])
  assert.equal(parseCaseReport(bad).consistent, false)
  assert.equal(parseCaseReport('<p>no table</p>'), null)
})

test('Invoices Today reads each case billed that day and its total', () => {
  const html = evidentTable(['Ref', 'Case Number', 'Last (Invoice)', 'Customer Code', 'Customer Name', 'Product Name', 'Salesperson', 'Sales Value (Total Billed)'], [
    ['7972', 'SETTLE, PANDORA', '2026-11-25', 'A1116', 'BROOKDALE MAIN', 'Full Denture Set Up - Lower', '', '759.98'],
    ['8635', 'Panj, Manuel', '2026-11-25', 'A1243', 'RINCON DENTAL CARE LLC', 'Digital Model', '', ''],
    ['', '', '', '', '', '', '', '759.98'],
  ])
  const r = parseInvoiceReport(html)
  assert.deepEqual(r.rows, [
    { ref: '7972', code: 'A1116', amount: 759.98, invoiceDate: '2026-11-25' },
    { ref: '8635', code: 'A1243', amount: 0, invoiceDate: '2026-11-25' },
  ])
  assert.equal(r.total, 759.98)
  assert.equal(r.consistent, true)
})

// An Open Cases email with its totals row.
const openCases = (rows) => {
  const total = rows.reduce((n, r) => n + (parseFloat(r[7]) || 0), 0).toFixed(2)
  return parseCaseReport(evidentTable(CASE_HEADERS, [...rows, ['', '', '', '', '', '', total, total, '', '', '', '', '', '']]))
}
const many = (n, from = 20000) => Array.from({ length: n }, (_, i) => caseRow(String(from + i), 'P', 'A1116', 'BROOKDALE MAIN', 'Crown', '10', '2026-11-20', '2026-12-01', 'Arrived'))

test('the plan: new cases, status changes, and cases that left the open list', () => {
  const current = new Map([
    ['10061', { evident_status: null }], // in the CRM, no status yet
    ['9000', { evident_status: 'Arrived' }], // sent today
    ['9001', { evident_status: 'Arrived' }], // gone from Open Cases, not sent today
    ['9002', { evident_status: 'Sent' }],
    ...many(30).map((r) => [r[0], { evident_status: 'Arrived' }]),
  ])
  const sent = openCases([caseRow('9000', 'P', 'A1116', 'BROOKDALE MAIN', 'Crown', '70', '2026-11-18', '2026-11-25', '')])
  sent.cases[0].evidentStatus = 'Sent' // the fixture headers have no Sent column
  const open = openCases([...many(30), caseRow('10061', 'TROUCHEN, JOCELYN', 'A1199', 'KINGSBROOK JEWISH MEDICAL CTR.', 'Denture Repair', '50.99', '2026-11-25', '2026-12-03', 'Held')])
  const plan = planEvidentDay({ date: '2026-11-26', booked: parseCaseReport(booked), sent, open, current })

  const byRef = Object.fromEntries(plan.upserts.map((u) => [u.ref, u]))
  assert.equal(byRef['10061'].evidentStatus, 'Held', 'Open Cases, the evening snapshot, has the last word')
  assert.equal(byRef['10061'].shipDate, '2026-12-03')
  assert.equal(byRef['10061'].exists, true)
  assert.equal(byRef['10140'].exists, false, 'a case new to the CRM')
  assert.equal(byRef['9000'].evidentStatus, 'Sent')
  assert.deepEqual(plan.closures, [{ ref: '9001', fromStatus: 'Arrived' }], 'sent today is not closed; an already-sent case is left alone')
  assert.equal(STATUS_TO_STAGE.Held, 'In Production')
})

test('a broken Open Cases email closes nothing', () => {
  const current = new Map(many(20).map((r) => [r[0], { evident_status: 'Arrived' }]))
  const short = planEvidentDay({ date: '2026-11-26', open: openCases(many(17)), current })
  assert.deepEqual(short.closures, [], 'lists under 90% of the open cases')
  assert.match(short.notes.join(' '), /no case was closed/)
  const noTotals = planEvidentDay({ date: '2026-11-26', open: parseCaseReport(evidentTable(CASE_HEADERS, many(19))), current })
  assert.deepEqual(noTotals.closures, [], 'no totals row to check it against')
  assert.match(noTotals.notes.join(' '), /no totals row/)
})

test('more closures in a day than allowed closes none', () => {
  const { MAX_CLOSURES_PER_DAY } = require('../src/services/evidentCaseSync')
  const n = MAX_CLOSURES_PER_DAY * 20
  const current = new Map(many(n).map((r) => [r[0], { evident_status: 'Arrived' }]))
  const open = openCases(many(n - MAX_CLOSURES_PER_DAY - 1))
  const plan = planEvidentDay({ date: '2026-11-26', open, current })
  assert.deepEqual(plan.closures, [])
  assert.match(plan.notes.join(' '), /more than the 75 allowed/)
  const ok = planEvidentDay({ date: '2026-11-26', open: openCases(many(n - MAX_CLOSURES_PER_DAY)), current })
  assert.equal(ok.closures.length, MAX_CLOSURES_PER_DAY)
})

test('only emails Gmail verified as sent by evidentlabs.com count', () => {
  const { isVerifiedEvident } = require('../src/services/evidentReport/gmailFetch')
  // Gmail's real verdict on Evident's 2026-11-25 "Daily Billed - Today" email.
  const real = 'mx.google.com;\r\n       dkim=pass header.i=@evidentlabs.com header.s=s1 header.b=AZOmO+Dj;\r\n       spf=pass (google.com: domain of bounces+3535763-12b6-media=aimdentallab.com@mail.evidentlabs.com designates 167.89.111.230 as permitted sender) smtp.mailfrom="bounces+3535763-12b6-media=aimdentallab.com@mail.evidentlabs.com";\r\n       dmarc=pass (p=REJECT sp=REJECT dis=NONE) header.from=evidentlabs.com'
  assert.equal(isVerifiedEvident(real), true)
  assert.equal(isVerifiedEvident(real.replace('dmarc=pass', 'dmarc=fail')), false)
  assert.equal(isVerifiedEvident(real.replace('header.i=@evidentlabs.com', 'header.i=@evidentlabs.com.evil.example')), false)
  assert.equal(isVerifiedEvident(real.replace('header.from=evidentlabs.com', 'header.from=evidentlabs.com.evil.example')), false)
  assert.equal(isVerifiedEvident('mx.google.com; dkim=pass header.i=@evil.example; dmarc=pass header.from=evil.example'), false)
  assert.equal(isVerifiedEvident(''), false)
  // Sender-chosen text in comments or quoted strings never counts.
  assert.equal(isVerifiedEvident('mx.google.com; spf=pass (x; dkim=pass header.i=@evidentlabs.com; dmarc=pass header.from=evidentlabs.com) smtp.mailfrom=a@evil.example'), false)
  assert.equal(isVerifiedEvident('mx.google.com; spf=pass smtp.mailfrom="x;dkim=pass header.i=@evidentlabs.com;dmarc=pass header.from=evidentlabs.com"'), false)
  assert.equal(isVerifiedEvident('evil.example; dkim=pass header.i=@evidentlabs.com; dmarc=pass header.from=evidentlabs.com'), false, 'only Gmail\'s own verdict')
})

test('a report is trusted only from Evident\'s mailbox, Gmail-verified, and sent that day', () => {
  const { isTrustedReport } = require('../src/services/evidentCaseSync')
  const { gmailAuthResults, fromAddress, sentDateEt } = require('../src/services/evidentReport/gmailFetch')
  const auth = 'mx.google.com; dkim=pass header.i=@evidentlabs.com header.s=s1; dmarc=pass (p=REJECT) header.from=evidentlabs.com'
  const msg = (headers) => ({ payload: { headers } })
  const real = msg([
    { name: 'Authentication-Results', value: auth },
    { name: 'From', value: '"evidentlabs.com" <support@evidentlabs.com>' },
    { name: 'Date', value: 'Thu, 26 Nov 2026 01:04:06 +0000 (UTC)' },
  ])
  const m = { authResults: gmailAuthResults(real), from: fromAddress(real), sentDate: sentDateEt(real) }
  assert.equal(m.sentDate, '2026-11-25', '8:04 PM in New York')
  assert.equal(isTrustedReport(m, '2026-11-25'), true)
  assert.equal(isTrustedReport(m, '2026-11-27'), false, 'an old email re-sent later is not that day\'s report')
  assert.equal(isTrustedReport({ ...m, from: 'support@evidentlabs.com.evil.example' }, '2026-11-25'), false)
  const twoVerdicts = msg([...real.payload.headers, { name: 'Authentication-Results', value: auth }])
  assert.equal(gmailAuthResults(twoVerdicts), '', 'a second verdict header means one was written by the sender')
})

test('the test account and nameless new cases are skipped; a cancelled case is worth $0', () => {
  const html = evidentTable([...CASE_HEADERS, 'Cancelled'], [
    [...caseRow('5', 'P', 'A10101', 'AIM TEST', 'Crown', '136', '2026-11-25', '', 'Arrived'), ''],
    [...caseRow('6', 'P', 'A1218', '', 'Coping', '495', '2026-11-25', '', 'Arrived'), ''],
    [...caseRow('7', 'P', 'A1116', 'BROOKDALE MAIN', 'Crown', '70', '2026-11-25', '', ''), '2026-11-25'],
  ])
  const plan = planEvidentDay({ date: '2026-11-25', booked: parseCaseReport(html), current: new Map() })
  assert.deepEqual(plan.skipped.map((s) => s.why), ['test account', 'no doctor name in Evident'])
  assert.equal(plan.upserts[0].evidentStatus, 'Cancelled')
  assert.equal(plan.upserts[0].value, 0)
})

test('every day since the history load that is not applied yet, oldest first', () => {
  assert.deepEqual(pendingDates('2026-11-30', new Set()), ['2026-11-26', '2026-11-27', '2026-11-28', '2026-11-29'])
  assert.deepEqual(pendingDates('2026-11-30', new Set(['2026-11-26', '2026-11-27'])), ['2026-11-28', '2026-11-29'])
  assert.deepEqual(pendingDates('2026-11-26', new Set()), [], 'nothing before the day has ended')
  assert.equal(pendingDates('2027-03-01', new Set())[0], '2027-01-30', 'at most 30 days back')
})

const fakeDeps = (over = {}) => {
  const claimed = []
  const sent = []
  const calls = []
  return {
    claimed, sent, calls,
    deps: {
      today: '2026-11-30',
      claim: async (job, date) => { claimed.push([job, date]); return true },
      release: async () => {},
      appliedDates: async () => new Set(['2026-11-26']),
      send: async (m) => sent.push(m),
      sync: async (date, opts) => { calls.push([date, opts.apply]); return { date, reportsFound: { booked: 3 }, newCases: 1, statusChanges: { 'Arrived -> Sent': 2 }, closures: [], skipped: [], invoiceRows: 4, invoiceTotal: 100, notes: [], problems: [] } },
      ...over,
    },
  }
}

const withEnv = async (env, fn) => {
  const prev = { ...process.env }
  Object.assign(process.env, env)
  if (!env.EVIDENT_CASE_SYNC_APPLY) delete process.env.EVIDENT_CASE_SYNC_APPLY
  try { await fn() } finally { process.env = prev }
}

test('the job is a dry run unless EVIDENT_CASE_SYNC_APPLY is true, and emails what it would do', () => withEnv({ EVIDENT_CRM_SYNC_ENABLED: 'true' }, async () => {
  const f = fakeDeps()
  assert.equal(await runEvidentCrmSyncJob({ deps: f.deps }), 'dry-run')
  assert.deepEqual(f.calls, [['2026-11-27', false], ['2026-11-28', false], ['2026-11-29', false]])
  assert.deepEqual(f.claimed, [['evident-crm-sync', '2026-11-30']], 'a dry run records no day as applied')
  assert.match(f.sent[0].subject, /dry run/)
  assert.match(f.sent[0].html, /Arrived -&gt; Sent: 2/)
}))

test('a real run records each day it applies and stops at a failed day', () => withEnv({ EVIDENT_CRM_SYNC_ENABLED: 'true', EVIDENT_CASE_SYNC_APPLY: 'true' }, async () => {
  const f = fakeDeps()
  const ok = f.deps.sync
  f.deps.sync = async (date, opts) => { if (date === '2026-11-28') throw new Error('Gmail down'); return ok(date, opts) }
  assert.equal(await runEvidentCrmSyncJob({ deps: f.deps }), 'failed')
  assert.deepEqual(f.calls, [['2026-11-27', true]], 'Nov 29 waits for Nov 28')
  assert.deepEqual(f.claimed.map(([, d]) => d), ['2026-11-30', '2026-11-27'])
  assert.match(f.sent[0].html, /Gmail down/)
}))

test('without the record of applied days nothing runs', () => withEnv({ EVIDENT_CRM_SYNC_ENABLED: 'true', EVIDENT_CASE_SYNC_APPLY: 'true' }, async () => {
  const f = fakeDeps({ appliedDates: async () => { throw new Error('db down') } })
  assert.equal(await runEvidentCrmSyncJob({ deps: f.deps }), 'failed')
  assert.deepEqual(f.calls, [])
}))

test('a real run emails only the days where the CRM and Evident disagree', () => {
  const off = { date: '2026-11-27', reportsFound: {}, statusChanges: {}, closures: [], skipped: [], invoiceRows: 0, invoiceTotal: null, newCases: 0, problems: ['Open cases: Evident lists 640, the CRM has 641 open.'] }
  const { subject, html } = buildSyncEmail([off], { apply: true })
  assert.match(subject, /disagree \(2026-11-27\)/)
  assert.match(html, /Evident lists 640/)
})
