const { createClient } = require('@supabase/supabase-js')

// This backend talks to Supabase exclusively as a bare Postgres endpoint
// everywhere else (pg/DATABASE_URL) — this is the one place that needs
// the actual Storage API, for Content Studio's real media uploads. Same
// service-role reasoning as every Storage-using route in this shared
// Supabase project's sibling app (Team Pulse's src/lib/supabase/
// service.ts): server-only, bypasses RLS/Storage policies by design, so
// this key must never reach a browser bundle.
function createStorageClient() {
  const url = process.env.SUPABASE_URL
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !serviceRoleKey) {
    throw new Error('SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY are not configured on this server')
  }
  return createClient(url, serviceRoleKey)
}

module.exports = { createStorageClient }
