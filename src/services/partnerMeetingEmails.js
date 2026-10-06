const { zonedTimeToUtc, formatSlot } = require('./partnerMeetingTime')
const { INTERNAL_TIME_ZONE } = require('../constants/partnerMeetings')

const HTML_ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }
const escapeHtml = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => HTML_ESCAPES[c])

// Anything a partner typed that lands in a subject or header must be one
// line, or a pasted line break could add a header (e.g. a hidden Bcc).
const oneLine = (v) => String(v ?? '').replace(/[\r\n]+/g, ' ').trim()

const SHELL_OPEN = `<div style="max-width:600px;margin:40px auto;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#10353f">`
const SHELL_CLOSE = '</div>'
const BTN = 'display:inline-block;padding:11px 20px;border-radius:10px;font-weight:600;font-size:14px;text-decoration:none;font-family:-apple-system,sans-serif'
const GREEN = `${BTN};background:#059669;color:#fff`
const OUTLINE = `${BTN};background:#eaf3f7;border:1px solid #a9cfe3;color:#1f6c88`

const who = (r) => oneLine(r.company) ? `${oneLine(r.company)} (${oneLine(r.partner_name)})` : oneLine(r.partner_name)

// "2:30 PM ET" for the same instant, in Ben's own zone.
function internalTimeLabel(slot, partnerTz) {
  const utc = zonedTimeToUtc(slot.date, slot.time, partnerTz)
  const t = utc.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: INTERNAL_TIME_ZONE })
  const d = utc.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: INTERNAL_TIME_ZONE })
  return `${d}, ${t} ET`
}

function detailsBlock(r) {
  const row = (label, value) => (value ? `<tr><td style="padding:3px 14px 3px 0;color:#5b7a86;font-size:13px">${label}</td><td style="padding:3px 0;font-size:14px">${value}</td></tr>` : '')
  return `<table style="border-collapse:collapse;margin:0 0 16px">
    ${row('Partner', escapeHtml(r.partner_name))}
    ${row('Company', escapeHtml(r.company))}
    ${row('Email', `<a href="mailto:${escapeHtml(r.email)}" style="color:#1f6c88">${escapeHtml(r.email)}</a>`)}
    ${row('Phone', r.phone ? `<a href="tel:${escapeHtml(r.phone)}" style="color:#1f6c88">${escapeHtml(r.phone)}</a>` : '')}
    ${row('Time zone', escapeHtml(r.timezone))}
  </table>`
}

// Request to Ben: three proposed times, each with its own Approve button,
// plus "I'll call them first".
function internalRequestEmail({ request, approveUrls, callFirstUrl }) {
  const slotRows = request.slots.map((slot, i) => `
    <div style="margin:0 0 12px;padding:14px 16px;border:1px solid #d7e3e1;border-radius:12px">
      <p style="margin:0 0 4px;font-size:12px;color:#5b7a86;text-transform:uppercase;letter-spacing:.08em">Option ${i + 1}</p>
      <p style="margin:0 0 2px;font-size:15px;font-weight:600">${escapeHtml(formatSlot(slot, request.timezone))}</p>
      <p style="margin:0 0 10px;font-size:13px;color:#5b7a86">${escapeHtml(internalTimeLabel(slot, request.timezone))}</p>
      <a href="${escapeHtml(approveUrls[i])}" style="${GREEN}">Approve this time</a>
    </div>`).join('')
  const html = `${SHELL_OPEN}
    <h1 style="font-size:20px;margin:0 0 6px">Partner meeting request</h1>
    <p style="margin:0 0 16px;font-size:14px;color:#5b7a86">${escapeHtml(who(request))} would like to meet. They offered 3 times.</p>
    ${detailsBlock(request)}
    ${request.note ? `<p style="margin:0 0 16px;padding:12px 14px;background:#f7faf9;border-radius:10px;font-size:14px">${escapeHtml(request.note)}</p>` : ''}
    ${slotRows}
    <p style="margin:18px 0 8px;font-size:14px">None of these work, or you would rather speak first?</p>
    <a href="${escapeHtml(callFirstUrl)}" style="${OUTLINE}">I'll call them first</a>
    <p style="margin:22px 0 0;font-size:12px;color:#8aa1ab">Approving sends the partner a confirmation with the Meet link and sends you a separate email with a calendar entry. Nothing is sent until you confirm on the next page.</p>
  ${SHELL_CLOSE}`
  return { subject: `Partner meeting request: ${who(request)}`, html }
}

function partnerConfirmationEmail({ request, slot, meetLink }) {
  const html = `${SHELL_OPEN}
    <h1 style="font-size:20px;margin:0 0 12px">Your meeting is confirmed</h1>
    <p style="margin:0 0 14px;font-size:14px;line-height:1.55">Hi ${escapeHtml(oneLine(request.partner_name).split(' ')[0] || 'there')}, thank you for your time. Your meeting with Ben at AIM Dental Laboratory is set:</p>
    <p style="margin:0 0 6px;font-size:16px;font-weight:600">${escapeHtml(formatSlot(slot, request.timezone))}</p>
    <p style="margin:0 0 18px;font-size:13px;color:#5b7a86">30 minutes, on Google Meet</p>
    <a href="${escapeHtml(meetLink)}" style="${GREEN}">Join the Google Meet</a>
    <p style="margin:18px 0 0;font-size:13px;color:#5b7a86;line-height:1.5">A calendar file is attached. Open it to add the meeting to your calendar. If you need to change the time, just reply to this email.</p>
  ${SHELL_CLOSE}`
  return { subject: `Your meeting with AIM Dental Laboratory is confirmed`, html }
}

