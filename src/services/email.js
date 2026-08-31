const { Resend } = require('resend')

// FRONTEND_URL supports a comma-separated list (see app.js's CORS setup) so
// multiple allowed origins can coexist during a domain migration — but a
// link inside an email needs exactly one URL, not the raw multi-value
// string glued onto a path. Every email CTA button should build its href
// through this, not `process.env.FRONTEND_URL` directly.
function primaryFrontendUrl() {
  return (process.env.FRONTEND_URL || '').split(',')[0].trim() || '#'
}

let resend

function getResend() {
  if (!resend) resend = new Resend(process.env.RESEND_API_KEY)
  return resend
}

// Brevo's transactional send API is HTTPS (api.brevo.com), unlike SMTP —
// tried a Gmail SMTP fallback first, but Render's outbound network times out
// on port 465 (ETIMEDOUT/CONN, confirmed in logs), so plain SMTP is a dead
// end on this host. Brevo's API key + a verified aimdentallab.com sender
// (info@) already exist and are proven working (same account the newsletter
// signup sync in routes/newsletter.js already uses), so it works as a
// fallback while Resend's domain verification is stuck pending.
async function sendViaBrevo({ to, subject, html, cc, attachments }) {
  // `to` may be a single address or an array — Resend accepts either
  // directly, but Brevo wants an array of {email} objects regardless, so
  // normalize here rather than assuming a single string (a multi-recipient
  // `to` used to silently break this fallback path with a 400).
  const toList = (Array.isArray(to) ? to : [to]).filter(Boolean)
  if (toList.length === 0) toList.push(process.env.ALERT_EMAIL)

  const res = await fetch('https://api.brevo.com/v3/smtp/email', {
    method: 'POST',
    headers: {
      'api-key': process.env.BREVO_API_KEY,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify({
      sender: { name: 'Aim Dental CRM', email: 'info@aimdentallab.com' },
      to: toList.map((email) => ({ email })),
      ...(cc?.length ? { cc: cc.map((email) => ({ email })) } : {}),
      subject,
      htmlContent: html,
      // Brevo wants base64 text, unlike Resend which takes a raw Buffer —
      // converted here rather than at the call site so callers only ever
      // deal in Buffers.
      ...(attachments?.length
        ? { attachment: attachments.map((a) => ({ name: a.filename, content: a.content.toString('base64') })) }
        : {}),
    }),
  })
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`Brevo send failed (${res.status}): ${body}`)
  }
}

// attachments: [{ filename, content: Buffer, contentType? }] — content type
// is inferred from filename if omitted. Used by routes/scanSubmission.js to
// forward a doctor's uploaded scan files straight through in the staff
// notification email; every other call site omits this.
async function sendEmail({ to, subject, html, cc, attachments }) {
  const client = getResend()
  const from = process.env.RESEND_FROM || 'Aim Dental CRM <onboarding@resend.dev>'
  const { error } = await client.emails.send({
    from,
    to: to || process.env.ALERT_EMAIL,
    ...(cc?.length ? { cc } : {}),
    subject,
    html,
    ...(attachments?.length ? { attachments } : {}),
  })
  if (!error) return

  if (!process.env.BREVO_API_KEY) {
    throw new Error(error.message)
  }
  console.warn('sendEmail: Resend failed, falling back to Brevo —', error.message)
  await sendViaBrevo({ to, subject, html, cc, attachments })
}

function coldLeadEmail(leads) {
  const rows = leads.slice(0, 10).map(l =>
    `<tr>
      <td style="padding:8px 12px;border-bottom:1px solid #f3f4f6">${l.doctor_name}</td>
      <td style="padding:8px 12px;border-bottom:1px solid #f3f4f6;color:#6b7280">${l.clinic_name || '—'}</td>
      <td style="padding:8px 12px;border-bottom:1px solid #f3f4f6;color:#f59e0b">
        ${l.last_contacted_at ? Math.floor((Date.now() - new Date(l.last_contacted_at)) / 86400000) + ' days ago' : 'Never'}
      </td>
    </tr>`
  ).join('')

  return emailWrapper(`
    <h2 style="color:#111;margin:0 0 8px">⚠ ${leads.length} Cold Lead${leads.length > 1 ? 's' : ''} Need Follow-up</h2>
    <p style="color:#6b7280;margin:0 0 24px">These leads have had no contact in 14+ days.</p>
    <table style="width:100%;border-collapse:collapse;font-size:14px">
      <thead><tr style="background:#f9fafb">
        <th style="text-align:left;padding:8px 12px;color:#6b7280;font-weight:600">Doctor</th>
        <th style="text-align:left;padding:8px 12px;color:#6b7280;font-weight:600">Clinic</th>
        <th style="text-align:left;padding:8px 12px;color:#6b7280;font-weight:600">Last Contact</th>
      </tr></thead>
      <tbody>${rows}</tbody>
    </table>
  `, 'View Leads')
}

function caseDueEmail(cases) {
  const rows = cases.map(c =>
    `<tr>
      <td style="padding:8px 12px;border-bottom:1px solid #f3f4f6;font-weight:600">${c.case_number}</td>
      <td style="padding:8px 12px;border-bottom:1px solid #f3f4f6">${c.client_name}</td>
      <td style="padding:8px 12px;border-bottom:1px solid #f3f4f6;color:#ef4444">${c.due_date}</td>
    </tr>`
  ).join('')

  return emailWrapper(`
    <h2 style="color:#111;margin:0 0 8px">📅 ${cases.length} Case${cases.length > 1 ? 's' : ''} Due Within 2 Days</h2>
    <p style="color:#6b7280;margin:0 0 24px">Check status and prepare for delivery.</p>
    <table style="width:100%;border-collapse:collapse;font-size:14px">
      <thead><tr style="background:#f9fafb">
        <th style="text-align:left;padding:8px 12px;color:#6b7280;font-weight:600">Case #</th>
        <th style="text-align:left;padding:8px 12px;color:#6b7280;font-weight:600">Client</th>
        <th style="text-align:left;padding:8px 12px;color:#6b7280;font-weight:600">Due Date</th>
      </tr></thead>
      <tbody>${rows}</tbody>
    </table>
  `, 'View Cases')
}

