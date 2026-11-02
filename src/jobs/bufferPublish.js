// src/jobs/bufferPublish.js
const cron = require('node-cron')
const db = require('../config/db')
const { sendEmail } = require('../services/email')
const { CHANNELS, createPost, deletePost } = require('../services/buffer')

// Queues approved social posts in Buffer at their planned time. The plan is
// Marketing OS's public/approvals/buffer-schedule.json (built from the
// content calendar and captions); a post goes to Buffer only once it is
// approved on /content-approvals. If an approval is taken back before the
// post goes out, the Buffer post is deleted again. Every create, withdrawal
// and error is recorded in buffer_posts (migration v36) and emailed to media@.
//
// BUFFER_PUBLISH_ENABLED: 'true' queues for real, 'dryrun' only logs the
// plan, anything else turns the job off.
const SCHEDULE_URL = process.env.BUFFER_SCHEDULE_URL || 'https://marketing.aimdentallab.com/approvals/buffer-schedule.json'
const ALERT_TO = ['media@aimdentallab.com']
// Buffer needs a little time to fetch the media before the post is due.
const CREATE_LEAD_MS = 10 * 60 * 1000
const WITHDRAW_LEAD_MS = 5 * 60 * 1000

const keyOf = (postId, platform) => `${postId}|${platform}`

// Decides what to do; pure, so it can be tested without Buffer or a database.
function planActions({ entries, approvedIds, rows, now = Date.now() }) {
  const create = []
  const withdraw = []
  const seen = new Set()
  for (const entry of entries) {
    const key = keyOf(entry.postId, entry.platform)
    if (seen.has(key)) continue
    seen.add(key)
    const due = Date.parse(entry.dueAt)
    if (!CHANNELS[entry.platform] || Number.isNaN(due)) continue
    const row = rows.get(key)
    const approved = approvedIds.has(entry.postId) && !entry.blocked
    if (approved && (!row || row.status === 'withdrawn') && due - now > CREATE_LEAD_MS) create.push(entry)
  }
  for (const row of rows.values()) {
    if (row.status !== 'queued' || !row.buffer_post_id) continue
    if (approvedIds.has(row.post_id)) continue
    if (new Date(row.due_at).getTime() - now > WITHDRAW_LEAD_MS) withdraw.push(row)
  }
  return { create, withdraw }
}

async function loadSchedule() {
  const res = await fetch(SCHEDULE_URL, { signal: AbortSignal.timeout(30_000) })
  if (!res.ok || !String(res.headers.get('content-type')).includes('json')) {
    throw new Error(`Could not load ${SCHEDULE_URL} (${res.status})`)
  }
  const body = await res.json()
  if (!Array.isArray(body.entries)) throw new Error('buffer-schedule.json has no entries list')
  return body.entries
}

async function alert(subject, lines) {
  try {
    await sendEmail({ to: ALERT_TO, subject, html: `<p>${lines.map((l) => String(l).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]))).join('</p><p>')}</p>` })
  } catch (err) {
    console.error('[buffer-publish] alert email failed:', err.message)
  }
}

const describe = (e) => `${e.postId ?? e.post_id} on ${e.platform}, due ${new Date(e.dueAt ?? e.due_at).toLocaleString('en-US', { timeZone: 'America/New_York' })} ET`

let running = false

async function runBufferPublishJob({ source = 'cron' } = {}) {
  const mode = process.env.BUFFER_PUBLISH_ENABLED
  if (mode !== 'true' && mode !== 'dryrun') return 'disabled'
  if (running) return 'already-running'
  running = true
  try {
    const entries = await loadSchedule()
    const { rows: decisions } = await db.query("select post_id from content_approval_decisions where status = 'approved'")
    const { rows: existing } = await db.query('select * from buffer_posts')
    const plan = planActions({
      entries,
      approvedIds: new Set(decisions.map((d) => d.post_id)),
      rows: new Map(existing.map((r) => [keyOf(r.post_id, r.platform), r])),
    })

    if (mode === 'dryrun') {
      console.log(`[buffer-publish] dry run (${source}): would queue ${plan.create.map(describe).join('; ') || 'nothing'}; would withdraw ${plan.withdraw.map(describe).join('; ') || 'nothing'}`)
      return 'dryrun'
    }

    const queued = []
    const failed = []
    for (const entry of plan.create) {
      // Claim the row first, so a second run at the same moment can't queue it
      // again. A post that was withdrawn and approved again is reclaimed.
      const { rows: claimed } = await db.query(
        `insert into buffer_posts (post_id, platform, due_at, status) values ($1, $2, $3, 'queued')
         on conflict (post_id, platform) do update
           set status = 'queued', buffer_post_id = null, error = null, due_at = excluded.due_at, updated_at = now()
           where buffer_posts.status = 'withdrawn'
         returning id`,
        [entry.postId, entry.platform, entry.dueAt]
      )
      if (!claimed.length) continue
      try {
        const bufferPostId = await createPost(entry)
        await db.query('update buffer_posts set buffer_post_id = $1, updated_at = now() where id = $2', [bufferPostId, claimed[0].id])
        queued.push(describe(entry))
      } catch (err) {
        await db.query("update buffer_posts set status = 'error', error = $1, updated_at = now() where id = $2", [err.message.slice(0, 1000), claimed[0].id])
        failed.push(`${describe(entry)}: ${err.message}`)
      }
    }

    const withdrawn = []
    for (const row of plan.withdraw) {
      try {
        await deletePost(row.platform, row.buffer_post_id)
        await db.query("update buffer_posts set status = 'withdrawn', updated_at = now() where id = $1", [row.id])
        withdrawn.push(describe(row))
      } catch (err) {
        failed.push(`Could not remove ${describe(row)} from Buffer: ${err.message}`)
      }
    }

    if (queued.length || withdrawn.length) {
      await alert('Buffer: posts queued or removed', [
        ...queued.map((q) => `Queued: ${q}`),
        ...withdrawn.map((w) => `Removed (no longer approved): ${w}`),
      ])
    }
    if (failed.length) {
      await alert('Buffer: posts that need attention', [...failed, 'Failed posts are not retried. Fix the cause, then delete the row from buffer_posts to try again.'])
    }
    console.log(`[buffer-publish] ${queued.length} queued, ${withdrawn.length} withdrawn, ${failed.length} failed (${source})`)
    return 'ran'
  } catch (err) {
    console.error('[buffer-publish] run failed:', err)
    await alert('Buffer: the publish job failed', [err.message])
    return 'failed'
  } finally {
    running = false
  }
}

function startBufferPublishScheduler() {
  // Every 30 minutes; approvals also trigger a run (routes/contentApprovalDecisions.js).
  cron.schedule('*/30 * * * *', () => runBufferPublishJob({ source: 'cron' }), { timezone: 'America/New_York' })
  console.log('[buffer-publish] job registered')
}

module.exports = { startBufferPublishScheduler, runBufferPublishJob, planActions }
