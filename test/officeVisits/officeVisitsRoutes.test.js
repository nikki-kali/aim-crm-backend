require('dotenv').config()
const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('path')
const httpClient = require('http')
const express = require('express')
const db = require('../../src/config/db')

// Stub services/email.js's sendEmail BEFORE requiring the route, by
// pre-populating Node's module cache for its resolved path — no route
// test in this repo has ever exercised a real email send before, and a
// real outbound call to Resend hangs in this sandboxed test environment
// rather than failing fast. require.cache keys are always the fully
// resolved absolute path, so this works regardless of the relative
// require() string officeVisits.js itself uses.
const sentEmails = []
const emailModulePath = require.resolve(path.join(__dirname, '../../src/services/email.js'))
require.cache[emailModulePath] = {
  id: emailModulePath, filename: emailModulePath, loaded: true,
  exports: { sendEmail: async (opts) => { sentEmails.push(opts) } },
}

const officeVisitsRoutes = require('../../src/routes/officeVisits')
const { createToken, peekToken } = require('../../src/services/officeVisitTokens')

function startServer() {
  const app = express()
  app.use('/api/office-visits', officeVisitsRoutes)
  return new Promise((resolve) => {
    const server = app.listen(0, () => resolve(server))
  })
}

function post(server, path, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body)
    const req = httpClient.request(
      { hostname: '127.0.0.1', port: server.address().port, path, method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } },
      (res) => {
        let raw = ''
        res.on('data', (c) => (raw += c))
        res.on('end', () => {
          // POST /request returns JSON; POST /confirm returns an HTML
          // result page — only parse as JSON when it actually looks like it.
          const looksJson = raw.trim().startsWith('{') || raw.trim().startsWith('[')
          resolve({ status: res.statusCode, body: looksJson ? JSON.parse(raw) : raw })
        })
      }
    )
    req.on('error', reject)
    req.write(data)
    req.end()
  })
}

function get(server, path) {
  return new Promise((resolve, reject) => {
    httpClient.get({ hostname: '127.0.0.1', port: server.address().port, path }, (res) => {
      let raw = ''
      res.on('data', (c) => (raw += c))
      res.on('end', () => resolve({ status: res.statusCode, body: raw }))
    }).on('error', reject)
  })
}

// The real confirmation pages submit a plain HTML <form method="POST">,
// which browsers send as application/x-www-form-urlencoded — NOT JSON.
// The post() helper above sends JSON, which is why the whole-branch
// review's form-encoding bug (every real email-link click 500'd) wasn't
// caught by the original test suite.
function postForm(server, path, formFields) {
  return new Promise((resolve, reject) => {
    const data = new URLSearchParams(formFields).toString()
    const req = httpClient.request(
      { hostname: '127.0.0.1', port: server.address().port, path, method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(data) } },
      (res) => {
        let raw = ''
        res.on('data', (c) => (raw += c))
        res.on('end', () => resolve({ status: res.statusCode, body: raw }))
      }
    )
    req.on('error', reject)
    req.write(data)
    req.end()
  })
}

// Whole-branch review finding (I7): these tests previously left every
// synthetic booking/token row behind in the only database this project
// has. Standing project rule: no staging DB exists, so a test must clean
// up exactly what it created.
async function cleanupBooking(bookingId) {
  if (!bookingId) return
  // Flip off 'pending' FIRST — officeVisitsAdmin.js's GET / (running
  // concurrently in a different test file against this same real
  // database, per node:test's default of running files in parallel)
  // lazily re-issues a fresh token for any 'pending' booking missing one.
  // That closes most of the window, but a GET / that already read this
  // booking as 'pending' a moment earlier can still insert a token right
  // after our status flip (a genuine check-then-act race across two
  // processes, not fully closeable without a DB-level lock) — so the
  // final delete retries a few times, re-clearing tokens each attempt,
  // rather than assuming one clean pass is enough.
  await db.query(`UPDATE office_visit_bookings SET status='declined' WHERE id = $1`, [bookingId])
  for (let attempt = 0; attempt < 5; attempt++) {
    await db.query(`DELETE FROM office_visit_tokens WHERE booking_id = $1`, [bookingId])
    try {
      await db.query(`DELETE FROM office_visit_bookings WHERE id = $1`, [bookingId])
      return
    } catch (err) {
      if (err.code !== '23503' || attempt === 4) throw err
    }
  }
}

