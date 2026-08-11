// LinkedIn — posting as a personal profile (member), not a Company Page.
// Company Page posting (w_organization_social etc.) requires LinkedIn's
// Community Management API, which needs a real partner-approval review —
// blocked entirely on the app used for this integration because another
// product request was already pending on it, on top of the review itself
// having no guaranteed timeline. Switched to the self-serve member-profile
// path instead so Connect works today; switching back to Company Page
// posting later is a matter of restoring the organization-scoped version
// of this file (see git history) once Community Management API clears.
//
// Needs two self-serve LinkedIn products added to the app (no review):
// "Sign In with LinkedIn using OpenID Connect" (openid, profile) and
// "Share on LinkedIn" (w_member_social).
//
// LinkedIn's default OAuth grant may not include a refresh_token at all
// unless the app has specific refresh-token access — exchangeCode()
// tolerates that (refreshToken comes back null), and
// jobs/socialTokenRefresh.js already skips rows with no refresh token, so
// this degrades to "reconnect manually before ~60 days" rather than
// erroring.

const MEMBER_SCOPES = ['openid', 'profile', 'w_member_social']

function redirectUri() {
  return `${process.env.BACKEND_PUBLIC_URL}/api/social-connections/linkedin/callback`
}

function buildAuthorizeUrl({ state }) {
  const url = new URL('https://www.linkedin.com/oauth/v2/authorization')
  url.searchParams.set('response_type', 'code')
  url.searchParams.set('client_id', process.env.LINKEDIN_CLIENT_ID)
  url.searchParams.set('redirect_uri', redirectUri())
  url.searchParams.set('state', state)
  url.searchParams.set('scope', MEMBER_SCOPES.join(' '))
  return url.toString()
}

async function exchangeCode({ code }) {
  const res = await fetch('https://www.linkedin.com/oauth/v2/accessToken', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri(),
      client_id: process.env.LINKEDIN_CLIENT_ID,
      client_secret: process.env.LINKEDIN_CLIENT_SECRET,
    }),
  })
  const body = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(body.error_description || body.error || `LinkedIn token exchange failed (${res.status})`)
  const expiresAt = body.expires_in ? new Date(Date.now() + body.expires_in * 1000) : null
  return { accessToken: body.access_token, refreshToken: body.refresh_token || null, expiresAt, scopes: body.scope }
}

// Standard OpenID Connect userinfo endpoint — the member-scope equivalent
// of the old organizationAcls/organizations lookup. `sub` is the member's
// stable LinkedIn URN-style id, used the same way accountId was used for
// an organization.
async function fetchAccount(accessToken) {
  const res = await fetch('https://api.linkedin.com/v2/userinfo', {
    headers: { Authorization: `Bearer ${accessToken}` },
  })
  const body = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(body.message || `LinkedIn profile lookup failed (${res.status})`)
  if (!body.sub) throw new Error('LinkedIn did not return a member profile')

  return { accountId: body.sub, accountName: body.name || 'LinkedIn member' }
}

// Only the versioned REST API (Posts, Images) needs these headers — the
// plain /v2/userinfo call above doesn't.
const API_VERSION = '202401'
function restHeaders(accessToken, extra = {}) {
  return {
    Authorization: `Bearer ${accessToken}`,
    'LinkedIn-Version': API_VERSION,
    'X-Restli-Protocol-Version': '2.0.0',
    ...extra,
  }
}

// Images API's 3-step flow: initialize -> PUT the raw bytes -> get back an
// image urn to reference on the post. No LinkedIn video upload here (see
// this file's own header comment) — a video-bearing post just skips this
// and publishes text-only, which the route layer surfaces honestly via
// mediaIncluded: false rather than silently dropping the video.
async function uploadImage(accessToken, accountId, media) {
  const initRes = await fetch('https://api.linkedin.com/rest/images?action=initializeUpload', {
    method: 'POST',
    headers: restHeaders(accessToken, { 'Content-Type': 'application/json' }),
    body: JSON.stringify({ initializeUploadRequest: { owner: `urn:li:person:${accountId}` } }),
  })
  const init = await initRes.json().catch(() => ({}))
  if (!initRes.ok) throw new Error(init.message || `LinkedIn image upload init failed (${initRes.status})`)

  const uploadRes = await fetch(init.value.uploadUrl, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': media.mimeType },
    body: media.buffer,
  })
  if (!uploadRes.ok) throw new Error(`LinkedIn image upload failed (${uploadRes.status})`)

  return init.value.image // an urn:li:image:... string
}

// author/accountId is the bare member id from fetchAccount's `sub` — the
// urn:li:person: prefix is added here, not stored, since it's just a
// formatting concern for API calls.
async function publishPost({ accessToken, accountId, text, media }) {
  let imageUrn = null
  let mediaIncluded = false
  if (media && !media.isVideo) {
    imageUrn = await uploadImage(accessToken, accountId, media)
    mediaIncluded = true
  }

  const body = {
    author: `urn:li:person:${accountId}`,
    commentary: text,
    visibility: 'PUBLIC',
    distribution: { feedDistribution: 'MAIN_FEED', targetEntities: [], thirdPartyDistributionChannels: [] },
    lifecycleState: 'PUBLISHED',
    isReshareDisabledByAuthor: false,
  }
  if (imageUrn) body.content = { media: { id: imageUrn } }

  const res = await fetch('https://api.linkedin.com/rest/posts', {
    method: 'POST',
    headers: restHeaders(accessToken, { 'Content-Type': 'application/json' }),
    body: JSON.stringify(body),
  })
  if (!res.ok) {
    const err = await res.json().catch(() => ({}))
    throw new Error(err.message || `LinkedIn post failed (${res.status})`)
  }
  // The Posts API returns the created post's urn via a response header,
  // not the (empty) body.
  const postUrn = res.headers.get('x-restli-id') || res.headers.get('x-linkedin-id')
  const externalUrl = postUrn ? `https://www.linkedin.com/feed/update/${postUrn}/` : null
  return { externalId: postUrn, externalUrl, mediaIncluded }
}

module.exports = { buildAuthorizeUrl, exchangeCode, fetchAccount, publishPost }
