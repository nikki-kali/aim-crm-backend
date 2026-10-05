const test = require('node:test')
const assert = require('node:assert/strict')
const http = require('http')
const express = require('express')
const { CRITICAL_EVIDENT_EMAILS, findMissingEvidentEmails, checkEvidentEmails, buildMissingEmailsAlert } = require('../../src/services/evidentReport/emailCheck')
const cronRoute = require('../../src/routes/cron')

const msg = (subject, date = '2026-10-01') => ({ subject, date })
const ALL = CRITICAL_EVIDENT_EMAILS.map((s) => msg(s))

test('the critical list is exactly the Evident emails the reports now depend on', () => {
  assert.deepEqual(CRITICAL_EVIDENT_EMAILS, [
    'Daily Booking Report - Nadine',
    'Daily Billed Report - Nadine',
    'MTD Booked Daily Update',
    'Daily MTD Total Billed',
    'YTD Billed Cases - Nadine',
  ])
})

test('nothing is missing when every critical email arrived', () => {
  assert.deepEqual(findMissingEvidentEmails(ALL), { present: CRITICAL_EVIDENT_EMAILS, missing: [] })
})

test('names exactly which critical emails did not arrive', () => {
  const some = ALL.filter((m) => m.subject !== 'MTD Booked Daily Update' && m.subject !== 'YTD Billed Cases - Nadine')
  assert.deepEqual(findMissingEvidentEmails(some).missing, ['MTD Booked Daily Update', 'YTD Billed Cases - Nadine'])
})

test('subject matching ignores case and stray whitespace, and other emails do not count', () => {
  const m = findMissingEvidentEmails([msg('  daily billed report - nadine '), msg('William Doctors Daily Report')])
  assert.ok(m.present.includes('Daily Billed Report - Nadine'))
  assert.equal(m.missing.length, 4)
})

test('with no emails at all, all five are reported missing', () => {
  assert.equal(findMissingEvidentEmails([]).missing.length, 5)
})

test("checkEvidentEmails only counts emails dated for the report day, never an older day's", async () => {
  const fetchEmails = async () => [...ALL.map((m) => ({ ...m, date: '2026-09-30' })), msg('Daily Billed Report - Nadine', '2026-10-01')]
  const out = await checkEvidentEmails({ fetchEmails, runDate: '2026-10-01' })
  assert.equal(out.runDate, '2026-10-01')
  assert.equal(out.ok, false)
  assert.equal(out.foundForRunDate, 1)
  assert.deepEqual(out.missing, ['Daily Booking Report - Nadine', 'MTD Booked Daily Update', 'Daily MTD Total Billed', 'YTD Billed Cases - Nadine'])
})

test('checkEvidentEmails reports ok when everything arrived', async () => {
  const out = await checkEvidentEmails({ fetchEmails: async () => ALL, runDate: '2026-10-01' })
  assert.equal(out.ok, true)
  assert.deepEqual(out.missing, [])
})

test('the alert email names the day, each missing email, and what it affects', () => {
  const { subject, html } = buildMissingEmailsAlert({ ok: false, runDate: '2026-10-02', missing: ['MTD Booked Daily Update', 'Daily MTD Total Billed'], present: ['Daily Booking Report - Nadine'] })
  assert.match(subject, /Friday, October 2/)
  assert.match(subject, /Evident/i)
  assert.match(html, /MTD Booked Daily Update/)
  assert.match(html, /Daily MTD Total Billed/)
  assert.match(html, /Monthly Sales/)
  assert.doesNotMatch(html, /undefined|NaN/)
})

function post(server, path, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port: server.address().port, path, method: 'POST', headers }, (res) => {
      let raw = ''
      res.on('data', (c) => (raw += c))
      res.on('end', () => resolve({ status: res.statusCode, body: raw ? JSON.parse(raw) : null }))
    })
    req.on('error', reject)
    req.end()
  })
}