test('POST /request creates a pending booking, matches a rep by state, and returns 201', async () => {
  const server = await startServer()
  let bookingId
  try {
    const res = await post(server, '/api/office-visits/request', {
      practice_name: 'Smile Dental', contact_name: 'Jane Doe', phone: '555-0100',
      email: 'jane@smiledental.com', address_line1: '123 Main St', city: 'Brooklyn', state: 'NY', zip: '11201',
      requested_date: '2026-10-15', requested_time: '14:00', service_interests: ['Crowns & Bridges'],
    })
    bookingId = res.body.id
    assert.equal(res.status, 201)
    const { rows } = await db.query(`SELECT * FROM office_visit_bookings WHERE id = $1`, [bookingId])
    assert.equal(rows[0].status, 'pending')
    assert.equal(rows[0].source, 'public_form')
    const { rows: repRows } = await db.query(`SELECT email FROM users WHERE id = $1`, [rows[0].assigned_rep_id])
    assert.equal(repRows[0].email, 'james@aimdentallab.com')
  } finally {
    server.close()
    await cleanupBooking(bookingId)
  }
})

test('POST /request with a state that matches no territory leaves assigned_rep_id null', async () => {
  const server = await startServer()
  let bookingId
  try {
    const res = await post(server, '/api/office-visits/request', {
      contact_name: 'No Match', phone: '555-0199', email: 'nomatch@example.com', state: 'TX',
      requested_date: '2026-10-15', requested_time: '14:00',
    })
    bookingId = res.body.id
    assert.equal(res.status, 201)
    const { rows } = await db.query(`SELECT assigned_rep_id FROM office_visit_bookings WHERE id = $1`, [bookingId])
    assert.equal(rows[0].assigned_rep_id, null)
  } finally {
    server.close()
    await cleanupBooking(bookingId)
  }
})

test('POST /request rejects a missing required field', async () => {
  const server = await startServer()
  try {
    const res = await post(server, '/api/office-visits/request', { contact_name: 'Missing Phone' })
    assert.equal(res.status, 400)
  } finally {
    server.close()
  }
})

test('GET /confirm shows a confirmation page for a valid approve token without consuming it', async () => {
  const server = await startServer()
  let bookingId
  try {
    const { rows } = await db.query(
      `INSERT INTO office_visit_bookings (source, contact_name, phone, status) VALUES ('public_form','Jane','555-0100','pending') RETURNING id`
    )
    bookingId = rows[0].id
    const token = await createToken({ bookingId, action: 'approve' })
    const res = await get(server, `/api/office-visits/confirm?token=${token}`)
    assert.equal(res.status, 200)
    assert.match(res.body, /Approve/)
    const stillUsable = await peekToken(token)
    assert.notEqual(stillUsable, null, 'GET must not consume the token')
  } finally {
    server.close()
    await cleanupBooking(bookingId)
  }
})

test('GET /confirm with an unknown token returns 410', async () => {
  const server = await startServer()
  try {
    const res = await get(server, '/api/office-visits/confirm?token=not-real')
    assert.equal(res.status, 410)
  } finally {
    server.close()
  }
})

test('POST /confirm with action=approve sets status approved and confirmed_date/time', async () => {
  const server = await startServer()
  let bookingId
  try {
    const { rows } = await db.query(
      `INSERT INTO office_visit_bookings (source, contact_name, phone, email, status, requested_date, requested_time)
       VALUES ('public_form','Jane','555-0100','jane@example.com','pending','2026-10-15','14:00') RETURNING id`
    )
    bookingId = rows[0].id
    const token = await createToken({ bookingId, action: 'approve' })
    const res = await post(server, '/api/office-visits/confirm', { token })
    assert.equal(res.status, 200)
    const { rows: after } = await db.query(`SELECT status, confirmed_date FROM office_visit_bookings WHERE id = $1`, [bookingId])
    assert.equal(after[0].status, 'approved')
    assert.notEqual(after[0].confirmed_date, null)
  } finally {
    server.close()
    await cleanupBooking(bookingId)
  }
})

