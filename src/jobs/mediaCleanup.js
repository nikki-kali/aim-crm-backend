const cron = require('node-cron')
const db = require('../config/db')
const { createStorageClient } = require('../config/supabaseStorage')

const BUCKET = 'content-media'

// Deliberately a separate file from jobs/scheduler.js, not an addition
// to it — that file has real in-progress unrelated work and must not be
// touched. Same try/catch-per-step and logging convention scheduler.js
// already uses, just with a [cleanup] prefix instead of [cron].
//
// Only the media file gets deleted, never the post row — Content
// Analytics (top posts, hashtag performance, best-time-to-post) needs
// real historical data to keep working, and only the image/video is the
// actual storage cost. Daily is already far more granular than the real
// posting cadence (roughly 2 weeks of posts scheduled every other week)
// needs — this isn't a high-volume system.
async function cleanupOldMedia() {
  try {
    const { rows } = await db.query(
      `select id, media_storage_path from content_posts
       where status = 'published'
         and published_at <= (now() - interval '30 days')
         and media_storage_path is not null
         and media_deleted_at is null`
    )
    if (rows.length === 0) {
      console.log('[cleanup] No published media older than 30 days — nothing to do.')
      return
    }

    const supabase = createStorageClient()
    let deleted = 0
    for (const row of rows) {
      try {
        const { error } = await supabase.storage.from(BUCKET).remove([row.media_storage_path])
        if (error) throw error
        await db.query(
          `update content_posts set media_storage_path = null, media_deleted_at = now() where id = $1`,
          [row.id]
        )
        deleted++
      } catch (err) {
        console.error(`[cleanup] Failed to delete media for post ${row.id}:`, err.message)
      }
    }
    console.log(`[cleanup] Removed media for ${deleted}/${rows.length} posts published 30+ days ago.`)
  } catch (err) {
    console.error('[cleanup] Media cleanup scan error:', err.message)
  }
}

function startMediaCleanupScheduler() {
  // Daily at 3:00 AM — well off-peak, and daily is already more
  // granular than this actually needs.
  cron.schedule('0 3 * * *', async () => {
    console.log('[cleanup] Running 30-day published-media cleanup')
    await cleanupOldMedia()
  })
  console.log('[cleanup] Media cleanup job registered')
}

module.exports = { startMediaCleanupScheduler, cleanupOldMedia }
