// Tests for /api/event-redemptions. The database, email and Google Sheets
// services are stubbed, so no real leads, emails or sheet rows are created.
const test = require('node:test')
const assert = require('node:assert')
const path = require('path')
const express = require('express')

// ---------- stubs ----------
const state = { redemptions: [], leads: [], clients: [], clinics: [], emails: [], sheetRows: [] }
function stub(rel, exports) {
  const p = path.join(__dirname, rel)
  require.cache[require.resolve(p)] = { id: p, filename: p, loaded: true, exports }
}
async function query(sql, params = []) {
  const s = sql.replace(/\s+/g, ' ').trim()
  if (/^(BEGIN|COMMIT|ROLLBACK)/.test(s) || s.includes('pg_advisory_xact_lock')) return { rows: [] }
  if (s.startsWith('SELECT email_norm')) {
    const [, e, p, pr, a] = params
    return { rows: state.redemptions.filter((r) => r.event_key === params[0] && (r.email_norm === e || r.phone_norm === p || r.practice_norm === pr || r.address_norm === a)).slice(0, 1) }
  }
  if (s.startsWith('SELECT count(*)')) return { rows: [{ n: state.redemptions.filter((r) => r.event_key === params[0]).length }] }
  if (s.startsWith('SELECT clinic_name')) {
    const [e, p, compact] = params
    return { rows: state.clients.filter((c) => c.email === e || c.phone === p || c.clinic_name.toLowerCase().replace(/[^a-z0-9]/g, '') === compact) }
  }
  if (s.startsWith('SELECT name FROM clinics')) return { rows: state.clinics.filter((c) => c.email === params[0]) }
  if (s.startsWith('SELECT id FROM leads')) return { rows: state.leads.filter((l) => l.email === params[0]).map((l) => ({ id: l.id })) }
  if (s.startsWith('UPDATE leads')) return { rows: [] }
  if (s.startsWith('INSERT INTO leads')) { const id = `lead-${state.leads.length + 1}`; state.leads.push({ id, email: params[3] }); return { rows: [{ id }] } }
  if (s.startsWith('INSERT INTO event_redemptions')) {
    const row = { id: `r-${state.redemptions.length + 1}`, event_key: params[0], prize: params[1], doctor_name: params[2], practice_name: params[3],
      email: params[4], phone: params[5], street: params[6], city: params[7], state: params[8], zip: params[9], scanner: params[10],
      case_interest: params[11], marketing_consent: params[12], email_norm: params[13], phone_norm: params[14], practice_norm: params[15],
      address_norm: params[16], status: params[17], review_reason: params[18], attribution: params[20],
      created_at: new Date(Date.UTC(2026, 11, 1, 12, 0, state.redemptions.length)).toISOString() }
    state.redemptions.push(row)
    return { rows: [row] }
  }
  if (s.startsWith('SELECT * FROM event_redemptions')) {
    const after = params[1] ? `${params[1]}|${params[2]}` : ''
    return { rows: state.redemptions.filter((r) => params[0].includes(r.event_key) && `${r.created_at}|${r.id}` > after) }
  }
  throw new Error(`unexpected query: ${s.slice(0, 60)}`)
}
stub('../src/config/db.js', { query, connect: async () => ({ query, release() {} }) })
stub('../src/services/email.js', { sendEmail: async (m) => { state.emails.push(m) } })
stub('../src/services/sheets.js', { appendLogRow: async (r) => { state.sheetRows.push(r.row); return true } })

const route = require('../src/routes/eventRedemptions')
const { validateRedemption, eventSettings, normPhone, normPractice, normAddress, teamEmail } = route

const good = {
  event: 'gnydm-2026', name: 'Dr. Jane Smith', practice: 'Smith Family Dental, PC', email: 'Jane@Example.com',
  phone: '+1 (718) 555-0100', street: '12 Court Street, Suite 3', city: 'Brooklyn', state: 'ny', zip: '11201',
  scanner: 'iTero', interest: 'Implant', consent: true, terms: true,
}

// ---------- pure functions ----------
test('normalizers make equivalent details match and different practices differ', () => {
  assert.strictEqual(normPhone('+1 (718) 555-0100'), '7185550100')
  assert.strictEqual(normPractice('The Smith Family Dental, PC'), normPractice('smith family dental'))
  assert.notStrictEqual(normPractice('Brooklyn Dental'), normPractice('Brooklyn Dental Care'))
  assert.strictEqual(normAddress('12 Court Street, Suite 3', '11201'), normAddress('12 court st ste 3', '11201-1234'))
  assert.notStrictEqual(normAddress('12 Court St Ste 3', '11201'), normAddress('12 Court St Ste 4', '11201'))
})