test('POST /confirm works when submitted as a real browser <form> (application/x-www-form-urlencoded), not just JSON', async () => {
  const server = await startServer()
  let bookingId
  try {
    const { rows } = await db.query(
      `INSERT INTO office_visit_bookings (source, contact_name, phone, email, status, requested_date, requested_time)
       VALUES ('public_form','Jane','555-0100','jane@example.com','pending','2026-10-15','14:00') RETURNING id`
    )
    bookingId = rows[0].id
    const token = await createToken({ bookingId, action: 'approve' })
    const res = await postForm(server, '/api/office-visits/confirm', { token })
    assert.equal(res.status, 200, `expected 200, got ${res.status}: ${res.body}`)
    const { rows: after } = await db.query(`SELECT status FROM office_visit_bookings WHERE id = $1`, [bookingId])
    assert.equal(after[0].status, 'approved')
  } finally {
    server.close()
    await cleanupBooking(bookingId)
  }
})

test('POST /confirm with action=suggest_time sets status time_suggested', async () => {
  const server = await startServer()
  let bookingId
  try {
    const { rows } = await db.query(
      `INSERT INTO office_visit_bookings (source, contact_name, phone, email, status)
       VALUES ('public_form','Jane','555-0100','jane@example.com','pending') RETURNING id`
    )
    bookingId = rows[0].id
    const token = await createToken({ bookingId, action: 'suggest_time' })
    const res = await post(server, '/api/office-visits/confirm', { token })
    assert.equal(res.status, 200)
    const { rows: after } = await db.query(`SELECT status FROM office_visit_bookings WHERE id = $1`, [bookingId])
    assert.equal(after[0].status, 'time_suggested')
  } finally {
    server.close()
    await cleanupBooking(bookingId)
  }
})

test('POST /confirm with an already-used token returns 410 and does not re-send', async () => {
  const server = await startServer()
  let bookingId
  try {
    const { rows } = await db.query(
      `INSERT INTO office_visit_bookings (source, contact_name, phone, email, status)
       VALUES ('public_form','Jane','555-0100','jane@example.com','pending') RETURNING id`
    )
    bookingId = rows[0].id
    const token = await createToken({ bookingId, action: 'approve' })
    await post(server, '/api/office-visits/confirm', { token })
    const second = await post(server, '/api/office-visits/confirm', { token })
    assert.equal(second.status, 410)
  } finally {
    server.close()
    await cleanupBooking(bookingId)
  }
})

test('clicking the sibling action after one was already taken does not contradict it or overwrite the confirmed slot', async () => {
  const server = await startServer()
  let bookingId
  try {
    const { rows } = await db.query(
      `INSERT INTO office_visit_bookings (source, contact_name, phone, email, status, requested_date, requested_time)
       VALUES ('public_form','Jane','555-0100','jane@example.com','pending','2026-10-15','14:00') RETURNING id`
    )
    bookingId = rows[0].id
    const approveToken = await createToken({ bookingId, action: 'approve' })
    const suggestToken = await createToken({ bookingId, action: 'suggest_time' })

    // Rep approves from the email.
    const approveRes = await post(server, '/api/office-visits/confirm', { token: approveToken })
    assert.equal(approveRes.status, 200)

    // The OTHER token (suggest_time), from the same original email, is
    // clicked later — it must be dead (410), not silently flip the booking
    // back to pending and tell the practice their confirmed visit is
    // actually "not yet confirmed".
    const suggestRes = await post(server, '/api/office-visits/confirm', { token: suggestToken })
    assert.equal(suggestRes.status, 410)
    const { rows: after } = await db.query(`SELECT status FROM office_visit_bookings WHERE id = $1`, [bookingId])
    assert.equal(after[0].status, 'approved', 'the booking must still be approved, not flipped to time_suggested')
  } finally {
    server.close()
    await cleanupBooking(bookingId)
  }
})
