const express = require('express')
const db = require('../config/db')
const auth = require('../middleware/auth')
const requireAdmin = require('../middleware/requireAdmin')
const { sendEmail, primaryFrontendUrl } = require('../services/email')
const {
  computeRepSummary, buildRepReportHtml, sendRepWeeklyReport, REPORT_CC,
} = require('../services/weeklyRepReport')
const {
  buildUnassignedLeadsReportHtml, sendUnassignedLeadsReport,
  REPORT_TO: UL_REPORT_TO, REPORT_CC: UL_REPORT_CC,
} = require('../services/unassignedLeadsReport')

const router = express.Router()

// GET /api/dashboard — matches both when mounted at /api/dashboard (path→/) or /api/reports (path→/dashboard)
router.get(['/', '/dashboard'], auth, async (req, res, next) => {
  try {
    const since7d = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString()
    const coldThreshold = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString()

    const [kpiRes, coldRes, recentRes, brandRes, intakeRes, casePipelineRes] = await Promise.all([
      db.query(`
        SELECT
          (SELECT COUNT(*) FROM leads WHERE status NOT IN ('Won','Lost') AND is_archived=false) AS active_leads,
          (SELECT COUNT(*) FROM clients) AS total_clients,
          (SELECT COALESCE(SUM(total_revenue),0) FROM clients) AS total_revenue,
          (SELECT COUNT(*) FROM leads WHERE status='Lost') AS lost_leads
      `),
      db.query(`
        SELECT * FROM leads
        WHERE status NOT IN ('Won','Lost') AND is_archived=false
          AND COALESCE(last_contacted_at, created_at) < $1
        ORDER BY last_contacted_at ASC NULLS FIRST LIMIT 5
      `, [coldThreshold]),
      db.query(`SELECT * FROM leads WHERE is_archived=false ORDER BY created_at DESC LIMIT 5`),
      db.query(`SELECT brand, total_revenue FROM clients`),
      db.query(`
        SELECT * FROM leads
        WHERE created_via='api' AND status='Lead' AND created_at >= $1
        ORDER BY created_at DESC LIMIT 10
      `, [since7d]),
      db.query(`
        SELECT status, COUNT(*) AS count FROM cases
        WHERE status != 'Completed'
        GROUP BY status ORDER BY status
      `).catch(() => ({ rows: [] })),
    ])

    res.json({
      kpis: kpiRes.rows[0],
      cold_leads: coldRes.rows,
      recent_leads: recentRes.rows,
      brand_revenue: brandRes.rows,
      intake_leads: intakeRes.rows,
      case_pipeline: casePipelineRes.rows,
    })
  } catch (err) { next(err) }
})

// GET /api/reports/overview
router.get('/overview', auth, requireAdmin, async (req, res, next) => {
  try {
    const yearStart = `${new Date().getFullYear()}-01-01`

    const [leadsRes, clientsRes, brandRes, topClientsRes] = await Promise.all([
      db.query(
        `SELECT
          COUNT(*) FILTER (WHERE created_at >= $1) AS ytd_leads,
          COUNT(*) FILTER (WHERE status='Won' AND created_at >= $1) AS ytd_won,
          COUNT(*) FILTER (WHERE status='Lost' AND created_at >= $1) AS ytd_lost,
          COALESCE(SUM(estimated_value) FILTER (WHERE status='Won' AND created_at >= $1),0) AS ytd_revenue
         FROM leads`,
        [yearStart]
      ),
      db.query('SELECT COUNT(*) AS active_clients FROM clients'),
      db.query(
        `SELECT brand, COALESCE(SUM(estimated_value),0) AS revenue
         FROM leads WHERE status='Won' GROUP BY brand`
      ),
      db.query(
        `SELECT doctor_name, clinic_name, total_revenue FROM clients ORDER BY total_revenue DESC LIMIT 5`
      ),
    ])

    const l = leadsRes.rows[0]
    const total = Number(l.ytd_leads)
    const won = Number(l.ytd_won)
    res.json({
      ytd_leads: total,
      ytd_won: won,
      ytd_lost: Number(l.ytd_lost),
      ytd_revenue: Number(l.ytd_revenue),
      active_clients: Number(clientsRes.rows[0].active_clients),
      conversion_rate: total > 0 ? Math.round((won / total) * 100) : 0,
      brand_revenue: brandRes.rows,
      top_clients: topClientsRes.rows,
    })
  } catch (err) { next(err) }
})

