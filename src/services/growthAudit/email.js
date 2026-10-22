const { money, percent, BENCHMARK_REMAKE_RATE, BENCHMARK_SOURCE, BENCHMARK_URL } = require('./calc')

// HTML for the Growth Audit report email (to the practice) and the internal
// lead notification. Email-safe: tables and inline styles only, bars drawn
// as table cells, hosted logo (never base64). Uses the website's design
// tokens and fonts (Cormorant Garamond + DM Sans, Georgia + Arial fallback).
// House style: no em dashes, a general greeting, always a clear CTA.

const LOGO_URL = 'https://aimdentallab.wordpress.com/wp-content/uploads/2025/03/aim-logo-transparent-2026-2.png?w=560'
// The PDF is printed on the server, which can't count on fetching the hosted
// logo, so the print layout carries the same logo inline. (Email clients
// block base64 images, so the email keeps the hosted URL.)
const LOGO_DATA_URI = `data:image/png;base64,${require('fs').readFileSync(require('path').join(__dirname, 'assets', 'aim-logo-teal.png')).toString('base64')}`
// The server's Chrome has no emoji font, so the PDF draws the phone icon.
const PHONE_SVG = `<svg width="16" height="16" viewBox="0 0 24 24" style="vertical-align:-2px" aria-hidden="true"><path fill="#207290" d="M6.6 10.8a15.1 15.1 0 0 0 6.6 6.6l2.2-2.2a1 1 0 0 1 1-.25 11.4 11.4 0 0 0 3.6.57 1 1 0 0 1 1 1V20a1 1 0 0 1-1 1A17 17 0 0 1 3 4a1 1 0 0 1 1-1h3.5a1 1 0 0 1 1 1c0 1.25.2 2.45.57 3.57a1 1 0 0 1-.25 1z"/></svg>`
// Dark bands use the deep brand blue, matching the AIM email template.
const DEEP_BAND = 'background:linear-gradient(135deg,#207290 0%,#1a5f7a 100%);background-color:#207290'
const INK = '#10353f'
const DEEP = '#207290'
const GOLD = '#d9a441'
const SLATE = '#5b7a86'
const MIST = '#eaf3f7'

// Links back to the site carry UTMs so GA4 can attribute return visits and
// bookings to the report.
function siteUrl(path, content, extra = {}) {
  const params = new URLSearchParams({
    ...extra,
    utm_source: 'growth-audit-report',
    utm_medium: 'email',
    utm_campaign: 'partner-audit-2026',
    utm_content: content,
  })
  const [base, hash] = path.split('#')
  return `https://aimdentallab.com${base}?${params.toString()}${hash ? `#${hash}` : ''}`
}

const HTML_ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => HTML_ESCAPES[c])



// Infographic building blocks. Email-safe: nested tables, inline styles,
// no images except the logo. Gold is used for fills and on dark ground only
// (it fails contrast as text on white).
const GOLD_TINT = '#fbf1dc'
const LINE = '#dfe8ec'








// Site design tokens (aimdentallab.com, src/index.css @theme).
const TEAL = '#06babe'
const TEAL_MIST = '#e6f9f9'
const TEAL_SOFT = '#7fdfe1'
const BODY = '#3f5c66' // ink at ~80%, readable body text on white
const DISPLAY = "'Cormorant Garamond',Georgia,serif"
const SANS = "'DM Sans',Arial,sans-serif"
const CTA_GRADIENT = `background:linear-gradient(135deg,${TEAL},${DEEP});background-color:${DEEP}`
const FONTS_LINK = '<link href="https://fonts.googleapis.com/css2?family=Cormorant+Garamond:wght@500;600&family=DM+Sans:wght@400;500;700&display=swap" rel="stylesheet">'

function pill(href, label) {
  return `<a href="${esc(href)}" style="display:inline-block;${CTA_GRADIENT};color:#ffffff;font:bold 15px ${SANS};text-decoration:none;padding:14px 28px;border-radius:999px">${esc(label)}</a>`
}

function sectionLabel(text) {
  return `<p class="kicker" style="margin:30px 0 10px;font:bold 11px ${SANS};letter-spacing:2px;text-transform:uppercase;color:${DEEP}">${esc(text)}</p>`
}

// Three result tiles in one row.
function resultTiles(tiles) {
  return `<table role="presentation" class="card" width="100%" cellpadding="0" cellspacing="0"><tr>${tiles
    .map(
      (t, i) => `<td width="33%" valign="top" style="padding:0 ${i < tiles.length - 1 ? 8 : 0}px 0 0">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${t.alert ? GOLD_TINT : MIST};border-radius:16px"><tr><td style="padding:16px 14px">
        <p style="margin:0;font:600 30px/1 ${DISPLAY};color:${INK}">${esc(t.value)}</p>
        <p style="margin:6px 0 0;font:13px/1.35 ${SANS};color:${SLATE}">${esc(t.label)}</p>
      </td></tr></table></td>`,
    )
    .join('')}</tr></table>`
}

