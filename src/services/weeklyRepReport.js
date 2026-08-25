const db = require('../config/db')
const { sendEmail, repReportEmail } = require('./email')

// Weekly report is cc'd to leadership on every automated send — the same
// three inboxes for every rep, not configurable per rep.
const REPORT_CC = ['media@aimdentallab.com', 'execassistant@aimdentallab.com', 'ben@aimdentallab.com']

// Used only to pad personalizedSuggestions() out to 3 lines when a rep
// doesn't have enough going on in their own numbers to trigger 3 specific
// rules (e.g. a brand-new rep with almost no history yet) — never shown on
// its own.
const FALLBACK_SUGGESTIONS = {
  green: [
    'Set a stretch goal: one more lead than last week.',
    'Write down what worked this week so it’s easy to repeat.',
  ],
  amber: [
    'Pick one lead and move it forward today — that’s your 1% for the week.',
    'Send one prospect a follow-up that references something specific, not a generic check-in.',
  ],
  red: [
    'Block 30 minutes this week for follow-ups only, before any new prospecting.',
    'If a lead has gone quiet twice, try a different channel than last time.',
  ],
}

// Personalized, data-driven suggestions — each rule reads the rep's own
// numbers (named cold leads, stuck proposals, WIP vs. billed, week-over-
// week trend, a real recent win) rather than showing the same 3 lines to
// every rep in a tier. Rules are checked in priority order (most specific
// and actionable first) and the first 3 matches win; FALLBACK_SUGGESTIONS
// only pads the list when fewer than 3 of a rep's own signals fire.
// Lives here (not in email.js) because computeRepSummary computes it once
// and both the email template and GET /api/reports/my-summary (which
// powers the rep dashboard's own "action items" card) read the same array
// off the summary object — one source of truth, not two.
function personalizedSuggestions({ week, month, previousWeek, sales, coldLeads, recentWinName, tier }) {
  const rules = []

  if (coldLeads?.count > 0 && coldLeads.leads[0]) {
    const l = coldLeads.leads[0]
    rules.push(`Follow up with ${l.doctor_name} — it’s been ${l.days_cold} day${l.days_cold !== 1 ? 's' : ''} since last contact.`)
  }
  if (coldLeads?.count > 1) {
    const rest = coldLeads.count - 1
    rules.push(`${rest} more cold lead${rest !== 1 ? 's' : ''} waiting behind that one — clear the list before it grows.`)
  }
  // Zero pipeline (no new leads *and* no new cases) is more foundational
  // than a stuck proposal or a WIP backlog — there's nothing downstream to
  // work if nothing's coming in, so it's checked ahead of those.
  if (Number(week.leads_created) === 0 && Number(week.cases_created || 0) === 0) {
    rules.push('No new leads or cases came in this week — block time for outreach before the pipeline stalls.')
  }
  if (month.proposals > 0 && month.wins === 0) {
    rules.push(`${month.proposals} proposal${month.proposals !== 1 ? 's' : ''} sent this month with no wins yet — a check-in could close one.`)
  }
  if (sales.wip > 0 && sales.wip > sales.billed) {
    rules.push(`$${sales.wip.toLocaleString()} sitting in WIP — check in on production to help convert it to billed.`)
  }
  if (previousWeek?.leads_created > 0 && week.leads_created < previousWeek.leads_created) {
    rules.push(`Lead creation dipped from last week (${previousWeek.leads_created} → ${week.leads_created}) — even one more this week reverses it.`)
  }
  if (recentWinName && (week.wins > 0 || month.wins > 0)) {
    rules.push(`Ask ${recentWinName} for a referral while the relationship is still warm.`)
  }
  if (month.leads_created >= 2 && month.conversion_rate >= 50) {
    rules.push(`Conversion is ${month.conversion_rate}% this month — well above average. Write down what’s working so you can repeat it.`)
  }
  if (month.leads_created >= 3 && month.conversion_rate < 20) {
    rules.push(`Conversion is ${month.conversion_rate}% this month — revisit how new leads get qualified before investing more follow-up time.`)
  }
  if (previousWeek && week.wins > previousWeek.wins) {
    rules.push(`Already ahead of last week’s ${previousWeek.wins} win${previousWeek.wins !== 1 ? 's' : ''} — one more keeps the streak building.`)
  }

  const picked = rules.slice(0, 3)
  if (picked.length < 3) {
    for (const f of FALLBACK_SUGGESTIONS[tier] || FALLBACK_SUGGESTIONS.amber) {
      if (picked.length >= 3) break
      picked.push(f)
    }
  }
  return picked
}

