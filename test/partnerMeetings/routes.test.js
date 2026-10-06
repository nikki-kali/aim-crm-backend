require('dotenv').config()
const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('path')
const httpClient = require('http')
const express = require('express')
const db = require('../../src/config/db')

// Stub sendEmail before the route loads (a real send hangs in this sandbox).
const sentEmails = []
let failEmailsTo = null
const emailModulePath = require.resolve(path.join(__dirname, '../../src/services/email.js'))
require.cache[emailModulePath] = {
  id: emailModulePath, filename: emailModulePath, loaded: true,
  exports: {
    sendEmail: async (opts) => {
      if (failEmailsTo && (opts.to || []).includes(failEmailsTo)) throw new Error('stub send failure')
      sentEmails.push(opts)
    },
  },
}

const routes = require('../../src/routes/partnerMeetings')

function startServer() {
  const app = express()
  app.use('/api/partner-meetings', routes)
  return new Promise((resolve) => { const s = app.listen(0, () => resolve(s)) })
}

function call(server, method, p, body, form) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : form ? new URLSearchParams(body).toString() : JSON.stringify(body)
    const headers = data ? { 'Content-Type': form ? 'application/x-www-form-urlencoded' : 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}
    const req = httpClient.request({ hostname: '127.0.0.1', port: server.address().port, path: p, method, headers }, (res) => {
      let raw = ''
      res.on('data', (c) => (raw += c))
      res.on('end', () => {
        let parsed = raw
        try { if (raw.trim().startsWith('{')) parsed = JSON.parse(raw) } catch {}
        resolve({ status: res.statusCode, body: parsed })
      })
    })
    req.on('error', reject)
    if (data) req.write(data)
    req.end()
  })
}

const futureDate = (days) => {
  const d = new Date(Date.now() + days * 86400000)
  return d.toISOString().slice(0, 10)
}
const goodBody = (over = {}) => ({
  partner_name: 'TEST PARTNER Jane', company: 'TEST PARTNER Co', email: 'test-partner@example.com',
  phone: '555-0100', timezone: 'America/Los_Angeles', note: '',
  slots: [{ date: futureDate(10), time: '10:00' }, { date: futureDate(11), time: '14:30' }, { date: futureDate(12), time: '09:00' }],
  ...over,
})
const tokenFrom = (html, label) => {
  const links = [...html.matchAll(/confirm\?token=([a-f0-9]{64})/g)].map((m) => m[1])
  return links
}

async function cleanup() {
  await db.query(`DELETE FROM partner_meeting_requests WHERE partner_name LIKE 'TEST PARTNER%'`)
}

test('GET /book serves the form with three date/time rows', async () => {
  const server = await startServer()
  try {
    const r = await call(server, 'GET', '/api/partner-meetings/book')
    assert.equal(r.status, 200)
    for (const n of ['date1', 'time1', 'date2', 'time2', 'date3', 'time3', 'timezone', 'partner_name', 'email']) assert.match(r.body, new RegExp(`name="${n}"`))
    assert.doesNotMatch(r.body, /—|–/)
  } finally { server.close() }
})

test('POST /request rejects bad input without saving or emailing', async () => {
  const server = await startServer()
  sentEmails.length = 0
  try {
    const cases = [
      goodBody({ partner_name: '' }),
      goodBody({ email: 'nope' }),
      goodBody({ timezone: 'Mars/Base' }),
      goodBody({ slots: [{ date: futureDate(10), time: '10:00' }] }),
      goodBody({ slots: [{ date: '2020-01-01', time: '10:00' }, { date: futureDate(11), time: '14:30' }, { date: futureDate(12), time: '09:00' }] }),
    ]
    for (const c of cases) {
      const r = await call(server, 'POST', '/api/partner-meetings/request', c)
      assert.equal(r.status, 400, JSON.stringify(r.body))
    }
    assert.equal(sentEmails.length, 0)
    const { rows } = await db.query(`SELECT 1 FROM partner_meeting_requests WHERE partner_name LIKE 'TEST PARTNER%'`)
    assert.equal(rows.length, 0)
  } finally { server.close(); await cleanup() }
})

test('a valid request emails Ben (cc execassistant, bcc media) with 4 working links', async () => {
  const server = await startServer()
  sentEmails.length = 0
  try {
    const r = await call(server, 'POST', '/api/partner-meetings/request', goodBody())
    assert.equal(r.status, 201, JSON.stringify(r.body))
    assert.equal(sentEmails.length, 1)
    const m = sentEmails[0]
    assert.deepEqual(m.to, ['ben@aimdentallab.com'])
    assert.deepEqual(m.cc, ['execassistant@aimdentallab.com'])
    assert.deepEqual(m.bcc, ['media@aimdentallab.com'])
    assert.equal(m.replyTo, 'test-partner@example.com')
    assert.equal(tokenFrom(m.html).length, 4)
  } finally { server.close(); await cleanup() }
})

