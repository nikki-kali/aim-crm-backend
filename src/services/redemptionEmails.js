// Branded emails for trade-show offer redemptions (routes/eventRedemptions.js):
//  - welcomeEmail: to the practice that just registered. Its first real
//    impression of AIM, so it's warm, personal (name, practice, scanner, what
//    they send most) and leads to one action: send the first case.
//  - teamAlertEmail: to James, cc media@, execassistant@, Ben.
// Table-based, inline styles, 600px, so it holds up in Gmail and Outlook.
// Brand tokens match services/email.js (pulled from the website's design
// system); fonts fall back to Georgia / system sans where web fonts don't load.

const FONT_DISPLAY = "'Cormorant Garamond',Georgia,'Times New Roman',serif"
const FONT_BODY = "'DM Sans',-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif"
const FONT_DATA = "'DM Mono',ui-monospace,SFMono-Regular,Menlo,Consolas,monospace"
const C = {
  ink: '#10353f', slate: '#5b7a86', aqua: '#06babe', teal: '#207290',
  mist: '#e6f9f9', ivory: '#f7f5f0', line: '#e5e7eb', page: '#eef4f6',
}
const LOGO = 'https://aimdentallab.wordpress.com/wp-content/uploads/2025/03/aim-logo-transparent-2026-2.png'
const SITE = 'https://aimdentallab.com'
const START_CASE = `${SITE}/contact?flow=scan#schedule-pickup`
const PHONE = '(718) 854-3900'
const PHONE_TEL = '+17188543900'