function benConfirmationEmail({ request, slot, meetLink, googleCalendarUrl }) {
  const html = `${SHELL_OPEN}
    <h1 style="font-size:20px;margin:0 0 6px">Partner meeting confirmed</h1>
    <p style="margin:0 0 16px;font-size:14px;color:#5b7a86">${escapeHtml(who(request))}</p>
    <p style="margin:0 0 4px;font-size:16px;font-weight:600">${escapeHtml(formatSlot(slot, request.timezone))}</p>
    <p style="margin:0 0 16px;font-size:14px">${escapeHtml(internalTimeLabel(slot, request.timezone))}</p>
    ${detailsBlock(request)}
    <a href="${escapeHtml(meetLink)}" style="${GREEN}">Join the Google Meet</a>
    <a href="${escapeHtml(googleCalendarUrl)}" style="${OUTLINE};margin-left:8px">Add to Google Calendar</a>
    <p style="margin:18px 0 0;font-size:13px;color:#5b7a86;line-height:1.5">A calendar file is attached too, for Outlook or Apple Calendar. The partner has been sent their own confirmation.</p>
  ${SHELL_CLOSE}`
  return { subject: `Partner meeting confirmed: ${who(request)}`, html }
}

const PAGE_HEAD = (title) => `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title></head>
  <body style="margin:0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#f7faf9;padding:60px 20px;text-align:center">
    <div style="max-width:440px;margin:0 auto;background:#fff;border-radius:16px;padding:36px 30px;box-shadow:0 4px 20px rgba(0,0,0,.06)">`
const PAGE_TAIL = '</div></body></html>'
const SUBMIT = 'display:inline-block;padding:12px 28px;background:#059669;color:#fff;border:none;font-weight:600;font-size:14px;border-radius:10px;cursor:pointer'

function resultPage(title, message) {
  return `${PAGE_HEAD(title)}<h1 style="margin:0 0 10px;font-size:19px;color:#10353f">${escapeHtml(title)}</h1><p style="margin:0;font-size:14px;color:#5b7a86;line-height:1.5">${escapeHtml(message)}</p>${PAGE_TAIL}`
}

// GET-safe confirmation pages: viewing them changes nothing; only the form's POST does.
function approveConfirmPage({ request, slot, token }) {
  return `${PAGE_HEAD('Approve partner meeting')}
      <h1 style="margin:0 0 10px;font-size:19px;color:#10353f">Approve this meeting?</h1>
      <p style="margin:0 0 6px;font-size:15px;font-weight:600;color:#10353f">${escapeHtml(formatSlot(slot, request.timezone))}</p>
      <p style="margin:0 0 18px;font-size:14px;color:#5b7a86;line-height:1.5">with ${escapeHtml(who(request))}. This sends the partner a confirmation with the Meet link, and sends you a separate email with a calendar entry.</p>
      <form method="POST" action="/api/partner-meetings/confirm">
        <input type="hidden" name="token" value="${escapeHtml(token)}">
        <button type="submit" style="${SUBMIT}">Confirm and send</button>
      </form>
  ${PAGE_TAIL}`
}

function callFirstConfirmPage({ request, token }) {
  const phone = request.phone ? `<a href="tel:${escapeHtml(request.phone)}" style="display:inline-block;margin:0 6px 18px;padding:10px 20px;background:#eaf3f7;border:1px solid #a9cfe3;color:#1f6c88;text-decoration:none;font-weight:600;border-radius:10px">Call ${escapeHtml(request.phone)}</a>` : ''
  return `${PAGE_HEAD('Call the partner first')}
      <h1 style="margin:0 0 10px;font-size:19px;color:#10353f">Call ${escapeHtml(oneLine(request.partner_name))} first?</h1>
      <p style="margin:0 0 18px;font-size:14px;color:#5b7a86;line-height:1.5">This only marks the request as "calling first". The partner is not emailed. The approve buttons in the request email still work afterwards.</p>
      ${phone}<a href="mailto:${escapeHtml(request.email)}" style="display:inline-block;margin:0 6px 18px;padding:10px 20px;background:#eaf3f7;border:1px solid #a9cfe3;color:#1f6c88;text-decoration:none;font-weight:600;border-radius:10px">Email them</a>
      <form method="POST" action="/api/partner-meetings/confirm">
        <input type="hidden" name="token" value="${escapeHtml(token)}">
        <button type="submit" style="${SUBMIT}">Mark as calling first</button>
      </form>
  ${PAGE_TAIL}`
}

module.exports = {
  internalRequestEmail, partnerConfirmationEmail, benConfirmationEmail,
  approveConfirmPage, callFirstConfirmPage, resultPage, oneLine, escapeHtml, who,
}
