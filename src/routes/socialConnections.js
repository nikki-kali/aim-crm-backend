const express = require('express')
const crypto = require('crypto')
const db = require('../config/db')
const auth = require('../middleware/auth')
const requireAdmin = require('../middleware/requireAdmin')
const { encrypt } = require('../utils/tokenCipher')
const { signOAuthState, verifyOAuthState } = require('../utils/oauthState')
const instagram = require('../services/socialProviders/instagram')
const x = require('../services/socialProviders/x')
const linkedin = require('../services/socialProviders/linkedin')

const router = express.Router()

// Real OAuth "Connect" for Marketing OS's Content Studio Settings page —
// Instagram/X/LinkedIn only, the three platforms with real developer
// apps as of this writing (see scripts/v10-social-connections-migration.sql
// and CLAUDE.md's Content Studio section). Connect/disconnect are
// admin-only; anyone logged in can see connection status. Actually
// publishing through these connections is a separate, later phase — this
// only proves the handshake and stores the resulting tokens.
const PROVIDERS = { instagram, x, linkedin }
const LABS = ['aim', 'kh']

// PKCE code_verifier storage for X only (see services/socialProviders/x.js
// for why X needs this and the others don't) — an in-memory Map keyed by
// the state's nonce, not Postgres, since the verifier only needs to
// survive the few minutes between /authorize and /callback and never
// needs to be queried or audited later. Fine for this backend's
// single-instance deployment; would need a real shared store if this ever
// ran as more than one instance.
const pkceVerifiers = new Map()
function sweepExpiredVerifiers() {
  const now = Date.now()
  for (const [nonce, entry] of pkceVerifiers) {
    if (entry.expiresAt < now) pkceVerifiers.delete(nonce)
  }
}

function mapConnection(row) {
  return {
    lab: row.lab,
    platform: row.platform,
    accountName: row.account_name,
    connectedBy: row.connected_by,
    connectedAt: row.connected_at,
    tokenExpiresAt: row.token_expires_at,
  }
}

// GET /api/social-connections — status for every connected platform/brand.
// Tokens are never included in this response, encrypted or otherwise.
router.get('/', auth, async (req, res, next) => {
  try {
    const { rows } = await db.query('select * from social_connections order by platform, lab')
    res.json({ connections: rows.map(mapConnection) })
  } catch (err) {
    next(err)
  }
})

// GET /api/social-connections/:platform/authorize?lab=aim — returns the
// provider's real authorize URL; the frontend does `window.location.href
// = url` itself as a second step, since a plain top-level browser
// navigation can't carry the bearer token this route itself requires.
router.get('/:platform/authorize', auth, requireAdmin, async (req, res, next) => {
  try {
    const { platform } = req.params
    const { lab } = req.query
    const provider = PROVIDERS[platform]
    if (!provider) return res.status(404).json({ error: `Unknown platform: ${platform}` })
    if (!LABS.includes(lab)) return res.status(400).json({ error: 'lab must be "aim" or "kh"' })

    const nonce = crypto.randomUUID()
    // initiatedBy travels inside the signed state itself, since the
    // callback below has no bearer token / req.user to read it from
    // directly — this is the only place that information is available.
    const state = signOAuthState({ lab, platform, nonce, initiatedBy: req.user?.name })

    let codeVerifier
    if (platform === 'x') {
      codeVerifier = x.generateCodeVerifier()
      sweepExpiredVerifiers()
      pkceVerifiers.set(nonce, { codeVerifier, expiresAt: Date.now() + 10 * 60 * 1000 })
    }

    const url = provider.buildAuthorizeUrl({ state, codeVerifier })
    res.json({ url })
  } catch (err) {
    next(err)
  }
})

