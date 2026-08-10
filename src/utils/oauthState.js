const jwt = require('jsonwebtoken')

// Signs/verifies the OAuth `state` param for the Social Connections flow
// (routes/socialConnections.js) — reuses the jsonwebtoken dependency
// middleware/auth.js already depends on, rather than hand-rolling HMAC
// signing. This is what protects the handshake against CSRF without a
// server-side session store: the state a provider echoes back on
// callback must be one this server actually signed, and it self-expires
// so a stale/replayed callback link doesn't work.

function signOAuthState(payload) {
  return jwt.sign(payload, process.env.SOCIAL_OAUTH_STATE_SECRET, { expiresIn: '10m' })
}

function verifyOAuthState(token) {
  return jwt.verify(token, process.env.SOCIAL_OAUTH_STATE_SECRET)
}

module.exports = { signOAuthState, verifyOAuthState }
