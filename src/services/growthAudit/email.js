const { money, percent, BENCHMARK_REMAKE_RATE, BENCHMARK_SOURCE, BENCHMARK_URL } = require('./calc')

// HTML for the Growth Audit report email (to the practice) and the internal
// lead notification. Email-safe: tables and inline styles only, bar charts
// drawn as table cells, hosted logo (never base64), Georgia + Arial.
// House style: no em dashes, a general greeting, always a clear CTA.

const LOGO_URL = 'https://aimdentallab.wordpress.com/wp-content/uploads/2025/03/aim-logo-transparent-2026-2.png?w=560'
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

function bars(rows, format) {
  const max = Math.max(...rows.map((r) => r.value), 1)
  return rows
    .map((r) => {
      const pct = Math.max(Math.round((r.value / max) * 100), r.value > 0 ? 2 : 0)
      return `
      <tr><td style="padding:10px 0 4px;font:14px Arial,sans-serif;color:${SLATE}">${esc(r.label)}</td>
          <td style="padding:10px 0 4px;font:bold 14px Arial,sans-serif;color:${INK};text-align:right;white-space:nowrap">${esc(format(r.value))}</td></tr>
      <tr><td colspan="2" style="padding:0 0 4px">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${MIST};border-radius:6px"><tr>
          <td width="${pct}%" style="background:${r.color || DEEP};height:12px;border-radius:6px;font-size:0;line-height:0">&nbsp;</td>
          <td style="font-size:0;line-height:0">&nbsp;</td>
        </tr></table>
      </td></tr>`
    })
    .join('')
}

function button(href, label, bg = DEEP, color = '#ffffff') {
  return `<a href="${esc(href)}" style="display:inline-block;background:${bg};color:${color};font:bold 15px Arial,sans-serif;text-decoration:none;padding:14px 26px;border-radius:999px">${esc(label)}</a>`
}

// Infographic building blocks. Email-safe: nested tables, inline styles,
// no images except the logo. Gold is used for fills and on dark ground only
// (it fails contrast as text on white).
const GOLD_TINT = '#fbf1dc'
const LINE = '#dfe8ec'

function heading(text, kicker) {
  return `
  <p class="kicker" style="margin:36px 0 4px;font:bold 12px Arial,sans-serif;letter-spacing:1.5px;text-transform:uppercase;color:${DEEP}">${esc(kicker)}</p>
  <h2 class="keep" style="margin:0 0 14px;font:normal 26px/1.2 Georgia,serif;color:${INK}">${esc(text)}</h2>`
}

function statTiles(tiles) {
  const cell = (t) => `
    <td width="50%" valign="top" style="padding:6px">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${MIST};border-radius:12px"><tr><td style="padding:16px 18px">
        <p style="margin:0;font:bold 26px Arial,sans-serif;color:${INK}">${esc(t.value)}</p>
        <p style="margin:2px 0 0;font:13px/1.4 Arial,sans-serif;color:${SLATE}">${esc(t.label)}</p>
      </td></tr></table>
    </td>`
  const rows = []
  for (let i = 0; i < tiles.length; i += 2) rows.push(`<tr>${cell(tiles[i])}${tiles[i + 1] ? cell(tiles[i + 1]) : '<td></td>'}</tr>`)
  return `<table role="presentation" class="card" width="100%" cellpadding="0" cellspacing="0" style="margin:0 -6px">${rows.join('')}</table>`
}

// One horizontal bar split into parts, with a legend underneath.
function splitBar(parts, format) {
  const total = parts.reduce((n, p) => n + p.value, 0) || 1
  const shown = parts.filter((p) => p.value > 0)
  const cells = shown
    .map((p) => `<td width="${Math.max(Math.round((p.value / total) * 100), 3)}%" style="background:${p.color};height:22px;font-size:0;line-height:0">&nbsp;</td>`)
    .join('')
  const legend = shown
    .map((p) => `<td valign="top" style="padding:10px 16px 0 0;font:13px/1.4 Arial,sans-serif;color:${SLATE}">
      <span style="display:inline-block;width:10px;height:10px;border-radius:2px;background:${p.color}"></span>&nbsp; ${esc(p.label)}<br>
      <b style="font:bold 17px Arial,sans-serif;color:${INK}">${esc(format(p.value))}</b></td>`)
    .join('')
  return `
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-radius:6px;overflow:hidden"><tr>${cells}</tr></table>
  <table role="presentation" cellpadding="0" cellspacing="0"><tr>${legend}</tr></table>`
}

