const { money, percent, BENCHMARK_REMAKE_RATE } = require('./calc')

// Builds the written part of the Growth Audit report email from rules, not
// AI: every sentence is chosen from the practice's own answers (remake rate,
// yearly cost, lab fee, chair time per remake, the problems they picked, what
// they want help with). Same answers, same report, every time.
//
// The logic, in order:
//   1. Benchmark gap: how many remakes a year are above the 3.8% national
//      rate, and what those extra remakes cost.
//   2. Cost driver: whether the money is mostly in how often remakes happen,
//      how long each one takes, or the lab fees.
//   3. Levers: the dollar value of each thing that would lower the cost,
//      ranked biggest first.
//   4. Priority: High / Moderate / Low, so reps know which calls matter most.
// The copy is written to lead to the call: lead with what's recoverable,
// make it concrete (per week, appointments), tie every next step to the rep
// and the booked call-back, and lower the risk of trying AIM.
//
// AIM claims here are only ones aimdentallab.com already makes (magnification
// on every case, 360-degree peer review, intake checks, shade on every unit,
// design preview, scanners and formats, rush options, named rep, case
// tracking, the guarantee, 16 implant systems, Scanner Placement Program).
// Clinical tips follow AIM's published impression checklist. Add a new claim
// to the website first, then here.
//
// House style: no em dashes, plain sentences, "you" for the reader.

// What each problem usually comes from, a chairside fix, and how AIM helps.
// Listed in the order we'd tackle them: fit problems cost the most chair time.
const PROBLEMS = {
  'Margins or fit': {
    cause: 'Margin remakes usually trace back to a margin that was not fully captured: a break in the line, a drag mark, or a bubble right at the finish line.',
    fix: 'Before the case leaves, trace the margin all the way around each prep. On a scan, rescan just that area instead of retaking the whole arch.',
    aim: 'Every case is checked under high-powered magnification, and a second technician reviews it before it ships, so margin problems are caught at the bench.',
  },
  'Contacts or occlusion': {
    cause: 'Tight contacts and high bites usually come from the bite record: a perforated or thin bite registration, or a partial opposing arch.',
    fix: 'Check for full-arch contact with no thin spots, and on a scan confirm the whole opposing arch and that the arches meet correctly in the software.',
    aim: 'Impressions and scans are checked at intake, including the opposing arch and bite, before any work begins.',
  },
  'Digital scan issues': {
    cause: 'Scan remakes usually come from holes in the mesh, a partial opposing arch, warping from movement, or a scan body that was not identified.',
    fix: 'Review the scan on screen before you submit: margins, coverage, bite, and the scan body on implant cases.',
    aim: 'Every major intraoral scanner is accepted (STL, PLY, OBJ, DCM), and scans are checked at intake so problems are caught before milling.',
  },
  'Communication with the lab': {
    cause: 'Many remakes start with a gap in the prescription: missing notes on materials, margins or occlusion, or no way to check on a case.',
    fix: 'Send photos and specific notes with every case, and talk complex cases through before you prep.',
    aim: 'You get one named rep who knows your practice, and you can track any case online by case number.',
  },
  Shade: {
    cause: 'Shade misses usually come from the information the lab receives: a single shade tab, mixed lighting, or no photo for reference.',
    fix: 'Take the shade in consistent light and send a photo with the shade tab next to the tooth.',
    aim: 'Shade is matched on every unit, and complex cases can get a digital design preview before milling.',
  },
  'Turnaround time': {
    cause: 'When a remake also restarts the queue, the patient waits twice and your schedule absorbs a second visit.',
    fix: 'Agree the rush terms with your lab before you need them, so a redo never waits behind new cases.',
    aim: 'AIM offers a 24-hour rush in the NYC metro for scans received by 12 PM, and a 2-day rush for every practice.',
  },
}
const PROBLEM_ORDER = Object.keys(PROBLEMS)

// One targeted next step per "what would help most" answer.
const FOCUS_STEPS = {
  'Fewer remakes and adjustments': 'Note the cause of each remake for the next month. A short list like that shows the pattern faster than any single case.',
  'Faster or more predictable turnaround': 'Ask your rep how AIM’s standard turnaround and rush options fit the cases you send most.',
  'Going digital / scanner workflow': 'Ask your rep whether your practice qualifies for AIM’s Scanner Placement Program, which places a scanner at no upfront cost.',
  'Implant cases': 'Ask your rep about implant restorations: AIM works with 16 major implant systems, and the implant intake protocol on our site lists what to send.',
}