// GET /api/reports/trends  (last 12 months)
router.get('/trends', auth, requireAdmin, async (req, res, next) => {
  try {
    const { rows } = await db.query(
      `SELECT
        TO_CHAR(DATE_TRUNC('month', created_at), 'YYYY-MM') AS month,
        COUNT(*) AS leads,
        COUNT(*) FILTER (WHERE status='Won') AS won,
        COUNT(*) FILTER (WHERE status='Lost') AS lost,
        COALESCE(SUM(estimated_value) FILTER (WHERE status='Won'),0) AS revenue
       FROM leads
       WHERE created_at >= NOW() - INTERVAL '12 months'
       GROUP BY DATE_TRUNC('month', created_at)
       ORDER BY DATE_TRUNC('month', created_at)`
    )
    res.json(rows.map(r => ({
      ...r,
      leads: Number(r.leads),
      won: Number(r.won),
      lost: Number(r.lost),
      revenue: Number(r.revenue),
      conversion_rate: Number(r.leads) > 0 ? Math.round((Number(r.won) / Number(r.leads)) * 100) : 0,
    })))
  } catch (err) { next(err) }
})

// GET /api/reports/sources
router.get('/sources', auth, requireAdmin, async (req, res, next) => {
  try {
    const { brand } = req.query
    const params = []
    let filter = ''
    if (brand && brand !== 'All') { params.push(brand); filter = `AND brand=$${params.length}` }

    const { rows } = await db.query(
      `SELECT
        COALESCE(referral_source, lead_source, 'Unknown') AS source,
        COUNT(*) AS total,
        COUNT(*) FILTER (WHERE status='Won') AS won
       FROM leads WHERE 1=1 ${filter}
       GROUP BY source HAVING COUNT(*) >= 2
       ORDER BY total DESC`,
      params
    )
    const grandTotal = rows.reduce((s, r) => s + Number(r.total), 0)
    res.json(rows.map(r => ({
      source: r.source,
      count: Number(r.total),
      won: Number(r.won),
      pct: grandTotal > 0 ? Math.round((Number(r.total) / grandTotal) * 100) : 0,
      conversion_rate: Number(r.total) > 0 ? Math.round((Number(r.won) / Number(r.total)) * 100) : 0,
    })))
  } catch (err) { next(err) }
})

// GET /api/reports/top-performers
router.get('/top-performers', auth, requireAdmin, async (req, res, next) => {
  try {
    const [clientsRes, caseTypesRes, bestSourceRes] = await Promise.all([
      db.query('SELECT doctor_name, clinic_name, brand, total_revenue FROM clients ORDER BY total_revenue DESC LIMIT 10'),
      db.query(
        `SELECT case_interest AS case_type, COUNT(*) AS count,
          COUNT(*) FILTER (WHERE status='Won') AS won,
          COALESCE(SUM(estimated_value) FILTER (WHERE status='Won'),0) AS value
         FROM leads WHERE case_interest != ''
         GROUP BY case_interest ORDER BY count DESC`
      ),
      db.query(
        `SELECT COALESCE(referral_source, lead_source) AS source,
          COUNT(*) AS total, COUNT(*) FILTER (WHERE status='Won') AS won
         FROM leads GROUP BY source HAVING COUNT(*) >= 2
         ORDER BY (COUNT(*) FILTER (WHERE status='Won')::float / COUNT(*)) DESC LIMIT 1`
      ),
    ])
    res.json({
      top_clients: clientsRes.rows,
      case_types: caseTypesRes.rows.map(r => ({ ...r, count: Number(r.count), won: Number(r.won), value: Number(r.value) })),
      best_source: bestSourceRes.rows[0] || null,
    })
  } catch (err) { next(err) }
})