// GET /api/social-connections/:platform/callback — the provider redirects
// the BROWSER here directly, so there's no bearer token and this route
// can't be behind `auth`. All of its trust comes from verifyOAuthState
// below (signed, 10-minute expiry) rather than a session. This is the
// first route in this backend that does res.redirect instead of
// responding with JSON — necessary here because it's the browser, not
// this app's own frontend JS, that lands on this URL.
router.get('/:platform/callback', async (req, res) => {
  const { platform } = req.params
  const { code, state, error: providerError, error_description: providerErrorDescription } = req.query
  // MARKETING_OS_URL, not FRONTEND_URL — that var is a shared multi-app
  // CORS allowlist (this backend also serves AIM-CRM's own frontend), and
  // its first entry isn't reliably Marketing OS. A real bug caught here:
  // the callback was redirecting to whichever app happened to be first in
  // that list (AIM-CRM's frontend, which has no /content/settings route
  // at all) instead of back to Marketing OS.
  const frontendUrl = (process.env.MARKETING_OS_URL || 'https://marketing.aimdentallab.com').trim()
  const redirectBack = (query) => res.redirect(`${frontendUrl}/content/settings?${new URLSearchParams(query)}`)

  if (providerError) {
    console.error(`[social-connections] ${platform} callback got a provider error:`, providerError, providerErrorDescription || '')
    return redirectBack({ social_error: String(providerErrorDescription || providerError), platform })
  }

  let statePayload
  try {
    statePayload = verifyOAuthState(state)
  } catch {
    return redirectBack({ social_error: 'This connection link expired or is invalid — please try again.', platform })
  }
  if (statePayload.platform !== platform) {
    return redirectBack({ social_error: 'Platform mismatch — please try again.', platform })
  }

  const provider = PROVIDERS[platform]
  if (!provider) return redirectBack({ social_error: `Unknown platform: ${platform}`, platform })

  try {
    let codeVerifier
    if (platform === 'x') {
      const entry = pkceVerifiers.get(statePayload.nonce)
      pkceVerifiers.delete(statePayload.nonce)
      if (!entry) throw new Error('This connection link expired — please try again.')
      codeVerifier = entry.codeVerifier
    }

    const exchange = await provider.exchangeCode({ code, codeVerifier })
    // fetchAccount is called with the token exchangeCode returned, but
    // some providers (Instagram) need a *different*, more specific token
    // for actual future publish calls (a Page token, not the user token)
    // — when fetchAccount returns its own accessToken, that one wins.
    const account = await provider.fetchAccount(exchange.accessToken)
    const finalAccessToken = account.accessToken || exchange.accessToken

    await db.query(
      `insert into social_connections (lab, platform, account_id, account_name, access_token_enc, refresh_token_enc, token_expires_at, scopes, connected_by)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       on conflict (lab, platform) do update set
         account_id = excluded.account_id,
         account_name = excluded.account_name,
         access_token_enc = excluded.access_token_enc,
         refresh_token_enc = excluded.refresh_token_enc,
         token_expires_at = excluded.token_expires_at,
         scopes = excluded.scopes,
         connected_by = excluded.connected_by`,
      [
        statePayload.lab,
        platform,
        account.accountId,
        account.accountName,
        encrypt(finalAccessToken),
        exchange.refreshToken ? encrypt(exchange.refreshToken) : null,
        exchange.expiresAt,
        exchange.scopes || null,
        statePayload.initiatedBy || 'Admin',
      ]
    )

    return redirectBack({ social_connected: platform, lab: statePayload.lab })
  } catch (err) {
    console.error(`[social-connections] ${platform} callback failed:`, err.message)
    return redirectBack({ social_error: err.message, platform })
  }
})

// DELETE /api/social-connections/:platform/:lab — local disconnect only;
// no provider-side token revocation call in this pass (a documented v1
// simplification, not an oversight).
router.delete('/:platform/:lab', auth, requireAdmin, async (req, res, next) => {
  try {
    const { platform, lab } = req.params
    const { rows } = await db.query(
      'delete from social_connections where platform = $1 and lab = $2 returning id',
      [platform, lab]
    )
    if (rows.length === 0) return res.status(404).json({ error: 'No connection found' })
    res.status(204).end()
  } catch (err) {
    next(err)
  }
})

module.exports = router
