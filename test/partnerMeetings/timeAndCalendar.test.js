const test = require('node:test')
const assert = require('node:assert/strict')
const { zonedTimeToUtc, validateSlots, formatSlot } = require('../../src/services/partnerMeetingTime')
const { buildIcs, buildGoogleCalendarUrl } = require('../../src/services/partnerMeetingCalendar')

test('a partner time converts to the exact UTC instant, including daylight saving', () => {
  assert.equal(zonedTimeToUtc('2026-10-14', '10:00', 'America/New_York').toISOString(), '2026-10-14T14:00:00.000Z') // EDT, UTC-4
  assert.equal(zonedTimeToUtc('2026-12-15', '10:00', 'America/New_York').toISOString(), '2026-12-15T15:00:00.000Z') // EST, UTC-5
  assert.equal(zonedTimeToUtc('2026-10-14', '09:00', 'Asia/Manila').toISOString(), '2026-10-14T01:00:00.000Z') // UTC+8, no DST
  assert.equal(zonedTimeToUtc('2026-10-14', '08:30', 'America/Los_Angeles').toISOString(), '2026-10-14T15:30:00.000Z') // PDT, UTC-7
  assert.equal(zonedTimeToUtc('2026-10-14', '12:00', 'UTC').toISOString(), '2026-10-14T12:00:00.000Z')
})

test('the day the clocks change still converts correctly (Nov 1 2026 is the US fall-back day)', () => {
  assert.equal(zonedTimeToUtc('2026-11-01', '09:00', 'America/New_York').toISOString(), '2026-11-01T14:00:00.000Z') // already EST
  assert.equal(zonedTimeToUtc('2026-10-31', '09:00', 'America/New_York').toISOString(), '2026-10-31T13:00:00.000Z') // still EDT
})

test('an unknown time zone is rejected', () => {
  assert.throws(() => zonedTimeToUtc('2026-10-14', '10:00', 'Mars/Olympus'), /time zone/i)
})

const NOW = new Date('2026-10-07T12:00:00Z')
const good = () => [
  { date: '2026-10-14', time: '10:00' },
  { date: '2026-10-15', time: '14:30' },
  { date: '2026-10-16', time: '09:00' },
]

test('three valid future slots pass and come back normalized', () => {
  const r = validateSlots(good(), 'America/New_York', NOW)
  assert.equal(r.ok, true)
  assert.equal(r.slots.length, 3)
  assert.deepEqual(r.slots[1], { date: '2026-10-15', time: '14:30' })
})

test('exactly three slots are required', () => {
  assert.equal(validateSlots(good().slice(0, 2), 'UTC', NOW).ok, false)
  assert.equal(validateSlots([...good(), { date: '2026-10-17', time: '10:00' }], 'UTC', NOW).ok, false)
  assert.match(validateSlots([], 'UTC', NOW).error, /3/)
  assert.equal(validateSlots(undefined, 'UTC', NOW).ok, false)
})

test('bad dates, bad times and past dates are rejected with a clear message', () => {
  const bad = (slot) => validateSlots([slot, good()[1], good()[2]], 'UTC', NOW)
  assert.match(bad({ date: '2026-13-40', time: '10:00' }).error, /date/i)
  assert.match(bad({ date: '2026-10-14', time: '25:99' }).error, /time/i)
  assert.match(bad({ date: '', time: '' }).error, /date|time/i)
  assert.match(bad({ date: '2026-10-01', time: '10:00' }).error, /past|future|upcoming/i)
  assert.equal(bad('not an object').ok, false)
})

test('the same slot twice is rejected, and a bad time zone is rejected', () => {
  const dup = [good()[0], good()[0], good()[2]]
  assert.match(validateSlots(dup, 'UTC', NOW).error, /different|twice|same/i)
  assert.match(validateSlots(good(), 'Mars/Olympus', NOW).error, /time zone/i)
})