test('validateRedemption requires every registration field and the terms box', () => {
  const { data, error } = validateRedemption(good)
  assert.strictEqual(error, undefined)
  assert.strictEqual(data.email, 'jane@example.com')
  assert.strictEqual(data.state, 'NY')
  for (const k of ['name', 'practice', 'email', 'phone', 'street', 'city', 'state', 'zip']) {
    assert.ok(validateRedemption({ ...good, [k]: '' }).error, `${k} should be required`)
  }
  assert.ok(validateRedemption({ ...good, terms: 'yes' }).error)
  assert.ok(validateRedemption({ ...good, phone: '555-0100' }).error)
  assert.ok(validateRedemption({ ...good, event: 'constructor' }).error)
  assert.strictEqual(validateRedemption({ ...good, scanner: '<b>' }).data.scanner, '')
})

test('eventSettings stays closed until switched on with a prize and limit, and closes after the deadline', () => {
  const ev = route.EVENTS['gnydm-2026']
  assert.strictEqual(eventSettings(ev, {}).open, false)
  assert.strictEqual(eventSettings(ev, { GNYDM_2026_REDEMPTIONS_OPEN: 'true', GNYDM_2026_PRIZE: 'X' }).open, false)
  const on = { GNYDM_2026_REDEMPTIONS_OPEN: 'true', GNYDM_2026_PRIZE: '30% off your first case', GNYDM_2026_REDEMPTION_LIMIT: '2' }
  assert.strictEqual(eventSettings(ev, on, new Date('2026-12-01T12:00:00Z')).open, true)
  assert.strictEqual(eventSettings(ev, on, new Date('2026-12-16T06:00:00Z')).reason, 'closed')
})

test('team email subject reads "Registered New Practice won: <prize>"', () => {
  const { data } = validateRedemption(good)
  const e = teamEmail(data, { prize: '30% off your first case', limit: 50 }, { status: 'verified', count: 1 })
  assert.strictEqual(e.subject, 'Registered New Practice won: 30% off your first case (Smith Family Dental, PC)')
  assert.ok(!e.html.includes('<script'))
})

// ---------- HTTP flow ----------
function start() {
  const app = express()
  app.set('trust proxy', 1)
  app.use('/api/event-redemptions', route)
  return new Promise((resolve) => { const s = app.listen(0, () => resolve(s)) })
}
const post = (base, b) => fetch(base, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) })

test('redemption route: closed, register, duplicates, existing client review, cap', async () => {
  const server = await start()
  const base = `http://127.0.0.1:${server.address().port}/api/event-redemptions`
  try {
    // switched off: nothing is saved
    delete process.env.GNYDM_2026_REDEMPTIONS_OPEN
    let r = await post(base, good)
    assert.strictEqual(r.status, 503)
    assert.strictEqual(state.redemptions.length, 0)

    process.env.GNYDM_2026_REDEMPTIONS_OPEN = 'true'
    process.env.GNYDM_2026_PRIZE = '30% off your first case'
    process.env.GNYDM_2026_REDEMPTION_LIMIT = '2'

    // a new practice registers: verified, lead created, team + doctor emails, sheet row
    r = await post(base, good)
    let j = await r.json()
    assert.strictEqual(r.status, 200, JSON.stringify(j))
    assert.strictEqual(j.status, 'verified')
    assert.strictEqual(state.leads.length, 1)
    const teamMail = state.emails.find((m) => Array.isArray(m.to) && m.to.includes('james@aimdentallab.com'))
    assert.ok(teamMail, 'team email sent to James')
    assert.deepStrictEqual(teamMail.cc, ['media@aimdentallab.com', 'execassistant@aimdentallab.com', 'ben@aimdentallab.com'])
    assert.ok(teamMail.subject.startsWith('Registered New Practice won: 30% off your first case'))
    assert.ok(state.emails.some((m) => m.to === 'jane@example.com'), 'doctor confirmation sent')
    assert.strictEqual(state.sheetRows.length, 1)

    // same practice again with a different email but the same phone: rejected
    r = await post(base, { ...good, email: 'other@example.com' })
    j = await r.json()
    assert.strictEqual(r.status, 409)
    assert.match(j.error, /phone number/)

    // same address in a different format: rejected
    r = await post(base, { ...good, email: 'x@example.com', phone: '718-555-0199', practice: 'Other Name', street: '12 court st ste 3' })
    assert.strictEqual(r.status, 409)

    // an existing AIM client registers: saved, but flagged for review
    state.clients.push({ email: 'known@clinic.com', phone: '', clinic_name: 'Known Clinic' })
    r = await post(base, { ...good, email: 'known@clinic.com', phone: '212-555-0111', practice: 'Known Clinic', street: '1 Main St', zip: '10001' })
    j = await r.json()
    assert.strictEqual(r.status, 200)
    assert.strictEqual(j.status, 'needs_review')
    assert.ok(state.emails.some((m) => /needs review/.test(m.subject || '')))

    // limit of 2 reached: a third new practice is turned away
    r = await post(base, { ...good, email: 'new@third.com', phone: '646-555-0122', practice: 'Third Practice', street: '9 Elm St', zip: '10002' })
    j = await r.json()
    assert.strictEqual(r.status, 410)
    assert.strictEqual(j.reason, 'full')
    assert.strictEqual(state.redemptions.length, 2)
  } finally {
    server.close()
  }
})

