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

module.exports = {
  REPORT_TYPE,
  sendContentApprovalRequestPreview,
  sendContentApprovalRequest,
}
