// Call-back booking for the website's Growth Audit. The practice picks a
// business day (from the next business day on, never today, so the rep has
// time to see it first) and a time window. We don't check the rep's real
// calendar: the booking holds a window, and the rep and the practice each get
// a calendar invite (.ics) so phones remind them.
//
// Windows are in the practice's local time, taken from the rep's territory:
// James (NYC metro) Eastern, William (West Coast) Pacific, unknown Eastern.

const WINDOWS = {
  morning: { label: 'Morning (8 to 11 am)', short: 'morning', start: 8, end: 11 },
  midday: { label: 'Midday (11 am to 2 pm)', short: 'midday', start: 11, end: 14 },
  afternoon: { label: 'Afternoon (2 to 5 pm)', short: 'afternoon', start: 14, end: 17 },
}

const REP_TIMEZONES = { james: 'America/New_York', william: 'America/Los_Angeles' }
const TZ_LABELS = { 'America/New_York': 'ET', 'America/Los_Angeles': 'PT' }
const DEFAULT_TZ = 'America/New_York'
const MAX_DAYS_AHEAD = 21

function timezoneFor(repId) {
  return REP_TIMEZONES[repId] || DEFAULT_TZ
}

// Today's date (YYYY-MM-DD) in a time zone.
function todayIn(tz, now = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now)
}

function addDays(dateStr, days) {
  const d = new Date(`${dateStr}T12:00:00Z`)
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString().slice(0, 10)
}

// Minutes the zone is ahead of UTC at a given instant.
function offsetMinutes(instant, tz) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    })
      .formatToParts(instant)
      .map((p) => [p.type, p.value])
  )
  const asUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second)
  return Math.round((asUtc - instant.getTime()) / 60000)
}

// A wall-clock time in a zone, as a real Date (handles daylight saving).
function zonedTime(dateStr, hour, tz) {
  const [y, m, d] = dateStr.split('-').map(Number)
  const guess = Date.UTC(y, m - 1, d, hour)
  let instant = new Date(guess - offsetMinutes(new Date(guess), tz) * 60000)
  instant = new Date(guess - offsetMinutes(instant, tz) * 60000)
  return instant
}

// Returns a validated booking, or null when the date/window aren't allowed:
// must be a weekday, after today in the practice's zone, within three weeks.
function parseCallback({ date, window, repId, now = new Date() }) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date || ''))) return null
  const win = WINDOWS[window]
  if (!win) return null
  const tz = timezoneFor(repId)
  const today = todayIn(tz, now)
  if (date <= today || date > addDays(today, MAX_DAYS_AHEAD)) return null
  const weekday = new Date(`${date}T12:00:00Z`).getUTCDay()
  if (weekday === 0 || weekday === 6) return null
  return {
    date,
    window,
    tz,
    tzLabel: TZ_LABELS[tz] || '',
    start: zonedTime(date, win.start, tz),
    end: zonedTime(date, win.end, tz),
    windowLabel: win.label,
    dayLabel: new Intl.DateTimeFormat('en-US', { weekday: 'long', month: 'long', day: 'numeric', timeZone: 'UTC' }).format(new Date(`${date}T12:00:00Z`)),
    short: win.short,
  }
}

// "Tuesday, October 21, in the morning (8 to 11 am ET)"
function describeCallback(cb) {
  return `${cb.dayLabel}, in the ${cb.short} (${cb.windowLabel.replace(/^.*\((.*)\)$/, '$1')}${cb.tzLabel ? ` ${cb.tzLabel}` : ''})`
}

const icsDate = (d) => d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '')

// RFC 5545 text escaping and 75-octet line folding.
function icsText(value) {
  return String(value ?? '').replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n')
}
function fold(line) {
  const out = []
  let rest = line
  while (Buffer.byteLength(rest) > 73) {
    let cut = 73
    while (Buffer.byteLength(rest.slice(0, cut)) > 73) cut--
    out.push(rest.slice(0, cut))
    rest = ' ' + rest.slice(cut)
  }
  out.push(rest)
  return out.join('\r\n')
}

// A standalone event (METHOD:PUBLISH): opens as "Add to calendar" in Gmail,
// Outlook and Apple Mail without needing a real calendar as organizer.
function icsEvent({ uid, start, end, summary, description, location, alarmMinutes = 15 }) {
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//AIM Dental Laboratory//Growth Audit//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    'BEGIN:VEVENT',
    `UID:${uid}`,
    `DTSTAMP:${icsDate(new Date())}`,
    `DTSTART:${icsDate(start)}`,
    `DTEND:${icsDate(end)}`,
    `SUMMARY:${icsText(summary)}`,
    `DESCRIPTION:${icsText(description)}`,
    location ? `LOCATION:${icsText(location)}` : null,
    'BEGIN:VALARM',
    'ACTION:DISPLAY',
    `DESCRIPTION:${icsText(summary)}`,
    `TRIGGER:-PT${alarmMinutes}M`,
    'END:VALARM',
    'END:VEVENT',
    'END:VCALENDAR',
  ].filter(Boolean)
  return Buffer.from(lines.map(fold).join('\r\n') + '\r\n', 'utf8')
}

module.exports = { WINDOWS, parseCallback, describeCallback, icsEvent, timezoneFor, todayIn, addDays }
