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
const { createToken } = require('../../src/services/officeVisitTokens')

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

// Whole-branch review finding (I7): these tests previously left every
// synthetic booking/token row behind in the only database this project
// has. Standing project rule: no staging DB exists, so a test must clean
// up exactly what it created.
async function cleanupBooking(bookingId) {
  if (!bookingId) return
  // Flip off 'pending' FIRST — GET /'s lazy token-reissue (I2) runs
  // concurrently against this same real database from a different test
  // file (node:test's default), and can race between the two deletes
  // below, inserting a fresh token right after we've cleared them.
  await db.query(`UPDATE office_visit_bookings SET status='declined' WHERE id = $1`, [bookingId])
  await db.query(`DELETE FROM office_visit_tokens WHERE booking_id = $1`, [bookingId])
  await db.query(`DELETE FROM office_visit_bookings WHERE id = $1`, [bookingId])
}

test('GET / requires auth', async () => {
  const server = await startServer()
  try {
    const res = await call(server, 'GET', '/api/office-visits-admin')
    assert.equal(res.status, 401)
  } finally {
    server.close()
  }
})

test('POST / (rep-scheduled) creates an approved booking with no email and skips sending', async () => {
  const server = await startServer()
  let bookingId
  try {
    const { rows: [rep] } = await db.query(`SELECT id, email FROM users WHERE email='james@aimdentallab.com'`)
    const token = authedToken({ id: rep.id, email: rep.email, role: 'sales_rep' })
    const res = await call(server, 'POST', '/api/office-visits-admin', {
      token,
      body: { contact_name: 'Walk-in Practice', phone: '555-0150', requested_date: '2026-10-20', requested_time: '10:00' },
    })
    bookingId = res.body.id
    assert.equal(res.status, 201)
    const { rows } = await db.query(`SELECT * FROM office_visit_bookings WHERE id = $1`, [bookingId])
    assert.equal(rows[0].source, 'rep_scheduled')
    assert.equal(rows[0].status, 'approved')
    assert.equal(rows[0].assigned_rep_id, rep.id)
  } finally {
    server.close()
    await cleanupBooking(bookingId)
  }
})

test('POST / (rep-scheduled) with an email sends a confirmation', async () => {
  const server = await startServer()
  let bookingId
  try {
    const { rows: [rep] } = await db.query(`SELECT id, email FROM users WHERE email='williama@aimdentallab.com'`)
    const token = authedToken({ id: rep.id, email: rep.email, role: 'sales_rep' })
    const before = sentEmails.length
    const res = await call(server, 'POST', '/api/office-visits-admin', {
      token,
      body: { contact_name: 'Has Email Practice', phone: '555-0160', email: 'office@example.com', requested_date: '2026-10-21', requested_time: '11:00' },
    })
    bookingId = res.body.id
    assert.equal(res.status, 201)
    assert.equal(sentEmails.length, before + 1)
  } finally {
    server.close()
    await cleanupBooking(bookingId)
  }
})

test('PUT /:id/reschedule sets a confirmed date/time and status approved', async () => {
  const server = await startServer()
  let bookingId
  try {
    const { rows: [rep] } = await db.query(`SELECT id, email FROM users WHERE email='james@aimdentallab.com'`)
    const { rows: [booking] } = await db.query(
      `INSERT INTO office_visit_bookings (source, contact_name, phone, email, status, assigned_rep_id)
       VALUES ('public_form','Jane','555-0100','jane@example.com','time_suggested',$1) RETURNING id`,
      [rep.id]
    )
    bookingId = booking.id
    const token = authedToken({ id: rep.id, email: rep.email, role: 'sales_rep' })
    const res = await call(server, 'PUT', `/api/office-visits-admin/${bookingId}/reschedule`, {
      token, body: { confirmed_date: '2026-10-22', confirmed_time: '15:00' },
    })
    assert.equal(res.status, 200)
    const { rows: after } = await db.query(`SELECT status, confirmed_date FROM office_visit_bookings WHERE id = $1`, [bookingId])
    assert.equal(after[0].status, 'approved')
    assert.notEqual(after[0].confirmed_date, null)
  } finally {
    server.close()
    await cleanupBooking(bookingId)
  }
})

test('GET / returns pending bookings with their approve/suggest-time tokens', async () => {
  const server = await startServer()
  let bookingId
  try {
    const { rows: [rep] } = await db.query(`SELECT id, email FROM users WHERE email='james@aimdentallab.com'`)
    const token = authedToken({ id: rep.id, email: rep.email, role: 'sales_rep' })
    const { rows: [pendingBooking] } = await db.query(
      `INSERT INTO office_visit_bookings (source, contact_name, phone, status, assigned_rep_id) VALUES ('public_form','Pending Co','555-0170','pending',$1) RETURNING id`,
      [rep.id]
    )
    bookingId = pendingBooking.id
    await createToken({ bookingId, action: 'approve' })
    await createToken({ bookingId, action: 'suggest_time' })

    const res = await call(server, 'GET', '/api/office-visits-admin', { token })
    assert.equal(res.status, 200)
    assert.ok(Array.isArray(res.body))
    const pending = res.body.find((b) => b.id === bookingId)
    assert.ok(pending, 'the pending booking should be in the list')
    assert.ok(pending.approve_token)
    assert.ok(pending.suggest_time_token)
  } finally {
    server.close()
    await cleanupBooking(bookingId)
  }
})

