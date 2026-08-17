const express = require('express')
const crypto = require('crypto')
const multer = require('multer')
const db = require('../config/db')
const auth = require('../middleware/auth')
const { createStorageClient } = require('../config/supabaseStorage')
const { decrypt, encrypt } = require('../utils/tokenCipher')
const socialX = require('../services/socialProviders/x')
const socialLinkedin = require('../services/socialProviders/linkedin')

const PUBLISHERS = { x: socialX, linkedin: socialLinkedin }

const router = express.Router()
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } })
const BUCKET = 'content-media'
// How long a signed URL is valid for, and how much of that window has to
// remain before /media-url will reuse a cached one rather than mint a new
// one. Minting on every call meant the token differed each time, which
// defeated browser HTTP caching and re-downloaded the full file on every
// post view — the leading driver of the Supabase org's egress overage.
const SIGNED_URL_TTL_SECONDS = 60 * 60 * 24 * 7
const SIGNED_URL_REUSE_BUFFER_SECONDS = 60 * 60 * 24

// Real persistence for Marketing OS's Content Studio (see CLAUDE.md's
// Content Studio section) — this backend previously had no concept of
// this data at all; every post lived in the frontend's in-memory
// ContentContext.jsx and reset on every reload. media_storage_path is
// what jobs/mediaCleanup.js's 30-day job actually deletes; the row
// itself (including analytics) is never deleted, only the file.

function safeFileName(name) {
  return String(name || 'file').replace(/[^a-zA-Z0-9._-]/g, '_')
}

// pg parses a `date` column into a UTC-midnight JS Date by default —
// toISOString() on that is safe here (unlike parsing a date *string* in
// the browser's local timezone, which is the actual bug lib/localDate.js
// on the frontend exists to avoid) since both sides agree on UTC
// midnight for a genuinely date-only value. Keeps the API returning the
// same plain YYYY-MM-DD strings the frontend already expects everywhere.
function toDateStr(value) {
  if (!value) return null
  return value instanceof Date ? value.toISOString().slice(0, 10) : value
}

function mapPost(row) {
  return {
    id: row.id,
    lab: row.lab,
    status: row.status,
    createdBy: row.created_by,
    createdAt: toDateStr(row.created_at) || row.created_at,
    platforms: row.platforms,
    content: row.content,
    perPlatformText: row.per_platform_text,
    scheduling: row.scheduling,
    approval: row.approval,
    compliance: row.compliance,
    complianceNote: row.compliance_note,
    analytics: row.analytics,
    publishedAt: toDateStr(row.published_at),
    activityLog: row.activity_log,
    publishResults: row.publish_results,
  }
}

const DEFAULT_CONTENT = { text: '', hashtags: [], firstComment: '', mediaType: 'none', mediaLabel: '', mediaFileName: '' }
const DEFAULT_SCHEDULING = { mode: 'queue', date: null, time: '09:00', timezone: 'America/New_York' }

// GET /api/content-posts?brand=aim
router.get('/content-posts', auth, async (req, res, next) => {
  try {
    const { brand } = req.query
    const { rows } = brand
      ? await db.query('select * from content_posts where lab = $1 order by created_at desc', [brand])
      : await db.query('select * from content_posts order by created_at desc')
    res.json({ posts: rows.map(mapPost) })
  } catch (err) {
    next(err)
  }
})

// GET /api/content-posts/:id
router.get('/content-posts/:id', auth, async (req, res, next) => {
  try {
    const { rows } = await db.query('select * from content_posts where id = $1', [req.params.id])
    if (rows.length === 0) return res.status(404).json({ error: 'Post not found' })
    res.json({ post: mapPost(rows[0]) })
  } catch (err) {
    next(err)
  }
})

// POST /api/content-posts — same default shape createBlankPost() used to
// apply client-side, applied server-side now.
router.post('/content-posts', auth, async (req, res, next) => {
  try {
    const body = req.body || {}
    const today = new Date().toISOString().slice(0, 10)
    const { rows } = await db.query(
      `insert into content_posts (lab, status, created_by, platforms, content, per_platform_text, scheduling, approval, activity_log)
       values ($1,'draft',$2,'[]'::jsonb,$3::jsonb,'{}'::jsonb,$4::jsonb,'{"required":true,"platforms":{}}'::jsonb,$5::jsonb)
       returning *`,
      [
        body.lab || 'aim',
        req.user?.name || 'Admin',
        JSON.stringify({ ...DEFAULT_CONTENT, ...(body.content || {}) }),
        JSON.stringify({ ...DEFAULT_SCHEDULING, date: today, ...(body.scheduling || {}) }),
        JSON.stringify([{ id: 'a1', type: 'created', text: 'Draft created', meta: `${req.user?.name || 'Admin'} · just now` }]),
      ]
    )
    res.json({ post: mapPost(rows[0]) })
  } catch (err) {
    next(err)
  }
})

