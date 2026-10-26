const crypto = require('crypto')
const fs = require('fs')
const path = require('path')
const { sendEmail } = require('../email')
const db = require('../../config/db')
const { createApprovalToken, buildApproveUrl } = require('../reportApproval')

// Weekly marketing update to leadership. Each week is one HTML file in
// ./updates named by the week-ending date (YYYY-MM-DD.html, with an
// <!--APPROVAL_BANNER--> placeholder and its subject in <title>). The newest
// file is the one sent, with any files in ./updates/<week>-attachments attached. Same preview-then-"Approve & Send" flow as the other
// leadership emails: the preview goes to the media inbox first.
const REPORT_TYPE = 'marketing-weekly-update'
const PREVIEW_TO = 'media@aimdentallab.com'
const LEADERSHIP = {
  to: ['ben@aimdentallab.com'],
  cc: ['execassistant@aimdentallab.com', 'james@aimdentallab.com', 'williama@aimdentallab.com', 'media@aimdentallab.com'],
  // Sent from noreply@, so replies go to the media inbox.
  replyTo: 'media@aimdentallab.com',
}
const UPDATES_DIR = path.join(__dirname, 'updates')
const RECIPIENTS_TEXT = `to ${LEADERSHIP.to.join(', ')}, cc ${LEADERSHIP.cc.join(', ')}, replies to ${LEADERSHIP.replyTo}`

function latestUpdate() {
  const files = fs.readdirSync(UPDATES_DIR).filter((f) => /^\d{4}-\d{2}-\d{2}\.html$/.test(f)).sort()
  if (!files.length) throw new Error('No weekly update files found')
  const file = files[files.length - 1]
  const html = fs.readFileSync(path.join(UPDATES_DIR, file), 'utf8')
  const subject = (html.match(/<title>([^<]+)<\/title>/) || [])[1] || 'Marketing weekly update'
  // Optional attachments: every file in updates/<week>-attachments/.
  const week = file.slice(0, 10)
  const dir = path.join(UPDATES_DIR, `${week}-attachments`)
  const attachments = fs.existsSync(dir)
    ? fs.readdirSync(dir).filter((f) => !f.startsWith('.')).sort().map((f) => ({ filename: f, content: fs.readFileSync(path.join(dir, f)) }))
    : []
  const hash = crypto.createHash('sha1').update(html)
  attachments.forEach((a) => hash.update(a.filename).update(a.content))
  return { week, html, subject, attachments, version: hash.digest('hex').slice(0, 8) }
}

function bannerRow(approveUrl) {
  return `<tr><td style="padding:18px 24px;background:#fef3c7;border-bottom:1px solid #fcd34d;font-family:-apple-system,Segoe UI,Arial,sans-serif;border-radius:19px 19px 0 0">
    <p style="margin:0 0 10px;font-size:13px;color:#78350f;line-height:1.5">This is a preview. Nothing has been sent to leadership yet.<br>Approving sends it ${RECIPIENTS_TEXT}.</p>
    <a href="${approveUrl}" style="display:inline-block;padding:10px 22px;background:#059669;color:#fff;text-decoration:none;font-weight:600;font-size:14px;border-radius:8px">Approve &amp; Send</a>
  </td></tr>`
}

async function sendWeeklyUpdatePreview() {
  const u = latestUpdate()
  // Retire any earlier unused preview link, so only the newest one can send.
  await db.query(`update report_approval_tokens set used_at = now() where report_type = $1 and used_at is null`, [REPORT_TYPE])
  const token = await createApprovalToken({ reportType: REPORT_TYPE, reportDate: u.week })
  await sendEmail({ to: PREVIEW_TO, subject: u.subject, html: u.html.replace('<!--APPROVAL_BANNER-->', bannerRow(buildApproveUrl(token))), attachments: u.attachments })
  return u
}

async function sendWeeklyUpdate() {
  const u = latestUpdate()
  await sendEmail({ ...LEADERSHIP, subject: u.subject, html: u.html.replace('<!--APPROVAL_BANNER-->', ''), attachments: u.attachments })
  return u
}

function describe() {
  const u = latestUpdate()
  return { week: u.week, subject: u.subject, version: u.version }
}

module.exports = { REPORT_TYPE, RECIPIENTS_TEXT, describe, sendWeeklyUpdatePreview, sendWeeklyUpdate }
