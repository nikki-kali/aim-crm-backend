const crypto = require('crypto')
const fs = require('fs')
const path = require('path')
const { sendEmail } = require('../email')
const db = require('../../config/db')
const { createApprovalToken, buildApproveUrl } = require('../reportApproval')

// Leadership approval request for the Dormant Accounts Re-engagement Plan,
// with the campaign playbook attached. Same preview-then-"Approve & Send"
// flow as the content approval emails: the preview goes to the media inbox,
// and only a confirmed click sends it to leadership.
const REPORT_TYPE = 'winback-approval'
const PREVIEW_TO = 'media@aimdentallab.com'
const LEADERSHIP = {
  to: ['ben@aimdentallab.com'],
  cc: ['execassistant@aimdentallab.com', 'james@aimdentallab.com', 'williama@aimdentallab.com', 'media@aimdentallab.com'],
  // Sent from noreply@, so replies go to the media inbox.
  replyTo: 'media@aimdentallab.com',
}
const SUBJECT = 'For Review and Approval: AIM Dormant Accounts Re-engagement Proposal'

const TEMPLATE = fs.readFileSync(path.join(__dirname, 'approvalEmail.html'), 'utf8')
const PLAYBOOK = fs.readFileSync(path.join(__dirname, 'Aim-Dormant-Accounts-Re-engagement-Playbook.pdf'))
const ATTACHMENTS = [{ filename: 'Aim-Dormant-Accounts-Re-engagement-Playbook.pdf', content: PLAYBOOK }]
// Shown on the confirm page so you can tell which email version will send.
const VERSION = crypto.createHash('sha1').update(TEMPLATE).update(PLAYBOOK).digest('hex').slice(0, 8)

const RECIPIENTS_TEXT = `to ${LEADERSHIP.to.join(', ')}, cc ${LEADERSHIP.cc.join(', ')}, replies to ${LEADERSHIP.replyTo}`

function bannerRow(approveUrl) {
  return `<tr><td style="padding:18px 24px;background:#fef3c7;border-bottom:1px solid #fcd34d;font-family:-apple-system,Segoe UI,Arial,sans-serif;border-radius:19px 19px 0 0">
    <p style="margin:0 0 10px;font-size:13px;color:#78350f;line-height:1.5">This is a preview. Nothing has been sent to leadership yet.<br>Approving sends it with the playbook attached, ${RECIPIENTS_TEXT}.</p>
    <a href="${approveUrl}" style="display:inline-block;padding:10px 22px;background:#059669;color:#fff;text-decoration:none;font-weight:600;font-size:14px;border-radius:8px">Approve &amp; Send</a>
  </td></tr>`
}

async function sendWinbackApprovalPreview() {
  // Retire any earlier unused preview link, so only the newest one can send.
  await db.query(`update report_approval_tokens set used_at = now() where report_type = $1 and used_at is null`, [REPORT_TYPE])
  const token = await createApprovalToken({ reportType: REPORT_TYPE, reportDate: new Date().toISOString().slice(0, 10) })
  const html = TEMPLATE.replace('<!--APPROVAL_BANNER-->', bannerRow(buildApproveUrl(token)))
  await sendEmail({ to: PREVIEW_TO, subject: SUBJECT, html, attachments: ATTACHMENTS })
}

async function sendWinbackApproval() {
  await sendEmail({ ...LEADERSHIP, subject: SUBJECT, html: TEMPLATE.replace('<!--APPROVAL_BANNER-->', ''), attachments: ATTACHMENTS })
}

module.exports = { REPORT_TYPE, VERSION, RECIPIENTS_TEXT, sendWinbackApprovalPreview, sendWinbackApproval }