// PATCH /api/content-posts/:id — shallow merge, matching ContentContext's
// existing updatePost(id, updates) contract exactly: whichever top-level
// keys are present in the body get overwritten wholesale (nested objects
// like `content`/`approval` are NOT deep-merged here — same as the
// frontend's own updatePost, which always requires callers to spread the
// existing nested object themselves before calling it).
const PATCHABLE_COLUMNS = {
  lab: 'lab', status: 'status', platforms: 'platforms', content: 'content',
  perPlatformText: 'per_platform_text', scheduling: 'scheduling', approval: 'approval',
  compliance: 'compliance', complianceNote: 'compliance_note', analytics: 'analytics',
  publishedAt: 'published_at', activityLog: 'activity_log',
}
const JSONB_COLUMNS = new Set(['platforms', 'content', 'per_platform_text', 'scheduling', 'approval', 'analytics', 'activity_log'])

router.patch('/content-posts/:id', auth, async (req, res, next) => {
  try {
    const updates = req.body || {}
    const setClauses = []
    const values = []
    let i = 1
    for (const [key, column] of Object.entries(PATCHABLE_COLUMNS)) {
      if (!(key in updates)) continue
      const value = updates[key]
      if (JSONB_COLUMNS.has(column)) {
        setClauses.push(`${column} = $${i}::jsonb`)
        values.push(value === null ? null : JSON.stringify(value))
      } else {
        setClauses.push(`${column} = $${i}`)
        values.push(value)
      }
      i++
    }
    if (setClauses.length === 0) return res.status(400).json({ error: 'No updatable fields provided' })

    values.push(req.params.id)
    const { rows } = await db.query(
      `update content_posts set ${setClauses.join(', ')} where id = $${i} returning *`,
      values
    )
    if (rows.length === 0) return res.status(404).json({ error: 'Post not found' })
    res.json({ post: mapPost(rows[0]) })
  } catch (err) {
    next(err)
  }
})

// DELETE /api/content-posts/:id — also removes its media object, if any,
// so a deleted post doesn't leave an orphaned Storage file behind.
router.delete('/content-posts/:id', auth, async (req, res, next) => {
  try {
    const { rows } = await db.query('delete from content_posts where id = $1 returning media_storage_path', [req.params.id])
    if (rows.length === 0) return res.status(404).json({ error: 'Post not found' })
    if (rows[0].media_storage_path) {
      const supabase = createStorageClient()
      await supabase.storage.from(BUCKET).remove([rows[0].media_storage_path])
    }
    res.status(204).end()
  } catch (err) {
    next(err)
  }
})

// POST /api/content-posts/:id/media — real upload, replacing the old
// browser-memory-only FileReader/data-URL approach entirely. Overwrites
// any previous media object for this post.
router.post('/content-posts/:id/media', auth, upload.single('file'), async (req, res, next) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file provided' })
    const { rows: existingRows } = await db.query('select media_storage_path from content_posts where id = $1', [req.params.id])
    if (existingRows.length === 0) return res.status(404).json({ error: 'Post not found' })

    const supabase = createStorageClient()
    if (existingRows[0].media_storage_path) {
      await supabase.storage.from(BUCKET).remove([existingRows[0].media_storage_path])
    }

    const storagePath = `posts/${req.params.id}/${crypto.randomUUID()}-${safeFileName(req.file.originalname)}`
    const { error: uploadError } = await supabase.storage.from(BUCKET).upload(storagePath, req.file.buffer, {
      contentType: req.file.mimetype || 'application/octet-stream',
      upsert: false,
    })
    if (uploadError) return res.status(500).json({ error: uploadError.message })

    const isVideo = (req.file.mimetype || '').startsWith('video/')
    const { data: signed, error: signError } = await supabase.storage.from(BUCKET).createSignedUrl(storagePath, SIGNED_URL_TTL_SECONDS)
    if (signError) return res.status(500).json({ error: signError.message })
    const expiresAt = new Date(Date.now() + SIGNED_URL_TTL_SECONDS * 1000)

    const { rows } = await db.query(
      `update content_posts set media_storage_path = $1, media_deleted_at = null,
        media_signed_url = $2, media_signed_url_expires_at = $3,
        content = content || jsonb_build_object('mediaType', $4::text, 'mediaFileName', $5::text)
       where id = $6 returning *`,
      [storagePath, signed.signedUrl, expiresAt, isVideo ? 'video' : 'image', req.file.originalname, req.params.id]
    )
    res.json({ post: mapPost(rows[0]), mediaUrl: signed.signedUrl })
  } catch (err) {
    next(err)
  }
})