// POST /api/reports/send — generate + email a summary report
router.post('/send', auth, requireAdmin, async (req, res, next) => {
  try {
    const { email } = req.body
    if (!email || !email.includes('@')) return res.status(400).json({ error: 'Valid email is required' })

    const yearStart = `${new Date().getFullYear()}-01-01`
    const coldThreshold = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString()

    const [kpiRes, ytdRes, brandRes, topRes, coldRes, caseRes] = await Promise.all([
      db.query(`
        SELECT
          (SELECT COUNT(*) FROM leads WHERE status NOT IN ('Won','Lost')) AS active_leads,
          (SELECT COUNT(*) FROM leads WHERE status='Won') AS total_won,
          (SELECT COUNT(*) FROM leads WHERE status='Lost') AS total_lost,
          (SELECT COUNT(*) FROM clients) AS total_clients,
          (SELECT COALESCE(SUM(total_revenue),0) FROM clients) AS total_revenue
      `),
      db.query(`
        SELECT
          COUNT(*) AS ytd_leads,
          COUNT(*) FILTER (WHERE status='Won') AS ytd_won,
          COUNT(*) FILTER (WHERE status='Lost') AS ytd_lost
        FROM leads WHERE created_at >= $1
      `, [yearStart]),
      db.query(`SELECT brand, COALESCE(SUM(total_revenue),0) AS revenue FROM clients GROUP BY brand ORDER BY revenue DESC`),
      db.query(`SELECT doctor_name, clinic_name, total_revenue FROM clients ORDER BY total_revenue DESC LIMIT 5`),
      db.query(`
        SELECT COUNT(*) AS count FROM leads
        WHERE status NOT IN ('Won','Lost') AND COALESCE(last_contacted_at, created_at) < $1
      `, [coldThreshold]),
      db.query(`SELECT COUNT(*) AS overdue FROM cases WHERE due_date < NOW() AND status != 'Delivered'`).catch(() => ({ rows: [{ overdue: 0 }] })),
    ])

    const kpi = { ...kpiRes.rows[0], open_cases: caseRes.rows[0]?.overdue ?? 0 }
    const ytd = ytdRes.rows[0]
    const total = Number(ytd.ytd_leads)
    const won = Number(ytd.ytd_won)
    const convRate = total > 0 ? Math.round((won / total) * 100) : 0
    const now = new Date()
    const month = now.toLocaleString('en-US', { month: 'long', year: 'numeric' })

    const brandRows = brandRes.rows.map(b =>
      `<tr>
        <td style="padding:8px 12px;border-bottom:1px solid #f3f4f6">${b.brand}</td>
        <td style="padding:8px 12px;border-bottom:1px solid #f3f4f6;font-weight:600;color:#06babe">$${Number(b.revenue).toLocaleString()}</td>
      </tr>`
    ).join('')

    const topRows = topRes.rows.map((c, i) =>
      `<tr>
        <td style="padding:8px 12px;border-bottom:1px solid #f3f4f6;color:#9ca3af">${i + 1}</td>
        <td style="padding:8px 12px;border-bottom:1px solid #f3f4f6;font-weight:600">${c.doctor_name}</td>
        <td style="padding:8px 12px;border-bottom:1px solid #f3f4f6;color:#6b7280">${c.clinic_name || '—'}</td>
        <td style="padding:8px 12px;border-bottom:1px solid #f3f4f6;font-weight:600;color:#06babe">$${Number(c.total_revenue).toLocaleString()}</td>
      </tr>`
    ).join('')

    const html = `
      <!DOCTYPE html>
      <html><body style="margin:0;padding:0;background:#f9fafb;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif">
      <div style="max-width:640px;margin:40px auto;background:#fff;border-radius:16px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,.08)">

        <!-- Header -->
        <div style="background:linear-gradient(135deg,#06babe,#207290);padding:28px 32px">
          <p style="color:rgba(255,255,255,0.8);font-size:13px;margin:0 0 4px">Aim Dental Laboratory</p>
          <h1 style="color:#fff;margin:0;font-size:22px;font-weight:700">CRM Summary Report</h1>
          <p style="color:rgba(255,255,255,0.75);margin:6px 0 0;font-size:14px">${month} · Generated ${now.toLocaleDateString('en-US', { weekday:'long', month:'long', day:'numeric' })}</p>
        </div>

        <!-- KPI Row -->
        <div style="display:flex;padding:24px 32px;gap:0;background:#f9fafb;border-bottom:1px solid #f3f4f6">
          ${[
            ['Active Leads', kpi.active_leads, '#06babe'],
            ['Total Clients', kpi.total_clients, '#207290'],
            ['Total Revenue', `$${Number(kpi.total_revenue).toLocaleString()}`, '#16a34a'],
            ['Open Cases', kpi.open_cases, '#6b7280'],
          ].map(([label, val, color]) => `
            <div style="flex:1;text-align:center;padding:12px 8px">
              <p style="margin:0;font-size:22px;font-weight:700;color:${color}">${val}</p>
              <p style="margin:4px 0 0;font-size:11px;color:#9ca3af;text-transform:uppercase;letter-spacing:.05em">${label}</p>
            </div>
          `).join('')}
        </div>

        <div style="padding:28px 32px">

          <!-- YTD Performance -->
          <h2 style="color:#111;font-size:16px;margin:0 0 16px;padding-bottom:8px;border-bottom:2px solid #06babe">${now.getFullYear()} Performance</h2>
          <div style="display:flex;gap:16px;margin-bottom:28px">
            ${[
              ['Leads Generated', total],
              ['Leads Won', won, '#16a34a'],
              ['Leads Lost', Number(ytd.ytd_lost), '#ef4444'],
              ['Conversion Rate', `${convRate}%`, convRate >= 50 ? '#16a34a' : '#f59e0b'],
            ].map(([label, val, color='#111']) => `
              <div style="flex:1;background:#f9fafb;border-radius:10px;padding:14px;text-align:center">
                <p style="margin:0;font-size:20px;font-weight:700;color:${color}">${val}</p>
                <p style="margin:4px 0 0;font-size:11px;color:#9ca3af">${label}</p>
              </div>
            `).join('')}
          </div>

          <!-- Revenue by Brand -->
          <h2 style="color:#111;font-size:16px;margin:0 0 12px;padding-bottom:8px;border-bottom:2px solid #06babe">Revenue by Brand</h2>
          <table style="width:100%;border-collapse:collapse;font-size:14px;margin-bottom:28px">
            <thead><tr style="background:#f9fafb">
              <th style="text-align:left;padding:8px 12px;color:#6b7280;font-weight:600">Brand</th>
              <th style="text-align:left;padding:8px 12px;color:#6b7280;font-weight:600">Revenue</th>
            </tr></thead>
            <tbody>${brandRows}</tbody>
          </table>

          <!-- Top Clients -->
          <h2 style="color:#111;font-size:16px;margin:0 0 12px;padding-bottom:8px;border-bottom:2px solid #06babe">Top 5 Clients</h2>
          <table style="width:100%;border-collapse:collapse;font-size:14px;margin-bottom:28px">
            <thead><tr style="background:#f9fafb">
              <th style="text-align:left;padding:8px 12px;color:#6b7280;font-weight:600">#</th>
              <th style="text-align:left;padding:8px 12px;color:#6b7280;font-weight:600">Doctor</th>
              <th style="text-align:left;padding:8px 12px;color:#6b7280;font-weight:600">Clinic</th>
              <th style="text-align:left;padding:8px 12px;color:#6b7280;font-weight:600">Revenue</th>
            </tr></thead>
            <tbody>${topRows}</tbody>
          </table>

          <!-- Alerts -->
          <div style="background:#fff8f0;border:1px solid #fed7aa;border-radius:10px;padding:16px 20px;margin-bottom:8px">
            <p style="margin:0;font-size:14px;color:#92400e">
              ⚠ <strong>${Number(coldRes.rows[0].count)} cold lead${Number(coldRes.rows[0].count) !== 1 ? 's' : ''}</strong> need follow-up (no contact in 14+ days)
              &nbsp;&nbsp;·&nbsp;&nbsp;
              🔴 <strong>${Number(caseRes.rows[0].overdue)} overdue case${Number(caseRes.rows[0].overdue) !== 1 ? 's' : ''}</strong> past due date
            </p>
          </div>

        </div>

        <!-- CTA -->
        <div style="padding:0 32px 28px">
          <a href="${primaryFrontendUrl()}/dashboard" style="display:inline-block;background:#06babe;color:#fff;padding:12px 28px;border-radius:10px;text-decoration:none;font-weight:600;font-size:14px">Open CRM Dashboard →</a>
        </div>

        <!-- Footer -->
        <div style="background:#f9fafb;padding:16px 32px;font-size:12px;color:#9ca3af;border-top:1px solid #f3f4f6">
          Aim Dental Laboratory CRM · This report was requested by ${req.user.name || req.user.email}
        </div>
      </div>
      </body></html>
    `

    await sendEmail({ to: email, subject: `Aim Dental CRM — ${month} Summary Report`, html })
    res.json({ success: true, message: `Report sent to ${email}` })
  } catch (err) { next(err) }
})

