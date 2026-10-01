const db = require('../config/db')

// Looks up which rep covers a given US state via rep_territories.state_codes
// (a text[] column) — real territory data, not geocoding: James covers NY,
// William covers CA (user-confirmed, 2026-10-01). Returns null for no match
// (an unassigned booking) rather than guessing a default rep.
async function matchRepByState(state) {
  if (!state) return null
  const { rows } = await db.query(
    `SELECT u.id, u.name, u.email
     FROM rep_territories rt
     JOIN users u ON u.id = rt.rep_id
     WHERE $1 = ANY (SELECT UPPER(s) FROM unnest(rt.state_codes) AS s)
     LIMIT 1`,
    [state.toUpperCase()]
  )
  return rows[0] || null
}

module.exports = { matchRepByState }