// DELETE /api/content-posts/:id/media — manual remove (mirrors the
// composer's existing removeMedia() action).
router.delete('/content-posts/:id/media', auth, async (req, res, next) => {
  try {
    const { rows: existingRows } = await db.query('select media_storage_path from content_posts where id = $1', [req.params.id])
    if (existingRows.length === 0) return res.status(404).json({ error: 'Post not found' })
    if (existingRows[0].media_storage_path) {
      const supabase = createStorageClient()
      await supabase.storage.from(BUCKET).remove([existingRows[0].media_storage_path])
    }
    const { rows } = await db.query(
      `update content_posts set media_storage_path = null, media_deleted_at = null,
        media_signed_url = null, media_signed_url_expires_at = null,
        content = content || '{"mediaType":"none","mediaLabel":"","mediaFileName":""}'::jsonb
       where id = $1 returning *`,
      [req.params.id]
    )
    res.json({ post: mapPost(rows[0]) })
  } catch (err) {
    next(err)
  }
})

// GET /api/content-posts/:id/media-url — reuses the cached signed URL
// while it still has real headroom left (see SIGNED_URL_REUSE_BUFFER_SECONDS
// above) instead of minting a new one on every call. A fresh signature
// on every call meant the URL differed each time, so the browser could
// never HTTP-cache the file and re-downloaded it in full on every post
// view — this is the actual fix for that.
router.get('/content-posts/:id/media-url', auth, async (req, res, next) => {
  try {
    const { rows } = await db.query(
      'select media_storage_path, media_signed_url, media_signed_url_expires_at from content_posts where id = $1',
      [req.params.id]
    )
    if (rows.length === 0) return res.status(404).json({ error: 'Post not found' })
    const row = rows[0]
    if (!row.media_storage_path) return res.json({ mediaUrl: null })

    const stillFresh = row.media_signed_url && row.media_signed_url_expires_at &&
      new Date(row.media_signed_url_expires_at).getTime() - Date.now() > SIGNED_URL_REUSE_BUFFER_SECONDS * 1000
    if (stillFresh) return res.json({ mediaUrl: row.media_signed_url })

    const supabase = createStorageClient()
    const { data, error } = await supabase.storage.from(BUCKET).createSignedUrl(row.media_storage_path, SIGNED_URL_TTL_SECONDS)
    if (error) return res.status(500).json({ error: error.message })
    const expiresAt = new Date(Date.now() + SIGNED_URL_TTL_SECONDS * 1000)
    await db.query(
      'update content_posts set media_signed_url = $1, media_signed_url_expires_at = $2 where id = $3',
      [data.signedUrl, expiresAt, req.params.id]
    )
    res.json({ mediaUrl: data.signedUrl })
  } catch (err) {
    next(err)
  }
})