test('formatSlot gives a readable line in the partner\'s own time zone', () => {
  assert.equal(formatSlot({ date: '2026-10-14', time: '10:00' }, 'America/New_York'), 'Wednesday, October 14, 2026 at 10:00 AM (America/New_York)')
  assert.equal(formatSlot({ date: '2026-10-15', time: '14:30' }, 'UTC'), 'Thursday, October 15, 2026 at 2:30 PM (UTC)')
})

const EVENT = {
  uid: 'partner-meeting-abc@aimdentallab.com',
  startUtc: new Date('2026-10-14T14:00:00Z'),
  durationMin: 30,
  summary: 'Partner meeting: Acme Dental with Ben',
  description: 'Partner: Jane Smith, Acme Dental\nPhone: 555-0100',
  location: 'https://meet.google.com/abc-defg-hij',
}

test('the calendar file is a valid single event with UTC times, the Meet link, and CRLF line endings', () => {
  const ics = buildIcs(EVENT)
  assert.match(ics, /^BEGIN:VCALENDAR\r\n/)
  assert.match(ics, /\r\nEND:VCALENDAR\r\n$/)
  assert.equal((ics.match(/BEGIN:VEVENT/g) || []).length, 1)
  assert.match(ics, /DTSTART:20261014T140000Z\r\n/)
  assert.match(ics, /DTEND:20261014T143000Z\r\n/)
  assert.match(ics, /UID:partner-meeting-abc@aimdentallab\.com\r\n/)
  assert.match(ics, /LOCATION:https:\/\/meet\.google\.com\/abc-defg-hij\r\n/)
  assert.match(ics, /METHOD:PUBLISH\r\n/)
  assert.equal(ics.replace(/\r\n/g, '').includes('\n'), false, 'no bare newlines')
})

test('commas, semicolons, backslashes and newlines in text are escaped, and long lines are folded under 75 bytes', () => {
  const ics = buildIcs({ ...EVENT, summary: 'Smith, Jones; and \\ Co', description: 'Line one\nLine two, with comma; and semicolon ' + 'x'.repeat(200) })
  assert.match(ics, /SUMMARY:Smith\\, Jones\\; and \\\\ Co\r\n/)
  assert.match(ics, /DESCRIPTION:Line one\\nLine two\\, with comma\\; and semicolon /)
  for (const line of ics.split('\r\n')) assert.ok(Buffer.byteLength(line) <= 75, `line too long: ${line.length}`)
  // Unfolding (removing CRLF + one space) must restore the whole description.
  assert.ok(ics.replace(/\r\n /g, '').includes('x'.repeat(200)))
})

test('the Google Calendar link carries the title, UTC times and the Meet link', () => {
  const url = new URL(buildGoogleCalendarUrl(EVENT))
  assert.equal(url.origin + url.pathname, 'https://calendar.google.com/calendar/render')
  assert.equal(url.searchParams.get('action'), 'TEMPLATE')
  assert.equal(url.searchParams.get('text'), EVENT.summary)
  assert.equal(url.searchParams.get('dates'), '20261014T140000Z/20261014T143000Z')
  assert.equal(url.searchParams.get('location'), EVENT.location)
  assert.match(url.searchParams.get('details'), /Jane Smith/)
})

test('utcToZonedParts is the reverse of zonedTimeToUtc', () => {
  const { utcToZonedParts, zonedTimeToUtc } = require('../../src/services/partnerMeetingTime')
  const utc = zonedTimeToUtc('2026-10-21', '09:30', 'America/New_York')
  assert.deepEqual(utcToZonedParts(utc, 'America/Los_Angeles'), { date: '2026-10-21', time: '06:30' })
  const late = zonedTimeToUtc('2026-10-21', '22:00', 'America/Los_Angeles')
  assert.deepEqual(utcToZonedParts(late, 'Asia/Manila'), { date: '2026-10-22', time: '13:00' })
})