function lostRecoveryEmail(leads) {
  const names = leads.slice(0, 5).map(l => `<li>${l.doctor_name} — lost ${Math.floor((Date.now() - new Date(l.updated_at)) / 86400000)} days ago</li>`).join('')
  return emailWrapper(`
    <h2 style="color:#111;margin:0 0 8px">🔄 ${leads.length} Lead${leads.length > 1 ? 's' : ''} Ready for Recovery</h2>
    <p style="color:#6b7280;margin:0 0 16px">These leads were marked Lost 30+ days ago and may be worth re-engaging.</p>
    <ul style="color:#374151;font-size:14px;line-height:1.8">${names}</ul>
  `, 'View Leads')
}

// Rotating weekly quote — mirrors Frontend/src/pages/Dashboard.jsx's
// MOTIVATIONAL list (kept in sync deliberately, same voice as the app's
// own greeting) but picked by ISO week number instead of day-of-week,
// since this email only ever sends on a Monday — a day-keyed pick would
// show the same line every single week.
const PUSH_QUOTES = [
  'Every no is one step closer to a yes.',
  'The best time to plant a tree was yesterday. The second best time is now.',
  'Consistency beats perfection every time.',
  'Small daily progress leads to big results.',
  'Your attitude determines your direction.',
  "Today's actions are tomorrow's results.",
  'Focus on progress, not perfection.',
]

function isoWeekNumber(d) {
  const date = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()))
  date.setUTCDate(date.getDate() + 4 - (date.getUTCDay() || 7))
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1))
  return Math.ceil((((date - yearStart) / 86400000) + 1) / 7)
}

// Color coding for the performance tier computeRepSummary derives (see
// services/weeklyRepReport.js) — `color` drives the status dot + focus-line
// text, `tint`/`border` the quiet left-accent callout under the header. No
// emoji — the dot already carries the signal, and a plain colored dot
// reads calmer/more deliberate across email clients than emoji rendering
// inconsistently between them.
const TIER_META = {
  green: { label: 'On track', color: '#15803d', tint: '#f3fbf6', border: '#bfe8cf' },
  amber: { label: 'Keep pushing', color: '#b45309', tint: '#fefaf1', border: '#f3ddab' },
  red:   { label: 'Time to reconnect', color: '#b91c1c', tint: '#fdf4f4', border: '#f0c9c9' },
}

// Header callout: pure status, one clause, no verb — the "what to do about
// it" lives entirely in the dedicated "Your 1% This Week" section below, so
// the two don't repeat each other.
function statusLine(tier, coldCount) {
  if (tier === 'green') return 'No cold leads, and momentum on the board this week.'
  if (tier === 'red') return `${coldCount} lead${coldCount !== 1 ? 's' : ''} need${coldCount === 1 ? 's' : ''} attention before ${coldCount === 1 ? 'it goes' : 'they go'} cold.`
  return 'A steady week — no fires, but room to build.'
}

// "Your 1% This Week" — one framing line stating the compounding-small-
// improvements idea outright (not just implied by a verb), plus 2-3
// concrete actions. Tier-specific so "what to do" always matches "how
// you're actually doing" rather than reading as generic filler.
function pushHeadline(tier) {
  if (tier === 'green') return "You're compounding well — keep the 1% rule going. Small, deliberate moves beat one big push:"
  if (tier === 'red') return "You don't need a big week — you need a 1% better one. Start here:"
  return "The 1% rule: a slightly better week beats a big one. Start here:"
}

// Per-rep weekly performance report. One clear status line up top (no
// competing badge/quote/paragraph), then a deliberate hierarchy rather than
// four identical KPI grids: Sales Value gets hero treatment (the number
// leadership actually cares about), This Week / This Month are quiet stat
// strips, Cold Leads is a plain list, and All-Time is a small footnote —
// not given equal weight to numbers that move week to week. Shared by the
// on-demand "email me my report" button (routes/reports.js POST
// /my-summary/email, self only, no cc) and the Monday-morning automated
// send to every rep (jobs/scheduler.js, cc'd to leadership) — same
// template, different recipients.
// Real brand tokens, pulled from the marketing site's own design system
// (~/Downloads/AIM Dental Laboratory website/src/index.css's @theme block —
// not reinvented here). `display` is used sparingly, for the one or two
// moments that should feel editorial (the title, the rep's name); `data` is
// the site's own convention for eyebrow labels and numeric figures (see
// TATWidget.jsx, DigitalBand.jsx), not just a font swap for its own sake.
// Every family lists a system fallback first in spirit — Outlook desktop
// ignores @font-face entirely and renders the fallback, so the fallback
// chain (Georgia / system sans / ui-monospace) has to carry the design on
// its own there.
const FONT_DISPLAY = "'Cormorant Garamond',Georgia,'Times New Roman',serif"
const FONT_BODY = "'DM Sans',-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif"
const FONT_DATA = "'DM Mono',ui-monospace,SFMono-Regular,Menlo,monospace"
const BRAND = {
  ink: '#10353f',
  slate: '#5b7a86',
  teal: '#06babe',
  deep: '#207290',
  tealMist: '#e6f9f9',
  blueMist: '#eaf3f7',
  skyBlue: '#a9cfe3', // lighter tint of `deep`, used only for the page wash
  gold: '#d9a441',
  success: '#059669',
}