// Runs `fn` against the real cron router with the check/alert stubbed and a known secret.
async function withRoute({ check, sendAlert, secret = 'test-secret' }, fn) {
  const prev = { secret: process.env.CRON_SECRET, check: cronRoute.emailCheckDeps.check, sendAlert: cronRoute.emailCheckDeps.sendAlert }
  process.env.CRON_SECRET = secret
  if (check) cronRoute.emailCheckDeps.check = check
  if (sendAlert) cronRoute.emailCheckDeps.sendAlert = sendAlert
  const app = express()
  app.use('/api/cron', cronRoute)
  const server = await new Promise((resolve) => { const s = app.listen(0, () => resolve(s)) })
  try {
    await fn(server)
  } finally {
    server.close()
    cronRoute.emailCheckDeps.check = prev.check
    cronRoute.emailCheckDeps.sendAlert = prev.sendAlert
    if (prev.secret === undefined) delete process.env.CRON_SECRET; else process.env.CRON_SECRET = prev.secret
  }
}

test('the check endpoint needs the same secret as the triggers, and answers with JSON', async () => {
  const result = { ok: false, runDate: '2026-10-01', missing: ['MTD Booked Daily Update'] }
  await withRoute({ check: async () => result }, async (server) => {
    assert.equal((await post(server, '/api/cron/evident-email-check')).status, 401)
    assert.equal((await post(server, '/api/cron/evident-email-check', { 'x-cron-secret': 'nope' })).status, 401)
    const ok = await post(server, '/api/cron/evident-email-check', { 'x-cron-secret': 'test-secret' })
    assert.equal(ok.status, 200)
    assert.deepEqual(ok.body, result)
  })
  await withRoute({ check: async () => ({ ok: true }), secret: '' }, async (server) => {
    assert.equal((await post(server, '/api/cron/evident-email-check', { 'x-cron-secret': 'anything' })).status, 503)
  })
})

test('?alert=true emails the approver only when something is missing; otherwise nothing is sent', async () => {
  const alerts = []
  const sendAlert = async (r) => { alerts.push(r) }
  const missing = { ok: false, runDate: '2026-10-01', missing: ['YTD Billed Cases - Nadine'] }
  const H = { 'x-cron-secret': 'test-secret' }
  await withRoute({ check: async () => missing, sendAlert }, async (server) => {
    assert.equal((await post(server, '/api/cron/evident-email-check', H)).body.alerted, undefined)
    assert.equal(alerts.length, 0, 'no alert without ?alert=true')
    const res = await post(server, '/api/cron/evident-email-check?alert=true', H)
    assert.equal(res.body.alerted, true)
    assert.deepEqual(alerts, [missing])
  })
  alerts.length = 0
  await withRoute({ check: async () => ({ ok: true, runDate: '2026-10-01', missing: [] }), sendAlert }, async (server) => {
    const res = await post(server, '/api/cron/evident-email-check?alert=true', H)
    assert.equal(res.body.alerted, undefined)
    assert.equal(alerts.length, 0, 'nothing missing = no alert')
  })
})

test('if the alert email itself fails, the check still answers with what was missing', async () => {
  const missing = { ok: false, runDate: '2026-10-01', missing: ['MTD Booked Daily Update'] }
  await withRoute({ check: async () => missing, sendAlert: async () => { throw new Error('smtp down') } }, async (server) => {
    const res = await post(server, '/api/cron/evident-email-check?alert=true', { 'x-cron-secret': 'test-secret' })
    assert.equal(res.status, 200)
    assert.equal(res.body.alerted, false)
    assert.match(res.body.alertError, /smtp down/)
    assert.deepEqual(res.body.missing, ['MTD Booked Daily Update'])
  })
})

test('a Gmail failure comes back as a 502 with a reason, so n8n can alert instead of staying silent', async () => {
  await withRoute({ check: async () => { throw new Error('invalid_grant') } }, async (server) => {
    const res = await post(server, '/api/cron/evident-email-check', { 'x-cron-secret': 'test-secret' })
    assert.equal(res.status, 502)
    assert.equal(res.body.ok, false)
    assert.match(res.body.error, /invalid_grant/)
  })
})
