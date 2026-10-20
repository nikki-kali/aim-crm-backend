const crypto = require('crypto')
const db = require('../config/db')

// Every real send this session has gone out only after the user
// explicitly reviewed a preview — this service backs a faster version of
// that same rule: an "Approve & Send" button embedded in the preview
// email itself, instead of the user replying "send it" in chat. The
// preview always goes to this one address; there's no per-user "who
// approves reports" concept in the CRM yet, so this is a hardcoded
// constant for now, matching this codebase's convention of hardcoding
// small fixed recipient lists (see RECIPIENTS in evidentReport/index.js,
// REPORT_CC in salesRepDailyReport.js).
const APPROVER_EMAIL = 'adivirtuosity@gmail.com'

const TOKEN_TTL_HOURS = 24

const BACKEND_URL = process.env.RENDER_EXTERNAL_URL || 'https://aim-crm-backend.onrender.com'

// 32 random bytes, hex-encoded — unguessable, and the only "auth" this
// flow has, since a link clicked from an email client can only ever be a
// plain unauthenticated GET (no bearer token to attach). Single-use
// (consumeApprovalToken below) and 24h-expiring, so a stale or forwarded
// link can't trigger a stray real send.
async function createApprovalToken({ reportType, repId = null, reportDate }) {
  const token = crypto.randomBytes(32).toString('hex')
  const expiresAt = new Date(Date.now() + TOKEN_TTL_HOURS * 60 * 60 * 1000)
  await db.query(
    `INSERT INTO report_approval_tokens (token, report_type, rep_id, report_date, expires_at)
     VALUES ($1,$2,$3,$4,$5)`,
    [token, reportType, repId, reportDate, expiresAt]
  )
  return token
}

function buildApproveUrl(token) {
  return `${BACKEND_URL}/api/reports/approve?token=${token}`
}

// reportLabel can carry a rep's name/email pulled from the CRM's own
// `users` table (see sendRepDailyReportForApproval) — admin-editable
// data, not a hardcoded constant, so it isn't safe to interpolate into
// the banner's HTML unescaped. Same escapeHtml as routes/scanSubmission.js
// and routes/implantIntake.js — duplicated here rather than shared,
// matching this codebase's convention for small isolated helpers.
function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
}

// Read-only check — does NOT mark the token used. Backs the GET /approve
// confirmation page (routes/reports.js), which must be safe to load
// repeatedly without side effects: email clients/providers routinely
// pre-fetch links in incoming mail to scan them for safety, and a GET that
// performed the real send (the original design) meant that automated
// pre-fetch silently burned the single-use token — and sent the real
// report — before the human ever clicked anything. Only the POST (backed
// by consumeApprovalToken below, triggered solely by a real click on the
// confirmation page's button) actually claims the token.
// Single use, fail closed (never sends twice): a link is usable only while
// unexpired and unclicked. A click that never finished sending (the server
// restarted mid-send, 20 Oct 2026) does NOT revive the link; once
// STALE_CLAIM_MINUTES have passed without sent_at, the link instead offers
// a fresh preview to the approver's own inbox (claimFreshPreview), which
// is approved as usual. sent_at is only a marker for that offer, never a
// condition for sending.
const STALE_CLAIM_MINUTES = 10
const run = (sql, params) => db.query(sql, params)
const CLAIM_FIELDS = `report_type, rep_id, to_char(report_date, 'YYYY-MM-DD') AS report_date`
const STALE_UNSENT = `expires_at > NOW() AND used_at IS NOT NULL AND sent_at IS NULL
  AND used_at < NOW() - make_interval(mins => ${STALE_CLAIM_MINUTES})`

async function peekApprovalToken(token, query = run) {
  const { rows } = await query(
    `SELECT ${CLAIM_FIELDS} FROM report_approval_tokens
     WHERE token = $1 AND used_at IS NULL AND expires_at > NOW()`,
    [token]
  )
  return rows[0] || null
}

// Atomic claim: a double-click or the page opened twice matches zero rows
// the second time, so it returns null rather than running the send twice.
async function consumeApprovalToken(token, query = run) {
  const { rows } = await query(
    `UPDATE report_approval_tokens SET used_at = NOW()
     WHERE token = $1 AND used_at IS NULL AND expires_at > NOW()
     RETURNING ${CLAIM_FIELDS}`,
    [token]
  )
  return rows[0] || null
}

// Called once the report has actually gone out.
async function markApprovalTokenSent(token, query = run) {
  await query(`UPDATE report_approval_tokens SET sent_at = NOW() WHERE token = $1`, [token])
}