test('a failed email removes the saved request so nothing is orphaned', async () => {
  const server = await startServer()
  failEmailsTo = 'ben@aimdentallab.com'
  try {
    const r = await call(server, 'POST', '/api/partner-meetings/request', goodBody())
    assert.equal(r.status, 500)
    const { rows } = await db.query(`SELECT 1 FROM partner_meeting_requests WHERE partner_name LIKE 'TEST PARTNER%'`)
    assert.equal(rows.length, 0)
  } finally { failEmailsTo = null; server.close(); await cleanup() }
})

test('GET /confirm changes nothing; POST approve confirms, emails both sides with an .ics, and burns the other links', async () => {
  const server = await startServer()
  sentEmails.length = 0
  try {
    await call(server, 'POST', '/api/partner-meetings/request', goodBody())
    const [a0, a1, a2, callTok] = tokenFrom(sentEmails[0].html)
    sentEmails.length = 0

    const peek = await call(server, 'GET', `/api/partner-meetings/confirm?token=${a1}`)
    assert.equal(peek.status, 200)
    assert.equal(sentEmails.length, 0)
    const { rows: still } = await db.query(`SELECT status FROM partner_meeting_requests WHERE partner_name LIKE 'TEST PARTNER%'`)
    assert.equal(still[0].status, 'pending')

    const ok = await call(server, 'POST', '/api/partner-meetings/confirm', { token: a1 }, true)
    assert.equal(ok.status, 200)
    assert.match(ok.body, /Meeting confirmed/)
    const { rows } = await db.query(`SELECT status, confirmed_slot_index FROM partner_meeting_requests WHERE partner_name LIKE 'TEST PARTNER%'`)
    assert.equal(rows[0].status, 'approved')
    assert.equal(rows[0].confirmed_slot_index, 1)

    assert.equal(sentEmails.length, 2)
    const toPartner = sentEmails.find((e) => e.to.includes('test-partner@example.com'))
    const toBen = sentEmails.find((e) => e.to.includes('ben@aimdentallab.com'))
    assert.ok(toPartner && toBen)
    assert.deepEqual(toBen.cc, ['execassistant@aimdentallab.com'])
    assert.deepEqual(toBen.bcc, ['media@aimdentallab.com'])
    assert.ok(!toPartner.bcc && !toPartner.cc)
    for (const e of [toPartner, toBen]) {
      assert.match(e.html, /meet\.google\.com\/spv-afjq-fbt/)
      assert.equal(e.attachments[0].filename, 'partner-meeting.ics')
      assert.match(e.attachments[0].content.toString(), /BEGIN:VCALENDAR/)
    }

    for (const t of [a0, a1, a2, callTok]) {
      const again = await call(server, 'POST', '/api/partner-meetings/confirm', { token: t }, true)
      assert.equal(again.status, 410)
    }
    assert.equal(sentEmails.length, 2)
  } finally { server.close(); await cleanup() }
})

test('"call first" marks the request, emails nobody, and leaves approve links working', async () => {
  const server = await startServer()
  sentEmails.length = 0
  try {
    await call(server, 'POST', '/api/partner-meetings/request', goodBody())
    const [a0, , , callTok] = tokenFrom(sentEmails[0].html)
    sentEmails.length = 0
    const r = await call(server, 'POST', '/api/partner-meetings/confirm', { token: callTok }, true)
    assert.equal(r.status, 200)
    assert.equal(sentEmails.length, 0)
    const { rows } = await db.query(`SELECT status FROM partner_meeting_requests WHERE partner_name LIKE 'TEST PARTNER%'`)
    assert.equal(rows[0].status, 'call_first')
    const ok = await call(server, 'POST', '/api/partner-meetings/confirm', { token: a0 }, true)
    assert.equal(ok.status, 200)
    assert.equal(sentEmails.length, 2)
  } finally { server.close(); await cleanup() }
})

test('if the partner email fails, the meeting stays approved and Ben still gets his email, and the page says so', async () => {
  const server = await startServer()
  sentEmails.length = 0
  try {
    await call(server, 'POST', '/api/partner-meetings/request', goodBody())
    const [a0] = tokenFrom(sentEmails[0].html)
    sentEmails.length = 0
    failEmailsTo = 'test-partner@example.com'
    const r = await call(server, 'POST', '/api/partner-meetings/confirm', { token: a0 }, true)
    assert.match(r.body, /did not send/)
    assert.equal(sentEmails.length, 1)
    assert.ok(sentEmails[0].to.includes('ben@aimdentallab.com'))
  } finally { failEmailsTo = null; server.close(); await cleanup() }
})

test('a missing or unknown token is rejected', async () => {
  const server = await startServer()
  try {
    assert.equal((await call(server, 'GET', '/api/partner-meetings/confirm')).status, 400)
    assert.equal((await call(server, 'GET', '/api/partner-meetings/confirm?token=abc')).status, 410)
    assert.equal((await call(server, 'POST', '/api/partner-meetings/confirm', { token: 'abc' }, true)).status, 410)
  } finally { server.close() }
})

test('the form supports browser autofill and link pre-fill', async () => {
  const server = await startServer()
  try {
    const r = await call(server, 'GET', '/api/partner-meetings/book')
    for (const a of ['name', 'organization', 'email', 'tel']) assert.match(r.body, new RegExp(`autocomplete="${a}"`))
    assert.match(r.body, /URLSearchParams\(location\.search\)/)
  } finally { server.close() }
})
