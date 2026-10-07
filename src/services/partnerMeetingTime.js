// Partner-meeting time handling. A partner types dates and times in THEIR
// time zone; Ben needs the exact instant. No date library: Intl is enough.

function assertTimeZone(tz) {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz })
  } catch {
    throw new RangeError(`Unknown time zone: ${tz}`)
  }
}

// How far `tz`'s wall clock is ahead of UTC at the instant `utcMs`.
function tzOffsetMs(utcMs, tz) {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    }).formatToParts(new Date(utcMs)).map((x) => [x.type, x.value])
  )
  const wallAsUtc = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second)
  return wallAsUtc - Math.floor(utcMs / 1000) * 1000
}

function zonedTimeToUtc(dateStr, timeStr, tz) {
  assertTimeZone(tz)
  const [y, m, d] = dateStr.split('-').map(Number)
  const [hh, mm] = timeStr.split(':').map(Number)
  const guess = Date.UTC(y, m - 1, d, hh, mm)
  // Two passes so a time on the far side of a daylight saving change still lands right.
  let utc = guess - tzOffsetMs(guess, tz)
  utc = guess - tzOffsetMs(utc, tz)
  return new Date(utc)
}

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/
const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/

function isRealDate(str) {
  const m = DATE_RE.exec(str)
  if (!m) return false
  const [y, mo, d] = [+m[1], +m[2], +m[3]]
  const dt = new Date(Date.UTC(y, mo - 1, d))
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d
}

// Exactly 3 distinct, upcoming slots, all in the partner's time zone.
function validateSlots(slots, tz, now = new Date()) {
  try {
    assertTimeZone(tz)
  } catch {
    return { ok: false, error: 'Please choose a valid time zone.' }
  }
  if (!Array.isArray(slots) || slots.length !== 3) {
    return { ok: false, error: 'Please give exactly 3 dates and times you are available.' }
  }
  const clean = []
  for (const s of slots) {
    if (!s || typeof s !== 'object') return { ok: false, error: 'Each option needs a date and a time.' }
    const date = String(s.date || '').trim()
    const time = String(s.time || '').trim()
    if (!isRealDate(date)) return { ok: false, error: 'One of the dates is not a valid date.' }
    if (!TIME_RE.test(time)) return { ok: false, error: 'One of the times is not a valid time.' }
    if (zonedTimeToUtc(date, time, tz).getTime() <= now.getTime()) {
      return { ok: false, error: 'Each option must be an upcoming date and time, not one in the past.' }
    }
    clean.push({ date, time })
  }
  const keys = new Set(clean.map((s) => `${s.date} ${s.time}`))
  if (keys.size !== 3) return { ok: false, error: 'Please give 3 different options, not the same one twice.' }
  return { ok: true, slots: clean }
}

// Slots are optional: blank rows are skipped, 0 to 3 filled rows are allowed.
// A half-filled row (date without time, or the reverse) is an error.
function validateOptionalSlots(slots, tz, now = new Date()) {
  try {
    assertTimeZone(tz)
  } catch {
    return { ok: false, error: 'Please choose a valid time zone.' }
  }
  if (slots == null) return { ok: true, slots: [] }
  if (!Array.isArray(slots) || slots.length > 3) return { ok: false, error: 'Please give at most 3 dates and times.' }
  const clean = []
  for (const s of slots) {
    const date = String((s && s.date) || '').trim()
    const time = String((s && s.time) || '').trim()
    if (!date && !time) continue
    if (!date || !time) return { ok: false, error: 'Each option needs both a date and a time.' }
    const one = checkOneSlot(date, time, tz, now)
    if (!one.ok) return one
    clean.push({ date, time })
  }
  if (new Set(clean.map((s) => `${s.date} ${s.time}`)).size !== clean.length) {
    return { ok: false, error: 'Please give different options, not the same one twice.' }
  }
  return { ok: true, slots: clean }
}

function checkOneSlot(date, time, tz, now = new Date()) {
  if (!isRealDate(date)) return { ok: false, error: 'One of the dates is not a valid date.' }
  if (!TIME_RE.test(time)) return { ok: false, error: 'One of the times is not a valid time.' }
  if (zonedTimeToUtc(date, time, tz).getTime() <= now.getTime()) {
    return { ok: false, error: 'Each option must be an upcoming date and time, not one in the past.' }
  }
  return { ok: true }
}

// "Wednesday, October 14, 2026 at 10:00 AM (America/New_York)": the wall-clock
// time exactly as the partner typed it, never converted.
function formatSlot(slot, tz) {
  const [y, m, d] = slot.date.split('-').map(Number)
  const [hh, mm] = slot.time.split(':').map(Number)
  const noonUtc = new Date(Date.UTC(y, m - 1, d, 12))
  const dateLabel = noonUtc.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' })
  const h12 = hh % 12 === 0 ? 12 : hh % 12
  return `${dateLabel} at ${h12}:${String(mm).padStart(2, '0')} ${hh < 12 ? 'AM' : 'PM'} (${tz})`
}

// The wall-clock date and time in `tz` at the instant `utcDate`: the reverse of zonedTimeToUtc.
function utcToZonedParts(utcDate, tz) {
  assertTimeZone(tz)
  const p = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
    }).formatToParts(utcDate).map((x) => [x.type, x.value])
  )
  return { date: `${p.year}-${p.month}-${p.day}`, time: `${p.hour}:${p.minute}` }
}

module.exports = { utcToZonedParts, zonedTimeToUtc, validateSlots, validateOptionalSlots, checkOneSlot, formatSlot, assertTimeZone }