// Chair time per remake above this counts as "long": the remake is costing
// more than a quick reseat.
const LONG_REMAKE_MINUTES = 60
const WEEKS_PER_YEAR = 52
const HOURS_PER_CHAIR_DAY = 8

function rateBand(rate) {
  if (rate === 0) return 'none'
  if (rate <= 0.02) return 'low'
  if (rate <= BENCHMARK_REMAKE_RATE) return 'near'
  if (rate <= 0.06) return 'above'
  return 'well-above'
}

const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1)
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`

// Everything the copy is chosen from. Pure numbers, no wording.
function analyze(cost) {
  const band = rateBand(cost.rate)
  const excessRemakes = Math.max(0, Math.round(cost.annualRemakes - cost.benchmarkAnnualRemakes))
  const benchmarkGap = excessRemakes * cost.perRemake
  const quarterCut = cost.scenarios[0].saved
  const halfCut = cost.scenarios[1].saved
  // The guarantee saves the fee only on remakes that still happen. The ones
  // removed by reaching the average already carry their fee in benchmarkGap,
  // so counting all fees again would double-count them.
  const remainingFees = (cost.annualRemakes - excessRemakes) * cost.inputs.labFee

  // What lowers the cost, in dollars a year. The levers are additive: their
  // sum is the recoverable headline. The guarantee lever only exists when
  // they pay their current lab for remakes.
  const levers = [
    benchmarkGap > 0 && { id: 'benchmark', value: benchmarkGap },
    remainingFees > 0 && { id: 'fees', value: remainingFees },
    benchmarkGap === 0 && cost.annualRemakes > 0 && { id: 'quarter', value: quarterCut },
  ]
    .filter(Boolean)
    .sort((a, b) => b.value - a.value)

  let driver = 'frequency'
  if (cost.labCost > cost.chairCost) driver = 'fees'
  else if (cost.inputs.minutes >= LONG_REMAKE_MINUTES && !cost.aboveBenchmark) driver = 'time'
  else if (!cost.aboveBenchmark) driver = 'steady'

  let priority = 'Low'
  if (band === 'well-above' || cost.total >= 20000) priority = 'High'
  else if (band === 'above' || cost.total >= 7500 || cost.labCost > 0) priority = 'Moderate'
  if (cost.annualRemakes === 0) priority = 'Low'

  // The biggest number we can honestly say is recoverable.
  const recoverable = Math.max(benchmarkGap + remainingFees, halfCut)

  return {
    band,
    excessRemakes,
    benchmarkGap,
    remainingFees,
    levers,
    driver,
    priority,
    recoverable,
    perWeek: cost.total / WEEKS_PER_YEAR,
    appointments: Math.round(cost.chairHours),
    chairDays: Math.round(cost.chairHours / HOURS_PER_CHAIR_DAY),
  }
}

function priorityReason(cost, a) {
  if (cost.annualRemakes === 0) return 'no remakes reported'
  const parts = [`${percent(cost.rate)} remake rate`, `${money(cost.total)} a year`]
  if (cost.labCost > 0) parts.push(`pays ${money(cost.inputs.labFee)} per remake to current lab`)
  if (a.excessRemakes > 0) parts.push(`${a.excessRemakes} remakes a year above benchmark`)
  return parts.join(', ')
}

function headlineFor(cost, a) {
  if (cost.annualRemakes === 0) return 'Your remake rate is excellent. Here is how to keep it there.'
  if (a.recoverable >= 1000) return `About ${money(a.recoverable)} a year of your remake cost is recoverable.`
  return `Remakes are costing you about ${money(cost.total)} a year.`
}

function summaryFor(cost, a) {
  if (cost.annualRemakes === 0) {
    return 'You reported no remakes in a typical month, which is excellent. The figures below show what even a few would cost, and how to keep it that way as your case volume grows.'
  }
  const where = {
    fees: 'most of it in lab fees you pay for each redo',
    time: `most of it in chair time, because each remake takes about ${cost.inputs.minutes} minutes`,
    frequency: 'most of it in chair time',
    steady: 'most of it in chair time',
  }[a.driver]
  const opener = `Remakes cost your practice about ${money(cost.total)} a year, ${where}. That is roughly ${money(a.perWeek)} every week.`
  const study = `the ${percent(BENCHMARK_REMAKE_RATE)} seen in a national study of 3,750 crowns`
  const rateLine = {
    low: `Your remake rate is ${percent(cost.rate)}, well below ${study}, so the opportunity is in the cost of each remake rather than how often they happen.`,
    near: `Your remake rate is ${percent(cost.rate)}, close to ${study}. You are not doing anything unusual, which means the gains come from the lab side of the process.`,
    above: `Your remake rate is ${percent(cost.rate)}, above ${study}. Matching that rate alone would mean ${plural(a.excessRemakes, 'fewer remake')} a year, worth about ${money(a.benchmarkGap)}.`,
    'well-above': `Your remake rate is ${percent(cost.rate)}, well above ${study}. That usually points to a pattern rather than bad luck, and patterns can be fixed: matching that rate would mean ${plural(a.excessRemakes, 'fewer remake')} a year, worth about ${money(a.benchmarkGap)}.`,
  }[a.band]
  return `${opener} ${rateLine}`
}

function costSection(cost, a) {
  if (cost.annualRemakes === 0) {
    return {
      title: 'What a remake would cost you',
      bullets: [
        `Each remake would cost you about ${money(cost.perRemake)}: ${cost.inputs.minutes} minutes of chair time at ${money(cost.inputs.hourValue)} an hour${cost.inputs.labFee ? `, plus a ${money(cost.inputs.labFee)} lab fee` : ''}.`,
        `At the national rate of ${percent(BENCHMARK_REMAKE_RATE)}, your volume would mean about ${Math.round(cost.benchmarkAnnualRemakes)} remakes a year.`,
      ],
    }
  }
  const bullets = [
    `Each remake costs you about ${money(cost.perRemake)}: ${cost.inputs.minutes} minutes of chair time at ${money(cost.inputs.hourValue)} an hour${cost.inputs.labFee ? `, plus a ${money(cost.inputs.labFee)} lab fee` : ''}.`,
    `${cost.annualRemakes} remakes a year take about ${a.appointments} hours of chair time${a.chairDays >= 1 ? `, or ${plural(a.chairDays, 'full chair day')}` : ''}. That is time that could go to about ${a.appointments} one-hour appointments with new patients.`,
  ]
  if (cost.labCost > 0) {
    bullets.push(`Your current lab charges for remakes, which adds ${money(cost.labCost)} a year on top of the chair time.`)
  }
  bullets.push(`Cutting remakes by a quarter would give you back about ${money(cost.scenarios[0].saved)} a year. Cutting them in half, about ${money(cost.scenarios[1].saved)}.`)
  return { title: 'What remakes are costing you', bullets }
}

// The levers, ranked by dollar value, worded for this practice.
function leverSection(cost, a) {
  if (!a.levers.length) return null
  const line = {
    benchmark: (v) => `Bring your remake rate to the national average: ${plural(a.excessRemakes, 'fewer remake')} a year, worth about ${money(v)}.`,
    fees: (v) => `Stop paying for remakes: remakes covered by AIM’s guarantee are redone at no charge, which would remove up to ${money(v)} a year in fees${a.benchmarkGap > 0 ? ' on the remakes that remain' : ''}.`,
    quarter: (v) => `Your rate is already in line with the national average, so the lever is the remakes that remain. One in four fewer would be worth about ${money(v)} a year.`,
  }
  return {
    title: 'Your biggest savings, ranked',
    bullets: a.levers.map((l, i) => `${i + 1}. ${line[l.id](l.value)}`),
  }
}

function causesSection(pains) {
  const known = PROBLEM_ORDER.filter((p) => pains.includes(p))
  if (!known.length) {
    return {
      title: 'Where your remakes likely come from',
      bullets: [
        'You didn’t flag a specific problem, so here are the most common sources. Your rep can help you pin down yours on the call.',
        PROBLEMS['Margins or fit'].cause,
        PROBLEMS['Contacts or occlusion'].cause,
        PROBLEMS['Communication with the lab'].cause,
      ],
    }
  }
  const lead = known.length > 1 ? [`You flagged ${['', '', 'two', 'three', 'four', 'five', 'six'][known.length]} problems. Start with ${known[0].toLowerCase()}: it usually costs the most chair time of the ones you picked.`] : []
  return {
    title: 'Where your remakes likely come from',
    bullets: [...lead, ...known.slice(0, 4).flatMap((p) => [`${p}: ${PROBLEMS[p].cause}`, `What helps: ${PROBLEMS[p].fix}`])],
  }
}

function helpSection(pains, cost) {
  const known = PROBLEM_ORDER.filter((p) => pains.includes(p))
  const lines = (known.length ? known : ['Margins or fit', 'Contacts or occlusion']).slice(0, 4).map((p) => PROBLEMS[p].aim)
  lines.push(
    `Remakes covered by AIM’s guarantee are redone at no charge, backed by a 10-year craftsmanship warranty${cost.labCost > 0 ? `. That alone would remove up to ${money(cost.labCost)} a year in remake fees.` : '.'}`
  )
  return { title: 'How AIM would help lower it', bullets: [...new Set(lines)] }
}

function nextSteps({ pains, interest, cost, firstName }) {
  const steps = []
  if (FOCUS_STEPS[interest]) steps.push(FOCUS_STEPS[interest])
  if (pains.includes('Digital scan issues') || pains.includes('Margins or fit') || pains.includes('Contacts or occlusion')) {
    steps.push('Run the chairside impression checklist on your next three cases.')
  } else if (!steps.length || interest !== 'Fewer remakes and adjustments') {
    steps.push('Note the cause of your next three remakes.')
  }
  steps.push(
    cost.annualRemakes > 0
      ? `Send your next crown case to AIM and compare the fit for yourself. ${cap(firstName)} can set up pickup or a scan submission on your call.`
      : `Talk with ${firstName} about keeping your remake rate where it is as you grow.`
  )
  return [...new Set(steps)].slice(0, 3)
}

// Short labels for the ranked savings ladder in the email.
const LEVER_LABELS = {
  benchmark: (a) => ({ label: 'Reach the national average', detail: `${plural(a.excessRemakes, 'fewer remake')} a year` }),
  fees: (a) => ({ label: 'Stop paying for remakes', detail: a.benchmarkGap > 0 ? 'Fees on the remakes that remain, removed by AIM’s guarantee' : 'Covered remakes are redone at no charge under AIM’s guarantee' }),
  quarter: () => ({ label: 'One in four fewer remakes', detail: 'Your rate is already in line, so this is the remaining lever' }),
}

// One card per flagged problem, in the order to tackle them. With none
// flagged, the two most common sources, marked as not flagged.
function problemCards(pains) {
  const known = PROBLEM_ORDER.filter((p) => pains.includes(p))
  const flagged = known.length > 0
  return (flagged ? known : ['Margins or fit', 'Contacts or occlusion']).slice(0, 4).map((name, i) => ({
    name,
    flagged,
    first: flagged && i === 0 && known.length > 1,
    ...PROBLEMS[name],
  }))
}

// The call to action near the top of the email: tied to the rep and the
// booked call-back, with what the call covers and a low-risk first step.
function ctaFor({ cost, a, firstName, callback }) {
  const when = callback ? `on ${callback}` : 'within one business day'
  const covers = cost.annualRemakes > 0
    ? `On the call you will go through these numbers together, see where your ${money(a.recoverable)} is coming from, and pick one change to try on your next case.`
    : 'On the call you will go through your workflow together and how AIM can support it as your case volume grows.'
  return {
    title: callback ? `Your call with ${firstName} is booked` : `${cap(firstName)} will call you`,
    body: `${cap(firstName)} will call you ${when}. ${covers} The call is free and there is no obligation.`,
    prep: 'To get the most from it, have your last two or three remakes in mind: what went wrong, and whether it was a scan or an impression.',
  }
}

// The written report. Shape the email expects:
// { headline, summary, cta, sections: [{ title, bullets }], next_steps,
//   priority, priority_reason }
function buildReport({ cost, pains = [], interest = '', firstName = 'your AIM rep', callback = null }) {
  const a = analyze(cost)
  const name = firstName === 'the AIM team' ? 'our team' : firstName
  return {
    headline: headlineFor(cost, a),
    summary: summaryFor(cost, a),
    cta: ctaFor({ cost, a, firstName: name, callback }),
    sections: [costSection(cost, a), leverSection(cost, a), causesSection(pains), helpSection(pains, cost)].filter(Boolean),
    next_steps: nextSteps({ pains, interest, cost, firstName: name }),
    priority: a.priority,
    priority_reason: priorityReason(cost, a),
    // Structured copies of the above for the infographic email.
    recoverable: a.recoverable,
    perWeek: a.perWeek,
    chairDays: a.chairDays,
    levers: a.levers.map((l) => ({ ...l, ...LEVER_LABELS[l.id](a) })),
    problems: problemCards(pains),
    guarantee: helpSection([], cost).bullets.at(-1),
  }
}

// Kept async so the route's call site doesn't change.
async function writeReport(details) {
  return { report: buildReport(details), source: 'rules' }
}

module.exports = { writeReport, buildReport, analyze, templateReport: buildReport, PROBLEMS, FOCUS_STEPS }
