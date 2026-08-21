const express = require('express')
const cors = require('cors')
const rateLimiter = require('../middleware/rateLimiter')
const { requestVerification, confirmVerification } = require('../services/emailVerification')

const router = express.Router()

// Public, browser-facing — same reasoning as webLeads.js/trackCase.js:
// mounted in app.js before the global CORS policy, so it's self-contained
// here too.
router.use(cors())
router.use(express.json({ limit: '4kb' }))

// POST /api/verify-email/request — first-time-email gate for the Schedule
// Pickup and Submit a Scanned Case forms. Stricter limit than most public
// endpoints since each call can trigger an email send; still generous
// enough for a doctor re-requesting a code a couple times.
router.post('/request', rateLimiter({ windowMs: 10 * 60 * 1000, max: 5 }), async (req, res, next) => {
  try {
    const { email } = req.body
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email || '')) {
      return res.status(400).json({ error: 'a valid email is required' })
    }
    const result = await requestVerification(email)
    res.json(result)
  } catch (err) {
    next(err)
  }
})

// POST /api/verify-email/confirm — a higher ceiling than /request since a
// legitimate doctor might mistype a 6-digit code a couple times; the
// service layer's own MAX_ATTEMPTS-per-code limit is the tighter guard
// against brute-forcing a single code.
router.post('/confirm', rateLimiter({ windowMs: 10 * 60 * 1000, max: 20 }), (req, res) => {
  const { email, code } = req.body
  if (!email || !code) {
    return res.status(400).json({ error: 'email and code are required' })
  }
  const result = confirmVerification(email, code)
  if (!result.success) {
    return res.status(400).json({ error: result.error })
  }
  res.json({ success: true, token: result.token })
})

module.exports = router
