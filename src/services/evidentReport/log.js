const db = require('../../config/db')

// Postgres-backed replacement for the standalone project's Google-Sheets
// log (sheetsLog.js). Same getHistory()/appendRow() shape buildReport.js
// already expects, so buildReport.js itself needed no changes — pg
// returns numeric/integer columns as strings, same as Sheet cells did,
// and buildReport.js already calls Number() on everything it compares.

async function getHistory() {
  const { rows } = await db.query(
    `SELECT id, to_char(date, 'YYYY-MM-DD') AS date, booked_daily_count, booked_daily_value,
            booked_mtd_count, booked_mtd_billed, booked_mtd_wip, booked_mtd_value,
            wip_cases, wip_value, aim_wip_value, kh_wip_value, james_wip_value, william_wip_value,
            ytd_billed_value, company_daily_booked_value, created_at
     FROM evident_report_log ORDER BY date DESC`
  )
  return rows
}

// The table's UNIQUE constraint on `date` means a same-day re-run of the
// pipeline fails loudly here (a real Postgres unique-violation error)
// rather than silently duplicating or overwriting a day's figures — this
// job should only ever run once per day.
async function appendRow(row) {
  await db.query(
    `INSERT INTO evident_report_log
     (date, booked_daily_count, booked_daily_value, booked_mtd_count, booked_mtd_billed,
      booked_mtd_wip, booked_mtd_value, wip_cases, wip_value, aim_wip_value, kh_wip_value,
      james_wip_value, william_wip_value, ytd_billed_value, company_daily_booked_value)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
    [
      row.date, row.booked_daily_count, row.booked_daily_value, row.booked_mtd_count,
      row.booked_mtd_billed, row.booked_mtd_wip, row.booked_mtd_value, row.wip_cases,
      row.wip_value, row.aim_wip_value, row.kh_wip_value, row.james_wip_value, row.william_wip_value,
      row.ytd_billed_value, row.company_daily_booked_value ?? null,
    ]
  )
}

module.exports = { getHistory, appendRow }