test('GET / re-issues tokens for a pending booking whose original tokens expired (I2)', async () => {
  const server = await startServer()
  let bookingId
  try {
    const { rows: [james] } = await db.query(`SELECT id, email FROM users WHERE email='james@aimdentallab.com'`)
    const { rows: [booking] } = await db.query(
      `INSERT INTO office_visit_bookings (source, contact_name, phone, status, assigned_rep_id) VALUES ('public_form','Old Pending','555-0171','pending',$1) RETURNING id`,
      [james.id]
    )
    bookingId = booking.id
    // Simulate a token that expired 7+ days ago — same shape createToken
    // produces, just already-expired, instead of waiting a real week.
    await db.query(
      `INSERT INTO office_visit_tokens (token, booking_id, action, expires_at) VALUES ('expired-approve-token',$1,'approve',NOW() - interval '1 day')`,
      [bookingId]
    )

    const token = authedToken({ id: james.id, email: james.email, role: 'sales_rep' })
    const res = await call(server, 'GET', '/api/office-visits-admin', { token })
    const pending = res.body.find((b) => b.id === bookingId)
    assert.ok(pending.approve_token, 'a fresh approve_token must be issued')
    assert.notEqual(pending.approve_token, 'expired-approve-token', 'must be a NEW token, not the dead one')
    assert.ok(pending.suggest_time_token, 'a fresh suggest_time_token must be issued too')
  } finally {
    server.close()
    await cleanupBooking(bookingId)
  }
})

// --- Role scoping (whole-branch review finding I5) ---

test('a scoped rep (staff/sales_rep) does NOT see another rep\'s assigned booking in GET /', async () => {
  const server = await startServer()
  let bookingId
  try {
    const { rows: [james] } = await db.query(`SELECT id, email FROM users WHERE email='james@aimdentallab.com'`)
    const { rows: [william] } = await db.query(`SELECT id, email FROM users WHERE email='williama@aimdentallab.com'`)
    const { rows: [booking] } = await db.query(
      `INSERT INTO office_visit_bookings (source, contact_name, phone, status, assigned_rep_id) VALUES ('public_form','Williams Only','555-0180','pending',$1) RETURNING id`,
      [william.id]
    )
    bookingId = booking.id

    const jamesToken = authedToken({ id: james.id, email: james.email, role: 'sales_rep' })
    const res = await call(server, 'GET', '/api/office-visits-admin', { token: jamesToken })
    assert.equal(res.status, 200)
    assert.ok(!res.body.some((b) => b.id === bookingId), "James must not see William's booking")

    const williamToken = authedToken({ id: william.id, email: william.email, role: 'sales_rep' })
    const williamRes = await call(server, 'GET', '/api/office-visits-admin', { token: williamToken })
    assert.ok(williamRes.body.some((b) => b.id === bookingId), 'William must see his own booking')
  } finally {
    server.close()
    await cleanupBooking(bookingId)
  }
})

test('a scoped rep DOES see an unassigned booking in GET / (so it can still be picked up)', async () => {
  const server = await startServer()
  let bookingId
  try {
    const { rows: [james] } = await db.query(`SELECT id, email FROM users WHERE email='james@aimdentallab.com'`)
    const { rows: [booking] } = await db.query(
      `INSERT INTO office_visit_bookings (source, contact_name, phone, status) VALUES ('public_form','Unassigned Co','555-0190','pending') RETURNING id`
    )
    bookingId = booking.id
    const token = authedToken({ id: james.id, email: james.email, role: 'sales_rep' })
    const res = await call(server, 'GET', '/api/office-visits-admin', { token })
    assert.ok(res.body.some((b) => b.id === bookingId), 'an unassigned booking must stay visible to every scoped rep')
  } finally {
    server.close()
    await cleanupBooking(bookingId)
  }
})

test('an admin sees every booking in GET /, including other reps\' assigned ones', async () => {
  const server = await startServer()
  let bookingId
  try {
    const { rows: [william] } = await db.query(`SELECT id FROM users WHERE email='williama@aimdentallab.com'`)
    const { rows: [admin] } = await db.query(`SELECT id, email FROM users WHERE role='admin' LIMIT 1`)
    const { rows: [booking] } = await db.query(
      `INSERT INTO office_visit_bookings (source, contact_name, phone, status, assigned_rep_id) VALUES ('public_form','Admin Visible','555-0195','pending',$1) RETURNING id`,
      [william.id]
    )
    bookingId = booking.id
    const token = authedToken({ id: admin.id, email: admin.email, role: 'admin' })
    const res = await call(server, 'GET', '/api/office-visits-admin', { token })
    assert.ok(res.body.some((b) => b.id === bookingId), 'an admin must see every booking regardless of assignment')
  } finally {
    server.close()
    await cleanupBooking(bookingId)
  }
})

test('a scoped rep gets 403 rescheduling another rep\'s booking', async () => {
  const server = await startServer()
  let bookingId
  try {
    const { rows: [james] } = await db.query(`SELECT id, email FROM users WHERE email='james@aimdentallab.com'`)
    const { rows: [william] } = await db.query(`SELECT id FROM users WHERE email='williama@aimdentallab.com'`)
    const { rows: [booking] } = await db.query(
      `INSERT INTO office_visit_bookings (source, contact_name, phone, status, assigned_rep_id) VALUES ('public_form','Williams Booking','555-0177','time_suggested',$1) RETURNING id`,
      [william.id]
    )
    bookingId = booking.id
    const jamesToken = authedToken({ id: james.id, email: james.email, role: 'sales_rep' })
    const res = await call(server, 'PUT', `/api/office-visits-admin/${bookingId}/reschedule`, {
      token: jamesToken, body: { confirmed_date: '2026-10-22', confirmed_time: '15:00' },
    })
    assert.equal(res.status, 403)
    const { rows: after } = await db.query(`SELECT status FROM office_visit_bookings WHERE id = $1`, [bookingId])
    assert.equal(after[0].status, 'time_suggested', 'the booking must not have changed')
  } finally {
    server.close()
    await cleanupBooking(bookingId)
  }
})