// POST /api/content-posts/:id/publish — real publishing to whichever of
// this post's selected platforms have a real social_connections row for
// this post's brand (see routes/socialConnections.js). A platform with no
// real connection is `skipped`, not an error — the post as a whole
// becomes `published` if at least one target actually published,
// `failed` otherwise (reusing the existing failed/"Retry scheduling"
// status rather than inventing a new one for this case). No extra access
// gate beyond `auth` — publishing is already gated by the approval flow
// a post goes through before it can even reach `scheduled`.
router.post('/content-posts/:id/publish', auth, async (req, res, next) => {
  try {
    const { rows } = await db.query('select * from content_posts where id = $1', [req.params.id])
    if (rows.length === 0) return res.status(404).json({ error: 'Post not found' })
    const post = rows[0]

    // Downloaded once and reused across whichever platforms need it,
    // rather than re-fetching per platform.
    let media = null
    if (post.media_storage_path) {
      const supabase = createStorageClient()
      const { data, error } = await supabase.storage.from(BUCKET).download(post.media_storage_path)
      if (!error && data) {
        media = {
          buffer: Buffer.from(await data.arrayBuffer()),
          mimeType: data.type || 'application/octet-stream',
          isVideo: post.content.mediaType === 'video',
        }
      }
    }

    const platformIds = post.platforms || []
    const { rows: connections } = platformIds.length
      ? await db.query('select * from social_connections where lab = $1 and platform = any($2::text[])', [post.lab, platformIds])
      : { rows: [] }
    const connectionByPlatform = Object.fromEntries(connections.map((c) => [c.platform, c]))

    const results = {}
    const activities = []

    for (const platformId of platformIds) {
      const provider = PUBLISHERS[platformId]
      const connection = connectionByPlatform[platformId]

      if (!provider || !connection) {
        results[platformId] = { status: 'skipped', error: 'Not connected' }
      } else {
        try {
          let accessToken = decrypt(connection.access_token_enc)
          if (connection.token_expires_at && new Date(connection.token_expires_at) <= new Date()) {
            if (provider.refreshAccessToken && connection.refresh_token_enc) {
              const refreshed = await provider.refreshAccessToken(decrypt(connection.refresh_token_enc))
              accessToken = refreshed.accessToken
              await db.query(
                'update social_connections set access_token_enc = $1, refresh_token_enc = $2, token_expires_at = $3 where id = $4',
                [
                  encrypt(refreshed.accessToken),
                  refreshed.refreshToken ? encrypt(refreshed.refreshToken) : connection.refresh_token_enc,
                  refreshed.expiresAt,
                  connection.id,
                ]
              )
            } else {
              throw new Error('Connection expired — reconnect in Settings')
            }
          }

          const text = [post.per_platform_text?.[platformId] ?? post.content.text, (post.content.hashtags || []).join(' ')]
            .filter(Boolean)
            .join('\n\n')

          const result = await provider.publishPost({
            accessToken,
            accountId: connection.account_id,
            accountName: connection.account_name,
            text,
            media,
          })
          results[platformId] = { status: 'published', ...result, publishedAt: new Date().toISOString() }
        } catch (err) {
          results[platformId] = { status: 'failed', error: err.message }
        }
      }

      const r = results[platformId]
      activities.push({
        id: `a-publish-${platformId}-${Date.now()}`,
        type: r.status === 'published' ? 'published' : 'unscheduled',
        text:
          r.status === 'published'
            ? `Published to ${platformId}${media && r.mediaIncluded === false ? ' (text only — media not included)' : ''}`
            : r.status === 'skipped'
              ? `Skipped ${platformId} — not connected`
              : `${platformId} publish failed: ${r.error}`,
        meta: 'System · just now',
      })
    }

    const anyPublished = Object.values(results).some((r) => r.status === 'published')
    const nextStatus = anyPublished ? 'published' : 'failed'
    const nextActivityLog = [...post.activity_log, ...activities]

    const { rows: updated } = await db.query(
      `update content_posts set status = $1, publish_results = $2::jsonb, activity_log = $3::jsonb,
        published_at = coalesce(published_at, case when $1 = 'published' then now()::date else null end)
       where id = $4 returning *`,
      [nextStatus, JSON.stringify(results), JSON.stringify(nextActivityLog), req.params.id]
    )

    res.json({ post: mapPost(updated[0]) })
  } catch (err) {
    next(err)
  }
})

// GET/PATCH /api/content-settings/:brand — backs ContentSettings.jsx and
// the Queue page's slot editor.
router.get('/content-settings/:brand', auth, async (req, res, next) => {
  try {
    const { rows } = await db.query('select * from content_settings where lab = $1', [req.params.brand])
    if (rows.length === 0) return res.status(404).json({ error: 'No settings for this brand' })
    const row = rows[0]
    res.json({
      settings: { connectedPlatforms: row.connected_platforms, approvalRequired: row.approval_required, queueSlots: row.queue_slots },
    })
  } catch (err) {
    next(err)
  }
})

router.patch('/content-settings/:brand', auth, async (req, res, next) => {
  try {
    const updates = req.body || {}
    const setClauses = []
    const values = []
    let i = 1
    if ('connectedPlatforms' in updates) { setClauses.push(`connected_platforms = $${i}::jsonb`); values.push(JSON.stringify(updates.connectedPlatforms)); i++ }
    if ('approvalRequired' in updates) { setClauses.push(`approval_required = $${i}`); values.push(updates.approvalRequired); i++ }
    if ('queueSlots' in updates) { setClauses.push(`queue_slots = $${i}::jsonb`); values.push(JSON.stringify(updates.queueSlots)); i++ }
    if (setClauses.length === 0) return res.status(400).json({ error: 'No updatable fields provided' })

    values.push(req.params.brand)
    const { rows } = await db.query(
      `update content_settings set ${setClauses.join(', ')} where lab = $${i} returning *`,
      values
    )
    if (rows.length === 0) return res.status(404).json({ error: 'No settings for this brand' })
    const row = rows[0]
    res.json({
      settings: { connectedPlatforms: row.connected_platforms, approvalRequired: row.approval_required, queueSlots: row.queue_slots },
    })
  } catch (err) {
    next(err)
  }
})

module.exports = router