// GET /api/reports/operations
router.get('/operations', auth, requireAdmin, async (req, res, next) => {
  try {
    const [volumeRes, techRes, caseTypeRes, stageRes] = await Promise.all([
      db.query(`
        SELECT
          COUNT(*) AS total_cases,
          COUNT(*) FILTER (WHERE status='Completed') AS completed,
          COUNT(*) FILTER (WHERE status NOT IN ('Completed','Dispatched')) AS active,
          COUNT(*) FILTER (WHERE due_date < NOW() AND status != 'Completed') AS overdue,
          COALESCE(SUM(value),0) AS total_value,
          COALESCE(AVG(value),0) AS avg_value
        FROM cases
      `),
      db.query(`
        SELECT
          COALESCE(assigned_technician, 'Unassigned') AS technician,
          COUNT(*) AS total,
          COUNT(*) FILTER (WHERE status='Completed') AS completed,
          COALESCE(SUM(value),0) AS value
        FROM cases
        GROUP BY assigned_technician ORDER BY total DESC
      `),
      db.query(`
        SELECT
          case_type, COUNT(*) AS total,
          COUNT(*) FILTER (WHERE status='Completed') AS completed,
          COALESCE(AVG(value),0) AS avg_value,
          COALESCE(SUM(value),0) AS total_value
        FROM cases WHERE case_type IS NOT NULL AND case_type != ''
        GROUP BY case_type ORDER BY total DESC
      `),
      db.query(`
        SELECT status, COUNT(*) AS count, COALESCE(SUM(value),0) AS value
        FROM cases GROUP BY status ORDER BY status
      `),
    ])
    res.json({
      volume: volumeRes.rows[0],
      technicians: techRes.rows.map(r => ({ ...r, total: Number(r.total), completed: Number(r.completed), value: Number(r.value) })),
      case_types: caseTypeRes.rows.map(r => ({ ...r, total: Number(r.total), completed: Number(r.completed), avg_value: Number(r.avg_value), total_value: Number(r.total_value) })),
      by_stage: stageRes.rows.map(r => ({ ...r, count: Number(r.count), value: Number(r.value) })),
    })
  } catch (err) { next(err) }
})

