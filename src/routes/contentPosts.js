const express = require('express')
const crypto = require('crypto')
const multer = require('multer')
const db = require('../config/db')
const auth = require('../middleware/auth')
const { createStorageClient } = require('../config/supabaseStorage')

const router = express.Router()
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } })
const BUCKET = 'content-media'

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
    const { data: signed, error: signError } = await supabase.storage.from(BUCKET).createSignedUrl(storagePath, 60 * 60 * 24 * 7)
    if (signError) return res.status(500).json({ error: signError.message })

    const { rows } = await db.query(
      `update content_posts set media_storage_path = $1, media_deleted_at = null,
        content = content || jsonb_build_object('mediaType', $2::text, 'mediaFileName', $3::text)
       where id = $4 returning *`,
      [storagePath, isVideo ? 'video' : 'image', req.file.originalname, req.params.id]
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
        content = content || '{"mediaType":"none","mediaLabel":"","mediaFileName":""}'::jsonb
       where id = $1 returning *`,
      [req.params.id]
    )
    res.json({ post: mapPost(rows[0]) })
  } catch (err) {
    next(err)
  }
})

// GET /api/content-posts/:id/media-url — a fresh signed URL (private
// bucket — the frontend can never hit Storage directly) for whenever a
// previously-returned one expires.
router.get('/content-posts/:id/media-url', auth, async (req, res, next) => {
  try {
    const { rows } = await db.query('select media_storage_path from content_posts where id = $1', [req.params.id])
    if (rows.length === 0) return res.status(404).json({ error: 'Post not found' })
    if (!rows[0].media_storage_path) return res.json({ mediaUrl: null })

    const supabase = createStorageClient()
    const { data, error } = await supabase.storage.from(BUCKET).createSignedUrl(rows[0].media_storage_path, 60 * 60 * 24 * 7)
    if (error) return res.status(500).json({ error: error.message })
    res.json({ mediaUrl: data.signedUrl })
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