// Shared by GET /api/reports/my-summary, POST /api/reports/my-summary/email,
// and this file's sendRepWeeklyReport — one place computing a rep's
// week/month/all-time/sales-value numbers so the on-demand, admin-test, and
// automated versions of "my report" can never drift apart.
async function computeRepSummary(repId) {
  const now = new Date()
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString()
  const yearStart = new Date(now.getFullYear(), 0, 1).toISOString()
  const weekStartDate = (() => {
    const d = new Date(now)
    const day = d.getDay()
    d.setDate(d.getDate() - (day === 0 ? 6 : day - 1))
    d.setHours(0, 0, 0, 0)
    return d
  })()
  const weekStartISO = weekStartDate.toISOString()
  const prevWeekStartISO = new Date(weekStartDate.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString()
  // Same 14-day threshold as the cold_lead automation (services/automations.js)
  // and the admin dashboard's cold-leads widget — kept in sync deliberately,
  // so "cold" means the same thing everywhere in the app.
  const coldThreshold = new Date(now.getTime() - 14 * 24 * 60 * 60 * 1000).toISOString()

  const [weekRes, weekCasesRes, prevWeekRes, monthRes, allTimeRes, salesRes, coldRes, recentWinRes] = await Promise.all([
    db.query(
      `SELECT COUNT(*) AS leads_created, COUNT(*) FILTER (WHERE status='Won') AS wins,
        COUNT(*) FILTER (WHERE status IN ('Proposal','Won')) AS proposals,
        COUNT(*) FILTER (WHERE status IN ('Contacted','Proposal','Won')) AS contacted
       FROM leads WHERE assigned_to=$1 AND created_at >= $2`,
      [repId, weekStartISO]
    ),
    // Cases logged this week, same client-attribution join as the sales
    // query below — lets the report flag "nothing came in this week" (no
    // leads *and* no cases) as its own signal, not just "no cold leads."
    db.query(
      `SELECT COUNT(c.*) AS cases_created
       FROM cases c JOIN clients cl ON cl.doctor_name = c.client_name
       WHERE cl.assigned_to = $1 AND c.created_at >= $2`,
      [repId, weekStartISO]
    ),
    // Same shape as the current week, one week earlier — powers a genuine
    // week-over-week trend suggestion rather than a static tier template.
    db.query(
      `SELECT COUNT(*) AS leads_created, COUNT(*) FILTER (WHERE status='Won') AS wins
       FROM leads WHERE assigned_to=$1 AND created_at >= $2 AND created_at < $3`,
      [repId, prevWeekStartISO, weekStartISO]
    ),
    db.query(
      `SELECT COUNT(*) AS leads_created, COUNT(*) FILTER (WHERE status='Won') AS wins,
        COUNT(*) FILTER (WHERE status IN ('Proposal','Won')) AS proposals,
        COUNT(*) FILTER (WHERE status IN ('Contacted','Proposal','Won')) AS contacted,
        COALESCE(SUM(estimated_value) FILTER (WHERE status='Won'), 0) AS revenue
       FROM leads WHERE assigned_to=$1 AND created_at >= $2`,
      [repId, monthStart]
    ),
    db.query(
      `SELECT COUNT(*) FILTER (WHERE status NOT IN ('Won','Lost') AND is_archived=false) AS active_leads,
        COUNT(*) AS total_leads, COUNT(*) FILTER (WHERE status='Won') AS total_wins,
        COUNT(*) FILTER (WHERE status='Lost') AS total_lost,
        COALESCE(SUM(estimated_value) FILTER (WHERE status='Won'), 0) AS total_revenue
       FROM leads WHERE assigned_to=$1`,
      [repId]
    ),
    // Same join/derivation as the rep dashboard's Sales Value KPI card —
    // cases have no assigned_to of their own, attributed via their client.
    db.query(
      `SELECT COUNT(c.*) AS case_count,
        COALESCE(SUM(c.value) FILTER (WHERE c.status = 'Completed'), 0) AS billed,
        COALESCE(SUM(c.value) FILTER (WHERE c.status != 'Completed'), 0) AS wip,
        COALESCE(SUM(c.value), 0) AS total
       FROM cases c JOIN clients cl ON cl.doctor_name = c.client_name
       WHERE cl.assigned_to = $1 AND c.created_at >= $2`,
      [repId, yearStart]
    ),
    // COUNT(*) OVER() alongside a LIMIT gets the true total in one query,
    // rather than a separate COUNT(*) round trip.
    db.query(
      `SELECT id, doctor_name, clinic_name, status,
        COALESCE(last_contacted_at, created_at) AS last_touch,
        COUNT(*) OVER() AS total_cold
       FROM leads
       WHERE assigned_to=$1 AND status NOT IN ('Won','Lost') AND is_archived=false
         AND COALESCE(last_contacted_at, created_at) < $2
       ORDER BY COALESCE(last_contacted_at, created_at) ASC
       LIMIT 8`,
      [repId, coldThreshold]
    ),
    // Most recent win, for a suggestion personalized with a real name
    // ("ask Dr. X for a referral") instead of a generic "a recent win."
    db.query(
      `SELECT doctor_name FROM leads WHERE assigned_to=$1 AND status='Won'
       ORDER BY updated_at DESC LIMIT 1`,
      [repId]
    ),
  ])

  const week = weekRes.rows[0]
  const month = monthRes.rows[0]
  const allTime = allTimeRes.rows[0]
  const sales = salesRes.rows[0]
  const mTotal = Number(month.leads_created)
  const mWon = Number(month.wins)
  const aTotal = Number(allTime.total_leads)
  const aWon = Number(allTime.total_wins)

  const coldLeads = coldRes.rows.map(r => ({
    doctor_name: r.doctor_name,
    clinic_name: r.clinic_name,
    days_cold: Math.floor((now.getTime() - new Date(r.last_touch).getTime()) / 86400000),
  }))
  const coldCount = coldRes.rows[0] ? Number(coldRes.rows[0].total_cold) : 0
  const wWins = Number(week.wins)
  const wCreated = Number(week.leads_created)
  const wCases = Number(weekCasesRes.rows[0].cases_created)

  // A simple, explainable performance tier — drives the report's color
  // coding and coaching message. Weighted toward cold leads (the thing a
  // rep can act on *this week*) over lifetime totals, which don't move
  // week to week. Green requires some real activity this week (a win, a
  // new lead, or a new case) — zero cold leads alone isn't "on track" if
  // it's zero cold leads because nothing came in either.
  let tier
  if (coldCount === 0 && (wWins > 0 || wCreated > 0 || wCases > 0)) tier = 'green'
  else if (coldCount >= 3 || (wWins === 0 && mWon === 0)) tier = 'red'
  else tier = 'amber'

  const summary = {
    tier,
    coldLeads: { count: coldCount, leads: coldLeads },
    recentWinName: recentWinRes.rows[0]?.doctor_name || null,
    week: {
      leads_created: Number(week.leads_created),
      cases_created: Number(weekCasesRes.rows[0].cases_created),
      wins: Number(week.wins),
      proposals: Number(week.proposals),
      contacted: Number(week.contacted),
    },
    previousWeek: {
      leads_created: Number(prevWeekRes.rows[0].leads_created),
      wins: Number(prevWeekRes.rows[0].wins),
    },
    month: {
      leads_created: mTotal,
      wins: mWon,
      proposals: Number(month.proposals),
      contacted: Number(month.contacted),
      revenue: Number(month.revenue),
      conversion_rate: mTotal > 0 ? Math.round(mWon / mTotal * 100) : 0,
    },
    allTime: {
      active_leads: Number(allTime.active_leads),
      total_leads: aTotal,
      total_wins: aWon,
      total_lost: Number(allTime.total_lost),
      total_revenue: Number(allTime.total_revenue),
      conversion_rate: aTotal > 0 ? Math.round(aWon / aTotal * 100) : 0,
    },
    sales: {
      case_count: Number(sales.case_count),
      billed: Number(sales.billed),
      wip: Number(sales.wip),
      total: Number(sales.total),
    },
  }

  // Computed once here off the summary that's already been built — both
  // the email template and GET /api/reports/my-summary (the rep
  // dashboard's action-items card) read this same array, so the two can
  // never show different suggestions for the same rep at the same moment.
  summary.suggestions = personalizedSuggestions({
    week: summary.week,
    month: summary.month,
    previousWeek: summary.previousWeek,
    sales: summary.sales,
    coldLeads: summary.coldLeads,
    recentWinName: summary.recentWinName,
    tier: summary.tier,
  })

  return summary
}

function buildRepReportHtml(repName, summary, { test = false } = {}) {
  const now = new Date()
  const monthLabel = now.toLocaleString('en-US', { month: 'long', year: 'numeric' })
  const dateLabel = now.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })
  return { html: repReportEmail({ repName, dateLabel, monthLabel, ...summary, test }), monthLabel }
}