// GET /api/reports/my-summary — rep-scoped KPIs and recent leads
router.get('/my-summary', auth, async (req, res, next) => {
  try {
    const summary = await computeRepSummary(req.user.id)
    const { rows: recentLeads } = await db.query(
      `SELECT doctor_name, clinic_name, status, estimated_value, created_at
       FROM leads WHERE assigned_to=$1 AND is_archived=false
       ORDER BY created_at DESC LIMIT 10`,
      [req.user.id]
    )
    res.json({
      ...summary,
      recent_leads: recentLeads,
      rep: { id: req.user.id, name: req.user.name, email: req.user.email },
    })
  } catch (err) { next(err) }
})

// POST /api/reports/my-summary/email — email the rep's own weekly report to
// themselves, no cc. (The Monday automated send to every rep, cc'd to
// leadership, lives in jobs/scheduler.js via sendAllWeeklyRepReports.)
router.post('/my-summary/email', auth, async (req, res, next) => {
  try {
    await sendRepWeeklyReport(
      { id: req.user.id, name: req.user.name, email: req.user.email },
      { cc: [] }
    )
    res.json({ success: true, message: `Report sent to ${req.user.email}` })
  } catch (err) { next(err) }
})

// GET /api/reports/weekly-rep-report/preview?rep_id=... — admin-only HTML
// preview of exactly what a rep's weekly report email looks like, without
// sending anything. Defaults to the requesting admin's own data if rep_id
// is omitted.
router.get('/weekly-rep-report/preview', auth, requireAdmin, async (req, res, next) => {
  try {
    const repId = req.query.rep_id || req.user.id
    const { rows } = await db.query(`SELECT id, name, email FROM users WHERE id=$1`, [repId])
    if (!rows[0]) return res.status(404).json({ error: 'Rep not found' })
    const summary = await computeRepSummary(repId)
    const { html } = buildRepReportHtml(rows[0].name || rows[0].email, summary)
    res.set('Content-Type', 'text/html').send(html)
  } catch (err) { next(err) }
})

