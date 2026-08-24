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

// Used only to pad personalizedSuggestions() out to 3 lines when a rep
// doesn't have enough going on in their own numbers to trigger 3 specific
// rules (e.g. a brand-new rep with almost no history yet) — never shown on
// its own.
const FALLBACK_SUGGESTIONS = {
  green: [
    'Set a stretch goal: one more lead than last week.',
    'Write down what worked this week so it’s easy to repeat.',
  ],
  amber: [
    'Pick one lead and move it forward today — that’s your 1% for the week.',
    'Send one prospect a follow-up that references something specific, not a generic check-in.',
  ],
  red: [
    'Block 30 minutes this week for follow-ups only, before any new prospecting.',
    'If a lead has gone quiet twice, try a different channel than last time.',
  ],
}

// Personalized, data-driven suggestions — each rule reads the rep's own
// numbers (named cold leads, stuck proposals, WIP vs. billed, week-over-
// week trend, a real recent win) rather than showing the same 3 lines to
// every rep in a tier. Rules are checked in priority order (most specific
// and actionable first) and the first 3 matches win; FALLBACK_SUGGESTIONS
// only pads the list when fewer than 3 of a rep's own signals fire.
function personalizedSuggestions({ week, month, previousWeek, sales, coldLeads, recentWinName, tier }) {
  const rules = []

  if (coldLeads?.count > 0 && coldLeads.leads[0]) {
    const l = coldLeads.leads[0]
    rules.push(`Follow up with ${l.doctor_name} — it’s been ${l.days_cold} day${l.days_cold !== 1 ? 's' : ''} since last contact.`)
  }
  if (coldLeads?.count > 1) {
    const rest = coldLeads.count - 1
    rules.push(`${rest} more cold lead${rest !== 1 ? 's' : ''} waiting behind that one — clear the list before it grows.`)
  }
  // Zero pipeline (no new leads *and* no new cases) is more foundational
  // than a stuck proposal or a WIP backlog — there's nothing downstream to
  // work if nothing's coming in, so it's checked ahead of those.
  if (Number(week.leads_created) === 0 && Number(week.cases_created || 0) === 0) {
    rules.push('No new leads or cases came in this week — block time for outreach before the pipeline stalls.')
  }
  if (month.proposals > 0 && month.wins === 0) {
    rules.push(`${month.proposals} proposal${month.proposals !== 1 ? 's' : ''} sent this month with no wins yet — a check-in could close one.`)
  }
  if (sales.wip > 0 && sales.wip > sales.billed) {
    rules.push(`$${sales.wip.toLocaleString()} sitting in WIP — check in on production to help convert it to billed.`)
  }
  if (previousWeek?.leads_created > 0 && week.leads_created < previousWeek.leads_created) {
    rules.push(`Lead creation dipped from last week (${previousWeek.leads_created} → ${week.leads_created}) — even one more this week reverses it.`)
  }
  if (recentWinName && (week.wins > 0 || month.wins > 0)) {
    rules.push(`Ask ${recentWinName} for a referral while the relationship is still warm.`)
  }
  if (month.leads_created >= 2 && month.conversion_rate >= 50) {
    rules.push(`Conversion is ${month.conversion_rate}% this month — well above average. Write down what’s working so you can repeat it.`)
  }
  if (month.leads_created >= 3 && month.conversion_rate < 20) {
    rules.push(`Conversion is ${month.conversion_rate}% this month — revisit how new leads get qualified before investing more follow-up time.`)
  }
  if (previousWeek && week.wins > previousWeek.wins) {
    rules.push(`Already ahead of last week’s ${previousWeek.wins} win${previousWeek.wins !== 1 ? 's' : ''} — one more keeps the streak building.`)
  }

  const picked = rules.slice(0, 3)
  if (picked.length < 3) {
    for (const f of FALLBACK_SUGGESTIONS[tier] || FALLBACK_SUGGESTIONS.amber) {
      if (picked.length >= 3) break
      picked.push(f)
    }
  }
  return picked
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

function repReportEmail({ repName, dateLabel, monthLabel, week, month, allTime, sales, tier, coldLeads, previousWeek, recentWinName }) {
  const { ink, slate, teal, deep, gold } = BRAND
  const hairline = '#dcebe9'
  const t = TIER_META[tier] || TIER_META.amber
  const quote = PUSH_QUOTES[isoWeekNumber(new Date()) % PUSH_QUOTES.length]
  const mTotal = Number(month.leads_created)
  const mWon = Number(month.wins)
  const convo = mTotal > 0 ? Math.round(mWon / mTotal * 100) : null
  const suggestions = personalizedSuggestions({ week, month, previousWeek, sales, coldLeads, recentWinName, tier })

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
  const statRow = (cells) => `
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
      <tr>
        ${cells.map((c, i) => `
        <td width="${Math.floor(100 / cells.length)}%" style="text-align:center;padding:0 4px;${i < cells.length - 1 ? `border-right:1px solid ${hairline}` : ''}">
          <p style="margin:0;font-family:${FONT_DATA};font-size:20px;font-weight:500;color:${c.color || ink};letter-spacing:-.01em">${c.val}</p>
          <p style="margin:5px 0 0;font-family:${FONT_DATA};font-size:9.5px;color:${slate};text-transform:uppercase;letter-spacing:.08em">${c.label}</p>
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
    <p style="margin:${coldLeads?.count > 0 ? '10px' : '8px'} 0 0;font-size:12.5px;line-height:1.5;color:#9a5b12;background:#fefaf1;border-radius:10px;padding:9px 12px">No new leads or cases came in this week — pipeline needs fresh activity.</p>
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

  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
    <tr>
      <td bgcolor="${teal}" style="background-color:${teal};background-image:linear-gradient(135deg,${teal},${deep});padding:34px 36px 28px">
        ${row2(
          `<p style="color:rgba(255,255,255,.75);font-family:${FONT_DATA};font-size:10.5px;letter-spacing:.1em;text-transform:uppercase;margin:0 0 9px">Aim Dental Laboratory</p>
           <h1 style="color:#fff;margin:0;font-family:${FONT_DISPLAY};font-size:30px;font-weight:700;letter-spacing:-.01em">Weekly Performance Report</h1>
           <p style="color:rgba(255,255,255,.82);margin:9px 0 0;font-size:13.5px">${repName} &nbsp;·&nbsp; ${dateLabel}</p>`,
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

  <div style="margin:26px 36px 0;padding:15px 18px;background:${t.tint};border:1px solid ${t.border};border-left:3px solid ${t.color};border-radius:4px 12px 12px 4px">
    <p style="margin:0;font-size:13.5px;line-height:1.55;color:${ink}">${statusLine(tier, coldLeads?.count || 0)}</p>
  </div>

  <p style="margin:14px 36px 0;font-size:12px;line-height:1.5;color:${slate};font-style:italic">"${quote}"</p>

  <div style="padding:26px 36px 0">
    ${sectionLabel('This Week')}
    ${statRow([
      { label: 'Leads', val: Number(week.leads_created) },
      { label: 'Contacted', val: Number(week.contacted) },
      { label: 'Proposals', val: Number(week.proposals) },
      { label: 'Wins', val: Number(week.wins), color: Number(week.wins) > 0 ? BRAND.success : undefined },
    ])}
  </div>

  <div style="padding:26px 36px 0">${coldSection}</div>

  <div style="margin:26px 36px 0;padding:20px 22px;background:#fff;border:1px solid ${hairline};border-radius:18px">
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

  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:28px 0 0">
    <tr><td style="padding:0 36px">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:${gold};background-image:linear-gradient(135deg,${teal},${gold});border-radius:19px">
        <tr><td style="padding:2px">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:${BRAND.tealMist};background-image:linear-gradient(160deg,${BRAND.tealMist},${BRAND.blueMist});border-radius:17px">
            <tr><td style="padding:20px 22px">
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
    ${sectionLabel(`This Month — ${monthLabel}`)}
    ${statRow([
      { label: 'Leads', val: mTotal },
      { label: 'Wins', val: mWon, color: mWon > 0 ? BRAND.success : undefined },
      { label: 'Revenue', val: '$' + Number(month.revenue).toLocaleString() },
      { label: 'Conversion', val: convo === null ? '—' : convo + '%', color: convo !== null && convo >= 50 ? BRAND.success : undefined },
    ])}
  </div>

  <div style="margin:28px 36px 0;padding-top:16px;border-top:1px solid ${hairline}">
    <p style="margin:0 0 12px;font-family:${FONT_DATA};font-size:9.5px;font-weight:500;letter-spacing:.09em;text-transform:uppercase;color:#a9c1c6">All-Time</p>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
      <td width="25%" style="text-align:left"><p style="margin:0;font-family:${FONT_DATA};font-size:14px;font-weight:500;color:${slate}">${Number(allTime.active_leads)}</p><p style="margin:3px 0 0;font-family:${FONT_DATA};font-size:8.5px;color:#a9c1c6;text-transform:uppercase;letter-spacing:.06em">Active</p></td>
      <td width="25%" style="text-align:left"><p style="margin:0;font-family:${FONT_DATA};font-size:14px;font-weight:500;color:${slate}">${Number(allTime.total_leads)}</p><p style="margin:3px 0 0;font-family:${FONT_DATA};font-size:8.5px;color:#a9c1c6;text-transform:uppercase;letter-spacing:.06em">Total Leads</p></td>
      <td width="25%" style="text-align:left"><p style="margin:0;font-family:${FONT_DATA};font-size:14px;font-weight:500;color:${slate}">${Number(allTime.total_wins)}</p><p style="margin:3px 0 0;font-family:${FONT_DATA};font-size:8.5px;color:#a9c1c6;text-transform:uppercase;letter-spacing:.06em">Won</p></td>
      <td width="25%" style="text-align:left"><p style="margin:0;font-family:${FONT_DATA};font-size:14px;font-weight:500;color:${slate}">$${Number(allTime.total_revenue).toLocaleString()}</p><p style="margin:3px 0 0;font-family:${FONT_DATA};font-size:8.5px;color:#a9c1c6;text-transform:uppercase;letter-spacing:.06em">Revenue</p></td>
    </tr></table>
  </div>

  <div style="margin:32px 36px 0;padding-top:24px;border-top:1px solid ${hairline}">
    <table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>
      <td bgcolor="${teal}" style="background-color:${teal};background-image:linear-gradient(135deg,${teal},${deep});border-radius:12px">
        <a href="${primaryFrontendUrl()}/reports" style="display:inline-block;padding:12px 26px;color:#fff;text-decoration:none;font-weight:600;font-size:13.5px;font-family:${FONT_BODY}">Open My Reports →</a>
      </td>
    </tr></table>
  </div>

  <div style="margin-top:32px;background:${BRAND.tealMist};padding:16px 36px;font-size:11.5px;color:${slate};border-top:1px solid ${hairline}">
    Aim Dental Laboratory CRM &nbsp;·&nbsp; Weekly report for ${repName}
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
  pickupRequestedEmail,
  pickupDispatchedEmail,
  pickupReceivedEmail,
  pickupBrand,
}