test('export route: secret required, rows returned in sheet order, cursor skips rows already pulled', async () => {
  const server = await start()
  const base = `http://127.0.0.1:${server.address().port}/api/event-redemptions/export?event=gnydm-2026`
  try {
    process.env.GNYDM_2026_REDEMPTIONS_SHEET_SECRET = 'sheet-secret'
    let r = await fetch(base)
    assert.strictEqual(r.status, 401)
    r = await fetch(base, { headers: { 'X-Sheet-Secret': 'wrong' } })
    assert.strictEqual(r.status, 401)
    r = await fetch(base, { headers: { 'X-Sheet-Secret': 'sheet-secret' } })
    const all = await r.json()
    assert.strictEqual(r.status, 200)
    assert.strictEqual(all.header[3], 'Prize won')
    assert.strictEqual(all.rows.length, state.redemptions.length)
    assert.strictEqual(all.rows[0].row[5], 'Smith Family Dental, PC')
    assert.strictEqual(all.rows[0].row[3], '30% off your first case')
    r = await fetch(`${base}&after=${encodeURIComponent(all.rows[0].cursor)}`, { headers: { 'X-Sheet-Secret': 'sheet-secret' } })
    const rest = await r.json()
    assert.strictEqual(rest.rows.length, all.rows.length - 1)
  } finally {
    server.close()
  }
})

test('test mode: no CRM lead, emails only media@ marked [TEST], sheet row labeled TEST - ignore', async () => {
  const server = await start()
  const base = `http://127.0.0.1:${server.address().port}/api/event-redemptions`
  try {
    const leadsBefore = state.leads.length
    const emailsBefore = state.emails.length
    let r = await post(base, { ...good, event: 'gnydm-2026-test' })
    assert.strictEqual(r.status, 503, 'closed until the test flag is on')
    process.env.GNYDM_2026_TEST_REDEMPTIONS_OPEN = 'true'
    r = await post(base, { ...good, event: 'gnydm-2026-test', email: 'media@aimdentallab.com' })
    const j = await r.json()
    assert.strictEqual(r.status, 200, JSON.stringify(j))
    assert.strictEqual(j.prize, 'TEST - not a real offer')
    assert.strictEqual(state.leads.length, leadsBefore, 'no CRM lead in test mode')
    const sent = state.emails.slice(emailsBefore)
    assert.ok(sent.length === 2 && sent.every((m) => /^\[TEST\]/.test(m.subject)))
    const team = sent.find((m) => Array.isArray(m.to))
    assert.deepStrictEqual(team.to, ['media@aimdentallab.com'])
    assert.deepStrictEqual(team.cc, [])
    assert.strictEqual(state.sheetRows.at(-1)[1], 'TEST - ignore')

    // the real event's export includes the test row, labeled
    const ex = await fetch(`${base}/export?event=gnydm-2026`, { headers: { 'X-Sheet-Secret': 'sheet-secret' } })
    const data = await ex.json()
    assert.strictEqual(data.rows.at(-1).row[1], 'TEST - ignore')
  } finally {
    delete process.env.GNYDM_2026_TEST_REDEMPTIONS_OPEN
    server.close()
  }
})
