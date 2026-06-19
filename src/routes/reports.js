const express = require('express')
const db = require('../config/db')
const auth = require('../middleware/auth')
const requireAdmin = require('../middleware/requireAdmin')

const router = express.Router()

// GET /api/dashboard — all data needed for the Dashboard page in one call
router.get('/dashboard', auth, async (req, res, next) => {
  try {
    const since7d = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString()
    const coldThreshold = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString()

    const [kpiRes, coldRes, recentRes, brandRes, intakeRes] = await Promise.all([
      db.query(`
        SELECT
          (SELECT COUNT(*) FROM leads WHERE status NOT IN ('Won','Lost')) AS active_leads,
          (SELECT COUNT(*) FROM clients) AS total_clients,
          (SELECT COALESCE(SUM(total_revenue),0) FROM clients) AS total_revenue,
          (SELECT COUNT(*) FROM leads WHERE status='Lost') AS lost_leads
      `),
      db.query(`
        SELECT * FROM leads
        WHERE status NOT IN ('Won','Lost')
          AND COALESCE(last_contacted_at, created_at) < $1
        ORDER BY last_contacted_at ASC NULLS FIRST LIMIT 5
      `, [coldThreshold]),
      db.query(`SELECT * FROM leads ORDER BY created_at DESC LIMIT 5`),
      db.query(`SELECT brand, total_revenue FROM clients`),
      db.query(`
        SELECT * FROM leads
        WHERE created_via='api' AND status='Lead' AND created_at >= $1
        ORDER BY created_at DESC LIMIT 10
      `, [since7d]),
    ])

    res.json({
      kpis: kpiRes.rows[0],
      cold_leads: coldRes.rows,
      recent_leads: recentRes.rows,
      brand_revenue: brandRes.rows,
      intake_leads: intakeRes.rows,
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