function numberBadge(n, bg = DEEP) {
  return `<table role="presentation" cellpadding="0" cellspacing="0"><tr><td width="34" height="34" align="center" valign="middle" style="background:${bg};border-radius:17px;font:bold 15px Arial,sans-serif;color:#ffffff">${n}</td></tr></table>`
}

function leverLadder(levers) {
  return levers
    .map(
      (l, i) => `
  <table role="presentation" class="card" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid ${LINE};border-radius:12px;margin:0 0 10px"><tr>
    <td width="50" valign="middle" style="padding:16px 0 16px 16px">${numberBadge(i + 1, i === 0 ? INK : DEEP)}</td>
    <td valign="middle" style="padding:16px 12px">
      <p style="margin:0;font:bold 16px Arial,sans-serif;color:${INK}">${esc(l.label)}</p>
      <p style="margin:3px 0 0;font:13px/1.4 Arial,sans-serif;color:${SLATE}">${esc(l.detail)}</p>
    </td>
    <td align="right" valign="middle" style="padding:16px 18px 16px 0;white-space:nowrap">
      <p style="margin:0;font:normal 24px Georgia,serif;color:${INK}">${esc(money(l.value))}</p>
      <p style="margin:0;font:12px Arial,sans-serif;color:${SLATE}">a year</p>
    </td>
  </tr></table>`,
    )
    .join('')
}

function problemCard(p) {
  const row = (label, text, bg) => `
    <tr><td style="padding:12px 18px;background:${bg};border-top:1px solid ${LINE}">
      <p style="margin:0 0 3px;font:bold 11px Arial,sans-serif;letter-spacing:1.2px;text-transform:uppercase;color:${DEEP}">${label}</p>
      <p style="margin:0;font:14px/1.55 Arial,sans-serif;color:${INK}">${esc(text)}</p>
    </td></tr>`
  return `
  <table role="presentation" class="card" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid ${LINE};border-radius:12px;overflow:hidden;margin:0 0 12px">
    <tr><td style="padding:14px 18px">
      <span style="font:bold 17px Arial,sans-serif;color:${INK}">${esc(p.name)}</span>
      ${p.first ? `&nbsp; <span style="display:inline-block;padding:3px 10px;border-radius:999px;background:${GOLD_TINT};font:bold 11px Arial,sans-serif;letter-spacing:.8px;text-transform:uppercase;color:${INK}">Start here</span>` : ''}
    </td></tr>
    ${row('Usual cause', p.cause, '#ffffff')}
    ${row('What helps chairside', p.fix, '#ffffff')}
    ${row('How AIM helps', p.aim, MIST)}
  </table>`
}

function stepTimeline(steps) {
  return steps
    .map(
      (step, i) => `
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
    <td width="50" valign="top" style="padding:0 0 ${i === steps.length - 1 ? 0 : 14}px">${numberBadge(i + 1)}</td>
    <td valign="top" style="padding:6px 0 ${i === steps.length - 1 ? 0 : 14}px;font:15px/1.5 Arial,sans-serif;color:${INK}">${esc(step)}</td>
  </tr></table>`,
    )
    .join('')
}