// Sends one rep's weekly report. `to`/`cc` overrides exist for the
// admin-triggered test send (routes/reports.js) — omit both to send to the
// rep's own address, cc'd to leadership, exactly as the Monday automated
// job below does. `test: true` prepends a "TEST" subject marker and a
// banner inside the email itself, so a real report can never be mistaken
// for one sent during testing (or vice versa) — a recipient should never
// have to guess which one they're looking at.
async function sendRepWeeklyReport(rep, { to, cc = REPORT_CC, test = false } = {}) {
  const summary = await computeRepSummary(rep.id)
  const { html, monthLabel } = buildRepReportHtml(rep.name || rep.email, summary, { test })
  await sendEmail({
    to: to || rep.email,
    ...(cc?.length ? { cc } : {}),
    subject: `${test ? 'TEST — ' : ''}Weekly Performance Report — ${rep.name || rep.email} — ${monthLabel}`,
    html,
  })
  return summary
}

// Monday-morning automated send (jobs/scheduler.js) — every staff/sales_rep
// user, cc'd to leadership. Best-effort per rep so one bad email/DB hiccup
// doesn't block the rest of the team's reports.
async function sendAllWeeklyRepReports() {
  const { rows: reps } = await db.query(
    `SELECT id, name, email FROM users WHERE role IN ('staff','sales_rep')`
  )
  const results = []
  for (const rep of reps) {
    try {
      await sendRepWeeklyReport(rep)
      results.push({ rep: rep.email, success: true })
    } catch (err) {
      console.error(`[weekly-rep-report] failed for ${rep.email}:`, err.message)
      results.push({ rep: rep.email, success: false, error: err.message })
    }
  }
  return results
}

module.exports = { computeRepSummary, buildRepReportHtml, sendRepWeeklyReport, sendAllWeeklyRepReports, REPORT_CC }
