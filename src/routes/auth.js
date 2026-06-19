const express = require('express')
const bcrypt = require('bcryptjs')
const jwt = require('jsonwebtoken')
const db = require('../config/db')
const auth = require('../middleware/auth')

const router = express.Router()

// POST /api/auth/login
router.post('/login', async (req, res, next) => {
  try {
    const { email, password } = req.body
    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password are required' })
    }

    const { rows } = await db.query(
      'SELECT id, email, name, role, password_hash FROM users WHERE email = $1',
      [email.toLowerCase().trim()]
    )
    const user = rows[0]
    if (!user) return res.status(401).json({ error: 'Invalid email or password' })

    const valid = await bcrypt.compare(password, user.password_hash)
    if (!valid) return res.status(401).json({ error: 'Invalid email or password' })

    const payload = { id: user.id, email: user.email, name: user.name, role: user.role }
    const token = jwt.sign(payload, process.env.JWT_SECRET, {
      expiresIn: process.env.JWT_EXPIRY || '24h',
    })

    res.json({ token, user: payload })
  } catch (err) {
    next(err)
  }
})

// GET /api/auth/me
router.get('/me', auth, (req, res) => {
  res.json({ user: req.user })
})

module.exports = router
