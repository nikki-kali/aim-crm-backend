// EviSmart's Daily Sales Report is the source for every figure except YTD
// billed (user decision, 2026-10-09: it states booked = report #12, billed =
// report #40 / Customer Activity). Evident's own emails remain the fallback
// when EviSmart's report is missing, and still supply YTD billed and the
// per-rep daily rows. Pure functions, no Gmail.
const { repKeyFromSalesperson } = require('./parseEvident')

// Overrides Evident's month-to-date booked and billed (company and per rep)
// with EviSmart's by-rep table whenever it has one, even when Evident's email
// arrived. A figure it supplies is no longer missing or rejected.
function applyEviSmartMtdPrimary(agg, eviSmart) {
  const rep = eviSmart && eviSmart.repMtd
  if (!rep) return agg
  const out = { ...agg, missing: [...agg.missing] }
  const take = (label, kind, totalKey, byRepKey) => {
    if (!rep[kind]) return
    out[totalKey] = rep[kind].company
    out[byRepKey] = { na: rep[kind].na, james: rep[kind].james, william: rep[kind].william }
    out.missing = out.missing.filter((l) => l !== label)
  }
  take('MTD Booked Daily Update', 'booked', 'companyMtdBooked', 'companyMtdBookedByRep')
  take('Daily MTD Total Billed', 'billed', 'companyMtdBilled', 'companyMtdBilledByRep')
  if (rep.booked) delete out.bookedMtdRejected
  return out
}

// Replaces each rep's new-doctor goal progress with EviSmart's count
// (doctors whose first case falls this month). No extras, or an email without
// that table, leaves the CRM-based numbers untouched.
function applyEviSmartNewDoctors(repGoals, extras) {
  if (!extras || !extras.newDoctors) return repGoals
  return repGoals.map((rep) => {
    const key = repKeyFromSalesperson(rep.repName)
    const list = key && extras.newDoctors[key]
    if (!list) return rep
    return {
      ...rep,
      goals: rep.goals.map((g) => {
        if (g.metric !== 'new_doctors') return g
        const target = Number(g.target)
        return { ...g, current_value: list.length, progress_pct: target > 0 ? Math.min(Math.round((list.length / target) * 100), 100) : 0 }
      }),
    }
  })
}

module.exports = { applyEviSmartMtdPrimary, applyEviSmartNewDoctors }
