// HTTP-level tests for /api/event-signups with the database stubbed out, so
// no real leads are written.
const test = require('node:test')
const assert = require('node:assert')
const path = require('path')
const express = require('express')

const dbPath = path.join(__dirname, '../src/config/db.js')
const leads = []
require.cache[require.resolve(dbPath)] = {
  id: dbPath, filename: dbPath, loaded: true,
  exports: {
    query: async (sql, params) => {
      if (sql.startsWith('SELECT')) {
        const hit = leads.find((l) => l.email === params[0] && l.referral_source === params[1])
        return { rows: hit ? [{ id: hit.id }] : [] }
      }
      const id = leads.length + 1
      leads.push({ id, email: params[3], referral_source: params[4], notes: params[6], lead_source: 'Trade Show' })
      return { rows: [{ id }] }
    },
  },
}
const route = require('../src/routes/eventSignups')

function start() {
  const app = express()
  app.set('trust proxy', 1)
  app.use('/api/event-signups', route)
  return new Promise((resolve) => { const s = app.listen(0, () => resolve(s)) })
}
const body = { event: 'gnydm-2026', name: 'Dr. Test', practice: 'Test Dental', email: 'test@example.com', consent: true }
const post = (base, b, ip) => fetch(base, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://aimdentallab.com', ...(ip ? { 'X-Forwarded-For': ip } : {}) }, body: JSON.stringify(b) })

test('event sign-up route: create, duplicate, validation, honeypot, CORS, booth-volume limit', async () => {
  const server = await start()
  const base = `http://127.0.0.1:${server.address().port}/api/event-signups`
  try {
    const r1 = await post(base, body); const d1 = await r1.json()
    assert.strictEqual(r1.status, 200); assert.strictEqual(d1.duplicate, false); assert.match(d1.code, /^AIM-[0-9A-F]{4}$/)
    assert.strictEqual(r1.headers.get('access-control-allow-origin'), '*')
    assert.match(leads[0].notes, /GNYDM 2026 \(booth QR code\)/)

    const r2 = await post(base, { ...body, email: 'TEST@example.com' }); const d2 = await r2.json()
    assert.strictEqual(d2.duplicate, true); assert.strictEqual(d2.code, d1.code); assert.strictEqual(leads.length, 1)

    const r3 = await post(base, { ...body, email: 'bad' })
    assert.strictEqual(r3.status, 400); assert.match((await r3.json()).error, /valid email/)

    const r4 = await post(base, { ...body, event: 'nope' }); assert.strictEqual(r4.status, 400)

    const r5 = await post(base, { ...body, email: 'bot@example.com', company: 'x' })
    assert.strictEqual(r5.status, 200); assert.strictEqual(leads.length, 1)

    // 40 sign-ups from one shared IP (booth Wi-Fi) must all succeed.
    for (let i = 0; i < 40; i++) {
      const r = await post(base, { ...body, email: `doc${i}@example.com` }, '10.9.9.9')
      assert.strictEqual(r.status, 200, `sign-up ${i} from shared IP`)
    }
    assert.strictEqual(leads.length, 41)

    const pre = await fetch(base, { method: 'OPTIONS', headers: { Origin: 'https://aimdentallab.com', 'Access-Control-Request-Method': 'POST' } })
    assert.ok(pre.status === 204 || pre.status === 200)
  } finally { server.closeAllConnections(); server.close() }
})