// Your rate vs the national rate, as two short bars.
function rateBars(cost) {
  const max = Math.max(cost.rate, BENCHMARK_REMAKE_RATE) || 1
  const bar = (label, value, color) => `
    <tr><td width="118" style="padding:5px 10px 5px 0;font:13px ${SANS};color:${SLATE};white-space:nowrap">${label}</td>
      <td style="padding:5px 0"><table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
        <td width="${Math.max(Math.round((value / max) * 100), value > 0 ? 3 : 0)}%" style="background:${color};height:14px;border-radius:7px;font-size:0;line-height:0">&nbsp;</td><td style="font-size:0;line-height:0">&nbsp;</td>
      </tr></table></td>
      <td width="52" align="right" style="padding:5px 0 5px 10px;font:bold 14px ${SANS};color:${INK}">${esc(percent(value))}</td></tr>`
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:14px 0 0">
    ${bar('Your practice', cost.rate, cost.aboveBenchmark ? GOLD : TEAL)}
    ${bar('National average', BENCHMARK_REMAKE_RATE, '#b9ccd4')}
  </table>`
}

// The savings, one line each, adding up to the headline.
function savingsList(levers) {
  return `<table role="presentation" class="card" width="100%" cellpadding="0" cellspacing="0" style="background:#ffffff;border:1px solid ${LINE};border-radius:16px">${levers
    .map(
      (l, i) => `<tr>
      <td width="40" valign="middle" style="padding:14px 0 14px 16px;${i ? `border-top:1px solid ${LINE}` : ''}">
        <table role="presentation" cellpadding="0" cellspacing="0"><tr><td width="26" height="26" align="center" valign="middle" style="${CTA_GRADIENT};border-radius:13px;font:bold 13px ${SANS};color:#ffffff">${i + 1}</td></tr></table>
      </td>
      <td valign="middle" style="padding:14px 10px;font:bold 15px ${SANS};color:${INK};${i ? `border-top:1px solid ${LINE}` : ''}">${esc(l.label)}</td>
      <td align="right" valign="middle" style="padding:14px 18px 14px 0;font:600 22px ${DISPLAY};color:${INK};white-space:nowrap;${i ? `border-top:1px solid ${LINE}` : ''}">${esc(money(l.value))}</td>
    </tr>`,
    )
    .join('')}</table>`
}

// What to fix: the problem, the one-line chairside fix, the one-line AIM answer.
function fixTable(problems) {
  return `<table role="presentation" class="card" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid ${LINE};border-radius:16px;overflow:hidden">${problems
    .map(
      (p, i) => `<tr><td style="padding:14px 18px;${i ? `border-top:1px solid ${LINE}` : ''}">
      <p style="margin:0 0 6px;font:bold 15px ${SANS};color:${INK}">${esc(p.name)}${p.first ? ` <span style="display:inline-block;margin-left:6px;padding:2px 9px;border-radius:999px;background:${TEAL_MIST};font:bold 10px ${SANS};letter-spacing:1px;text-transform:uppercase;color:${DEEP};vertical-align:2px">Start here</span>` : ''}</p>
      <p style="margin:0 0 3px;font:14px/1.45 ${SANS};color:${BODY}"><b style="color:${SLATE}">You:</b> ${esc(p.fixShort)}</p>
      <p style="margin:0;font:14px/1.45 ${SANS};color:${BODY}"><b style="color:${DEEP}">AIM:</b> ${esc(p.aimShort)}</p>
    </td></tr>`,
    )
    .join('')}</table>`
}

// `callback` is the booked slot as text ("Tuesday, October 21, in the
// morning (8 to 11 am ET)"), or null if none was booked.
// `print` lays the same report out for the PDF attachment: no grey frame,
// full Letter width, cards kept whole across page breaks. `pdfAttached`
// adds a line to the email saying a printable copy is attached.
// Built to be read at a glance: one number, three results, two savings,
// what to fix, and the call. The detail lives in the conversation.
function reportEmail({ practice, cost, report, contact, callback, print = false, pdfAttached = false }) {
  const first = contact.firstName === 'the AIM team' ? 'the lab' : contact.firstName
  const caller = contact.firstName === 'the AIM team' ? 'Our team' : contact.firstName
  const none = cost.annualRemakes === 0
  const bg = print ? '#ffffff' : '#f3f6f7'

  const heroNumber = none ? '0 remakes' : money(report.recoverable)
  const heroLine = none ? 'reported in a typical month' : 'a year you could get back'
  const heroSub = none ? report.glance : `Remakes cost your practice ${money(cost.total)} a year.`
  const recoverPct = none ? 0 : Math.max(Math.round((report.recoverable / (cost.total || 1)) * 100), 3)

  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light">${print ? '' : FONTS_LINK}${print ? `<title>AIM Growth Audit, ${esc(practice)}</title><style>
  @page { size: Letter; margin: 0.45in 0.5in; }
  html, body { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  .card, .sec { break-inside: avoid; page-break-inside: avoid; }
  .kicker { break-after: avoid; page-break-after: avoid; }
</style>` : ''}</head>
<body style="margin:0;padding:0;background:${bg}">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${bg}"><tr><td align="center" style="padding:${print ? '0' : '28px 12px'}">
<table role="presentation" width="${print ? '100%' : '600'}" cellpadding="0" cellspacing="0" style="${print ? 'width:100%' : 'max-width:600px;width:100%'};background:#ffffff;border-radius:${print ? '0' : '20px'};overflow:hidden">
  <tr><td style="height:5px;line-height:5px;font-size:5px;${CTA_GRADIENT}">&nbsp;</td></tr>
  <tr><td style="padding:22px 32px">
    <img src="${print ? LOGO_DATA_URI : LOGO_URL}" width="130" alt="AIM Dental Laboratory" style="display:block;width:130px;height:auto;border:0">
  </td></tr>

  <tr><td style="padding:28px 32px 30px;${DEEP_BAND}">
    <p style="margin:0 0 12px;font:bold 11px ${SANS};letter-spacing:2px;text-transform:uppercase;color:${TEAL_SOFT}">Your Growth Audit &middot; ${esc(practice)}</p>
    <p style="margin:0;font:600 60px/1 ${DISPLAY};color:#ffffff">${esc(heroNumber)}</p>
    <p style="margin:6px 0 0;font:500 18px ${SANS};color:#ffffff">${esc(heroLine)}</p>
    ${none ? '' : `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:18px 0 0;border-radius:7px;overflow:hidden"><tr>
      <td width="${recoverPct}%" style="background:${TEAL_SOFT};height:12px;font-size:0;line-height:0">&nbsp;</td>
      <td style="background:#4d8ba3;height:12px;font-size:0;line-height:0">&nbsp;</td>
    </tr></table>`}
    <p style="margin:10px 0 0;font:14px/1.5 ${SANS};color:#ffffff">${esc(heroSub)}</p>
  </td></tr>

  <tr><td class="px" style="padding:6px 32px 34px">

    <div class="sec">
    ${sectionLabel('Your results')}
    ${resultTiles([
      { value: percent(cost.rate), label: 'your remake rate', alert: cost.aboveBenchmark },
      { value: String(cost.annualRemakes), label: 'remakes a year' },
      { value: String(Math.round(cost.chairHours)), label: 'chair hours lost a year' },
    ])}
    <p style="margin:14px 0 0;font:bold 15px/1.45 ${SANS};color:${INK}">${esc(report.glance)}</p>
    ${none ? '' : rateBars(cost)}
    </div>

    ${report.levers.length ? `<div class="sec">
    ${sectionLabel('Where you can save')}
    ${savingsList(report.levers)}
    </div>` : ''}

    <div class="sec">
    ${sectionLabel(report.problems[0]?.flagged ? 'What to fix first' : 'Most common causes')}
    ${fixTable(report.problems)}
    </div>

    <table role="presentation" class="card" width="100%" cellpadding="0" cellspacing="0" style="background:${TEAL_MIST};border-radius:20px;margin:30px 0 0"><tr><td style="padding:24px 24px 26px">
      <p style="margin:0 0 6px;font:bold 11px ${SANS};letter-spacing:2px;text-transform:uppercase;color:${DEEP}">${print ? PHONE_SVG : '&#128222;'}&nbsp; Your call</p>
      <p style="margin:0 0 8px;font:600 24px/1.25 ${DISPLAY};color:${INK}">${callback ? `${esc(caller)} calls you ${esc(callback)}` : `${esc(caller)} will call you within one business day`}</p>
      <p style="margin:0 0 18px;font:14px/1.5 ${SANS};color:${BODY}">Free, no obligation. Next step: send one case and compare the fit.</p>
      ${pill(`tel:${contact.phoneTel}`, print ? `Call ${first}: ${contact.phone}` : `Talk now: call ${first}`)}
      ${print ? '' : `<p style="margin:14px 0 0;font:13px ${SANS};color:${SLATE}">${esc(contact.phone)}${contact.email ? ` &middot; <a href="mailto:${esc(contact.email)}" style="color:${DEEP}">${esc(contact.email)}</a>` : ''}</p>`}
    </td></tr></table>

    <p style="margin:22px 0 0;font:12px/1.55 ${SANS};color:${SLATE}">
      ${pdfAttached && !print ? 'A printable copy is attached. ' : ''}Estimates from the numbers you entered.
      National average: <a href="${BENCHMARK_URL}" style="color:${SLATE}">${esc(BENCHMARK_SOURCE)}</a>, 3,750 crowns.
      Remakes covered by <a href="${esc(siteUrl('/blog/aim-guarantee-explained', 'guarantee-link'))}" style="color:${SLATE}">AIM&rsquo;s guarantee</a> are redone at no charge.
    </p>
  </td></tr>
  <tr><td style="padding:18px 32px;background:#f3f6f7;font:12px/1.5 ${SANS};color:${SLATE}">
    AIM Dental Laboratory &middot; 802 Myrtle Avenue, Brooklyn, NY 11206 &middot; (718) 854-3900<br>
    ${print ? `Prepared for ${esc(practice)} from the Growth Audit on aimdentallab.com.` : 'You&rsquo;re receiving this because you requested a Growth Audit on aimdentallab.com.'}
  </td></tr>
</table>
</td></tr></table>
</body></html>`
}

