const sdk = require('@anthropic-ai/sdk')
const { money, percent, BENCHMARK_REMAKE_RATE } = require('./calc')

const Anthropic = sdk.default || sdk

// Writes the narrative part of the Growth Audit report email with Claude.
// The numbers themselves are computed in calc.js and rendered by email.js;
// Claude only explains them. It is given a fixed list of AIM facts (the same
// ones the website publishes) and told not to add any others, so the report
// can't invent claims such as an AIM remake rate.
//
// Needs ANTHROPIC_API_KEY. Without it, or on any API error or refusal, the
// caller gets a plain template report instead, so the practice still gets
// their email.

const MODEL = 'claude-opus-5-5'

// What AIM can truthfully say, mirrored from aimdentallab.com. Keep in step
// with the website's partnerData.js / GrowthResults.jsx.
const AIM_FACTS = [
  'AIM Dental Laboratory, Brooklyn NY, founded 1951, serves more than 600 practices. All work is done in-house; nothing is outsourced.',
  'Every case is checked under high-powered magnification before it ships, and a second technician reviews the work (360-degree peer review).',
  'Impressions and scans are checked at intake, including the opposing arch and bite, before any work begins.',
  'Shade is matched on every unit. Complex cases can get a digital design preview before milling (adds 1 business day).',
  'Every major intraoral scanner is accepted (STL, PLY, OBJ, DCM).',
  'Standard turnaround: 11 days crown and bridge, 12 days implants, 11 days removables, 8 days orthodontics. 24-hour rush in metro NYC for scans received by 12 PM; 2-day rush for every practice.',
  'AIM guarantee: 90-day no-questions returns, a 10-year craftsmanship warranty, and a no-argument remake policy. Remakes covered by the guarantee are redone at no charge.',
  'Each practice has one named rep. Cases can be tracked online by case number.',
]

const SYSTEM = `You write the personalized part of a dental lab's "Growth Audit" report, emailed to a dentist who just entered their own numbers into a remake cost calculator.

Rules:
- Use only the numbers in the FACTS block and only the AIM facts listed there. Do not invent statistics, percentages, studies, testimonials, or any claim about AIM's own remake rate.
- Restate dollar figures exactly as given. Do not compute new figures.
- Write in plain, warm, professional US English for a busy dentist. Short sentences. No hype.
- Never use em dashes or en dashes. Use commas, periods or colons instead.
- Address the reader as "you". Do not use their name or a greeting; the email adds that.
- Sections: exactly three, titled "What remakes are costing you", "Where your remakes likely come from", and "How AIM would help lower it". Three to five bullets each, one or two sentences per bullet.
- In "Where your remakes likely come from", base it on the problems the practice selected and well-known clinical causes of those problems. If none were selected, discuss common causes generally and say so.
- In "How AIM would help lower it", connect each point to one of the listed AIM facts.
- next_steps: two or three short, concrete actions, the last one inviting them to talk with their AIM rep.`

const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['summary', 'sections', 'next_steps'],
  properties: {
    summary: { type: 'string', description: 'Two or three sentences summarizing the result.' },
    sections: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['title', 'bullets'],
        properties: {
          title: { type: 'string' },
          bullets: { type: 'array', items: { type: 'string' } },
        },
      },
    },
    next_steps: { type: 'array', items: { type: 'string' } },
  },
}

function factsBlock({ cost, pains, interest, message, practice }) {
  const lines = [
    `Practice: ${practice}`,
    `Crown and bridge units sent per month: ${cost.inputs.units}`,
    `Remakes per month: ${cost.inputs.remakes} (remake rate ${percent(cost.rate)})`,
    `Benchmark: a national study of 3,750 single-unit crowns found ${percent(BENCHMARK_REMAKE_RATE)} rejected at try-in (McCracken et al., Journal of Prosthodontics, 2018). This practice is ${cost.aboveBenchmark ? 'above' : 'at or below'} that.`,
    `Extra chair time per remake: ${cost.inputs.minutes} minutes. Chair time value: ${money(cost.inputs.hourValue)} per hour.`,
    `Lab fee per remake: ${cost.inputs.labFee ? money(cost.inputs.labFee) : 'none, their lab remakes for free'}`,
    `Cost per remake: ${money(cost.perRemake)}`,
    `Remakes per year: ${cost.annualRemakes}. Chair hours lost per year: ${Math.round(cost.chairHours)}.`,
    `Yearly cost: ${money(cost.total)} (chair time ${money(cost.chairCost)}, lab fees ${money(cost.labCost)}).`,
    ...cost.scenarios.map((s) => `If remakes fell ${Math.round(s.cut * 100)}%: about ${money(s.saved)} a year back and ${Math.round(s.hoursBack)} chair hours.`),
    `Problems they selected: ${pains.length ? pains.join(', ') : 'none selected'}`,
    `What they said would help most: ${interest || 'not given'}`,
    message ? `Their note: ${message.slice(0, 800)}` : '',
    '',
    'AIM facts you may use:',
    ...AIM_FACTS.map((f) => `- ${f}`),
  ]
  return lines.filter((l) => l !== '').join('\n')
}