function repReportEmail({ repName, dateLabel, monthLabel, lastMonthLabel, week, month, allTime, sales, tier, coldLeads, suggestions, test }) {
  const { ink, slate, teal, deep, gold } = BRAND
  const hairline = '#dcebe9'
  const t = TIER_META[tier] || TIER_META.amber
  const quote = PUSH_QUOTES[isoWeekNumber(new Date()) % PUSH_QUOTES.length]
  const mTotal = Number(month.leads_created)
  const mWon = Number(month.wins)
  const convo = mTotal > 0 ? Math.round(mWon / mTotal * 100) : null

  // Table-based layout throughout, not flexbox — Outlook desktop has never
  // supported CSS flexbox in HTML email, and Gmail's own draft/compose
  // view was observed silently dropping `display:flex` and
  // `linear-gradient` backgrounds too (verified against a real Gmail
  // draft: the header and stat rows collapsed with no spacing). Tables are
  // the one layout primitive every major email client renders consistently.
  // Every gradient background also gets a solid `bgcolor` attribute
  // fallback alongside the CSS gradient, for the same reason.
  // padding/margin/border in `opts.style` go on the <td> cells, not the
  // <table> element — email clients (this was the actual bug behind the
  // mangled Gmail render) don't reliably apply box-model CSS to <table>
  // itself, only to table cells.
  const row2 = (leftHtml, rightHtml, opts = {}) => `
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
      <tr>
        <td style="text-align:left;vertical-align:${opts.valign || 'middle'};${opts.style || ''}">${leftHtml}</td>
        <td style="text-align:right;vertical-align:${opts.valign || 'middle'};white-space:nowrap;${opts.style || ''}">${rightHtml}</td>
      </tr>
    </table>`

  // Quiet stat strip — numbers stay ink by default, in the site's own
  // data face (DM Mono), the same treatment TATWidget.jsx gives its
  // turnaround-day figure. `color` is only passed for the one number per
  // row worth calling out, so color reads as signal, not decoration.
  // No vertical divider lines between columns — whitespace does the
  // separating instead, reads calmer than a row of hairlines.
  const statRow = (cells) => `
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
      <tr>
        ${cells.map((c) => `
        <td width="${Math.floor(100 / cells.length)}%" style="text-align:center;padding:0 6px">
          <p style="margin:0;font-family:${FONT_DATA};font-size:21px;font-weight:500;color:${c.color || ink};letter-spacing:-.01em">${c.val}</p>
          <p style="margin:6px 0 0;font-family:${FONT_DATA};font-size:9.5px;color:${slate};text-transform:uppercase;letter-spacing:.08em">${c.label}</p>
        </td>`).join('')}
      </tr>
    </table>`

  // Eyebrow labels in the site's own data-face-uppercase-tracked-wide
  // convention (see "From AIM" / "Resources" in the real components) —
  // `color` defaults to slate, matching most of the site's own labels.
  const sectionLabel = (text, color = slate) => `<p style="margin:0 0 14px;font-family:${FONT_DATA};font-size:10px;font-weight:500;letter-spacing:.09em;text-transform:uppercase;color:${color}">${text}</p>`

  const coldRows = (coldLeads?.leads || []).map((l, i) => row2(
    `<p style="margin:0;font-size:13.5px;font-weight:600;color:${ink}">${l.doctor_name}</p>${l.clinic_name ? `<p style="margin:2px 0 0;font-size:12px;color:${slate}">${l.clinic_name}</p>` : ''}`,
    `<span style="font-family:${FONT_DATA};font-size:11px;font-weight:500;color:#b45309;background:#fefaf1;border-radius:999px;padding:4px 10px">${l.days_cold}d</span>`,
    { style: `padding:11px 0;${i > 0 ? `border-top:1px solid ${hairline}` : ''}` },
  )).join('')

  // A rep can have zero cold leads for two very different reasons: nothing
  // has gone stale (genuinely "caught up"), or nothing came in this week at
  // all (no leads, no cases) — there's simply nothing that could have gone
  // cold yet. The two aren't mutually exclusive with an existing cold-leads
  // list either — a rep can have old leads going stale *and* zero new
  // activity this week, so the "no pipeline" callout can appear alongside
  // the list, not just in its place.
  const noPipelineThisWeek = Number(week.leads_created) === 0 && Number(week.cases_created || 0) === 0
  const noPipelineCallout = noPipelineThisWeek ? `
    <p style="margin:${coldLeads?.count > 0 ? '10px' : '8px'} 0 0;font-size:12.5px;line-height:1.5;color:#9a5b12;background:#fefaf1;border-radius:10px;padding:9px 12px">No new leads or cases came in last week — pipeline needs fresh activity.</p>
  ` : ''

  const coldSection = coldLeads?.count > 0 ? `
    ${row2(sectionLabel('Cold Leads'), `<span style="font-family:${FONT_DATA};font-size:10.5px;color:#b91c1c;font-weight:500">${coldLeads.count} need${coldLeads.count === 1 ? 's' : ''} follow-up</span>`, { valign: 'top', style: 'padding-bottom:4px' })}
    ${coldLeads.count > coldLeads.leads.length ? `<p style="margin:0 0 6px;font-size:11px;color:${slate}">showing ${coldLeads.leads.length} oldest</p>` : ''}
    <div>${coldRows}</div>
    ${noPipelineCallout}
  ` : noPipelineThisWeek ? `
    ${row2(sectionLabel('Cold Leads'), `<span style="font-family:${FONT_DATA};font-size:10.5px;color:#9a5b12;font-weight:500">no new activity</span>`, { valign: 'top' })}
    ${noPipelineCallout}
  ` : `
    ${row2(sectionLabel('Cold Leads'), `<span style="font-family:${FONT_DATA};font-size:10.5px;color:${BRAND.success};font-weight:500">✓ all caught up</span>`, { valign: 'top' })}
  `

  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Cormorant+Garamond:wght@600;700&family=DM+Sans:wght@400;500;600;700&family=DM+Mono:wght@400;500&display=swap" rel="stylesheet">
</head>
<body style="margin:0;padding:0;background-color:${BRAND.deep};background-image:linear-gradient(160deg,${BRAND.skyBlue} 0%,${BRAND.deep} 100%);font-family:${FONT_BODY}">
<div style="max-width:600px;margin:40px auto;background:#fff;border-radius:24px;overflow:hidden;box-shadow:0 6px 28px rgba(32,114,144,.16)">

  ${test ? `
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
    <tr>
      <td bgcolor="#fbbf24" style="background-color:#fbbf24;padding:10px 20px;text-align:center">
        <p style="margin:0;font-family:${FONT_DATA};font-size:11.5px;font-weight:500;letter-spacing:.08em;text-transform:uppercase;color:#78350f">⚠ Test send — not a real weekly report</p>
      </td>
    </tr>
  </table>
  ` : ''}

  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
    <tr>
      <td bgcolor="${teal}" style="background-color:${teal};background-image:linear-gradient(135deg,${teal},${deep});padding:34px 36px 28px">
        ${row2(
          `<h1 style="color:#fff;margin:0;font-family:${FONT_DISPLAY};font-size:30px;font-weight:700;letter-spacing:-.01em">Weekly Performance Report</h1>
           <p style="color:rgba(255,255,255,.92);margin:10px 0 0;font-family:${FONT_DISPLAY};font-size:17px;font-style:italic;font-weight:600">"${quote}"</p>
           <p style="color:rgba(255,255,255,.72);margin:12px 0 0;font-size:13px">${repName} &nbsp;·&nbsp; ${dateLabel}</p>`,
          `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="background:rgba(255,255,255,.15);border:1px solid rgba(255,255,255,.3);border-radius:999px"><tr>
             <td style="padding:7px 13px">
               <span style="display:inline-block;width:7px;height:7px;border-radius:50%;background-color:${t.color};font-size:0;line-height:0">&nbsp;</span>
               <span style="font-size:11.5px;font-weight:600;color:#fff">&nbsp;${t.label}</span>
             </td>
           </tr></table>`,
          { valign: 'top' },
        )}
      </td>
    </tr>
  </table>

  <div style="margin:30px 36px 0;padding:16px 19px;background:${t.tint};border:1px solid ${t.border};border-left:3px solid ${t.color};border-radius:4px 12px 12px 4px">
    <p style="margin:0;font-size:13.5px;line-height:1.55;color:${ink}">${statusLine(tier, coldLeads?.count || 0)}</p>
  </div>

  <div style="padding:30px 36px 0">
    ${sectionLabel('Last Week')}
    ${statRow([
      { label: 'Leads', val: Number(week.leads_created) },
      { label: 'Cases', val: Number(week.cases_created || 0) },
      { label: 'Contacted', val: Number(week.contacted) },
      { label: 'Proposals', val: Number(week.proposals) },
      { label: 'Wins', val: Number(week.wins), color: Number(week.wins) > 0 ? BRAND.success : undefined },
    ])}
  </div>

  <div style="padding:30px 36px 0">${coldSection}</div>

  <div style="margin:30px 36px 0;padding:22px 24px;background:#fff;border:1px solid ${hairline};border-radius:18px">
    <p style="margin:0 0 10px;font-family:${FONT_DATA};font-size:10px;font-weight:500;letter-spacing:.09em;text-transform:uppercase;color:${t.color}">Your 1% This Week</p>
    <p style="margin:0 0 13px;font-size:13px;line-height:1.55;color:${ink}">${pushHeadline(tier)}</p>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
      ${suggestions.map((s) => `
      <tr>
        <td width="16" valign="top" style="padding:6px 0">
          <span style="display:inline-block;width:5px;height:5px;border-radius:50%;background-color:${t.color};font-size:0;line-height:0">&nbsp;</span>
        </td>
        <td valign="top" style="padding:6px 0">
          <p style="margin:0;font-size:13px;line-height:1.5;color:#33484f">${s}</p>
        </td>
      </tr>`).join('')}
    </table>
  </div>

  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:32px 0 0">
    <tr><td style="padding:0 36px">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:${gold};background-image:linear-gradient(135deg,${teal},${gold});border-radius:19px">
        <tr><td style="padding:2px">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:${BRAND.tealMist};background-image:linear-gradient(160deg,${BRAND.tealMist},${BRAND.blueMist});border-radius:17px">
            <tr><td style="padding:22px 24px">
              <p style="margin:0 0 3px;font-family:${FONT_DATA};font-size:10px;font-weight:500;letter-spacing:.09em;text-transform:uppercase;color:${gold}">Sales Value &nbsp;·&nbsp; YTD Booked Cases</p>
              <p style="margin:0;font-family:${FONT_DATA};font-size:30px;font-weight:500;color:${teal};letter-spacing:-.01em">$${Number(sales.total).toLocaleString()}</p>
              <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin-top:15px;padding-top:15px;border-top:1px solid rgba(32,114,144,.16)"><tr>
                <td style="padding-right:26px"><p style="margin:0;font-family:${FONT_DATA};font-size:9.5px;color:${deep};text-transform:uppercase;letter-spacing:.08em">Billed</p><p style="margin:3px 0 0;font-family:${FONT_DATA};font-size:14px;font-weight:500;color:${ink}">$${Number(sales.billed).toLocaleString()}</p></td>
                <td style="padding-right:26px"><p style="margin:0;font-family:${FONT_DATA};font-size:9.5px;color:${deep};text-transform:uppercase;letter-spacing:.08em">WIP</p><p style="margin:3px 0 0;font-family:${FONT_DATA};font-size:14px;font-weight:500;color:${ink}">$${Number(sales.wip).toLocaleString()}</p></td>
                <td><p style="margin:0;font-family:${FONT_DATA};font-size:9.5px;color:${deep};text-transform:uppercase;letter-spacing:.08em">Cases</p><p style="margin:3px 0 0;font-family:${FONT_DATA};font-size:14px;font-weight:500;color:${ink}">${Number(sales.case_count)}</p></td>
              </tr></table>
            </td></tr>
          </table>
        </td></tr>
      </table>
    </td></tr>
  </table>

  <div style="padding:30px 36px 0">
    ${sectionLabel(`Last Month — ${lastMonthLabel}`)}
    ${statRow([
      { label: 'Leads', val: mTotal },
      { label: 'Wins', val: mWon, color: mWon > 0 ? BRAND.success : undefined },
      { label: 'Revenue', val: '$' + Number(month.revenue).toLocaleString() },
      { label: 'Conversion', val: convo === null ? '—' : convo + '%', color: convo !== null && convo >= 50 ? BRAND.success : undefined },
    ])}
  </div>

  <div style="margin:32px 36px 0;padding-top:20px;border-top:1px solid ${hairline}">
    <p style="margin:0 0 14px;font-family:${FONT_DATA};font-size:9.5px;font-weight:500;letter-spacing:.09em;text-transform:uppercase;color:#a9c1c6">All-Time</p>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
      <td width="25%" style="text-align:left"><p style="margin:0;font-family:${FONT_DATA};font-size:14px;font-weight:500;color:${slate}">${Number(allTime.active_leads)}</p><p style="margin:3px 0 0;font-family:${FONT_DATA};font-size:8.5px;color:#a9c1c6;text-transform:uppercase;letter-spacing:.06em">Active</p></td>
      <td width="25%" style="text-align:left"><p style="margin:0;font-family:${FONT_DATA};font-size:14px;font-weight:500;color:${slate}">${Number(allTime.total_leads)}</p><p style="margin:3px 0 0;font-family:${FONT_DATA};font-size:8.5px;color:#a9c1c6;text-transform:uppercase;letter-spacing:.06em">Total Leads</p></td>
      <td width="25%" style="text-align:left"><p style="margin:0;font-family:${FONT_DATA};font-size:14px;font-weight:500;color:${slate}">${Number(allTime.total_wins)}</p><p style="margin:3px 0 0;font-family:${FONT_DATA};font-size:8.5px;color:#a9c1c6;text-transform:uppercase;letter-spacing:.06em">Won</p></td>
      <td width="25%" style="text-align:left"><p style="margin:0;font-family:${FONT_DATA};font-size:14px;font-weight:500;color:${slate}">$${Number(allTime.total_revenue).toLocaleString()}</p><p style="margin:3px 0 0;font-family:${FONT_DATA};font-size:8.5px;color:#a9c1c6;text-transform:uppercase;letter-spacing:.06em">Revenue</p></td>
    </tr></table>
  </div>

  <div style="margin:36px 36px 0;padding-top:26px;border-top:1px solid ${hairline}">
    <table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>
      <td bgcolor="${teal}" style="background-color:${teal};background-image:linear-gradient(135deg,${teal},${deep});border-radius:12px">
        <a href="${primaryFrontendUrl()}/reports" style="display:inline-block;padding:12px 26px;color:#fff;text-decoration:none;font-weight:600;font-size:13.5px;font-family:${FONT_BODY}">Open My Reports →</a>
      </td>
    </tr></table>
  </div>

  <div style="margin-top:36px;background:${BRAND.tealMist};padding:18px 36px;font-size:11.5px;color:${slate};border-top:1px solid ${hairline}">
    Aim Dental Laboratory CRM &nbsp;·&nbsp; Weekly report for ${repName}
  </div>
</div>
</body></html>`
}

// Weekly Unassigned Leads Report — sent every Monday to leadership (not
// reps), listing leads that came in over the past 7 days and are still
// sitting with no owner. Reuses repReportEmail's brand chrome (gradient
// header, blue page wash, table-based layout for Gmail/Outlook safety) so
// it reads as the same family of CRM report, but the body is a plain data
// table rather than a personalized narrative — this is an ops list, not a
// performance summary, so no quote/motivational framing here.
function unassignedLeadsReportEmail({ leads, weekLabel, test }) {
  const { ink, slate, teal, deep, gold } = BRAND
  const hairline = '#dcebe9'
  const goldHairline = 'rgba(217,164,65,.28)'
  const count = leads.length
  const empty = count === 0
  const totalValue = leads.reduce((sum, l) => sum + (Number(l.estimated_value) || 0), 0)

  // A thin gold diamond in place of a bullet/icon — the one recurring
  // ornament used everywhere something needs to read as considered rather
  // than templated (eyebrow labels, the section rule). No emoji, no stock
  // icon glyphs — a single quiet mark repeated is what reads as designed.
  const diamond = `<span style="display:inline-block;width:5px;height:5px;background:${gold};transform:rotate(45deg);font-size:0;line-height:0">&nbsp;</span>`

  const brandBadge = (brand) => `<span style="display:inline-block;font-family:${FONT_DATA};font-size:9px;font-weight:500;letter-spacing:.06em;padding:2px 8px;border-radius:999px;border:1px solid ${brand === 'Aim Dental' ? 'rgba(32,114,144,.25)' : 'rgba(32,114,144,.25)'};color:${deep}">${brand === 'Aim Dental' ? 'AIM' : 'KH'}</span>`

  // Source as a quiet outlined pill, not a flat gray fill — a solid-fill
  // badge reads like a system tag; a hairline-bordered one with tracked
  // caps reads like a considered label. Still the one signal that tells
  // whoever's assigning *how* to reach out (LinkedIn wants a personal
  // note, a website form wants a fast callback).
  const sourceBadge = (source) => source
    ? `<span style="display:inline-block;font-family:${FONT_DATA};font-size:9px;font-weight:500;letter-spacing:.07em;text-transform:uppercase;padding:3px 9px;border-radius:999px;border:1px solid ${goldHairline};color:${slate}">${source}</span>`
    : ''


  const contactLine = (l) => {
    const parts = []
    if (l.email) parts.push(`<a href="mailto:${l.email}" style="color:${teal};text-decoration:none">${l.email}</a>`)
    if (l.phone) parts.push(l.phone)
    return parts.length ? parts.join(' &nbsp;·&nbsp; ') : '<span style="color:#a9c1c6;font-style:italic">No contact info on file</span>'
  }

  // Each lead reads as its own quiet card (hairline border, generous
  // padding, rounded corners) rather than a plain divided table row —
  // individually-framed items feel considered; a dense list of tr/td
  // dividers reads like a spreadsheet export.
  const rows = leads.map((l) => {
    const source = l.lead_source || l.referral_source || ''
    const value = Number(l.estimated_value) || 0
    return `
    <tr>
      <td style="padding:0 0 12px">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border:1px solid ${hairline};border-radius:14px">
          <tr>
            <td style="padding:18px 20px" valign="top">
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
                <tr>
                  <td valign="top">
                    <p style="margin:0 0 4px;font-family:${FONT_DISPLAY};font-size:17px;font-weight:700;color:${ink}">${l.doctor_name} &nbsp;${brandBadge(l.brand)}</p>
                    <p style="margin:0 0 10px;font-size:12px;font-style:italic;color:${slate}">${l.clinic_name || 'No clinic on file'}${l.case_interest ? ` &nbsp;·&nbsp; ${l.case_interest}` : ''}${l.location ? ` &nbsp;·&nbsp; ${l.location}` : ''}</p>
                    <p style="margin:0 0 12px;font-size:12.5px;color:${ink}">${contactLine(l)}</p>
                    ${sourceBadge(source)}
                  </td>
                  <td width="104" class="em-stack em-stack-pad" valign="top" style="text-align:right">
                    ${value > 0 ? `
                    <p style="margin:0;font-family:${FONT_DATA};font-size:17px;font-weight:500;color:${gold};letter-spacing:-.01em">$${value.toLocaleString()}</p>
                    <p style="margin:2px 0 10px;font-family:${FONT_DATA};font-size:8.5px;color:#c9b489;text-transform:uppercase;letter-spacing:.08em">Potential</p>
                    ` : ''}
                    <p style="margin:0;font-family:${FONT_DATA};font-size:10px;color:${slate}">${new Date(l.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}</p>
                  </td>
                </tr>
              </table>
            </td>
          </tr>
        </table>
      </td>
    </tr>`
  }).join('')

  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Cormorant+Garamond:wght@600;700&family=DM+Sans:wght@400;500;600;700&family=DM+Mono:wght@400;500&display=swap" rel="stylesheet">
<style>
  body, table, td, a { -webkit-text-size-adjust:100%; -ms-text-size-adjust:100%; }
  img { border:0; outline:none; text-decoration:none; }
  /* Below 600px (most phones in portrait): the fixed 36px side gutters and
     two-up rows (hero count/value, each lead's info/date-value split) are
     what actually break on a ~375px viewport, not the outer 600px card —
     that already shrinks fluidly since it's max-width, not width. These
     rules only touch gutters and force the two-up rows to stack. */
  @media only screen and (max-width:600px) {
    .em-px  { padding-left:20px !important; padding-right:20px !important; }
    .em-mx  { margin-left:20px !important; margin-right:20px !important; }
    .em-stack { display:block !important; width:100% !important; text-align:left !important; }
    .em-stack-pad { padding-top:12px !important; }
    .em-h1 { font-size:25px !important; }
    .em-hero-num { font-size:31px !important; }
  }
</style>
</head>
<body style="margin:0;padding:0;background-color:${BRAND.deep};background-image:linear-gradient(160deg,${BRAND.skyBlue} 0%,${BRAND.deep} 100%);font-family:${FONT_BODY}">
<div style="max-width:600px;margin:40px auto;background:#fff;border-radius:24px;overflow:hidden;box-shadow:0 6px 28px rgba(32,114,144,.16)">

  ${test ? `
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
    <tr>
      <td bgcolor="#fbbf24" style="background-color:#fbbf24;padding:10px 20px;text-align:center">
        <p style="margin:0;font-family:${FONT_DATA};font-size:11.5px;font-weight:500;letter-spacing:.08em;text-transform:uppercase;color:#78350f">⚠ Test send — not a real weekly report</p>
      </td>
    </tr>
  </table>
  ` : ''}

  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
    <tr>
      <td bgcolor="${teal}" class="em-px" style="background-color:${teal};background-image:linear-gradient(135deg,${teal},${deep});padding:38px 36px 30px">
        <table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>
          <td style="padding-right:8px">${diamond}</td>
          <td><p style="margin:0;font-family:${FONT_DATA};font-size:10px;font-weight:500;letter-spacing:.16em;text-transform:uppercase;color:rgba(255,255,255,.78)">Weekly Lead Intake</p></td>
        </tr></table>
        <h1 class="em-h1" style="color:#fff;margin:12px 0 0;font-family:${FONT_DISPLAY};font-size:32px;font-weight:700;letter-spacing:-.01em">Unassigned Leads</h1>
        <p style="color:rgba(255,255,255,.72);margin:9px 0 0;font-size:13px;font-style:italic;font-family:${FONT_DISPLAY}">Week of ${weekLabel}</p>
      </td>
    </tr>
  </table>

  <div class="em-mx" style="margin:34px 36px 0">
    ${empty ? `
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border:1px solid #bfe8cf;border-radius:16px">
      <tr><td style="padding:20px 22px">
        <p style="margin:0;font-size:13.5px;line-height:1.6;color:${ink}">No unassigned leads this week — every new lead that came in already has an owner. Nice work keeping the queue clear.</p>
      </td></tr>
    </table>
    ` : `
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:${gold};background-image:linear-gradient(135deg,${teal},${gold});border-radius:18px">
      <tr><td style="padding:2px">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:${BRAND.tealMist};background-image:linear-gradient(160deg,${BRAND.tealMist},${BRAND.blueMist});border-radius:16px">
          <tr><td style="padding:24px 26px">
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
              <td valign="top">
                <p style="margin:0 0 4px;font-family:${FONT_DATA};font-size:10px;font-weight:500;letter-spacing:.1em;text-transform:uppercase;color:${gold}">Sitting Unclaimed</p>
                <p class="em-hero-num" style="margin:0;font-family:${FONT_DISPLAY};font-size:38px;font-weight:700;color:${teal};letter-spacing:-.01em">${count}</p>
                <p style="margin:2px 0 0;font-size:11.5px;color:${deep}">lead${count === 1 ? '' : 's'} with no owner</p>
              </td>
              ${totalValue > 0 ? `
              <td class="em-stack em-stack-pad" valign="top" style="text-align:right">
                <p style="margin:0 0 4px;font-family:${FONT_DATA};font-size:10px;font-weight:500;letter-spacing:.1em;text-transform:uppercase;color:${gold}">Potential Value</p>
                <p style="margin:0;font-family:${FONT_DATA};font-size:26px;font-weight:500;color:${ink};letter-spacing:-.01em">$${totalValue.toLocaleString()}</p>
              </td>
              ` : ''}
            </tr></table>
          </td></tr>
        </table>
      </td></tr>
    </table>
    `}
  </div>

  ${!empty ? `
  <div class="em-mx" style="margin:22px 36px 0;padding-top:22px;border-top:1px solid ${goldHairline}">
    <table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>
      <td style="padding-right:8px" valign="top">${diamond}</td>
      <td>
        <p style="margin:0 0 6px;font-family:${FONT_DATA};font-size:10px;font-weight:500;letter-spacing:.09em;text-transform:uppercase;color:${gold}">These Should Be Assigned</p>
        <p style="margin:0;font-size:13px;line-height:1.65;color:${ink}">None of these have been contacted yet — that's not a downside, it's an opening. Whoever reaches out first sets the tone, and a prospect who's never heard from the lab is still the easiest pitch there is. Assign these to the team this week and have them send a real first outreach, not just a form follow-up.</p>
      </td>
    </tr></table>
  </div>
  ` : ''}

  ${!empty ? `
  <div class="em-px" style="padding:28px 36px 0">
    <p style="margin:0 0 14px;font-family:${FONT_DATA};font-size:10px;font-weight:500;letter-spacing:.09em;text-transform:uppercase;color:${slate}">The List</p>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
      ${rows}
    </table>
  </div>
  ` : ''}

  <div class="em-mx" style="margin:8px 36px 0;padding-top:26px;border-top:1px solid ${hairline}">
    <table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>
      <td bgcolor="${teal}" style="background-color:${teal};background-image:linear-gradient(135deg,${teal},${deep});border-radius:12px">
        <a href="${primaryFrontendUrl()}/leads" style="display:inline-block;padding:13px 28px;color:#fff;text-decoration:none;font-weight:600;font-size:13.5px;letter-spacing:.01em;font-family:${FONT_BODY}">Open Leads →</a>
      </td>
    </tr></table>
  </div>

  <div class="em-px" style="margin-top:36px;background:${BRAND.tealMist};padding:20px 36px;font-size:11.5px;font-style:italic;font-family:${FONT_DISPLAY};color:${slate};border-top:1px solid ${hairline}">
    Aim Dental Laboratory CRM &nbsp;·&nbsp; Weekly Unassigned Leads Report
  </div>
</div>
</body></html>`
}

function winStreakEmail(streak) {
  return emailWrapper(`
    <h2 style="color:#111;margin:0 0 8px">🏆 Win Streak: ${streak} in a Row!</h2>
    <p style="color:#6b7280;margin:0 0 16px">Your last ${streak} resolved leads are all wins — keep the momentum going!</p>
    <p style="color:#374151;font-size:14px">Consider asking your recent wins for a referral while the relationship is warm.</p>
  `, 'View Pipeline')
}

const BACKEND_URL = process.env.RENDER_EXTERNAL_URL || 'https://aim-crm-backend.onrender.com'

// Per-brand identity for the customer-facing pickup emails below — AIM and
// Kings Highway are two separate dental labs sharing this one CRM (see
// leads.brand/cases.brand), each with their own name, color, phone, and
// logo. Keyed by the exact `brand` column value used elsewhere (leads.js,
// caseNumber.js). Falls back to Aim Dental for anything unrecognized so
// existing AIM-only call sites that don't pass a brand keep working as-is.
const PICKUP_BRANDS = {
  'Aim Dental': {
    name: 'AIM Dental Laboratory',
    color: '#06babe',
    phone: '(718) 854-3900',
    logoUrl: null,
    footer: 'AIM Dental Laboratory — 802 Myrtle Avenue, Brooklyn, NY 11206 — (718) 854-3900',
  },
  'Kings Highway': {
    name: 'Kings Highway Dental Laboratory',
    color: '#31799b',
    phone: '(718) 331-2241',
    logoUrl: `${BACKEND_URL}/brand/kh-dental-logo.png`,
    footer: 'Kings Highway Dental Laboratory — khdentallab.com',
  },
}

function pickupBrand(brand) {
  return PICKUP_BRANDS[brand] || PICKUP_BRANDS['Aim Dental']
}

// Customer-facing wrapper for pickup-status emails — distinct from
// emailWrapper() below, which is staff-facing (links back to the internal
// CRM dashboard, "automated alert" framing). This one goes to the dental
// practice that requested the pickup, so it's branded as whichever lab
// (AIM or Kings Highway) the pickup lead actually belongs to, with no
// CRM-facing links.
function pickupCustomerWrapper(title, bodyHtml, brand) {
  const b = pickupBrand(brand)
  const headerContent = b.logoUrl
    ? `<img src="${b.logoUrl}" height="28" alt="${b.name}" style="display:block;height:28px;width:auto" />`
    : `<span style="color:#fff;font-weight:700;font-size:16px">${b.name}</span>`
  return `
    <!DOCTYPE html>
    <html><body style="margin:0;padding:0;background:#f9fafb;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif">
    <div style="max-width:600px;margin:40px auto;background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,.1)">
      <div style="background:${b.logoUrl ? '#fff' : b.color};padding:20px 32px;${b.logoUrl ? `border-bottom:3px solid ${b.color}` : ''}">
        ${headerContent}
      </div>
      <div style="padding:32px">
        <h2 style="color:#111;margin:0 0 12px;font-size:20px">${title}</h2>
        ${bodyHtml}
      </div>
      <div style="background:#f9fafb;padding:16px 32px;font-size:12px;color:#9ca3af">
        ${b.footer}
      </div>
    </div>
    </body></html>
  `
}

// Stage 1 — sent immediately on submission (see webLeads.js). Has the full
// set of fields straight from the pickup scheduler's request body, since
// those aren't all persisted as their own lead columns (folded into `notes`
// instead) — this is the one place they're available structured. `brand`
// isn't on the lead row yet at this call site (webLeads.js calls this
// before/alongside the insert), so it's passed through explicitly.
function pickupRequestedEmail({ doctorName, pickupAddress, pickupDate, pickupWindow, caseCount, instructions, brand }) {
  const b = pickupBrand(brand)
  const rows = [
    ['Pickup address', pickupAddress],
    ['Preferred date', pickupDate],
    ['Time window', pickupWindow],
    ['Cases / boxes', caseCount],
    instructions && ['Special instructions', instructions],
  ].filter(Boolean)

  const rowsHtml = rows
    .map(([label, value]) => `
      <tr>
        <td style="padding:6px 12px 6px 0;color:#6b7280;white-space:nowrap;vertical-align:top">${label}</td>
        <td style="padding:6px 0;color:#111">${value}</td>
      </tr>`)
    .join('')

  return pickupCustomerWrapper("We've received your pickup request", `
    <p style="color:#374151;font-size:14px;line-height:1.6;margin:0 0 16px">
      Hi ${doctorName || 'there'}, thanks for scheduling a case pickup with ${b.name}.
      We've got your request and our team will have it confirmed shortly — you'll get another
      email once a courier is dispatched to collect your case.
    </p>
    <table style="width:100%;border-collapse:collapse;font-size:14px">${rowsHtml}</table>
    <p style="color:#374151;font-size:14px;line-height:1.6;margin-top:20px">
      Questions or need to make a change? Call us at <strong>${b.phone}</strong>.
    </p>
  `, brand)
}

// Stage 2 — sent when staff mark the pickup as dispatched (leads.js
// /:id/dispatch). Only has the saved lead row to work with, not the
// original structured form fields, so it stays deliberately simple. Unlike
// pickupRequestedEmail, `lead.brand` is a real column by this point, so it
// reads brand off the row instead of taking a separate param.
function pickupDispatchedEmail(lead) {
  const b = pickupBrand(lead.brand)
  return pickupCustomerWrapper('Your courier is on the way', `
    <p style="color:#374151;font-size:14px;line-height:1.6;margin:0 0 16px">
      Hi ${lead.doctor_name || 'there'}, a courier has been dispatched to collect your case.
      You'll get a final confirmation email once it arrives back at our lab.
    </p>
    <p style="color:#374151;font-size:14px;line-height:1.6">
      Anything come up? Call us at <strong>${b.phone}</strong>.
    </p>
  `, lead.brand)
}

// Stage 3 — sent when staff mark the pickup as received (leads.js
// /:id/receive).
function pickupReceivedEmail(lead) {
  const b = pickupBrand(lead.brand)
  return pickupCustomerWrapper("We've received your case", `
    <p style="color:#374151;font-size:14px;line-height:1.6;margin:0 0 16px">
      Hi ${lead.doctor_name || 'there'}, your case has arrived at ${b.name} and is
      now in our production queue. We'll be in touch if we need anything further.
    </p>
    <p style="color:#374151;font-size:14px;line-height:1.6">
      Questions on turnaround? Call us at <strong>${b.phone}</strong>.
    </p>
  `, lead.brand)
}

function emailWrapper(content, ctaLabel) {
  return `
    <!DOCTYPE html>
    <html><body style="margin:0;padding:0;background:#f9fafb;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif">
    <div style="max-width:600px;margin:40px auto;background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,.1)">
      <div style="background:#06babe;padding:20px 32px">
        <span style="color:#fff;font-weight:700;font-size:16px">🦷 Aim Dental CRM</span>
      </div>
      <div style="padding:32px">${content}</div>
      <div style="padding:0 32px 32px">
        <a href="${primaryFrontendUrl()}" style="display:inline-block;background:#06babe;color:#fff;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:600;font-size:14px">${ctaLabel} →</a>
      </div>
      <div style="background:#f9fafb;padding:16px 32px;font-size:12px;color:#9ca3af">
        Aim Dental Laboratory CRM — automated alert
      </div>
    </div>
    </body></html>
  `
}

module.exports = {
  sendEmail,
  primaryFrontendUrl,
  coldLeadEmail,
  caseDueEmail,
  lostRecoveryEmail,
  winStreakEmail,
  repReportEmail,
  unassignedLeadsReportEmail,
  pickupRequestedEmail,
  pickupDispatchedEmail,
  pickupReceivedEmail,
  pickupBrand,
}
