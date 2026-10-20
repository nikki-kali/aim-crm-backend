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

function chart(title, rows, format) {
  return `
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #dfe8ec;border-radius:12px;margin:0 0 16px">
    <tr><td style="padding:18px 20px">
      <p style="margin:0 0 4px;font:bold 15px Arial,sans-serif;color:${INK}">${esc(title)}</p>
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0">${bars(rows, format)}</table>
    </td></tr>
  </table>`
}

function bulletList(items) {
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0">${items
    .map(
      (b) => `<tr><td width="22" valign="top" style="padding:6px 0;font:bold 15px Arial,sans-serif;color:${DEEP}">&#10003;</td>
      <td style="padding:6px 0;font:15px/1.5 Arial,sans-serif;color:${INK}">${esc(b)}</td></tr>`,
    )
    .join('')}</table>`
}

function button(href, label, bg = DEEP, color = '#ffffff') {
  return `<a href="${esc(href)}" style="display:inline-block;background:${bg};color:${color};font:bold 15px Arial,sans-serif;text-decoration:none;padding:14px 26px;border-radius:999px">${esc(label)}</a>`
}

// `callback` is the booked slot as text ("Tuesday, October 21, in the
// morning (8 to 11 am ET)"), or null if none was booked.
function reportEmail({ practice, cost, report, contact, callback }) {
  const sections = report.sections
    .map(
      (s) => `
      <h2 style="margin:28px 0 8px;font:normal 24px Georgia,serif;color:${INK}">${esc(s.title)}</h2>
      ${bulletList(s.bullets)}`,
    )
    .join('')

  return `<!DOCTYPE html>
<html><body style="margin:0;padding:0;background:#f3f6f7">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f3f6f7"><tr><td align="center" style="padding:32px 12px">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:#ffffff;border-radius:16px;overflow:hidden">
  <tr><td style="padding:26px 32px;border-bottom:3px solid ${DEEP}">
    <img src="${LOGO_URL}" width="140" alt="AIM Dental Laboratory" style="display:block;width:140px;height:auto;border:0">
  </td></tr>
  <tr><td style="padding:32px">
    <p style="margin:0 0 6px;font:14px Arial,sans-serif;color:${SLATE}">Your Growth Audit report, ${esc(practice)}</p>
    <h1 style="margin:0 0 14px;font:normal 32px/1.15 Georgia,serif;color:${INK}">Remakes are costing you about ${esc(money(cost.total))} a year.</h1>
    <p style="margin:0 0 6px;font:15px/1.6 Arial,sans-serif;color:${INK}">Hello!</p>
    <p style="margin:0 0 24px;font:15px/1.6 Arial,sans-serif;color:${INK}">${esc(report.summary)}</p>

    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${INK};border-radius:12px;margin:0 0 24px"><tr>
      <td style="padding:18px 20px;font:13px Arial,sans-serif;color:#cfe0e6">Per remake<br><span style="font:bold 22px Arial,sans-serif;color:#ffffff">${esc(money(cost.perRemake))}</span></td>
      <td style="padding:18px 20px;font:13px Arial,sans-serif;color:#cfe0e6">Remakes a year<br><span style="font:bold 22px Arial,sans-serif;color:#ffffff">${cost.annualRemakes}</span></td>
      <td style="padding:18px 20px;font:13px Arial,sans-serif;color:#cfe0e6">Chair hours lost<br><span style="font:bold 22px Arial,sans-serif;color:#ffffff">${Math.round(cost.chairHours)}</span></td>
    </tr></table>

    ${chart('Where the money goes, per year', [
      { label: `Chair time (${Math.round(cost.chairHours)} hours)`, value: cost.chairCost },
      { label: 'Remake lab fees', value: cost.labCost, color: GOLD },
    ], money)}
    ${chart('Your remake rate vs a national study of 3,750 crowns', [
      { label: 'Your practice', value: cost.rate, color: cost.aboveBenchmark ? GOLD : DEEP },
      { label: 'National study', value: BENCHMARK_REMAKE_RATE, color: SLATE },
    ], (v) => percent(v))}
    ${chart('What fewer remakes would be worth each year', cost.scenarios.map((s) => ({
      label: `${Math.round(s.cut * 100)}% fewer remakes (${Math.round(s.hoursBack)} chair hours back)`,
      value: s.saved,
    })), money)}

    ${sections}

    <h2 style="margin:28px 0 8px;font:normal 24px Georgia,serif;color:${INK}">Your next steps</h2>
    ${bulletList(report.next_steps)}
    <p style="margin:14px 0 0;font:14px Arial,sans-serif"><a href="${esc(siteUrl('/blog/the-dental-impression-checklist-for-better-restorations', 'checklist-link'))}" style="color:${DEEP}">Get the free chairside impression checklist</a></p>

    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${MIST};border-radius:14px;margin:32px 0 0"><tr><td style="padding:26px">
      <p style="margin:0 0 6px;font:normal 24px Georgia,serif;color:${INK}">Talk it through with ${esc(contact.firstName)}</p>
      <p style="margin:0 0 16px;font:15px/1.6 Arial,sans-serif;color:${INK}">${esc(contact.name)}${contact.region ? `, your AIM rep for the ${esc(contact.region)},` : ''} ${callback ? `will call you <b>${esc(callback)}</b>. It's in the calendar invite attached to this email.` : 'will call you within one business day.'} Rather not wait?</p>
      <p style="margin:0 0 4px;font:15px Arial,sans-serif;color:${INK}"><b>Phone:</b> <a href="tel:${esc(contact.phoneTel)}" style="color:${DEEP}">${esc(contact.phone)}</a></p>
      ${contact.email ? `<p style="margin:0 0 18px;font:15px Arial,sans-serif;color:${INK}"><b>Email:</b> <a href="mailto:${esc(contact.email)}" style="color:${DEEP}">${esc(contact.email)}</a></p>` : '<p style="margin:0 0 18px"></p>'}
      ${button(`tel:${contact.phoneTel}`, `Call ${contact.firstName === 'the AIM team' ? 'the lab' : contact.firstName} now`)}
    </td></tr></table>

    <p style="margin:24px 0 0;font:12px/1.5 Arial,sans-serif;color:${SLATE}">
      These estimates use the numbers you entered and leave out harder-to-count costs like patient trust.
      Benchmark: <a href="${BENCHMARK_URL}" style="color:${SLATE}">${esc(BENCHMARK_SOURCE)}</a>.
      Remakes covered by <a href="${esc(siteUrl('/blog/aim-guarantee-explained', 'guarantee-link'))}" style="color:${SLATE}">AIM&rsquo;s guarantee</a> are redone at no charge.
    </p>
  </td></tr>
  <tr><td style="padding:18px 32px;background:#f3f6f7;font:12px Arial,sans-serif;color:${SLATE}">
    AIM Dental Laboratory, 802 Myrtle Avenue, Brooklyn, NY 11206. (718) 854-3900. You&rsquo;re receiving this because you requested a Growth Audit on aimdentallab.com.
  </td></tr>
