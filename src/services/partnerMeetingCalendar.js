// Calendar files for a confirmed partner meeting: an .ics that opens in
// Google Calendar, Outlook and Apple Calendar, and a one-click Google
// Calendar link. Pure functions, no network.

const pad = (n) => String(n).padStart(2, '0')

function toIcsUtc(date) {
  const d = new Date(date)
  return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`
}

function endOf({ startUtc, durationMin }) {
  return new Date(new Date(startUtc).getTime() + durationMin * 60000)
}

const escapeText = (s) => String(s ?? '').replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n')

// RFC 5545: lines are at most 75 octets; a longer one continues on the next
// line after CRLF + one space. Splits on characters, not bytes, so a
// multi-byte character is never cut in half.
function fold(line) {
  if (Buffer.byteLength(line) <= 75) return line
  const out = []
  let cur = ''
  for (const ch of line) {
    const limit = out.length === 0 ? 75 : 74 // continuation lines start with a space
    if (Buffer.byteLength(cur + ch) > limit) { out.push(cur); cur = ch } else cur += ch
  }
  out.push(cur)
  return out.join('\r\n ')
}

function buildIcs({ uid, startUtc, durationMin = 30, summary, description, location }) {
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//AIM Dental Laboratory//Partner Meetings//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    'BEGIN:VEVENT',
    `UID:${uid}`,
    `DTSTAMP:${toIcsUtc(new Date())}`,
    `DTSTART:${toIcsUtc(startUtc)}`,
    `DTEND:${toIcsUtc(endOf({ startUtc, durationMin }))}`,
    `SUMMARY:${escapeText(summary)}`,
    `DESCRIPTION:${escapeText(description)}`,
    `LOCATION:${escapeText(location)}`,
    'STATUS:CONFIRMED',
    'END:VEVENT',
    'END:VCALENDAR',
  ]
  return lines.map(fold).join('\r\n') + '\r\n'
}

function buildGoogleCalendarUrl({ startUtc, durationMin = 30, summary, description, location }) {
  const url = new URL('https://calendar.google.com/calendar/render')
  url.searchParams.set('action', 'TEMPLATE')
  url.searchParams.set('text', summary)
  url.searchParams.set('dates', `${toIcsUtc(startUtc)}/${toIcsUtc(endOf({ startUtc, durationMin }))}`)
  url.searchParams.set('details', description)
  url.searchParams.set('location', location)
  return url.toString()
}

module.exports = { buildIcs, buildGoogleCalendarUrl }
