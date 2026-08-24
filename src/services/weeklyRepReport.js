const db = require('../config/db')
const { sendEmail, repReportEmail } = require('./email')

// Weekly report is cc'd to leadership on every automated send — the same
// three inboxes for every rep, not configurable per rep.
const REPORT_CC = ['media@aimdentallab.com', 'execassistant@aimdentallab.com', 'ben@aimdentallab.com']

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

  return {
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