// POST /api/reports/weekly-rep-report/send — admin-only manual trigger.
// Body: { rep_id, to?, include_cc?, test? }. Omit `to` to send to the rep's
// own address; pass it to redirect the send elsewhere (a test to the
// admin's own inbox, say) without changing whose numbers are reported.
// `include_cc` defaults true (the real leadership cc list) — set false for
// a quiet dry run. `test` (default false) marks the send with a "TEST —"
// subject prefix and a banner inside the email itself, so it can never be
// mistaken for a real report landing in someone's inbox.
router.post('/weekly-rep-report/send', auth, requireAdmin, async (req, res, next) => {
  try {
    const { rep_id, to, include_cc = true, test = false } = req.body
    if (!rep_id) return res.status(400).json({ error: 'rep_id is required' })
    const { rows } = await db.query(
      `SELECT id, name, email FROM users WHERE id=$1 AND role IN ('staff','sales_rep')`, [rep_id]
    )
    if (!rows[0]) return res.status(400).json({ error: 'rep_id must be an existing staff/sales_rep user' })

    await sendRepWeeklyReport(rows[0], { to, cc: include_cc ? REPORT_CC : [], test })
    res.json({ success: true, message: `${test ? 'Test report' : 'Report'} sent to ${to || rows[0].email}${include_cc ? ` (cc: ${REPORT_CC.join(', ')})` : ''}` })
  } catch (err) { next(err) }
})

// GET /api/reports/unassigned-leads-report/preview — admin-only HTML
// preview of the Monday-morning unassigned-leads report, without sending.
router.get('/unassigned-leads-report/preview', auth, requireAdmin, async (req, res, next) => {
  try {
    const { html } = await buildUnassignedLeadsReportHtml()
    res.set('Content-Type', 'text/html').send(html)
  } catch (err) { next(err) }
})