</table>
</td></tr></table>
</body></html>`
}

// Internal notification: scannable, key numbers in bold.
function leadNotificationEmail({ leadId, lead, cost, contact, routing, reportSource, callbackText, callbackBooked = Boolean(callbackText) }) {
  const row = (k, v) => `<tr><td style="padding:4px 12px 4px 0;font:14px Arial,sans-serif;color:${SLATE};white-space:nowrap">${esc(k)}</td><td style="padding:4px 0;font:14px Arial,sans-serif;color:${INK}">${v}</td></tr>`
  return `<!DOCTYPE html><html><body style="margin:0;padding:24px;background:#f3f6f7;font-family:Arial,sans-serif">
  <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;background:#fff;border-radius:12px"><tr><td style="padding:24px">
    <p style="margin:0 0 4px;font:13px Arial,sans-serif;color:${SLATE}">New Growth Audit lead #${leadId}</p>
    <h1 style="margin:0 0 16px;font:normal 24px Georgia,serif;color:${INK}">${esc(lead.name)}, ${esc(lead.practice)}</h1>
    <p style="margin:0 0 14px;padding:12px 14px;background:#fff4dc;border-radius:8px;font:bold 15px Arial,sans-serif;color:${INK}">&#128197; ${callbackBooked ? `Call-back booked: ${esc(callbackText)}. It's in the attached calendar invite. The practice has the same time, so they're expecting your call.` : `No call-back time was booked. Please call ${esc(lead.name)} the next business day.`}</p>
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
      ${row('Report', reportSource === 'ai' ? 'AI-written report sent' : 'Template report sent (AI unavailable)')}
    </table>
  </td></tr></table></body></html>`
}

module.exports = { reportEmail, leadNotificationEmail, siteUrl }
