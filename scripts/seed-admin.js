/**
 * One-time script to create the first admin user.
 * Usage: node scripts/seed-admin.js
 * Set ADMIN_EMAIL and ADMIN_PASSWORD as env vars or edit below.
 */
require('dotenv').config({ path: require('path').join(__dirname, '../.env') })
const bcrypt = require('bcryptjs')
const db = require('../src/config/db')

async function seed() {
  const email = process.env.ADMIN_EMAIL || 'admin@aimdentallab.com'
  const password = process.env.ADMIN_PASSWORD || 'ChangeMe123!'
  const name = process.env.ADMIN_NAME || 'Admin'

  const hash = await bcrypt.hash(password, 12)
  await db.query(
    `INSERT INTO users (email, password_hash, name, role)
     VALUES ($1, $2, $3, 'admin')
     ON CONFLICT (email) DO UPDATE SET password_hash=$2, role='admin'`,
    [email, hash, name]
  )
  console.log(`✓ Admin user created/updated: ${email}`)
  await db.end()
}

seed().catch(err => { console.error(err); process.exit(1) })