// POST /api/reports/unassigned-leads-report/send — admin-only manual
// trigger. Body: { to?, include_cc?, test? } — same shape/defaults as
// weekly-rep-report/send above. `to` defaults to UL_REPORT_TO
// (media@aimdentallab.com); `include_cc` (default true) is the real
// UL_REPORT_CC leadership list; `test` marks the send clearly so it can't
// be mistaken for the real weekly report.
router.post('/unassigned-leads-report/send', auth, requireAdmin, async (req, res, next) => {
  try {
    const { to, include_cc = true, test = false } = req.body
    const result = await sendUnassignedLeadsReport({
      to: to || undefined,
      cc: include_cc ? UL_REPORT_CC : [],
      test,
    })
    res.json({
      success: true,
      message: `${test ? 'Test report' : 'Report'} (${result.count} lead${result.count === 1 ? '' : 's'}) sent to ${to || UL_REPORT_TO}${include_cc ? ` (cc: ${UL_REPORT_CC.join(', ')})` : ''}`,
    })
  } catch (err) { next(err) }
})

// GET /api/reports/my-summary/csv — rep leads as downloadable CSV
router.get('/my-summary/csv', auth, async (req, res, next) => {
  try {
    const { rows } = await db.query(
      `SELECT doctor_name, clinic_name, brand, case_interest, status, estimated_value, intent_level, lead_source, created_at
       FROM leads WHERE assigned_to=$1 AND is_archived=false ORDER BY created_at DESC`,
      [req.user.id]
    )
    const headers = ['Doctor Name', 'Clinic', 'Brand', 'Case Interest', 'Status', 'Value', 'Intent', 'Source', 'Created']
    const csvLines = [
      headers.join(','),
      ...rows.map(r => [
        `"${(r.doctor_name || '').replace(/"/g, '""')}"`,
        `"${(r.clinic_name || '').replace(/"/g, '""')}"`,
        r.brand || '',
        r.case_interest || '',
        r.status || '',
        r.estimated_value || 0,
        r.intent_level || '',
        r.lead_source || '',
        new Date(r.created_at).toLocaleDateString('en-US'),
      ].join(','))
    ]
    const safeName = (req.user.name || req.user.id).replace(/\s+/g, '-')
    res.setHeader('Content-Type', 'text/csv')
    res.setHeader('Content-Disposition', `attachment; filename="my-leads-${safeName}.csv"`)
    res.send(csvLines.join('\n'))
  } catch (err) { next(err) }
})

