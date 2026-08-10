// Instagram, via Facebook Login for Business + the Instagram Graph API —
// there is no separate "Instagram OAuth," publishing always goes through
// a Meta app and a Facebook Page that has an Instagram Business account
// linked to it. Same three-function shape as x.js/linkedin.js so
// routes/socialConnections.js can dispatch generically.
//
// Meta app mode matters here: until this app passes App Review for
// instagram_content_publish, only Facebook users added as testers/admins
// on the Meta app can complete this flow (see CLAUDE.md/the implementation
// plan's open items). Fine for an admin-only feature, not fine once
// non-admins need to connect.

const GRAPH_VERSION = 'v21.0'
const GRAPH_BASE = `https://graph.facebook.com/${GRAPH_VERSION}`

function redirectUri() {
  return `${process.env.BACKEND_PUBLIC_URL}/api/social-connections/instagram/callback`
}

async function graphGet(path, params) {
  const url = new URL(`${GRAPH_BASE}${path}`)
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v))
  const res = await fetch(url)
  const body = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(body.error?.message || `Meta Graph API request failed (${res.status})`)
  return body
}

function buildAuthorizeUrl({ state }) {
  const url = new URL(`https://www.facebook.com/${GRAPH_VERSION}/dialog/oauth`)
  url.searchParams.set('client_id', process.env.META_APP_ID)
  url.searchParams.set('redirect_uri', redirectUri())
  url.searchParams.set('state', state)
  url.searchParams.set('response_type', 'code')
  // instagram_content_publish is the one that actually matters for a
  // future Publish phase; requested now so re-consent isn't needed later.
  url.searchParams.set('scope', 'instagram_basic,instagram_content_publish,pages_show_list,pages_read_engagement,business_management')
  return url.toString()
}

// Two-step token exchange, both required for Meta: the code exchanges for
// a short-lived user token, which then exchanges for a long-lived one
// (~60 days) — publishing calls should use a Page access token derived
// from this long-lived user token, not the user token itself; that
// derivation happens in fetchAccount below since it needs to look up the
// Page anyway.
async function exchangeCode({ code }) {
  const short = await graphGet('/oauth/access_token', {
    client_id: process.env.META_APP_ID,
    client_secret: process.env.META_APP_SECRET,
    redirect_uri: redirectUri(),
    code,
  })
  const long = await graphGet('/oauth/access_token', {
    grant_type: 'fb_exchange_token',
    client_id: process.env.META_APP_ID,
    client_secret: process.env.META_APP_SECRET,
    fb_exchange_token: short.access_token,
  })
  const expiresAt = long.expires_in ? new Date(Date.now() + long.expires_in * 1000) : null
  return { accessToken: long.access_token, refreshToken: null, expiresAt, scopes: 'instagram_basic,instagram_content_publish,pages_show_list,pages_read_engagement,business_management' }
}

// Returns the FIRST Page (and its linked Instagram Business account) the
// authorizing user manages — no "pick which Page" UI in this pass (see
// the implementation plan's confirmed scope). accessToken returned here
// is the Page's own long-lived access token, not the user token passed
// in — Instagram Graph API publish calls need the Page token, so storing
// the user token would just require re-deriving this on every future
// publish call for no benefit.
async function fetchAccount(userAccessToken) {
  const pages = await graphGet('/me/accounts', { access_token: userAccessToken })
  const page = pages.data?.[0]
  if (!page) throw new Error('This Facebook user does not manage any Pages')

  const withIg = await graphGet(`/${page.id}`, {
    fields: 'instagram_business_account{id,username}',
    access_token: page.access_token,
  })
  const ig = withIg.instagram_business_account
  if (!ig) throw new Error(`Page "${page.name}" has no linked Instagram Business account`)

  return { accountId: ig.id, accountName: `@${ig.username} (via ${page.name})`, accessToken: page.access_token }
}

module.exports = { buildAuthorizeUrl, exchangeCode, fetchAccount }
