// Plausibility check for Evident's company "MTD Booked Daily Update" figure.
// Found 2026-10-08: that email reported $485,192.03 for the month after
// $36,803.29 the day before, on a day that booked $7,457.74. Left alone, the
// Leadership Dashboard would have shown it as fact (and announced we had
// "surpassed last month"). Month-to-date booked can only grow by what the day
// booked, give or take small revisions, so a reading far from that is
// rejected and shown as unavailable instead of being trusted.

const fmt = (n) => Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

const UP_TOLERANCE_MIN = 2000      // dollars of slack above (previous + today)
const UP_TOLERANCE_PCT = 0.25      // or 25% of the expected figure, whichever is larger
const MAX_DROP_PCT = 0.10          // month-to-date should not fall more than 10%
const NO_PREVIOUS_DAYS = 25        // no earlier reading: allow up to 25 days of bookings
const NO_DAILY_CEILING = 100000    // daily total unknown: flat ceiling above the previous reading

function checkBookedMtd({ mtd, prevMtd = null, dailyBooked = null }) {
  if (mtd === null || mtd === undefined) return { ok: true }
  const m = Number(mtd)
  if (!Number.isFinite(m) || m < 0) return { ok: false, reason: `month-to-date booked of ${mtd} is not a valid amount` }

  const daily = dailyBooked === null || dailyBooked === undefined ? null : Number(dailyBooked)
  if (prevMtd === null || prevMtd === undefined) {
    const ceiling = daily === null ? NO_DAILY_CEILING : daily * NO_PREVIOUS_DAYS + UP_TOLERANCE_MIN
    return m <= ceiling
      ? { ok: true }
      : { ok: false, reason: `month-to-date booked of $${fmt(m)} is far more than ${NO_PREVIOUS_DAYS} days of bookings`, expected: null }
  }

  const prev = Number(prevMtd)
  if (daily === null) {
    return m <= prev + NO_DAILY_CEILING && m >= prev * (1 - MAX_DROP_PCT)
      ? { ok: true }
      : { ok: false, reason: `month-to-date booked of $${fmt(m)} moved too far from the previous $${fmt(prev)}`, expected: null }
  }
  const expected = Math.round((prev + daily) * 100) / 100
  const upper = expected + Math.max(UP_TOLERANCE_MIN, expected * UP_TOLERANCE_PCT)
  const lower = prev * (1 - MAX_DROP_PCT)
  if (m > upper || m < lower) {
    return {
      ok: false,
      expected,
      reason: `month-to-date booked of $${fmt(m)} does not fit the previous $${fmt(prev)} plus the day's $${fmt(daily)} (about $${fmt(expected)})`,
    }
  }
  return { ok: true, expected }
}

// The weekday before `dateStr` (YYYY-MM-DD), skipping Saturday and Sunday.
function previousWeekday(dateStr) {
  const d = new Date(`${dateStr}T00:00:00Z`)
  do { d.setUTCDate(d.getUTCDate() - 1) } while (d.getUTCDay() === 0 || d.getUTCDay() === 6)
  return d.toISOString().slice(0, 10)
}

const sameMonth = (a, b) => a.slice(0, 7) === b.slice(0, 7)

const MTD_BOOKED_LABEL = 'MTD Booked Daily Update'

// Checks the day's company MTD booked reading on an aggregate (from
// parseAndAggregate) and, when it is implausible, treats that email as not
// usable: it is added to aggregate.missing (so every card shows N/A instead
// of the figure), the figure and its per-rep split are cleared, and the
// reason is kept on aggregate.bookedMtdRejected for the report notice and the
// approver alert. `fetchPrevMtd(prevDate)` returns the previous weekday's
// company MTD booked, or null. Returns the rejection, or null when fine.
async function applyBookedMtdGuard(aggregate, runDate, fetchPrevMtd) {
  if (!aggregate || aggregate.missing.includes(MTD_BOOKED_LABEL)) return null
  const prevDate = previousWeekday(runDate)
  let prevMtd = null
  if (sameMonth(prevDate, runDate)) {
    try { prevMtd = await fetchPrevMtd(prevDate) } catch { prevMtd = null }
  }
  const result = checkBookedMtd({ mtd: aggregate.companyMtdBooked, prevMtd, dailyBooked: aggregate.companyDailyBooked })
  if (result.ok) return null
  const rejection = { reported: aggregate.companyMtdBooked, expected: result.expected ?? null, reason: result.reason }
  aggregate.missing.push(MTD_BOOKED_LABEL)
  aggregate.companyMtdBooked = 0
  aggregate.companyMtdBookedByRep = null
  aggregate.bookedMtdRejected = rejection
  return rejection
}

module.exports = { checkBookedMtd, previousWeekday, sameMonth, applyBookedMtdGuard, MTD_BOOKED_LABEL }