// `callback` is the booked slot as text ("Tuesday, October 21, in the
// morning (8 to 11 am ET)"), or null if none was booked.
// `print` lays the same report out for the PDF attachment: no grey frame,
// full Letter width, cards kept whole across page breaks. `pdfAttached`
// adds a line to the email saying a printable copy is attached.
function reportEmail({ practice, cost, report, contact, callback, print = false, pdfAttached = false }) {
  const first = contact.firstName === 'the AIM team' ? 'the lab' : contact.firstName
  const none = cost.annualRemakes === 0
  const above = cost.aboveBenchmark
  const verdict = none ? 'No remakes' : above ? (cost.rate > 0.06 ? 'Well above average' : 'Above average') : 'In line or better'

  const hero = none
    ? `<p style="margin:0;font:normal 52px/1 Georgia,serif;color:${GOLD}">0 remakes</p>
       <p style="margin:10px 0 0;font:17px/1.5 Arial,sans-serif;color:#ffffff">${esc(report.headline)}</p>`
    : `<p style="margin:0;font:normal 56px/1 Georgia,serif;color:${GOLD}">${esc(money(report.recoverable))}</p>
       <p style="margin:8px 0 18px;font:17px/1.5 Arial,sans-serif;color:#ffffff">a year of your remake cost is recoverable</p>
       <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-radius:6px;overflow:hidden"><tr>
         <td width="${Math.max(Math.round((report.recoverable / (cost.total || 1)) * 100), 3)}%" style="background:${GOLD};height:14px;font-size:0;line-height:0">&nbsp;</td>
         <td style="background:#3d6170;height:14px;font-size:0;line-height:0">&nbsp;</td>
       </tr></table>
       <p style="margin:8px 0 0;font:13px Arial,sans-serif;color:#cfe0e6">Recoverable, out of the <b style="color:#ffffff">${esc(money(cost.total))}</b> a year remakes cost you now</p>`

  return `<!DOCTYPE html>
<html>${print ? `<head><meta charset="utf-8"><title>AIM Growth Audit, ${esc(practice)}</title><style>
  @page { size: Letter; margin: 0.45in 0.5in; }
  html, body { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  .card { break-inside: avoid; page-break-inside: avoid; }
  .kicker, .keep { break-after: avoid; page-break-after: avoid; }
  .sec { break-inside: avoid; page-break-inside: avoid; }
</style></head>` : ''}<body style="margin:0;padding:0;background:${print ? '#ffffff' : '#f3f6f7'}">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${print ? '#ffffff' : '#f3f6f7'}"><tr><td align="center" style="padding:${print ? '0' : '32px 12px'}">
<table role="presentation" width="${print ? '100%' : '600'}" cellpadding="0" cellspacing="0" style="${print ? 'width:100%' : 'max-width:600px;width:100%'};background:#ffffff;border-radius:${print ? '0' : '16px'};overflow:hidden">
  <tr><td style="padding:24px 32px">
    <img src="${LOGO_URL}" width="140" alt="AIM Dental Laboratory" style="display:block;width:140px;height:auto;border:0">
  </td></tr>

  <tr><td style="padding:30px 32px 32px;background:${INK}">
    <p style="margin:0 0 14px;font:bold 12px Arial,sans-serif;letter-spacing:1.5px;text-transform:uppercase;color:#9fc3cf">Growth Audit report for ${esc(practice)}</p>
    ${hero}
  </td></tr>

  <tr><td style="padding:28px 32px 36px">
    ${print ? '' : `<p style="margin:0 0 6px;font:15px/1.6 Arial,sans-serif;color:${INK}">Hello!</p>`}
    <p style="margin:0 0 20px;font:15px/1.6 Arial,sans-serif;color:${INK}">${esc(report.summary)}</p>
    ${pdfAttached && !print ? `<p style="margin:-8px 0 20px;font:14px/1.5 Arial,sans-serif;color:${SLATE}">&#128206; A printable PDF copy of this report is attached, to share with your team.</p>` : ''}

    ${statTiles([
      { value: money(cost.perRemake), label: 'cost of each remake' },
      { value: String(cost.annualRemakes), label: 'remakes a year' },
      { value: String(Math.round(cost.chairHours)), label: report.chairDays >= 1 ? `chair hours lost, about ${report.chairDays} full day${report.chairDays === 1 ? '' : 's'}` : 'chair hours lost a year' },
      { value: money(report.perWeek), label: 'lost every week' },
    ])}

    ${report.cta ? `
    <table role="presentation" class="card" width="100%" cellpadding="0" cellspacing="0" style="border:2px solid ${GOLD};border-radius:14px;margin:22px 0 0"><tr><td style="padding:20px 22px">
      <p style="margin:0 0 6px;font:bold 17px Arial,sans-serif;color:${INK}">&#128222; ${esc(report.cta.title)}</p>
      <p style="margin:0 0 8px;font:15px/1.6 Arial,sans-serif;color:${INK}">${esc(report.cta.body)}</p>
      <p style="margin:0 0 16px;font:14px/1.5 Arial,sans-serif;color:${SLATE}">${esc(report.cta.prep)}</p>
      ${button(`tel:${contact.phoneTel}`, print ? `Rather talk now? Call ${first}: ${contact.phone}` : `Rather talk now? Call ${first}`)}
    </td></tr></table>` : ''}

    <div class="sec">
    ${heading('Your remake rate vs the national average', 'Benchmark')}
    <p style="margin:0 0 4px"><span style="display:inline-block;padding:4px 12px;border-radius:999px;background:${above ? GOLD_TINT : MIST};font:bold 12px Arial,sans-serif;color:${INK}">${esc(verdict)}</span></p>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0">${bars([
      { label: 'Your practice', value: cost.rate, color: above ? GOLD : DEEP },
      { label: 'National study, 3,750 crowns', value: BENCHMARK_REMAKE_RATE, color: SLATE },
    ], (v) => percent(v))}</table>
    </div>

    ${none ? '' : `<div class="sec">
    ${heading('Where the money goes', 'Your yearly cost')}
    ${splitBar([
      { label: `Chair time (${Math.round(cost.chairHours)} hours)`, value: cost.chairCost, color: DEEP },
      { label: 'Remake lab fees', value: cost.labCost, color: GOLD },
    ], money)}</div>`}

    ${report.levers.length ? `<div class="sec">
    ${heading('Your biggest savings, ranked', 'Where to start')}
    ${leverLadder(report.levers)}</div>` : ''}

    ${none ? '' : `<div class="sec">
    ${heading('What fewer remakes would be worth', 'Scenarios')}
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0">${bars(cost.scenarios.map((sc) => ({
      label: `${Math.round(sc.cut * 100)}% fewer (${Math.round(sc.hoursBack)} chair hours back)`,
      value: sc.saved,
    })), money)}</table></div>`}

    ${heading(report.problems[0]?.flagged ? 'What to fix first' : 'The most common causes', 'Your problems')}
    ${report.problems[0]?.flagged ? '' : `<p style="margin:0 0 12px;font:14px/1.5 Arial,sans-serif;color:${SLATE}">You didn&rsquo;t flag a specific problem, so here are the two we see most. ${esc(contact.firstName === 'the AIM team' ? 'We' : contact.firstName)} can help pin down yours on the call.</p>`}
    ${report.problems.map(problemCard).join('')}

    <table role="presentation" class="card" width="100%" cellpadding="0" cellspacing="0" style="background:${INK};border-radius:12px;margin:8px 0 0"><tr>
      <td width="44" valign="top" style="padding:18px 0 18px 18px;font:bold 22px Arial,sans-serif;color:${GOLD}">&#10003;</td>
      <td style="padding:18px 20px 18px 8px;font:15px/1.55 Arial,sans-serif;color:#ffffff">${esc(report.guarantee)}</td>
    </tr></table>

    <div class="sec">
    ${heading('Your next steps', 'Action plan')}
    ${stepTimeline(report.next_steps)}
    <p style="margin:16px 0 0;font:14px Arial,sans-serif"><a href="${esc(siteUrl('/blog/the-dental-impression-checklist-for-better-restorations', 'checklist-link'))}" style="color:${DEEP}">Get the free chairside impression checklist</a></p>
    </div>

    <table role="presentation" class="card" width="100%" cellpadding="0" cellspacing="0" style="background:${MIST};border-radius:14px;margin:32px 0 0"><tr><td style="padding:26px">
      <p style="margin:0 0 6px;font:normal 24px Georgia,serif;color:${INK}">Talk it through with ${esc(contact.firstName)}</p>
      <p style="margin:0 0 16px;font:15px/1.6 Arial,sans-serif;color:${INK}">${esc(contact.name)}${contact.region ? `, your AIM rep for the ${esc(contact.region)},` : ''} ${callback ? `will call you <b>${esc(callback)}</b>. ${print ? 'The calendar invite is in your report email.' : 'It&rsquo;s in the calendar invite attached to this email.'}` : 'will call you within one business day.'} Rather not wait?</p>
      <p style="margin:0 0 4px;font:15px Arial,sans-serif;color:${INK}"><b>Phone:</b> <a href="tel:${esc(contact.phoneTel)}" style="color:${DEEP}">${esc(contact.phone)}</a></p>
      ${contact.email ? `<p style="margin:0 0 18px;font:15px Arial,sans-serif;color:${INK}"><b>Email:</b> <a href="mailto:${esc(contact.email)}" style="color:${DEEP}">${esc(contact.email)}</a></p>` : '<p style="margin:0 0 18px"></p>'}
      ${print ? '' : button(`tel:${contact.phoneTel}`, `Call ${first} now`)}
    </td></tr></table>

    <p style="margin:24px 0 0;font:12px/1.5 Arial,sans-serif;color:${SLATE}">
      These estimates use the numbers you entered and leave out harder-to-count costs like patient trust.
      Benchmark: <a href="${BENCHMARK_URL}" style="color:${SLATE}">${esc(BENCHMARK_SOURCE)}</a>.
      Remakes covered by <a href="${esc(siteUrl('/blog/aim-guarantee-explained', 'guarantee-link'))}" style="color:${SLATE}">AIM&rsquo;s guarantee</a> are redone at no charge.
    </p>
  </td></tr>
  <tr><td style="padding:18px 32px;background:#f3f6f7;font:12px Arial,sans-serif;color:${SLATE}">
    AIM Dental Laboratory, 802 Myrtle Avenue, Brooklyn, NY 11206. (718) 854-3900. ${print ? `Prepared for ${esc(practice)} from the answers given in the Growth Audit on aimdentallab.com.` : 'You&rsquo;re receiving this because you requested a Growth Audit on aimdentallab.com.'}
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
