// LinkedIn — posting as a Company Page (organization), not a personal
// profile, per the confirmed scope. Organization-posting scopes
// (w_organization_social etc.) require LinkedIn's Community Management
// API / Marketing Developer Platform product approval on the app; the
// exact scope names below MUST match what's actually approved — this is
// an open item to confirm, not something verifiable from code alone (see
// the implementation plan's open items). If the approved product uses
// different scope names, update ORG_SCOPES below.
//
// LinkedIn's default OAuth grant may not include a refresh_token at all
// unless the app has specific refresh-token access — exchangeCode()
// tolerates that (refreshToken comes back null), and
// jobs/socialTokenRefresh.js already skips rows with no refresh token, so
// this degrades to "reconnect manually before ~60 days" rather than
// erroring.

const API_VERSION = '202401'
const ORG_SCOPES = ['w_organization_social', 'r_organization_social', 'rw_organization_admin']

function redirectUri() {
  return `${process.env.BACKEND_PUBLIC_URL}/api/social-connections/linkedin/callback`
}

function restHeaders(accessToken) {
  return {
    Authorization: `Bearer ${accessToken}`,
    'LinkedIn-Version': API_VERSION,
    'X-Restli-Protocol-Version': '2.0.0',
  }
}

function buildAuthorizeUrl({ state }) {
  const url = new URL('https://www.linkedin.com/oauth/v2/authorization')
  url.searchParams.set('response_type', 'code')
  url.searchParams.set('client_id', process.env.LINKEDIN_CLIENT_ID)
  url.searchParams.set('redirect_uri', redirectUri())
  url.searchParams.set('state', state)
  url.searchParams.set('scope', ORG_SCOPES.join(' '))
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

// First organization the authorizing user administers — no picker UI
// (matches Instagram's same confirmed simplification), since each brand's
// LinkedIn user is expected to administer exactly one Company Page.
async function fetchAccount(accessToken) {
  const aclsRes = await fetch(
    'https://api.linkedin.com/rest/organizationAcls?q=roleAssignee&role=ADMINISTRATOR&state=APPROVED',
    { headers: restHeaders(accessToken) }
  )
  const acls = await aclsRes.json().catch(() => ({}))
  if (!aclsRes.ok) throw new Error(acls.message || `LinkedIn organization lookup failed (${aclsRes.status})`)

  const orgUrn = acls.elements?.[0]?.organization
  if (!orgUrn) throw new Error('This LinkedIn user does not administer any Company Page')
  const orgId = orgUrn.split(':').pop()

  const orgRes = await fetch(`https://api.linkedin.com/rest/organizations/${orgId}`, { headers: restHeaders(accessToken) })
  const org = await orgRes.json().catch(() => ({}))
  if (!orgRes.ok) throw new Error(org.message || `LinkedIn organization details failed (${orgRes.status})`)

  const name = org.localizedName || org.name?.localized?.en_US || `Organization ${orgId}`
  return { accountId: orgUrn, accountName: name }
}

module.exports = { buildAuthorizeUrl, exchangeCode, fetchAccount }
