const test = require('node:test')
const assert = require('node:assert/strict')
const {
  evidentRefFromInput, contactMatches, phoneKey, pageDate, evidentTrackingView, EVIDENT_STAGES,
} = require('../src/services/caseTracking')

test('the Evident number is accepted the way doctors write it', () => {
  for (const v of ['10150', ' 10150 ', '#10150', 'EVD-10150', 'evd 10150', 'Evd10150']) {
    assert.equal(evidentRefFromInput(v), '10150', v)
  }
  for (const v of ['AIM-2026-014', '10150a', '12', '', null, '1015012345']) {
    assert.equal(evidentRefFromInput(v), null, String(v))
  }
})

test('contact check: email exact (any case), phone on its last 10 digits', () => {
  const onFile = { emails: [null, 'Front@Practice.com'], phones: ['(718) 854-3900', null] }
  assert.equal(contactMatches('front@practice.com', onFile), true)
  assert.equal(contactMatches(' FRONT@PRACTICE.COM ', onFile), true)
  assert.equal(contactMatches('other@practice.com', onFile), false)
  assert.equal(contactMatches('+1 718-854-3900', onFile), true)
  assert.equal(contactMatches('7188543900', onFile), true)
  assert.equal(contactMatches('7188543901', onFile), false)
  assert.equal(contactMatches('3900', onFile), false)
  assert.equal(contactMatches('', onFile), false)
  assert.equal(contactMatches('front@practice.com', { emails: [], phones: [] }), false)
  assert.equal(phoneKey('12'), null)
})

test('dates go to the page as local noon so they show the right day', () => {
  assert.equal(pageDate('2026-12-09'), '2026-12-09T12:00:00')
  assert.equal(pageDate(new Date(2026, 11, 9)), '2026-12-09T12:00:00')
  assert.equal(pageDate(null), null)
  assert.equal(pageDate('nonsense'), null)
})

const base = {
  evident_case_number: '10060', status: 'In Production', evident_status: 'Arrived',
  booked_on: '2026-11-25', arrived_on: '2026-11-25', ship_date: '2026-12-09',
}

test('an open case shows In Production, its dates and the planned ship date', () => {
  const v = evidentTrackingView(base, [], '2026-11-28')
  assert.equal(v.caseNumber, '10060')
  assert.equal(v.status, 'In Production')
  assert.deepEqual(v.stages, EVIDENT_STAGES)
  assert.equal(v.dueDate, null)
  assert.equal(v.estCompletionDate, '2026-12-09T12:00:00')
  assert.equal(v.onHold, false)
  assert.deepEqual(v.history, [
    { stage: 'Case Received', changedAt: '2026-11-25T12:00:00' },
    { stage: 'In Production', changedAt: '2026-11-25T12:00:00' },
  ])
  assert.equal(v.pickup, null)
  for (const k of ['patient', 'value', 'client_name', 'doctor_email', 'doctor_phone']) assert.equal(k in v, false)
})

test('a planned date already past is not shown', () => {
  assert.equal(evidentTrackingView(base, [], '2026-12-10').estCompletionDate, null)
})

test('Held shows as In Production with the hold flag', () => {
  const v = evidentTrackingView({ ...base, evident_status: 'Held' }, [], '2026-11-28')
  assert.equal(v.status, 'In Production')
  assert.equal(v.onHold, true)
})

test('a sent case shows Shipped on its ship date and no estimate', () => {
  const v = evidentTrackingView({ ...base, evident_status: 'Sent', status: 'Completed', ship_date: '2026-12-04' },
    [{ to_status: 'Complete', status_date: '2026-12-03' }, { to_status: 'Sent', status_date: '2026-12-04' }], '2026-12-05')
  assert.equal(v.status, 'Shipped')
  assert.equal(v.estCompletionDate, null)
  assert.deepEqual(v.history.map((h) => [h.stage, h.changedAt.slice(0, 10)]), [
    ['Case Received', '2026-11-25'], ['In Production', '2026-11-25'], ['Ready to Ship', '2026-12-03'], ['Shipped', '2026-12-04'],
  ])
})

test('a case back in production does not keep a later step', () => {
  const v = evidentTrackingView(base, [{ to_status: 'Complete', status_date: '2026-12-03' }, { to_status: 'Arrived', status_date: '2026-12-04' }], '2026-12-05')
  assert.equal(v.status, 'In Production')
  assert.deepEqual(v.history.map((h) => h.stage), ['Case Received', 'In Production'])
  assert.equal(v.history[1].changedAt, '2026-12-04T12:00:00')
})

test('cancelled and closed cases tick no steps and show no estimate', () => {
  for (const s of ['Cancelled', 'Closed']) {
    const v = evidentTrackingView({ ...base, evident_status: s }, [], '2026-11-28')
    assert.equal(v.status, s)
    assert.deepEqual(v.history, [])
    assert.equal(v.estCompletionDate, null)
  }
})

test('an Evident case with no Evident status yet falls back to the CRM status', () => {
  const v = evidentTrackingView({ ...base, evident_status: null }, [], '2026-11-28')
  assert.equal(v.status, 'In Production')
})
