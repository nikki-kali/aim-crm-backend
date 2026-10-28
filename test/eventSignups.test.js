const test = require('node:test')
const assert = require('node:assert')
process.env.EVENT_SIGNUP_SECRET = 'test-secret'
const { validateSignup, confirmationCode, buildNotes } = require('../src/routes/eventSignups')
const { scoreFromLead } = require('../src/services/scoring')

const good = { event: 'gnydm-2026', name: ' Dr. Jane Smith ', practice: 'Smith Family Dental', email: 'Jane@Example.com', phone: '718-555-0100', interest: 'Implant', consent: true }

test('validateSignup accepts a complete sign-up and normalizes it', () => {
  const { data, error } = validateSignup(good)
  assert.strictEqual(error, undefined)
  assert.strictEqual(data.name, 'Dr. Jane Smith')
  assert.strictEqual(data.email, 'jane@example.com')
  assert.strictEqual(data.event.source, 'GNYDM 2026')
  assert.strictEqual(data.consent, true)
})

test('validateSignup rejects unknown events and missing fields', () => {
  assert.ok(validateSignup({ ...good, event: 'other-show' }).error)
  assert.ok(validateSignup({ ...good, name: '  ' }).error)
  assert.ok(validateSignup({ ...good, practice: '' }).error)
  assert.ok(validateSignup({ ...good, email: 'not-an-email' }).error)
})

test('validateSignup drops interests outside the list and treats consent strictly', () => {
  const { data } = validateSignup({ ...good, interest: '<script>', consent: 'yes' })
  assert.strictEqual(data.interest, '')
  assert.strictEqual(data.consent, false)
})

test('validateSignup ignores inherited keys and strips HTML characters', () => {
  for (const event of ['constructor', '__proto__', 'toString', 'hasOwnProperty']) assert.ok(validateSignup({ ...good, event }).error, event)
  const { data } = validateSignup({ ...good, name: '<img src=x onerror=alert(1)>Jane', practice: 'A & B "Dental"' })
  assert.ok(!/[<>&"']/.test(data.name + data.practice))
  assert.ok(validateSignup({ ...good, phone: '<b>call</b>' }).error)
})

test('confirmationCode depends on the server secret', () => {
  const a = confirmationCode(42)
  process.env.EVENT_SIGNUP_SECRET = 'other-secret'
  const b = confirmationCode(42)
  process.env.EVENT_SIGNUP_SECRET = 'test-secret'
  assert.notStrictEqual(a, b)
})

test('confirmationCode is stable and short', () => {
  assert.strictEqual(confirmationCode(42), confirmationCode(42))
  assert.match(confirmationCode(42), /^AIM-[0-9A-F]{6}$/)
  assert.notStrictEqual(confirmationCode(42), confirmationCode(43))
})

test('buildNotes records how the sign-up came in and the email consent', () => {
  const notes = buildNotes(validateSignup({ ...good, staff: true, consent: false }).data)
  assert.match(notes, /GNYDM 2026 \(entered by AIM staff at the booth\)/)
  assert.match(notes, /not opted in/)
})

test('Trade Show leads score for their source', () => {
  const withSource = scoreFromLead({ lead_source: 'Trade Show', intent_level: 'Medium' })
  const without = scoreFromLead({ lead_source: '', intent_level: 'Medium' })
  assert.strictEqual(withSource - without, 15)
  assert.strictEqual(scoreFromLead({ lead_source: 'trade show' }), scoreFromLead({ lead_source: 'Trade Show' }))
})