// GET /api/reports/team-comparison — admin: side-by-side rep stats by period
router.get('/team-comparison', auth, requireAdmin, async (req, res, next) => {
  try {
    const { rows: reps } = await db.query(
      "SELECT id, name, email, role FROM users WHERE role IN ('staff','sales_rep') ORDER BY name"
    )
    const now = new Date()

    const weekStart = (() => {
      const d = new Date(now)
      const day = d.getDay()
      d.setDate(d.getDate() - (day === 0 ? 6 : day - 1))
      d.setHours(0, 0, 0, 0)
      return d
    })()
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1)
    const quarterStart = new Date(now.getFullYear(), Math.floor(now.getMonth() / 3) * 3, 1)

    const getStats = async (repId, start) => {
      const { rows: [r] } = await db.query(
        `SELECT
          COUNT(*) AS leads_assigned,
          COUNT(*) FILTER (WHERE status='Won') AS leads_won,
          COUNT(*) FILTER (WHERE status IN ('Proposal','Won')) AS proposals_sent,
          COUNT(*) FILTER (WHERE status IN ('Contacted','Proposal','Won')) AS leads_contacted
         FROM leads WHERE assigned_to=$1 AND created_at >= $2`,
        [repId, start]
      )
      const total = Number(r.leads_assigned)
      const won = Number(r.leads_won)
      return {
        leads_assigned: total,
        leads_won: won,
        proposals_sent: Number(r.proposals_sent),
        leads_contacted: Number(r.leads_contacted),
        conversion_rate: total > 0 ? Math.round(won / total * 100) : 0,
      }
    }

    // Existing book of business — current state, not scoped to any one
    // period like the stats above, so it's computed once per rep and shown
    // regardless of which week/month/quarter tab is selected. cases has no
    // assigned_to of its own (see import-evident's comment in cases.js), so
    // a rep's cases are found via their clients' doctor_name, same join
    // used everywhere else a rep's case data is derived from clients.
    const getBook = async (repId) => {
      const { rows: [r] } = await db.query(
        `SELECT
          (SELECT COUNT(*) FROM clients WHERE assigned_to=$1) AS clients_count,
          (SELECT COUNT(*) FROM cases WHERE client_name IN (SELECT doctor_name FROM clients WHERE assigned_to=$1)) AS cases_count`,
        [repId]
      )
      return { clients_count: Number(r.clients_count), cases_count: Number(r.cases_count) }
    }

    const result = await Promise.all(reps.map(async (rep) => {
      const [week, month, quarter, book] = await Promise.all([
        getStats(rep.id, weekStart),
        getStats(rep.id, monthStart),
        getStats(rep.id, quarterStart),
        getBook(rep.id),
      ])
      return { rep, week, month, quarter, ...book }
    }))

    res.json(result)
  } catch (err) { next(err) }
})

// GET /api/reports/rep/:id/activities — admin-only, Rep Detail page's
// merged activity feed. `activities.entity_id` is polymorphic (lead,
// client, or case row depending on entity_type — see v3-migration.sql),
// so "this rep's activity" has to be assembled as a UNION across all three
// ownership paths rather than one join: leads/clients are owned directly
// via assigned_to, cases via the same clients.doctor_name = cases.client_name
// bridge used everywhere else a case's rep has to be derived.
router.get('/rep/:id/activities', auth, requireAdmin, async (req, res, next) => {
  try {
    const { id } = req.params
    const { rows } = await db.query(
      `SELECT a.id, a.entity_type, a.entity_id, a.type, a.description, a.created_at, u.name AS created_by_name
       FROM activities a
       JOIN leads l ON a.entity_type='lead' AND a.entity_id=l.id
       LEFT JOIN users u ON u.id = a.created_by
       WHERE l.assigned_to = $1
       UNION ALL
       SELECT a.id, a.entity_type, a.entity_id, a.type, a.description, a.created_at, u.name AS created_by_name
       FROM activities a
       JOIN clients c ON a.entity_type='client' AND a.entity_id=c.id
       LEFT JOIN users u ON u.id = a.created_by
       WHERE c.assigned_to = $1
       UNION ALL
       SELECT a.id, a.entity_type, a.entity_id, a.type, a.description, a.created_at, u.name AS created_by_name
       FROM activities a
       JOIN cases ca ON a.entity_type='case' AND a.entity_id=ca.id
       JOIN clients c2 ON c2.doctor_name = ca.client_name
       LEFT JOIN users u ON u.id = a.created_by
       WHERE c2.assigned_to = $1
       ORDER BY created_at DESC
       LIMIT 50`,
      [id]
    )
    res.json(rows)
  } catch (err) { next(err) }
})

// GET /api/reports/import-history
router.get('/import-history', auth, requireAdmin, async (req, res, next) => {
  try {
    const { rows } = await db.query(
      `SELECT ih.*, u.name AS imported_by_name
       FROM import_history ih
       LEFT JOIN users u ON u.id = ih.imported_by
       ORDER BY ih.created_at DESC`
    )
    res.json(rows)
  } catch (err) { next(err) }
})

module.exports = router
