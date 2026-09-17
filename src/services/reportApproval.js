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

// Atomic claim: only succeeds once per token, even under a double-click
// or the link being opened twice — the UPDATE's WHERE clause (unused,
// unexpired) means a second attempt matches zero rows and this returns
// null rather than re-running a real send.
async function consumeApprovalToken(token) {
  const { rows } = await db.query(
    `UPDATE report_approval_tokens
     SET used_at = NOW()
     WHERE token = $1 AND used_at IS NULL AND expires_at > NOW()
     RETURNING report_type, rep_id, to_char(report_date, 'YYYY-MM-DD') AS report_date`,
    [token]
  )
  return rows[0] || null
}

// Inserted right inside the report's own white card, above its header —
// same exact wrapper string both buildReport.js's (Leadership Report) and
// email.js's (Sales Rep Daily Report) templates open with, so this works
// for either without needing report-specific injection logic. Only the
// FIRST match is replaced (plain string .replace), which is correct here
// since each of these HTML documents contains exactly one such wrapper.
const CARD_OPEN = '<div style="max-width:600px;margin:40px auto;background:#fff;border-radius:24px;overflow:hidden;box-shadow:0 6px 28px rgba(32,114,144,.16)">'

function injectApprovalBanner(html, { reportLabel, approveUrl }) {
  const banner = `
  <div style="background:#fefaf1;border-bottom:1px solid #fde68a;padding:18px 36px;text-align:center">
    <p style="margin:0 0 10px;font-size:13px;color:#78350f;line-height:1.5">This is a preview of the <b>${escapeHtml(reportLabel)}</b>. Nothing has been sent yet.</p>
    <a href="${approveUrl}" style="display:inline-block;padding:11px 26px;background:#059669;color:#fff;text-decoration:none;font-weight:600;font-size:13.5px;border-radius:10px;font-family:-apple-system,sans-serif">Approve &amp; Send &#8594;</a>
    <p style="margin:10px 0 0;font-size:10.5px;color:#92702c">This link expires in 24 hours and can only be used once.</p>
  </div>`
  if (!html.includes(CARD_OPEN)) return html // defensive: template changed shape, don't silently drop the report
  return html.replace(CARD_OPEN, CARD_OPEN + banner)
}

module.exports = {
  APPROVER_EMAIL,
  createApprovalToken,
  consumeApprovalToken,
  buildApproveUrl,
  injectApprovalBanner,
}
