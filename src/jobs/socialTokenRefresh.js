const cron = require('node-cron')
const db = require('../config/db')
const { encrypt, decrypt } = require('../utils/tokenCipher')
const x = require('../services/socialProviders/x')

// Deliberately a separate file from jobs/scheduler.js, not an addition to
// it — same reason jobs/mediaCleanup.js already documents (that file has
// real in-progress unrelated work and must not be touched). Same
// try/catch-per-row and bracketed-prefix logging convention, just
// [social-refresh] instead of [cleanup]/[cron].
//
// Only X currently exposes a refresh function — Instagram's long-lived
// user tokens and LinkedIn's default OAuth grant don't reliably issue a
// refresh_token (see services/socialProviders/{instagram,linkedin}.js's
// own comments), so rows for those platforms simply have no
// refresh_token_enc and are skipped here. They degrade to "reconnect
// manually before it expires" rather than erroring — an accepted v1
// limitation, not a bug.
const PROVIDERS = { x }

async function refreshExpiringTokens() {
  try {
    const { rows } = await db.query(
      `select * from social_connections
       where refresh_token_enc is not null
         and token_expires_at is not null
         and token_expires_at <= (now() + interval '1 day')`
    )
    if (rows.length === 0) {
      console.log('[social-refresh] No connections need refreshing.')
      return
    }

    let refreshed = 0
    for (const row of rows) {
      const provider = PROVIDERS[row.platform]
      if (!provider?.refreshAccessToken) continue
      try {
        const refreshToken = decrypt(row.refresh_token_enc)
        const result = await provider.refreshAccessToken(refreshToken)
        await db.query(
          `update social_connections set access_token_enc = $1, refresh_token_enc = $2, token_expires_at = $3
           where id = $4`,
          [encrypt(result.accessToken), result.refreshToken ? encrypt(result.refreshToken) : null, result.expiresAt, row.id]
        )
        refreshed++
      } catch (err) {
        console.error(`[social-refresh] Failed to refresh ${row.platform}/${row.lab}:`, err.message)
      }
    }
    console.log(`[social-refresh] Refreshed ${refreshed}/${rows.length} expiring connections.`)
  } catch (err) {
    console.error('[social-refresh] Refresh scan error:', err.message)
  }
}

function startSocialTokenRefreshScheduler() {
  // Every 6 hours — tokens are only refreshed once within a day of
  // expiring, so this doesn't need to be more frequent than that.
  cron.schedule('0 */6 * * *', async () => {
    console.log('[social-refresh] Running expiring-token refresh scan')
    await refreshExpiringTokens()
  })
  console.log('[social-refresh] Social token refresh job registered')
}

module.exports = { startSocialTokenRefreshScheduler, refreshExpiringTokens }
