const test = require('node:test')
const assert = require('node:assert/strict')
const {
  internalRequestEmail, partnerConfirmationEmail, benConfirmationEmail,
  approveConfirmPage, callFirstConfirmPage, resultPage, oneLine,
} = require('../../src/services/partnerMeetingEmails')

const REQUEST = {
  id: 'req-1', partner_name: 'Jane Smith', company: 'Acme Dental', email: 'jane@acme.com', phone: '555-0100',
  timezone: 'America/Los_Angeles', note: 'Interested in implant restorations.',
  slots: [{ date: '2026-10-14', time: '10:00' }, { date: '2026-10-15', time: '14:30' }, { date: '2026-10-16', time: '09:00' }],
}
const MEET = 'https://meet.google.com/spv-afjq-fbt'
const text = (html) => html.replace(/<style[\s\S]*?<\/style>/gi, '').replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/&#39;/g, "'").replace(/\s+/g, ' ')

test('the request email shows all 3 options, an Approve button for each, and a call-first button', () => {
  const { subject, html } = internalRequestEmail({
    request: REQUEST, approveUrls: ['https://x/a0', 'https://x/a1', 'https://x/a2'], callFirstUrl: 'https://x/call',
  })
  assert.match(subject, /Partner meeting request/)
  assert.match(subject, /Acme Dental|Jane Smith/)
  const t = text(html)
  assert.match(t, /Wednesday, October 14, 2026 at 10:00 AM \(America\/Los_Angeles\)/)
  assert.match(t, /Thursday, October 15, 2026 at 2:30 PM/)
  assert.match(t, /Friday, October 16, 2026 at 9:00 AM/)
  for (const u of ['https://x/a0', 'https://x/a1', 'https://x/a2', 'https://x/call']) assert.ok(html.includes(`href="${u}"`), u)
  assert.match(t, /Jane Smith/)
  assert.match(t, /Acme Dental/)
  assert.match(t, /jane@acme\.com/)
  assert.match(t, /555-0100/)
  assert.match(t, /Interested in implant restorations/)
  assert.match(t, /call/i)
})

test("each option also shows the time in Ben's own time zone, so he doesn't convert in his head", () => {
  const t = text(internalRequestEmail({ request: REQUEST, approveUrls: ['a', 'b', 'c'], callFirstUrl: 'd' }).html)
  assert.match(t, /1:00 PM ET|1:00 PM Eastern|1:00 PM \(America\/New_York\)/) // 10:00 PDT = 13:00 EDT
})

test('partner-typed text is escaped, and line breaks cannot leak into the subject', () => {
  const evil = { ...REQUEST, partner_name: '<script>alert(1)</script>\r\nBcc: attacker@evil.com', company: '"><img src=x onerror=alert(1)>', note: '<b>bold</b>' }
  const { subject, html } = internalRequestEmail({ request: evil, approveUrls: ['a', 'b', 'c'], callFirstUrl: 'd' })
  assert.doesNotMatch(html, /<script>alert/)
  assert.doesNotMatch(html, /<img src=x/)
  assert.doesNotMatch(html, /<b>bold<\/b>/)
  assert.match(html, /&lt;script&gt;/)
  assert.doesNotMatch(subject, /[\r\n]/)
  assert.equal(oneLine('a\r\nb\nc'), 'a b c')
})

test('a missing company or phone does not print "undefined" or "null"', () => {
  const { html, subject } = internalRequestEmail({ request: { ...REQUEST, company: null, phone: null, note: null }, approveUrls: ['a', 'b', 'c'], callFirstUrl: 'd' })
  assert.doesNotMatch(html + subject, /undefined|null|NaN/)
})

test("the partner's confirmation names the time in their own zone, the Meet link, and mentions the calendar file", () => {
  const { subject, html } = partnerConfirmationEmail({ request: REQUEST, slot: REQUEST.slots[1], meetLink: MEET })
  assert.match(subject, /confirmed/i)
  const t = text(html)
  assert.match(t, /Thursday, October 15, 2026 at 2:30 PM \(America\/Los_Angeles\)/)
  assert.ok(html.includes(`href="${MEET}"`))
  assert.match(t, /Jane/)
  assert.match(t, /calendar/i)
})

test("Ben's confirmation is a separate email with the Meet link, an Add to Google Calendar button and both time zones", () => {
  const { subject, html } = benConfirmationEmail({ request: REQUEST, slot: REQUEST.slots[1], meetLink: MEET, googleCalendarUrl: 'https://calendar.google.com/calendar/render?x=1' })
  assert.match(subject, /Partner meeting confirmed/)
  assert.match(subject, /Acme Dental|Jane Smith/)
  assert.ok(html.includes(`href="${MEET}"`))
  assert.ok(html.includes('href="https://calendar.google.com/calendar/render?x=1"'))
  const t = text(html)
  assert.match(t, /Add to Google Calendar/)
  assert.match(t, /2:30 PM \(America\/Los_Angeles\)/)
  assert.match(t, /5:30 PM ET/) // 14:30 PDT = 17:30 EDT
  assert.match(t, /jane@acme\.com/)
})

test('no email or page contains an em dash or en dash', () => {
  const all = [
    internalRequestEmail({ request: REQUEST, approveUrls: ['a', 'b', 'c'], callFirstUrl: 'd' }),
    partnerConfirmationEmail({ request: REQUEST, slot: REQUEST.slots[0], meetLink: MEET }),
    benConfirmationEmail({ request: REQUEST, slot: REQUEST.slots[0], meetLink: MEET, googleCalendarUrl: 'u' }),
  ].map((e) => e.subject + e.html)
  all.push(approveConfirmPage({ request: REQUEST, slot: REQUEST.slots[0], token: 't' }))
  all.push(callFirstConfirmPage({ request: REQUEST, token: 't' }))
  all.push(resultPage('Title', 'Message'))
  for (const s of all) assert.doesNotMatch(s, /—|–/)
})

test('the confirm pages post the token in a form, show the partner, and the call page has a click-to-call button', () => {
  const approve = approveConfirmPage({ request: REQUEST, slot: REQUEST.slots[2], token: 'tok123' })
  assert.match(approve, /<form[^>]*method="POST"/i)
  assert.match(approve, /name="token" value="tok123"/)
  assert.match(text(approve), /Friday, October 16, 2026 at 9:00 AM/)
  const call = callFirstConfirmPage({ request: REQUEST, token: 'tok456' })
  assert.match(call, /name="token" value="tok456"/)
  assert.ok(call.includes('href="tel:555-0100"'))
  assert.ok(call.includes('href="mailto:jane@acme.com"'))
})
