const nodemailer = require('nodemailer')

let transporter

function getTransporter() {
  if (!transporter) {
    transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: Number(process.env.SMTP_PORT) || 465,
      secure: true,
      auth: {
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASS,
      },
      connectionTimeout: 10000,
      greetingTimeout: 10000,
      socketTimeout: 15000,
    })
  }
  return transporter
}

async function sendEmail({ to, subject, html }) {
  const t = getTransporter()
  await t.sendMail({
    from: `"Aim Dental CRM" <${process.env.SMTP_USER}>`,
    to: to || process.env.ALERT_EMAIL,
    subject,
    html,
  })
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

module.exports = { sendEmail, coldLeadEmail, caseDueEmail, lostRecoveryEmail, winStreakEmail }
