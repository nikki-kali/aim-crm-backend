const HTML_ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }
function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => HTML_ESCAPES[c])
}

const SHELL_OPEN = `<div style="max-width:600px;margin:40px auto;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#10353f">`
const SHELL_CLOSE = `</div>`

// `pg` returns a Postgres `date` column as a JS Date object, constructed
// from the value's own LOCAL date components (confirmed for real: a
// stored '2026-10-15' comes back as a Date whose .getFullYear()/
// .getMonth()/.getDate() are 2026/9/15, regardless of the Node process's
// timezone) — NOT a plain "YYYY-MM-DD" string. Reading it back with those
// same local getters recovers the real date correctly on any server
// timezone; using .toISOString() instead (a pattern already used
// elsewhere in this codebase, e.g. campaigns.js/contentPosts.js) shifts
// the date by one day whenever the server isn't running in UTC+0 — do
// not copy that pattern. A plain string (e.g. from a test fixture) is
// taken as-is. Whole-branch review finding (Critical, confirmed): every
// booking fetched from the real database hit this, showing
// "Invalid Date" in every office-visit email.
function toDateStr(value) {
  if (!value) return null
  if (value instanceof Date) {
    const y = value.getFullYear()
    const m = String(value.getMonth() + 1).padStart(2, '0')
    const d = String(value.getDate()).padStart(2, '0')
    return `${y}-${m}-${d}`
  }
  return String(value).slice(0, 10)
}

function fmtDateTime(date, time) {
  const dateStr = toDateStr(date)
  if (!dateStr) return 'TBD'
  const d = new Date(`${dateStr}T${time || '00:00:00'}`)
  const dateLabel = d.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })
  if (!time) return dateLabel
  const timeLabel = d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
  return `${dateLabel} at ${timeLabel}`
}

function addressLine(booking) {
  return [booking.address_line1, booking.address_line2, booking.city, booking.state, booking.zip]
    .filter(Boolean).map(escapeHtml).join(', ')
}

function serviceInterestsLine(booking) {
  return (booking.service_interests || []).map(escapeHtml).join(', ') || '(none selected)'
}

// Sent to the territory-matched rep (or media@aimdentallab.com fallback)
// when a practice submits the public request form. Both action links are
// GET-safe confirmation PAGES (officeVisits.js's GET /confirm), not
// instant-action links — see that route's own comments for why.
function repNotificationEmail({ booking, approveUrl, suggestTimeConfirmUrl }) {
  const subject = `Office Visit request: ${escapeHtml(booking.practice_name || booking.contact_name)}`
  const html = `${SHELL_OPEN}
    <h1 style="font-size:20px;margin:0 0 16px">New Office Visit Request</h1>
    <p style="margin:0 0 4px"><b>${escapeHtml(booking.practice_name || '(no practice name given)')}</b></p>
    <p style="margin:0 0 4px">${escapeHtml(booking.contact_name)}${booking.contact_role ? ` — ${escapeHtml(booking.contact_role)}` : ''}</p>
    <p style="margin:0 0 4px">${addressLine(booking)}</p>
    <p style="margin:0 0 4px">${escapeHtml(booking.email)} · ${escapeHtml(booking.phone)}</p>
    <p style="margin:16px 0 4px"><b>Requested:</b> ${escapeHtml(fmtDateTime(booking.requested_date, booking.requested_time))}</p>
    <p style="margin:0 0 4px"><b>Interested in:</b> ${serviceInterestsLine(booking)}</p>
    ${booking.message ? `<p style="margin:12px 0;padding:12px;background:#f3f8f8;border-radius:8px">${escapeHtml(booking.message)}</p>` : ''}
    <div style="margin-top:24px">
      <a href="${approveUrl}" style="display:inline-block;padding:11px 22px;background:#059669;color:#fff;text-decoration:none;font-weight:600;border-radius:10px;margin-right:10px">Approve</a>
      <a href="${suggestTimeConfirmUrl}" style="display:inline-block;padding:11px 22px;background:#fff;border:1px solid #d1d5db;color:#10353f;text-decoration:none;font-weight:600;border-radius:10px">Suggest another time</a>
    </div>
  ${SHELL_CLOSE}`
  return { subject, html }
}

