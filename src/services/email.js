const { Resend } = require('resend')

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
async function sendViaBrevo({ to, subject, html, cc }) {
  const res = await fetch('https://api.brevo.com/v3/smtp/email', {
    method: 'POST',
    headers: {
      'api-key': process.env.BREVO_API_KEY,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify({
      sender: { name: 'Aim Dental CRM', email: 'info@aimdentallab.com' },
      to: [{ email: to || process.env.ALERT_EMAIL }],
      ...(cc?.length ? { cc: cc.map((email) => ({ email })) } : {}),
      subject,
      htmlContent: html,
    }),
  })
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`Brevo send failed (${res.status}): ${body}`)
  }
}

async function sendEmail({ to, subject, html, cc }) {
  const client = getResend()
  const from = process.env.RESEND_FROM || 'Aim Dental CRM <onboarding@resend.dev>'
  const { error } = await client.emails.send({
    from,
    to: to || process.env.ALERT_EMAIL,
    ...(cc?.length ? { cc } : {}),
    subject,
    html,
  })
  if (!error) return

  if (!process.env.BREVO_API_KEY) {
    throw new Error(error.message)
  }
  console.warn('sendEmail: Resend failed, falling back to Brevo —', error.message)
  await sendViaBrevo({ to, subject, html, cc })
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

function winStreakEmail(streak) {
  return emailWrapper(`
    <h2 style="color:#111;margin:0 0 8px">🏆 Win Streak: ${streak} in a Row!</h2>
    <p style="color:#6b7280;margin:0 0 16px">Your last ${streak} resolved leads are all wins — keep the momentum going!</p>
    <p style="color:#374151;font-size:14px">Consider asking your recent wins for a referral while the relationship is warm.</p>
  `, 'View Pipeline')
}

// Customer-facing wrapper for pickup-status emails — distinct from
// emailWrapper() below, which is staff-facing (links back to the internal
// CRM dashboard, "automated alert" framing). This one goes to the dental
// practice that requested the pickup, so it's branded as AIM Dental
// Laboratory itself with no CRM-facing links.
function pickupCustomerWrapper(title, bodyHtml) {
  return `
    <!DOCTYPE html>
    <html><body style="margin:0;padding:0;background:#f9fafb;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif">
    <div style="max-width:600px;margin:40px auto;background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,.1)">
      <div style="background:#06babe;padding:20px 32px">
        <span style="color:#fff;font-weight:700;font-size:16px">AIM Dental Laboratory</span>
      </div>
      <div style="padding:32px">
        <h2 style="color:#111;margin:0 0 12px;font-size:20px">${title}</h2>
        ${bodyHtml}
      </div>
      <div style="background:#f9fafb;padding:16px 32px;font-size:12px;color:#9ca3af">
        AIM Dental Laboratory — 802 Myrtle Avenue, Brooklyn, NY 11206 — (718) 854-3900
      </div>
    </div>
    </body></html>
  `
}

// Stage 1 — sent immediately on submission (see webLeads.js). Has the full
// set of fields straight from the pickup scheduler's request body, since
// those aren't all persisted as their own lead columns (folded into `notes`
// instead) — this is the one place they're available structured.
function pickupRequestedEmail({ doctorName, pickupAddress, pickupDate, pickupWindow, caseCount, instructions }) {
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
      Hi ${doctorName || 'there'}, thanks for scheduling a case pickup with AIM Dental Laboratory.
      We've got your request and our team will have it confirmed shortly — you'll get another
      email once a courier is dispatched to collect your case.
    </p>
    <table style="width:100%;border-collapse:collapse;font-size:14px">${rowsHtml}</table>
    <p style="color:#374151;font-size:14px;line-height:1.6;margin-top:20px">
      Questions or need to make a change? Call us at <strong>(718) 854-3900</strong>.
    </p>
  `)
}

// Stage 2 — sent when staff mark the pickup as dispatched (leads.js
// /:id/dispatch). Only has the saved lead row to work with, not the
// original structured form fields, so it stays deliberately simple.
function pickupDispatchedEmail(lead) {
  return pickupCustomerWrapper('Your courier is on the way', `
    <p style="color:#374151;font-size:14px;line-height:1.6;margin:0 0 16px">
      Hi ${lead.doctor_name || 'there'}, a courier has been dispatched to collect your case.
      You'll get a final confirmation email once it arrives back at our lab.
    </p>
    <p style="color:#374151;font-size:14px;line-height:1.6">
      Anything come up? Call us at <strong>(718) 854-3900</strong>.
    </p>
  `)
}

// Stage 3 — sent when staff mark the pickup as received (leads.js
// /:id/receive).
function pickupReceivedEmail(lead) {
  return pickupCustomerWrapper("We've received your case", `
    <p style="color:#374151;font-size:14px;line-height:1.6;margin:0 0 16px">
      Hi ${lead.doctor_name || 'there'}, your case has arrived at AIM Dental Laboratory and is
      now in our production queue. We'll be in touch if we need anything further.
    </p>
    <p style="color:#374151;font-size:14px;line-height:1.6">
      Questions on turnaround? Call us at <strong>(718) 854-3900</strong>.
    </p>
  `)
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
        <a href="${process.env.FRONTEND_URL || '#'}" style="display:inline-block;background:#06babe;color:#fff;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:600;font-size:14px">${ctaLabel} →</a>
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
  coldLeadEmail,
  caseDueEmail,
  lostRecoveryEmail,
  winStreakEmail,
  pickupRequestedEmail,
  pickupDispatchedEmail,
  pickupReceivedEmail,
}
