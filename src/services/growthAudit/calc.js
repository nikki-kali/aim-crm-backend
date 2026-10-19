// Remake cost model for the website's Growth Audit (/partner). Mirrors the
// website's src/lib/remakeCost.js: the page shows these numbers instantly,
// and the report email recomputes them here from the raw answers so a
// tampered request can't put different figures in the report. Keep the two
// in step.

// National Dental PBRN study of 3,750 single-unit crowns: 3.8% rejected at
// try-in. McCracken et al., Journal of Prosthodontics, 2018.
const BENCHMARK_REMAKE_RATE = 0.038
const BENCHMARK_SOURCE = 'McCracken et al., Journal of Prosthodontics, 2018'
const BENCHMARK_URL = 'https://pmc.ncbi.nlm.nih.gov/articles/PMC7005880/'
const REDUCTION_SCENARIOS = [0.25, 0.5, 0.75]

// Generous ceilings so a typo can't produce an absurd report.
const LIMITS = { unitsPerMonth: 5000, remakesPerMonth: 5000, minutesPerRemake: 240, chairHourValue: 10000, labFeePerRemake: 5000 }

function clean(value, max) {
  const n = Number(value)
  if (!Number.isFinite(n) || n <= 0) return 0
  return Math.min(n, max)
}

function remakeCost(inputs) {
  const units = clean(inputs.unitsPerMonth, LIMITS.unitsPerMonth)
  const remakes = Math.min(clean(inputs.remakesPerMonth, LIMITS.remakesPerMonth), units || Infinity)
  const minutes = clean(inputs.minutesPerRemake, LIMITS.minutesPerRemake)
  const hourValue = clean(inputs.chairHourValue, LIMITS.chairHourValue)
  const labFee = clean(inputs.labFeePerRemake, LIMITS.labFeePerRemake)

  const annualUnits = units * 12
  const annualRemakes = remakes * 12
  const rate = units ? remakes / units : 0
  const chairHours = (annualRemakes * minutes) / 60
  const chairCost = chairHours * hourValue
  const labCost = annualRemakes * labFee
  const total = chairCost + labCost

  return {
    inputs: { units, remakes, minutes, hourValue, labFee },
    annualUnits,
    annualRemakes,
    rate,
    chairHours,
    chairCost,
    labCost,
    total,
    perRemake: (minutes / 60) * hourValue + labFee,
    benchmarkAnnualRemakes: annualUnits * BENCHMARK_REMAKE_RATE,
    aboveBenchmark: rate > BENCHMARK_REMAKE_RATE,
    scenarios: REDUCTION_SCENARIOS.map((cut) => ({
      cut,
      remakesAvoided: annualRemakes * cut,
      hoursBack: chairHours * cut,
      saved: total * cut,
    })),
  }
}

const money = (n) =>
  new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(Math.round(n))
const percent = (n, digits = 1) => `${(n * 100).toFixed(digits)}%`

module.exports = { remakeCost, money, percent, BENCHMARK_REMAKE_RATE, BENCHMARK_SOURCE, BENCHMARK_URL }
