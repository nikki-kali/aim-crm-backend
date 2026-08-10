// X (Twitter) API v2 — OAuth 2.0 with PKCE, required by X regardless of
// client type. The PKCE code_verifier itself is generated and tracked by
// routes/socialConnections.js (a short-lived in-memory map keyed by the
// state nonce) — this module only turns a verifier into a challenge and
// does the token/account calls, it doesn't generate or store the verifier.

const crypto = require('crypto')

function redirectUri() {
  return `${process.env.BACKEND_PUBLIC_URL}/api/social-connections/x/callback`
}

function basicAuthHeader() {
  return 'Basic ' + Buffer.from(`${process.env.X_CLIENT_ID}:${process.env.X_CLIENT_SECRET}`).toString('base64')
}

// S256 code_challenge derived from a code_verifier, per RFC 7636 —
// base64url, no padding.
function codeChallengeFor(codeVerifier) {
  return crypto.createHash('sha256').update(codeVerifier).digest('base64url')
}

function generateCodeVerifier() {
  return crypto.randomBytes(32).toString('base64url')
}

function buildAuthorizeUrl({ state, codeVerifier }) {
  const url = new URL('https://twitter.com/i/oauth2/authorize')
  url.searchParams.set('response_type', 'code')
  url.searchParams.set('client_id', process.env.X_CLIENT_ID)
  url.searchParams.set('redirect_uri', redirectUri())
  // offline.access is what makes X issue a refresh_token alongside the
  // (short-lived, ~2hr) access token.
  url.searchParams.set('scope', 'tweet.read tweet.write users.read offline.access')
  url.searchParams.set('state', state)
  url.searchParams.set('code_challenge', codeChallengeFor(codeVerifier))
  url.searchParams.set('code_challenge_method', 'S256')
  return url.toString()
}

async function exchangeCode({ code, codeVerifier }) {
  const res = await fetch('https://api.twitter.com/2/oauth2/token', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Authorization: basicAuthHeader(),
    },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri(),
      code_verifier: codeVerifier,
    }),
  })
  const body = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(body.error_description || body.error || `X token exchange failed (${res.status})`)
  const expiresAt = body.expires_in ? new Date(Date.now() + body.expires_in * 1000) : null
  return { accessToken: body.access_token, refreshToken: body.refresh_token || null, expiresAt, scopes: body.scope }
}

async function refreshAccessToken(refreshToken) {
  const res = await fetch('https://api.twitter.com/2/oauth2/token', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Authorization: basicAuthHeader(),
    },
    body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refreshToken }),
  })
  const body = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(body.error_description || body.error || `X token refresh failed (${res.status})`)
  const expiresAt = body.expires_in ? new Date(Date.now() + body.expires_in * 1000) : null
  return { accessToken: body.access_token, refreshToken: body.refresh_token || refreshToken, expiresAt }
}

async function fetchAccount(accessToken) {
  const res = await fetch('https://api.twitter.com/2/users/me', {
    headers: { Authorization: `Bearer ${accessToken}` },
  })
  const body = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(body.detail || body.title || `X user lookup failed (${res.status})`)
  return { accountId: body.data.id, accountName: `@${body.data.username}` }
}

module.exports = { buildAuthorizeUrl, exchangeCode, fetchAccount, refreshAccessToken, generateCodeVerifier }
