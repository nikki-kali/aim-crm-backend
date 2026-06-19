const express = require('express')
const bcrypt = require('bcryptjs')
const db = require('../config/db')
const auth = require('../middleware/auth')
const requireAdmin = require('../middleware/requireAdmin')

const router = express.Router()

router.get('/', auth, requireAdmin, async (req, res, next) => {
  try {
    const { rows } = await db.query(
      'SELECT id, email, name, role, created_at FROM users ORDER BY created_at'
    )
    res.json(rows)
  } catch (err) { next(err) }
})

router.post('/', auth, requireAdmin, async (req, res, next) => {
  try {
    const { email, password, name, role } = req.body
    if (!email || !password) return res.status(400).json({ error: 'Email and password are required' })
    const hash = await bcrypt.hash(password, 12)
    const { rows } = await db.query(
      'INSERT INTO users (email, password_hash, name, role) VALUES ($1,$2,$3,$4) RETURNING id, email, name, role',
      [email.toLowerCase().trim(), hash, name || '', role || 'staff']
    )
    res.status(201).json(rows[0])
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'Email already exists' })
    next(err)
  }
})

router.put('/:id', auth, requireAdmin, async (req, res, next) => {
  try {
    const { name, role, password } = req.body
    if (password) {
      const hash = await bcrypt.hash(password, 12)
      await db.query('UPDATE users SET password_hash=$1 WHERE id=$2', [hash, req.params.id])
    }
    const { rows } = await db.query(
      'UPDATE users SET name=$1, role=$2 WHERE id=$3 RETURNING id, email, name, role',
      [name, role, req.params.id]
    )
    if (!rows[0]) return res.status(404).json({ error: 'User not found' })
    res.json(rows[0])
  } catch (err) { next(err) }
})

router.delete('/:id', auth, requireAdmin, async (req, res, next) => {
  try {
    if (req.user.id === req.params.id) return res.status(400).json({ error: 'Cannot delete yourself' })
    await db.query('DELETE FROM users WHERE id=$1', [req.params.id])
    res.json({ success: true })
  } catch (err) { next(err) }
})

module.exports = router
