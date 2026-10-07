const test = require('node:test')
const assert = require('node:assert/strict')
const { CRITICAL_EVIDENT_EMAILS, assessEviSmart, checkEvidentEmails, buildMissingEmailsAlert } = require('../../src/services/evidentReport/emailCheck')

const RUN = '2026-10-06' // Tuesday
const EVENING = Date.UTC(2026, 9, 6, 23, 30) // 7:30 PM ET on the run day
const MORNING = Date.UTC(2026, 9, 6, 12, 14) // 8:14 AM ET: the early pull the report ignores
const subj = (d = '6 October 2026') => `EviSmart Daily Sales Report - ${d}`
const em = (over = {}) => ({ subject: subj(), sender: 'media@aimdentallab.com', internalDate: EVENING, ...over })
const ALL_EVIDENT = CRITICAL_EVIDENT_EMAILS.map((s) => ({ subject: s, date: RUN }))

test('an evening email from an accepted sender is ok', () => {
  assert.equal(assessEviSmart([em()], RUN).status, 'ok')
  assert.equal(assessEviSmart([em({ sender: 'VA Learning Center <valearningcenterphilippines@gmail.com>' })], RUN).status, 'ok')
})

test('no EviSmart email for the day is reported as not yet arrived', () => {
  assert.equal(assessEviSmart([], RUN).status, 'missing')
  assert.equal(assessEviSmart([em({ subject: subj('5 October 2026') })], RUN).status, 'missing')
})

test('an email from an address the automation does not accept is named, not ignored silently', () => {
  const r = assessEviSmart([em({ sender: 'Akie <akielimjoco@gmail.com>' })], RUN)
  assert.equal(r.status, 'wrong_sender')
  assert.deepEqual(r.senders, ['akielimjoco@gmail.com'])
})

test('an early-day pull alone is reported, because the report ignores it', () => {
  assert.equal(assessEviSmart([em({ internalDate: MORNING })], RUN).status, 'too_early')
})

test('one good email is enough even when others are early or from elsewhere', () => {
  assert.equal(assessEviSmart([em({ internalDate: MORNING }), em({ sender: 'x@y.com' }), em()], RUN).status, 'ok')
})

test('a wrong sender fails the check even when every Evident email arrived', async () => {
  const out = await checkEvidentEmails({ fetchEmails: async () => ALL_EVIDENT, fetchEviSmart: async () => [em({ sender: 'x@y.com' })], runDate: RUN })
  assert.equal(out.ok, false)
  assert.deepEqual(out.missing, [])
  assert.equal(out.eviSmart.status, 'wrong_sender')
})

test('EviSmart simply not here yet does NOT fail the 5:30 AM check (it normally arrives 5:30 to 7:00)', async () => {
  const out = await checkEvidentEmails({ fetchEmails: async () => ALL_EVIDENT, fetchEviSmart: async () => [], runDate: RUN })
  assert.equal(out.ok, true)
  assert.equal(out.eviSmart.status, 'missing')
})

test('without an EviSmart fetcher the result is unchanged', async () => {
  const out = await checkEvidentEmails({ fetchEmails: async () => ALL_EVIDENT, runDate: RUN })
  assert.equal(out.ok, true)
  assert.equal(out.eviSmart, undefined)
})

test('the alert names the unaccepted sender and says how to fix it, with no undefined or dashes', () => {
  const a = buildMissingEmailsAlert({ ok: false, runDate: RUN, missing: [], present: CRITICAL_EVIDENT_EMAILS, eviSmart: { status: 'wrong_sender', senders: ['akielimjoco@gmail.com'] } })
  assert.match(a.subject, /EviSmart/)
  assert.match(a.html, /akielimjoco@gmail\.com/)
  assert.doesNotMatch(a.subject + a.html, /undefined|NaN|—|–/)
})

test('an alert with both Evident and sender problems lists both', () => {
  const a = buildMissingEmailsAlert({ ok: false, runDate: RUN, missing: ['MTD Booked Daily Update'], present: [], eviSmart: { status: 'wrong_sender', senders: ['x@y.com'] } })
  assert.match(a.html, /MTD Booked Daily Update/)
  assert.match(a.html, /x@y\.com/)
})