// GET-safe confirmation page for "Suggest another time" — the rep's own
// click-to-call button for the PRACTICE's number lives here (not in any
// email to the practice), so the rep can call them right before sending
// the "pending" email. See the spec's self-review correction.
function repSuggestTimeConfirmPage({ booking, confirmUrl }) {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Suggest another time</title></head>
  <body style="margin:0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#f7faf9;padding:60px 20px;text-align:center">
    <div style="max-width:420px;margin:0 auto;background:#fff;border-radius:16px;padding:36px 30px;box-shadow:0 4px 20px rgba(0,0,0,.06)">
      <h1 style="margin:0 0 10px;font-size:19px;color:#10353f">Suggest another time for ${escapeHtml(booking.practice_name || booking.contact_name)}?</h1>
      <p style="margin:0 0 18px;font-size:14px;color:#5b7a86;line-height:1.5">This marks the request as pending and emails the practice that you'll reach out directly. Call them now so you have a time ready:</p>
      <a href="tel:${escapeHtml(booking.phone)}" style="display:inline-block;margin-bottom:18px;padding:10px 20px;background:#eaf3f7;border:1px solid #a9cfe3;color:#1f6c88;text-decoration:none;font-weight:600;border-radius:10px">Call ${escapeHtml(booking.phone)}</a>
      <form method="POST" action="/api/office-visits/confirm">
        <input type="hidden" name="token" value="${escapeHtml(confirmUrl)}">
        <button type="submit" style="display:inline-block;padding:12px 28px;background:#059669;color:#fff;border:none;font-weight:600;font-size:14px;border-radius:10px;cursor:pointer">Send pending email</button>
      </form>
    </div>
  </body></html>`
}

// GET-safe confirmation page for "Approve" — no click-to-call needed here
// (approving doesn't require the rep to have called anyone first).
function repApproveConfirmPage({ booking, confirmUrl }) {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Approve office visit</title></head>
  <body style="margin:0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#f7faf9;padding:60px 20px;text-align:center">
    <div style="max-width:420px;margin:0 auto;background:#fff;border-radius:16px;padding:36px 30px;box-shadow:0 4px 20px rgba(0,0,0,.06)">
      <h1 style="margin:0 0 10px;font-size:19px;color:#10353f">Approve the visit to ${escapeHtml(booking.practice_name || booking.contact_name)}?</h1>
      <p style="margin:0 0 18px;font-size:14px;color:#5b7a86;line-height:1.5">This confirms ${escapeHtml(fmtDateTime(booking.requested_date, booking.requested_time))} and emails the practice a confirmation with your name and number.</p>
      <form method="POST" action="/api/office-visits/confirm">
        <input type="hidden" name="token" value="${escapeHtml(confirmUrl)}">
        <button type="submit" style="display:inline-block;padding:12px 28px;background:#059669;color:#fff;border:none;font-weight:600;font-size:14px;border-radius:10px;cursor:pointer">Confirm &amp; Send</button>
      </form>
    </div>
  </body></html>`
}

// Sent to the practice once a booking is approved (either directly, or
// after a rep reschedules following "suggest another time").
function practiceConfirmationEmail({ booking, rep }) {
  const subject = `Your office visit is confirmed — ${fmtDateTime(booking.confirmed_date || booking.requested_date, booking.confirmed_time || booking.requested_time)}`
  const html = `${SHELL_OPEN}
    <h1 style="font-size:20px;margin:0 0 16px">Your Office Visit is Confirmed</h1>
    <p style="margin:0 0 12px"><b>${escapeHtml(fmtDateTime(booking.confirmed_date || booking.requested_date, booking.confirmed_time || booking.requested_time))}</b></p>
    <p style="margin:0 0 4px">Your rep: <b>${escapeHtml(rep.name)}</b></p>
    <p style="margin:0 0 16px">Reach them directly at ${escapeHtml(rep.phone || rep.email)}</p>
    <p style="margin:16px 0 4px;font-weight:600">What you told us:</p>
    <p style="margin:0 0 4px">Interested in: ${serviceInterestsLine(booking)}</p>
    ${booking.message ? `<p style="margin:0 0 4px">Message: ${escapeHtml(booking.message)}</p>` : ''}
  ${SHELL_CLOSE}`
  return { subject, html }
}

// Sent to the practice when the rep suggests another time instead of
// approving the requested slot. Deliberately NO click-to-call button —
// the practice already has its own number; that button is for the REP,
// on repSuggestTimeConfirmPage above.
function practicePendingEmail({ booking, rep }) {
  const subject = `Re: Your office visit request — ${escapeHtml(booking.practice_name || booking.contact_name)}`
  const html = `${SHELL_OPEN}
    <h1 style="font-size:20px;margin:0 0 16px">Your Request is Pending</h1>
    <p style="margin:0 0 16px;line-height:1.6">This booking is pending and is not yet confirmed. <b>${escapeHtml(rep.name)}</b> will reach out directly to find a time that works for you.</p>
  ${SHELL_CLOSE}`
  return { subject, html }
}

module.exports = {
  repNotificationEmail,
  repSuggestTimeConfirmPage,
  repApproveConfirmPage,
  practiceConfirmationEmail,
  practicePendingEmail,
  toDateStr,
}
