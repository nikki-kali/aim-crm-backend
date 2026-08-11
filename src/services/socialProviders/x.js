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

const UPLOAD_URL = 'https://upload.twitter.com/1.1/media/upload.json'
const APPEND_CHUNK_SIZE = 4 * 1024 * 1024 // 4MB per segment, well under X's per-chunk limit

async function uploadCall(accessToken, form) {
  const res = await fetch(UPLOAD_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}` },
    body: form,
  })
  const body = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(body.errors?.[0]?.message || body.error || `X media upload failed (${res.status})`)
  return body
}

// Simple (non-chunked) upload — fine for images, which is all this ever
// sends through this path (video always goes through the chunked
// INIT/APPEND/FINALIZE flow below instead).
async function uploadImage(accessToken, media) {
  const form = new FormData()
  form.append('media', new Blob([media.buffer], { type: media.mimeType }))
  const body = await uploadCall(accessToken, form)
  return body.media_id_string
}

// Chunked upload — required for video by X's own API, regardless of file
// size. Our media is short-form (composer accepts single-file uploads,
// not long video), so a bounded STATUS poll (a handful of tries, a few
// seconds apart) is enough rather than needing open-ended waiting.
async function uploadVideo(accessToken, media) {
  const initForm = new FormData()
  initForm.append('command', 'INIT')
  initForm.append('media_type', media.mimeType)
  initForm.append('total_bytes', String(media.buffer.length))
  initForm.append('media_category', 'tweet_video')
  const init = await uploadCall(accessToken, initForm)
  const mediaId = init.media_id_string

  for (let offset = 0, segment = 0; offset < media.buffer.length; offset += APPEND_CHUNK_SIZE, segment++) {
    const chunk = media.buffer.subarray(offset, offset + APPEND_CHUNK_SIZE)
    const appendForm = new FormData()
    appendForm.append('command', 'APPEND')
    appendForm.append('media_id', mediaId)
    appendForm.append('segment_index', String(segment))
    appendForm.append('media', new Blob([chunk], { type: media.mimeType }))
    await uploadCall(accessToken, appendForm)
  }

  const finalizeForm = new FormData()
  finalizeForm.append('command', 'FINALIZE')
  finalizeForm.append('media_id', mediaId)
  let status = await uploadCall(accessToken, finalizeForm)

  let attempts = 0
  while (status.processing_info && status.processing_info.state !== 'succeeded' && attempts < 8) {
    if (status.processing_info.state === 'failed') {
      throw new Error(status.processing_info.error?.message || 'X video processing failed')
    }
    const waitSecs = status.processing_info.check_after_secs || 2
    await new Promise((r) => setTimeout(r, waitSecs * 1000))
    const statusUrl = new URL(UPLOAD_URL)
    statusUrl.searchParams.set('command', 'STATUS')
    statusUrl.searchParams.set('media_id', mediaId)
    const res = await fetch(statusUrl, { headers: { Authorization: `Bearer ${accessToken}` } })
    status = await res.json().catch(() => ({}))
    attempts++
  }
  if (status.processing_info && status.processing_info.state !== 'succeeded') {
    throw new Error('X video still processing after waiting — try publishing again shortly')
  }
  return mediaId
}

// accountName is the stored "@handle" string from social_connections —
// used only to build a human-followable externalUrl, X's own create-tweet
// response doesn't include one.
async function publishPost({ accessToken, text, media, accountName }) {
  let mediaId = null
  let mediaIncluded = false
  if (media) {
    mediaId = media.isVideo ? await uploadVideo(accessToken, media) : await uploadImage(accessToken, media)
    mediaIncluded = true
  }

  const res = await fetch('https://api.twitter.com/2/tweets', {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(mediaId ? { text, media: { media_ids: [mediaId] } } : { text }),
  })
  const body = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(body.detail || body.title || body.errors?.[0]?.message || `X post failed (${res.status})`)

  const handle = (accountName || '').replace(/^@/, '')
  const externalUrl = handle ? `https://x.com/${handle}/status/${body.data.id}` : null
  return { externalId: body.data.id, externalUrl, mediaIncluded }
}

module.exports = { buildAuthorizeUrl, exchangeCode, fetchAccount, refreshAccessToken, generateCodeVerifier, publishPost }