// A clicked link whose send never finished, or null. Read-only.
async function peekStaleUnsentClaim(token, query = run) {
  const { rows } = await query(`SELECT ${CLAIM_FIELDS} FROM report_approval_tokens WHERE token = $1 AND ${STALE_UNSENT}`, [token])
  return rows[0] || null
}

// Atomically takes the one fresh-preview offer for such a link (sets
// sent_at so it can't be taken twice). The caller only ever sends a new
// approval PREVIEW to the approver, never the report itself.
async function claimFreshPreview(token, query = run) {
  const { rows } = await query(
    `UPDATE report_approval_tokens SET sent_at = NOW() WHERE token = $1 AND ${STALE_UNSENT} RETURNING ${CLAIM_FIELDS}`,
    [token]
  )
  return rows[0] || null
}

// The 9:00 AM ET automatic rep report send takes over a rep's approval
// links for that day before sending, in one locked transaction, so a click
// on Approve & Send and the automatic send can never both go out. Returns
// false when any link for that rep and day was already clicked (approved,
// or being approved), in which case the automatic send skips that rep.
async function claimRepLinksForAutoSend(repId, reportDate, pool = db) {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const { rows } = await client.query(
      `SELECT used_at FROM report_approval_tokens
       WHERE report_type = 'sales-rep-daily-report' AND rep_id = $1 AND report_date = $2 FOR UPDATE`,
      [repId, reportDate]
    )
    if (rows.some((r) => r.used_at)) { await client.query('ROLLBACK'); return false }
    await client.query(
      `UPDATE report_approval_tokens SET used_at = NOW()
       WHERE report_type = 'sales-rep-daily-report' AND rep_id = $1 AND report_date = $2 AND used_at IS NULL`,
      [repId, reportDate]
    )
    await client.query('COMMIT')
    return true
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {})
    throw err
  } finally {
    client.release()
  }
}

// After the automatic send went out: the day's links for that rep are sent.
async function markRepLinksSent(repId, reportDate, query = run) {
  await query(
    `UPDATE report_approval_tokens SET sent_at = NOW()
     WHERE report_type = 'sales-rep-daily-report' AND rep_id = $1 AND report_date = $2 AND sent_at IS NULL`,
    [repId, reportDate]
  )
}

// Inserted right inside the report's own card, above its header. Matched by
// its stable opening (max-width:600px card, 40px auto margin) rather than
// the full style string: the Leadership Report's card was restyled
// (2026-09-19) and an exact-string match silently stopped finding it, which
// sent approval previews with no Approve & Send button. Only the FIRST
// match is replaced, which is correct since each report has exactly one
// such wrapper.
const CARD_OPEN_RE = /<div style="max-width:600px;margin:40px auto;[^"]*">/

// `autoSendAt` (e.g. '7:00 AM ET'): when set, the banner says the report goes
// out automatically then unless the approver sends it sooner.
function injectApprovalBanner(html, { reportLabel, approveUrl, autoSendAt, autoSendTo = 'leadership', holdUrl }) {
  const banner = `
  <div style="background:#fefaf1;border-bottom:1px solid #fde68a;padding:18px 36px;text-align:center">
    <p style="margin:0 0 10px;font-size:13px;color:#78350f;line-height:1.5">This is a preview of the <b>${escapeHtml(reportLabel)}</b>. ${autoSendAt ? `It goes to ${escapeHtml(autoSendTo)} automatically at <b>${escapeHtml(autoSendAt)}</b>. Click below to send it sooner.` : 'Nothing has been sent yet.'}</p>
    <a href="${approveUrl}" style="display:inline-block;padding:11px 26px;background:#059669;color:#fff;text-decoration:none;font-weight:600;font-size:13.5px;border-radius:10px;font-family:-apple-system,sans-serif">Approve &amp; Send &#8594;</a>
    <p style="margin:10px 0 0;font-size:10.5px;color:#92702c">You'll be asked to confirm before anything sends. This link expires in 24 hours and can only be used once.</p>
    ${holdUrl ? `<p style="margin:12px 0 0;font-size:12.5px;color:#78350f">Don't want it to go out today? <a href="${holdUrl}" style="color:#b45309;font-weight:600;text-decoration:underline">Hold today's send</a></p>` : ''}
  </div>`
  if (!CARD_OPEN_RE.test(html)) return html // defensive: template changed shape, don't silently drop the report
  return html.replace(CARD_OPEN_RE, (card) => card + banner)
}

module.exports = {
  APPROVER_EMAIL,
  createApprovalToken,
  peekApprovalToken,
  consumeApprovalToken,
  markApprovalTokenSent,
  peekStaleUnsentClaim,
  claimFreshPreview,
  STALE_CLAIM_MINUTES,
  claimRepLinksForAutoSend,
  markRepLinksSent,
  buildApproveUrl,
  injectApprovalBanner,
}