// Internal notification: scannable, key numbers in bold.
function leadNotificationEmail({ leadId, lead, cost, contact, routing, reportSource, report, callbackText, callbackBooked = Boolean(callbackText) }) {
  const row = (k, v) => `<tr><td style="padding:4px 12px 4px 0;font:14px Arial,sans-serif;color:${SLATE};white-space:nowrap">${esc(k)}</td><td style="padding:4px 0;font:14px Arial,sans-serif;color:${INK}">${v}</td></tr>`
  return `<!DOCTYPE html><html><body style="margin:0;padding:24px;background:#f3f6f7;font-family:Arial,sans-serif">
  <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;background:#fff;border-radius:12px"><tr><td style="padding:24px">
    <p style="margin:0 0 4px;font:13px Arial,sans-serif;color:${SLATE}">New Growth Audit lead #${leadId}</p>
    <h1 style="margin:0 0 16px;font:normal 24px Georgia,serif;color:${INK}">${esc(lead.name)}, ${esc(lead.practice)}</h1>
    <p style="margin:0 0 14px;padding:12px 14px;background:#fff4dc;border-radius:8px;font:bold 15px Arial,sans-serif;color:${INK}">&#128197; ${callbackBooked ? `Call-back booked: ${esc(callbackText)}. It's in the attached calendar invite. The practice has the same time, so they're expecting your call.` : `No call-back time was booked. Please call ${esc(lead.name)} the next business day.`}</p>
    ${report?.priority ? `<p style="margin:0 0 12px;font:bold 15px Arial,sans-serif;color:${report.priority === 'High' ? '#b5651d' : INK}">Priority: ${esc(report.priority)} <span style="font-weight:normal;color:${SLATE}">(${esc(report.priority_reason)})</span></p>` : ''}
    <p style="margin:0 0 12px;font:15px Arial,sans-serif;color:${INK}">&#10003; Call back: <b>${esc(contact.name)}</b> (${esc(routing)})<br>
    &#10003; Yearly remake cost: <b>${esc(money(cost.total))}</b><br>
    &#10003; Remake rate: <b>${esc(percent(cost.rate))}</b> (${cost.aboveBenchmark ? 'above' : 'at or below'} the 3.8% benchmark)</p>
    <table role="presentation" cellpadding="0" cellspacing="0">
      ${row('Email', esc(lead.email))}
      ${row('Phone', esc(lead.phone))}
      ${lead.address ? row('Practice address', esc(lead.address)) : ''}
      ${row('Units / month', String(cost.inputs.units))}
      ${row('Remakes / month', String(cost.inputs.remakes))}
      ${row('Chair time / remake', `${cost.inputs.minutes} min at ${esc(money(cost.inputs.hourValue))}/hr`)}
      ${row('Lab remake fee', cost.inputs.labFee ? esc(money(cost.inputs.labFee)) : 'none')}
      ${row('Problems', esc(lead.pains.join(', ') || 'none selected'))}
      ${row('Wants help with', esc(lead.interest || ''))}
      ${lead.message ? row('Note', esc(lead.message)) : ''}
      ${lead.attribution ? row('Came from', esc(lead.attribution)) : ''}
      ${row('Report', 'Sent to the practice (rule-based, from their answers)')}
    </table>
  </td></tr></table></body></html>`
}

module.exports = { reportEmail, leadNotificationEmail, siteUrl }
