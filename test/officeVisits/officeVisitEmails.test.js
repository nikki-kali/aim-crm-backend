const test = require('node:test')
const assert = require('node:assert/strict')
const {
  repNotificationEmail,
  repSuggestTimeConfirmPage,
  repApproveConfirmPage,
  practiceConfirmationEmail,
  practicePendingEmail,
} = require('../../src/services/officeVisitEmails')

const BOOKING = {
  id: 'b1', practice_name: 'Smile Dental', contact_name: 'Jane <script>alert(1)</script> Doe',
  contact_role: 'Office Manager', address_line1: '123 Main St', city: 'Brooklyn', state: 'NY', zip: '11201',
  email: 'jane@smiledental.com', phone: '555-0100', message: 'Looking forward to it',
  service_interests: ['Crowns & Bridges', 'Implant Restorations'],
  requested_date: '2026-10-15', requested_time: '14:00:00',
}
const REP = { name: 'James Delaney', phone: '555-0199', email: 'james@aimdentallab.com' }

// Real whole-branch review finding (Critical, confirmed): `pg` returns a
// Postgres `date` column as a JS Date object (constructed from LOCAL date
// components), not a string — every booking fetched from the real
// database hits this, not just this synthetic test fixture using a plain
// string. A real `db.query` row's requested_date looks like this, not
// like BOOKING.requested_date above.
const PG_DATE_BOOKING = {
  ...BOOKING,
  requested_date: new Date(2026, 9, 15), // October 15, 2026 via local components, exactly how pg constructs it
  requested_time: '14:00:00',
}

test('repNotificationEmail formats a real pg Date object correctly, not "Invalid Date"', () => {
  const { html } = repNotificationEmail({ booking: PG_DATE_BOOKING, approveUrl: 'https://x/a', suggestTimeConfirmUrl: 'https://x/s' })
  assert.doesNotMatch(html, /Invalid Date/)
  assert.match(html, /October 15, 2026/)
})

test('practiceConfirmationEmail formats a real pg Date object correctly, not "Invalid Date"', () => {
  const { html, subject } = practiceConfirmationEmail({ booking: PG_DATE_BOOKING, rep: REP })
  assert.doesNotMatch(html, /Invalid Date/)
  assert.doesNotMatch(subject, /Invalid Date/)
  assert.match(html, /October 15, 2026/)
})

test('repNotificationEmail HTML-escapes the contact name (XSS)', () => {
  const { html } = repNotificationEmail({ booking: BOOKING, approveUrl: 'https://x/a', suggestTimeConfirmUrl: 'https://x/s' })
  assert.doesNotMatch(html, /<script>alert\(1\)<\/script>/)
  assert.match(html, /&lt;script&gt;/)
})

test('repNotificationEmail includes both action links and the service interests', () => {
  const { html } = repNotificationEmail({ booking: BOOKING, approveUrl: 'https://x/approve', suggestTimeConfirmUrl: 'https://x/suggest' })
  assert.match(html, /https:\/\/x\/approve/)
  assert.match(html, /https:\/\/x\/suggest/)
  assert.match(html, /Crowns &amp; Bridges/)
  assert.match(html, /Implant Restorations/)
})

test('repSuggestTimeConfirmPage includes a tel: click-to-call button for the practice phone', () => {
  const html = repSuggestTimeConfirmPage({ booking: BOOKING, confirmUrl: 'https://x/confirm' })
  assert.match(html, /tel:555-0100/)
})

test('repApproveConfirmPage does not need a click-to-call button (it is a real confirm action, not a reach-out prompt)', () => {
  const html = repApproveConfirmPage({ booking: BOOKING, confirmUrl: 'https://x/confirm' })
  assert.match(html, /Smile Dental/)
})

test('practiceConfirmationEmail shows the rep name, phone, and a summary of what was submitted', () => {
  const { html } = practiceConfirmationEmail({ booking: BOOKING, rep: REP })
  assert.match(html, /James Delaney/)
  assert.match(html, /555-0199/)
  assert.match(html, /Crowns &amp; Bridges/)
  assert.match(html, /Looking forward to it/)
})

test('practicePendingEmail has NO click-to-call button (the practice already has its own number)', () => {
  const { html } = practicePendingEmail({ booking: BOOKING, rep: REP })
  assert.doesNotMatch(html, /tel:/)
  assert.match(html, /pending/i)
})
