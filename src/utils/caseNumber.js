const db = require('../config/db')

async function generateCaseNumber(brand) {
  const prefix = brand === 'Aim Dental' ? 'AIM' : 'KH'
  const year = new Date().getFullYear()
  const { rows } = await db.query('SELECT COUNT(*) FROM cases')
  const count = parseInt(rows[0].count, 10)
  return `${prefix}-${year}-${String(count + 1).padStart(3, '0')}`
}

module.exports = { generateCaseNumber }
