require('dotenv').config()
const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('path')
const jwt = require('jsonwebtoken')
const httpClient = require('http')
const express = require('express')
const db = require('../../src/config/db')

// Same email-module-cache stub as officeVisitsRoutes.test.js — a real
// outbound send hangs in this sandboxed test environment, and no route
// test in this repo should depend on live network delivery.
const sentEmails = []
const emailModulePath = require.resolve(path.join(__dirname, '../../src/services/email.js'))
require.cache[emailModulePath] = {
  id: emailModulePath, filename: emailModulePath, loaded: true,
  exports: { sendEmail: async (opts) => { sentEmails.push(opts) } },
}

const officeVisitsAdminRoutes = require('../../src/routes/officeVisitsAdmin')

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret'

function startServer() {
  const app = express()
  app.use(express.json())
  app.use('/api/office-visits-admin', officeVisitsAdminRoutes)
  return new Promise((resolve) => { const server = app.listen(0, () => resolve(server)) })
}

function authedToken(user) {
  return jwt.sign(user, process.env.JWT_SECRET, { expiresIn: '1h' })
}

function call(server, method, path, { body, token } = {}) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null
    const headers = { 'Content-Type': 'application/json' }
    if (token) headers.Authorization = `Bearer ${token}`
    if (data) headers['Content-Length'] = Buffer.byteLength(data)
    const req = httpClient.request({ hostname: '127.0.0.1', port: server.address().port, path, method, headers }, (res) => {
      let raw = ''
      res.on('data', (c) => (raw += c))
      res.on('end', () => resolve({ status: res.statusCode, body: raw ? JSON.parse(raw) : null }))
    })
    req.on('error', reject)
    if (data) req.write(data)
    req.end()
  })
}

test('GET / requires auth', async () => {
  const server = await startServer()
  const res = await call(server, 'GET', '/api/office-visits-admin')
  assert.equal(res.status, 401)
  server.close()
})

test('POST / (rep-scheduled) creates an approved booking with no email and skips sending', async () => {
  const server = await startServer()
  const { rows: [rep] } = await db.query(`SELECT id, email FROM users WHERE email='james@aimdentallab.com'`)
  const token = authedToken({ id: rep.id, email: rep.email, role: 'sales_rep' })
  const res = await call(server, 'POST', '/api/office-visits-admin', {
    token,
    body: { contact_name: 'Walk-in Practice', phone: '555-0150', requested_date: '2026-10-20', requested_time: '10:00' },
  })
  assert.equal(res.status, 201)
  const { rows } = await db.query(`SELECT * FROM office_visit_bookings WHERE id = $1`, [res.body.id])
  assert.equal(rows[0].source, 'rep_scheduled')
  assert.equal(rows[0].status, 'approved')
  assert.equal(rows[0].assigned_rep_id, rep.id)
  server.close()
})

test('POST / (rep-scheduled) with an email sends a confirmation', async () => {
  const server = await startServer()
  const { rows: [rep] } = await db.query(`SELECT id, email FROM users WHERE email='williama@aimdentallab.com'`)
  const token = authedToken({ id: rep.id, email: rep.email, role: 'sales_rep' })
  const before = sentEmails.length
  const res = await call(server, 'POST', '/api/office-visits-admin', {
    token,
    body: { contact_name: 'Has Email Practice', phone: '555-0160', email: 'office@example.com', requested_date: '2026-10-21', requested_time: '11:00' },
  })
  assert.equal(res.status, 201)
  assert.equal(sentEmails.length, before + 1)
  server.close()
})

test('PUT /:id/reschedule sets a confirmed date/time and status approved', async () => {
  const server = await startServer()
  const { rows: [rep] } = await db.query(`SELECT id, email FROM users WHERE email='james@aimdentallab.com'`)
  const { rows: [booking] } = await db.query(
    `INSERT INTO office_visit_bookings (source, contact_name, phone, email, status, assigned_rep_id)
     VALUES ('public_form','Jane','555-0100','jane@example.com','time_suggested',$1) RETURNING id`,
    [rep.id]
  )
  const token = authedToken({ id: rep.id, email: rep.email, role: 'sales_rep' })
  const res = await call(server, 'PUT', `/api/office-visits-admin/${booking.id}/reschedule`, {
    token, body: { confirmed_date: '2026-10-22', confirmed_time: '15:00' },
  })
  assert.equal(res.status, 200)
  const { rows: after } = await db.query(`SELECT status, confirmed_date FROM office_visit_bookings WHERE id = $1`, [booking.id])
  assert.equal(after[0].status, 'approved')
  assert.notEqual(after[0].confirmed_date, null)
  server.close()
})

test('GET / returns pending bookings with their approve/suggest-time tokens', async () => {
  const server = await startServer()
  const { rows: [rep] } = await db.query(`SELECT id, email FROM users WHERE email='james@aimdentallab.com'`)
  const token = authedToken({ id: rep.id, email: rep.email, role: 'sales_rep' })
  const { createToken } = require('../../src/services/officeVisitTokens')
  const { rows: [pendingBooking] } = await db.query(
    `INSERT INTO office_visit_bookings (source, contact_name, phone, status) VALUES ('public_form','Pending Co','555-0170','pending') RETURNING id`
  )
  await createToken({ bookingId: pendingBooking.id, action: 'approve' })
  await createToken({ bookingId: pendingBooking.id, action: 'suggest_time' })

  const res = await call(server, 'GET', '/api/office-visits-admin', { token })
  assert.equal(res.status, 200)
  assert.ok(Array.isArray(res.body))
  const pending = res.body.find((b) => b.id === pendingBooking.id)
  assert.ok(pending, 'the pending booking should be in the list')
  assert.ok(pending.approve_token)
  assert.ok(pending.suggest_time_token)
  server.close()
})
