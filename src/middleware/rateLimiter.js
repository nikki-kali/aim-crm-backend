// Minimal in-memory sliding-window rate limiter — no new dependency needed
// for a single-instance Render deployment. Keyed by IP; resets on restart.
// Not suitable for a multi-instance deployment (state isn't shared), but
// fine for this backend's current single-dyno setup.
function rateLimiter({ windowMs, max }) {
  const hits = new Map() // ip -> array of request timestamps

  return (req, res, next) => {
    const ip = req.ip || 'unknown'
    const now = Date.now()
    const windowStart = now - windowMs

    const timestamps = (hits.get(ip) || []).filter((t) => t > windowStart)
    if (timestamps.length >= max) {
      return res.status(429).json({ error: 'Too many requests. Please try again later.' })
    }

    timestamps.push(now)
    hits.set(ip, timestamps)

    // Opportunistic cleanup so the map doesn't grow unbounded
    if (hits.size > 5000) {
      for (const [key, times] of hits) {
        if (!times.some((t) => t > windowStart)) hits.delete(key)
      }
    }

    next()
  }
}

module.exports = rateLimiter