function esc(v) {
  return String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

// "Dr. Jane Smith" -> "Dr. Smith"; "Jane Smith" -> "Jane".
function greetingName(name) {
  const n = String(name || '').trim().replace(/\s+/g, ' ')
  if (!n) return 'there'
  const parts = n.split(' ')
  if (/^dr\.?$/i.test(parts[0]) && parts.length > 1) return `Dr. ${parts[parts.length - 1]}`
  return parts[0]
}

const INTEREST_PHRASE = {
  'Crown & Bridge': 'crown and bridge case',
  Implant: 'implant case',
  Dentures: 'denture case',
  Ortho: 'orthodontic case',
  'Digital scanning': 'digital case',
}

// Step 1 adapts to how the practice works today.
function firstStep(scanner) {
  if (scanner && !/^No scanner/.test(scanner) && scanner !== 'Other scanner') {
    return { title: 'Send your scan', body: `Upload your ${esc(scanner)} scan straight to us. We accept STL, PLY, OBJ and DCM files.` }
  }
  if (/^No scanner/.test(scanner || '')) {
    return { title: 'Book a pickup', body: 'Schedule a pickup for your impressions with our NYC courier.' }
  }
  return { title: 'Send your case', body: 'Upload a digital scan, or schedule a pickup for impressions with our NYC courier.' }
}

function shell({ preheader, body }) {
  return `<!DOCTYPE html>
<html lang="en" xmlns="http://www.w3.org/1999/xhtml">
<head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="x-apple-disable-message-reformatting">
<meta name="color-scheme" content="light"><meta name="supported-color-schemes" content="light">
<title>AIM Dental Laboratory</title>
<link href="https://fonts.googleapis.com/css2?family=Cormorant+Garamond:wght@600&family=DM+Sans:wght@400;500;700&family=DM+Mono:wght@500&display=swap" rel="stylesheet">
<style>
  body{margin:0;padding:0;background:${C.page};}
  a{color:${C.teal};}
  @media (max-width:620px){ .wrap{width:100%!important} .px{padding-left:22px!important;padding-right:22px!important} .h1{font-size:30px!important} .prize{font-size:30px!important} }
</style>
</head>
<body style="margin:0;padding:0;background:${C.page};">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;font-size:1px;line-height:1px;color:${C.page};">${esc(preheader)}&#847;&#847;&#847;&#847;&#847;&#847;</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${C.page};">
<tr><td align="center" style="padding:28px 12px;">
<table role="presentation" class="wrap" width="600" cellpadding="0" cellspacing="0" border="0" style="width:600px;max-width:600px;background:#ffffff;border-radius:16px;overflow:hidden;">
${body}
</table>
</td></tr></table>
</body></html>`
}

function logoHeader(eyebrow) {
  return `<tr><td align="center" style="padding:28px 40px 18px;" class="px">
  <a href="${SITE}"><img src="${LOGO}" width="180" height="54" alt="AIM Dental Laboratory, Est. 1951" style="display:block;width:180px;height:auto;border:0;"></a>
  ${eyebrow ? `<div style="margin-top:12px;font-family:${FONT_DATA};font-size:11px;letter-spacing:2.5px;color:${C.teal};text-transform:uppercase;">${esc(eyebrow)}</div>` : ''}
</td></tr>
<tr><td style="padding:0 40px;" class="px"><div style="height:2px;line-height:2px;font-size:0;background:${C.aqua};width:56px;margin:0 auto;">&nbsp;</div></td></tr>`
}

function footer() {
  return `<tr><td style="padding:26px 40px 30px;background:${C.ink};" class="px" align="center">
  <div style="font-family:${FONT_DISPLAY};font-size:19px;font-weight:600;color:#ffffff;">Precision crafted. Delivered on time.</div>
  <div style="margin-top:6px;font-family:${FONT_BODY};font-size:13px;color:#c9d4d7;">Your Brooklyn dental lab since 1951</div>
  <div style="margin-top:16px;font-family:${FONT_BODY};font-size:12px;line-height:1.7;color:#9fb4bb;">
    AIM Dental Laboratory &middot; 802 Myrtle Avenue, Brooklyn, NY 11206<br>
    <a href="tel:${PHONE_TEL}" style="color:#9fb4bb;text-decoration:none;">${PHONE}</a> &middot; <a href="${SITE}" style="color:#9fb4bb;text-decoration:none;">aimdentallab.com</a>
  </div>
</td></tr>`
}

function button(href, label) {
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" align="center"><tr>
  <td bgcolor="${C.teal}" style="background:${C.teal};border-radius:999px;">
    <a href="${href}" style="display:inline-block;padding:15px 34px;font-family:${FONT_BODY};font-size:16px;font-weight:700;color:#ffffff;text-decoration:none;border-radius:999px;">${esc(label)}</a>
  </td></tr></table>`
}

// ---------------------------------------------------------------- practice welcome
function welcomeEmail(d, s, r = {}) {
  const review = r.status === 'needs_review'
  const hi = greetingName(d.name)
  const first = INTEREST_PHRASE[d.interest]
  const step1 = firstStep(d.scanner)
  const subject = `${d.event.test ? '[TEST] ' : ''}${review ? `Thank you, ${hi}: your ${d.event.label} offer is registered` : `Welcome to AIM, ${hi}: your ${d.event.label} offer is ready`}`
  const preheader = `${s.prize} for ${d.practice}. Send your first case by ${d.event.deadlineLabel}.`
  const steps = [
    step1,
    { title: 'Mention your show offer', body: `Note "${esc(d.event.label)} offer" on your Rx so we apply it to your first case.` },
    { title: `Have it reach us by ${esc(d.event.deadlineLabel)}`, body: 'Your offer is valid when your first case arrives within 14 days of the show.' },
  ]
  const body = `
${logoHeader(`${d.event.label} · Show offer`)}
<tr><td style="padding:22px 40px 6px;" class="px" align="center">
  <h1 class="h1" style="margin:0;font-family:${FONT_DISPLAY};font-size:36px;line-height:1.1;font-weight:600;color:${C.ink};">${review ? `Thank you, ${esc(hi)}.` : `Welcome to AIM, ${esc(hi)}.`}</h1>
  <p style="margin:12px 0 0;font-family:${FONT_BODY};font-size:16px;line-height:1.6;color:${C.slate};">
    ${review
      ? `We've received ${esc(d.practice)}'s registration. Our team will confirm your offer with you shortly.`
      : `It was a pleasure meeting you at ${esc(d.event.label)}. ${esc(d.practice)} is registered, and your offer is ready to use.`}
  </p>
</td></tr>

<tr><td style="padding:22px 40px 8px;" class="px">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${C.ink};border-radius:14px;">
    <tr><td align="center" style="padding:26px 24px 24px;">
      <div style="font-family:${FONT_DATA};font-size:11px;letter-spacing:2.5px;color:${C.aqua};text-transform:uppercase;">Your offer</div>
      <div class="prize" style="margin-top:8px;font-family:${FONT_DISPLAY};font-size:36px;line-height:1.1;font-weight:600;color:#ffffff;">${esc(s.prize)}</div>
      <div style="margin:14px auto 0;height:1px;line-height:1px;font-size:0;background:#2c5865;width:80px;">&nbsp;</div>
      <div style="margin-top:14px;font-family:${FONT_BODY};font-size:14px;color:#c9d4d7;">For ${esc(d.practice)} &middot; first case by <b style="color:#ffffff;">${esc(d.event.deadlineLabel)}</b></div>
    </td></tr>
  </table>
</td></tr>

<tr><td style="padding:22px 40px 4px;" class="px">
  <div style="font-family:${FONT_DISPLAY};font-size:24px;font-weight:600;color:${C.ink};">How to use it</div>
  ${first ? `<p style="margin:6px 0 0;font-family:${FONT_BODY};font-size:15px;line-height:1.6;color:${C.slate};">We're looking forward to your first ${first}. Three simple steps:</p>` : ''}
</td></tr>
<tr><td style="padding:10px 40px 6px;" class="px">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
    ${steps.map((st, i) => `<tr>
      <td width="40" valign="top" style="padding:10px 0;">
        <div style="width:30px;height:30px;line-height:30px;border-radius:15px;background:${C.mist};text-align:center;font-family:${FONT_DATA};font-size:14px;font-weight:500;color:${C.teal};">${i + 1}</div>
      </td>
      <td valign="top" style="padding:10px 0 10px 10px;border-bottom:${i < steps.length - 1 ? `1px solid ${C.line}` : '0'};">
        <div style="font-family:${FONT_BODY};font-size:15px;font-weight:700;color:${C.ink};">${st.title}</div>
        <div style="margin-top:3px;font-family:${FONT_BODY};font-size:14px;line-height:1.55;color:${C.slate};">${st.body}</div>
      </td></tr>`).join('')}
  </table>
</td></tr>

<tr><td style="padding:22px 40px 8px;" class="px" align="center">
  ${button(START_CASE, 'Start your first case')}
  <div style="margin-top:12px;font-family:${FONT_BODY};font-size:13px;color:${C.slate};">or call us at <a href="tel:${PHONE_TEL}" style="color:${C.teal};font-weight:700;text-decoration:none;">${PHONE}</a></div>
</td></tr>

<tr><td style="padding:24px 40px 28px;" class="px">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${C.ivory};border-radius:12px;">
    <tr><td style="padding:18px 20px;">
      <div style="font-family:${FONT_DATA};font-size:11px;letter-spacing:2px;color:${C.teal};text-transform:uppercase;">Registered for</div>
      <div style="margin-top:8px;font-family:${FONT_BODY};font-size:14px;line-height:1.65;color:${C.ink};">
        <b>${esc(d.practice)}</b><br>
        ${esc(d.street)}, ${esc(d.city)}, ${esc(d.state)} ${esc(d.zip)}<br>
        ${esc(d.phone)} &middot; ${esc(d.email)}
      </div>
      <div style="margin-top:10px;font-family:${FONT_BODY};font-size:13px;color:${C.slate};">Something not right? Just reply to this email and we'll fix it.</div>
    </td></tr>
  </table>
  <p style="margin:16px 0 0;font-family:${FONT_BODY};font-size:12px;line-height:1.6;color:${C.slate};">
    One offer per practice. Valid when your first case reaches AIM by ${esc(d.event.deadlineLabel)}. Full terms at
    <a href="${SITE}/gnydm/redeem" style="color:${C.teal};">aimdentallab.com/gnydm/redeem</a>.
  </p>
</td></tr>
${footer()}`
  return { subject, html: shell({ preheader, body }) }
}

// ---------------------------------------------------------------- team alert
function teamAlertEmail(d, s, r, { sheetUrl } = {}) {
  const review = r.status === 'needs_review'
  const subject = (d.event.test ? '[TEST] ' : '') + (review
    ? `Registered Practice won: ${s.prize} - needs review (${d.practice})`
    : `Registered New Practice won: ${s.prize} (${d.practice})`)
  const rows = [
    ['Doctor', esc(d.name)],
    ['Practice', `<b>${esc(d.practice)}</b>`],
    ['Email', `<a href="mailto:${esc(d.email)}" style="color:${C.teal};">${esc(d.email)}</a>`],
    ['Phone', `<a href="tel:${esc(d.phone.replace(/[^\d+]/g, ''))}" style="color:${C.teal};">${esc(d.phone)}</a>`],
    ['Address', `${esc(d.street)}<br>${esc(d.city)}, ${esc(d.state)} ${esc(d.zip)}`],
    ['Scanner', esc(d.scanner || 'Not given')],
    ['Sends most', esc(d.interest || 'Not given')],
    ['Marketing emails', d.consent ? 'Opted in' : 'Not opted in'],
    ['First case due', esc(d.event.deadlineLabel)],
    ['Redemptions', `${r.count} of ${s.limit}`],
  ]
  const badge = review
    ? `<span style="display:inline-block;padding:5px 12px;border-radius:999px;background:#fdf3e1;color:#8a5a00;font-family:${FONT_BODY};font-size:12px;font-weight:700;">Needs review</span>`
    : `<span style="display:inline-block;padding:5px 12px;border-radius:999px;background:${C.mist};color:${C.teal};font-family:${FONT_BODY};font-size:12px;font-weight:700;">Verified new practice</span>`
  const body = `
${logoHeader('Marketing Updates & Alerts')}
<tr><td style="padding:22px 40px 4px;" class="px" align="center">
  ${badge}
  <h1 style="margin:12px 0 0;font-family:${FONT_DISPLAY};font-size:30px;line-height:1.15;font-weight:600;color:${C.ink};">${esc(d.practice)} claimed the ${esc(d.event.label)} offer</h1>
  <p style="margin:10px 0 0;font-family:${FONT_BODY};font-size:15px;line-height:1.6;color:${C.slate};">
    ${review ? `It matches ${esc(r.review_reason || 'an existing AIM client or clinic')}. Please confirm it qualifies before the offer is applied.` : 'All checks passed. Time to welcome them and help them send that first case.'}
  </p>
</td></tr>
<tr><td style="padding:18px 40px 6px;" class="px">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${C.ink};border-radius:12px;">
    <tr><td align="center" style="padding:18px 20px;">
      <div style="font-family:${FONT_DATA};font-size:11px;letter-spacing:2.5px;color:${C.aqua};text-transform:uppercase;">Prize won</div>
      <div style="margin-top:6px;font-family:${FONT_DISPLAY};font-size:26px;font-weight:600;color:#ffffff;">${esc(s.prize)}</div>
    </td></tr>
  </table>
</td></tr>
<tr><td style="padding:14px 40px 8px;" class="px">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
    ${rows.map(([k, v]) => `<tr>
      <td width="140" valign="top" style="padding:10px 0;border-bottom:1px solid ${C.line};font-family:${FONT_BODY};font-size:13px;color:${C.slate};">${k}</td>
      <td valign="top" style="padding:10px 0;border-bottom:1px solid ${C.line};font-family:${FONT_BODY};font-size:14px;color:${C.ink};">${v}</td>
    </tr>`).join('')}
  </table>
</td></tr>
<tr><td style="padding:20px 40px 28px;" class="px" align="center">
  ${sheetUrl ? button(sheetUrl, 'Open the redemptions sheet') : ''}
  <div style="margin-top:12px;font-family:${FONT_BODY};font-size:12px;line-height:1.6;color:${C.slate};">
    ${d.event.test ? 'TEST registration: not added to the CRM. It shows in the sheet as "TEST - ignore".' : `Added to the CRM as a ${esc(d.event.label)} lead. Reply to this email to reach the practice directly.`}
  </div>
</td></tr>
${footer()}`
  return { subject, html: shell({ preheader: `${d.practice} claimed ${s.prize}.`, body }) }
}

module.exports = { welcomeEmail, teamAlertEmail, greetingName, firstStep }
