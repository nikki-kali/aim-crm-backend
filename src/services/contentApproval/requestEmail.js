const crypto = require('crypto')
const fs = require('fs')
const path = require('path')
const { sendEmail } = require('../email')
const { createApprovalToken, buildApproveUrl } = require('../reportApproval')

// Email asking leadership to review content on Marketing OS's public
// /content-approvals page. Same preview-then-"Approve & Send" flow as the
// leadership reports (services/reportApproval.js): the preview goes to the
// media inbox first, and only a confirmed click sends it to leadership.
const REPORT_TYPE = 'content-approval-request'
const PREVIEW_TO = 'media@aimdentallab.com'
const LEADERSHIP = {
  to: ['execassistant@aimdentallab.com'],
  cc: ['ben@aimdentallab.com'],
  bcc: ['media@aimdentallab.com'],
}
const SUBJECT = 'AIM October social posts ready for your approval'

const TEMPLATE = fs.readFileSync(path.join(__dirname, 'requestEmail.html'), 'utf8')
// Shown on the confirm page so you can tell which email version will send.
const TEMPLATE_VERSION = crypto.createHash('sha1').update(TEMPLATE).digest('hex').slice(0, 8)

// Follow-up nudge on the same request. Its preview keeps the original
// "[Preview] ..." subject and the leadership copy uses "Re: ...", so both
// land in the existing threads.
const FOLLOWUP_REPORT_TYPE = 'content-approval-followup'
const FOLLOWUP_TEMPLATE = fs.readFileSync(path.join(__dirname, 'followupEmail.html'), 'utf8')
const FOLLOWUP_VERSION = crypto.createHash('sha1').update(FOLLOWUP_TEMPLATE).digest('hex').slice(0, 8)
// Message-ID of the Oct 8 leadership email (read from the media@ BCC copy).
// Sending the follow-up with In-Reply-To/References set to it is what puts
// it in the same thread; a matching subject alone isn't enough for Gmail.
const ORIGINAL_MESSAGE_ID = '<010001a11a7750db-d48c0c86-f965-44a1-8fca-6c98a4598f74-000000@email.amazonses.com>'
const REPLY_HEADERS = { 'In-Reply-To': ORIGINAL_MESSAGE_ID, References: ORIGINAL_MESSAGE_ID }

function bannerRow(approveUrl) {
  return `<tr><td style="background:#fefaf1;border-bottom:1px solid #fde68a;padding:18px 36px;text-align:center;font-family:Arial,Helvetica,sans-serif">
    <p style="margin:0 0 10px;font-size:13px;color:#78350f;line-height:1.5">This is a preview. Nothing has been sent to leadership yet.<br>Approving sends it to execassistant@aimdentallab.com, cc ben@aimdentallab.com, bcc media@aimdentallab.com.</p>
    <a href="${approveUrl}" style="display:inline-block;padding:11px 26px;background:#059669;color:#fff;text-decoration:none;font-weight:600;font-size:13.5px;border-radius:10px">Approve &amp; Send &#8594;</a>
    <p style="margin:10px 0 0;font-size:10.5px;color:#92702c">You'll be asked to confirm before anything sends. This link expires in 24 hours and can only be used once.</p>
  </td></tr>`
}

async function sendContentApprovalRequestPreview() {
  const reportDate = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' })
  const token = await createApprovalToken({ reportType: REPORT_TYPE, reportDate })
  const html = TEMPLATE.replace('<!--APPROVAL_BANNER-->', bannerRow(buildApproveUrl(token)))
  await sendEmail({ to: PREVIEW_TO, subject: `[Preview] ${SUBJECT}`, html })
  return { previewTo: PREVIEW_TO }
}

async function sendContentApprovalRequest() {
  await sendEmail({ ...LEADERSHIP, subject: SUBJECT, html: TEMPLATE })
}

async function sendContentApprovalFollowupPreview() {
  const reportDate = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' })
  const token = await createApprovalToken({ reportType: FOLLOWUP_REPORT_TYPE, reportDate })
  const html = FOLLOWUP_TEMPLATE.replace('<!--APPROVAL_BANNER-->', bannerRow(buildApproveUrl(token)))
  await sendEmail({ to: PREVIEW_TO, subject: `[Preview] ${SUBJECT}`, html, headers: REPLY_HEADERS })
  return { previewTo: PREVIEW_TO }
}

async function sendContentApprovalFollowup() {
  await sendEmail({ ...LEADERSHIP, subject: `Re: ${SUBJECT}`, html: FOLLOWUP_TEMPLATE, headers: REPLY_HEADERS })
}

module.exports = {
  REPORT_TYPE,
  TEMPLATE_VERSION,
  FOLLOWUP_REPORT_TYPE,
  FOLLOWUP_VERSION,
  sendContentApprovalRequestPreview,
  sendContentApprovalRequest,
  sendContentApprovalFollowupPreview,
  sendContentApprovalFollowup,
}