const stripDashes = (s) => String(s).replace(/\s*[—–]\s*/g, ', ')

function sanitize(report) {
  return {
    summary: stripDashes(report.summary),
    sections: (report.sections || []).slice(0, 4).map((sec) => ({
      title: stripDashes(sec.title),
      bullets: (sec.bullets || []).slice(0, 6).map(stripDashes),
    })),
    next_steps: (report.next_steps || []).slice(0, 4).map(stripDashes),
  }
}

// Plain fallback used when the AI call isn't available. Same structure.
function templateReport({ cost, pains }) {
  return {
    summary: `Based on your numbers, remakes cost your practice about ${money(cost.total)} a year, mostly in chair time. Your remake rate is ${percent(cost.rate)}, ${cost.aboveBenchmark ? 'above' : 'at or below'} the ${percent(BENCHMARK_REMAKE_RATE)} seen in a national study.`,
    sections: [
      {
        title: 'What remakes are costing you',
        bullets: [
          `Each remake costs you about ${money(cost.perRemake)} in chair time${cost.inputs.labFee ? ' and lab fees' : ''}.`,
          `That is ${cost.annualRemakes} remakes and ${Math.round(cost.chairHours)} chair hours a year.`,
          `Cutting remakes by half would give you back about ${money(cost.scenarios[1].saved)} a year.`,
        ],
      },
      {
        title: 'Where your remakes likely come from',
        bullets: pains.length
          ? pains.map((p) => `You flagged ${p.toLowerCase()} as a common cause. It is worth reviewing the last few cases where it came up.`)
          : ['Most remakes trace back to margins, bite records or communication between the practice and the lab.'],
      },
      {
        title: 'How AIM would help lower it',
        bullets: [
          'Every case is checked under high-powered magnification, and a second technician reviews the work before it ships.',
          'Impressions and scans are checked at intake, before any work begins.',
          'Remakes covered by the AIM guarantee are redone at no charge, backed by a 10-year craftsmanship warranty.',
        ],
      },
    ],
    next_steps: [
      'Note the cause of your next three remakes.',
      'Run the chairside impression checklist on your next case.',
      'Talk through your results with your AIM rep.',
    ],
  }
}

async function writeReport(details) {
  if (!process.env.ANTHROPIC_API_KEY) return { report: templateReport(details), source: 'template' }
  try {
    const client = new Anthropic()
    const response = await client.beta.messages.create({
      model: MODEL,
      max_tokens: 4000,
      // Server-side fallback: if the model declines, the API reruns the same
      // request on a fallback model within this call.
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      output_config: { effort: 'medium', format: { type: 'json_schema', schema: SCHEMA } },
      system: SYSTEM,
      messages: [{ role: 'user', content: `FACTS\n${factsBlock(details)}` }],
    })
    if (response.stop_reason === 'refusal' || response.stop_reason === 'max_tokens') {
      console.error('growth-audit: report not usable, stop_reason', response.stop_reason)
      return { report: templateReport(details), source: 'template' }
    }
    const text = response.content.find((b) => b.type === 'text')?.text
    const parsed = JSON.parse(text)
    if (!parsed.sections?.length) throw new Error('empty report')
    return { report: sanitize(parsed), source: 'ai' }
  } catch (err) {
    console.error('growth-audit: AI report failed, using template', err?.status || '', err?.message || err)
    return { report: templateReport(details), source: 'template' }
  }
}

module.exports = { writeReport, templateReport, AIM_FACTS }
