const express = require('express')
const cors = require('cors')
const db = require('../config/db')
const rateLimiter = require('../middleware/rateLimiter')
const { validateOptionalSlots, checkOneSlot, zonedTimeToUtc, utcToZonedParts, assertTimeZone, formatSlot } = require('../services/partnerMeetingTime')
const { buildIcs, buildGoogleCalendarUrl } = require('../services/partnerMeetingCalendar')
const { createToken, peekToken, consumeToken, invalidateOtherTokens } = require('../services/partnerMeetingTokens')
const {
  internalRequestEmail, partnerConfirmationEmail, benConfirmationEmail,
  approveConfirmPage, callFirstConfirmPage, setTimePage, resultPage, oneLine, escapeHtml, who,
} = require('../services/partnerMeetingEmails')
const { COMMON_ZONES, PARTNER_MEETING_TO, PARTNER_MEETING_CC, PARTNER_MEETING_BCC, MEET_LINK, MEETING_MINUTES } = require('../constants/partnerMeetings')
const { sendEmail } = require('../services/email')

const router = express.Router()
const BACKEND_URL = process.env.RENDER_EXTERNAL_URL || 'https://aim-crm-backend.onrender.com'
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

// Public and self-contained, like office visits: its own CORS so a form on
// another site can post here; mounted before the CRM's restrictive global CORS.
router.use(cors())
router.use(express.json({ limit: '64kb' }))
router.use(express.urlencoded({ extended: false, limit: '64kb' }))

// ---- the public form ----
router.get('/book', (req, res) => {
  const slotRow = (i) => `
      <div style="display:flex;gap:8px;margin-bottom:10px">
        <div style="flex:1"><label style="display:block;font-size:12px;color:#5b7a86;margin:0 0 3px">Option ${i} date</label>
          <input type="date" name="date${i}" style="width:100%;box-sizing:border-box;padding:10px 12px;border:1px solid #d7e3e1;border-radius:8px;font-size:14px"></div>
        <div style="flex:1"><label style="display:block;font-size:12px;color:#5b7a86;margin:0 0 3px">Option ${i} time</label>
          <input type="time" name="time${i}" style="width:100%;box-sizing:border-box;padding:10px 12px;border:1px solid #d7e3e1;border-radius:8px;font-size:14px"></div>
      </div>`
  const AUTOCOMPLETE = { partner_name: 'name', company: 'organization', email: 'email', phone: 'tel' }
  const field = (label, name, type = 'text', required = false) => `
      <label style="display:block;font-size:13px;color:#10353f;font-weight:600;margin:0 0 4px">${label}${required ? ' *' : ''}</label>
      <input type="${type}" name="${name}" autocomplete="${AUTOCOMPLETE[name] || 'off'}" ${required ? 'required' : ''} style="width:100%;box-sizing:border-box;padding:10px 12px;border:1px solid #d7e3e1;border-radius:8px;margin-bottom:14px;font-size:14px">`
  res.send(`<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Schedule a meeting with Ben | AIM Dental Laboratory</title></head>
<body style="margin:0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#f7faf9;padding:40px 16px">
  <div style="max-width:480px;margin:0 auto">
    <h1 style="font-size:20px;color:#10353f;margin:0 0 6px">Schedule a meeting with Ben</h1>
    <p style="font-size:14px;color:#5b7a86;margin:0 0 24px">Tell us who you are and when you are available. We will confirm a time by email with a Google Meet link.</p>
    <form id="pm-form" style="background:#fff;border-radius:16px;padding:24px;box-shadow:0 4px 20px rgba(0,0,0,.06)">
      ${field('Your name', 'partner_name', 'text', true)}
      ${field('Company', 'company')}
      ${field('Email', 'email', 'email', true)}
      ${field('Phone', 'phone', 'tel')}
      <label style="display:block;font-size:13px;color:#10353f;font-weight:600;margin:0 0 4px">Your time zone *</label>
      <select name="timezone" id="pm-tz" style="width:100%;box-sizing:border-box;padding:10px 12px;border:1px solid #d7e3e1;border-radius:8px;margin-bottom:14px;font-size:14px;background:#fff"></select>
      <label style="display:block;font-size:13px;color:#10353f;font-weight:600;margin:0 0 4px">Your availability *</label>
      <textarea name="availability" rows="3" maxlength="1000" placeholder="For example: weekday mornings next week, or Tuesday and Thursday after 2 PM" style="width:100%;box-sizing:border-box;padding:10px 12px;border:1px solid #d7e3e1;border-radius:8px;margin-bottom:16px;font-size:14px;font-family:inherit"></textarea>
      <p style="font-size:13px;color:#10353f;font-weight:600;margin:0 0 2px">Have exact times in mind? (optional, 30 minutes)</p>
      <p style="font-size:12px;color:#5b7a86;margin:0 0 8px">Add up to 3 and we can confirm one with a single click.</p>
      ${slotRow(1)}${slotRow(2)}${slotRow(3)}
      <label style="display:block;font-size:13px;color:#10353f;font-weight:600;margin:6px 0 4px">Anything we should know?</label>
      <textarea name="note" rows="3" maxlength="1000" style="width:100%;box-sizing:border-box;padding:10px 12px;border:1px solid #d7e3e1;border-radius:8px;margin-bottom:18px;font-size:14px;font-family:inherit"></textarea>
      <button type="submit" id="pm-submit" style="width:100%;padding:13px;background:#06babe;color:#fff;border:none;border-radius:999px;font-size:15px;font-weight:600;cursor:pointer">Request meeting</button>
      <p id="pm-error" style="display:none;color:#b91c1c;font-size:13px;margin:10px 0 0"></p>
    </form>
    <div id="pm-success" style="display:none;background:#fff;border-radius:16px;padding:28px;box-shadow:0 4px 20px rgba(0,0,0,.06);text-align:center">
      <h2 style="font-size:17px;color:#10353f;margin:0 0 8px">Request sent</h2>
      <p style="font-size:14px;color:#5b7a86;margin:0">Thank you. We will email you to confirm your meeting, or to suggest another time.</p>
    </div>
  </div>
  <script>
    var ZONES = ${JSON.stringify(COMMON_ZONES)};
    var sel = document.getElementById('pm-tz');
    var detected = '';
    try { detected = Intl.DateTimeFormat().resolvedOptions().timeZone || ''; } catch (e) {}
    var known = ZONES.map(function (z) { return z[0]; });
    if (detected && known.indexOf(detected) === -1) ZONES.unshift([detected, detected]);
    ZONES.forEach(function (z) {
      var o = document.createElement('option'); o.value = z[0]; o.textContent = z[1]; sel.appendChild(o);
    });
    if (detected) sel.value = detected;
    // Links can pre-fill the form: ?name=&company=&email=&phone=&timezone=
    var qs = new URLSearchParams(location.search);
    [['name', 'partner_name'], ['company', 'company'], ['email', 'email'], ['phone', 'phone']].forEach(function (m) {
      var val = qs.get(m[0]); if (val) document.getElementsByName(m[1])[0].value = val.slice(0, 160);
    });
    var tzq = qs.get('timezone');
    if (tzq) { var has = Array.prototype.some.call(sel.options, function (o) { return o.value === tzq; }); if (has) sel.value = tzq; }
    var today = new Date(); today.setMinutes(today.getMinutes() - today.getTimezoneOffset());
    var min = today.toISOString().slice(0, 10);
    ['1', '2', '3'].forEach(function (i) { document.getElementsByName('date' + i)[0].min = min; });

    document.getElementById('pm-form').addEventListener('submit', async function (e) {
      e.preventDefault();
      var f = e.target, err = document.getElementById('pm-error'), btn = document.getElementById('pm-submit');
      err.style.display = 'none';
      var v = function (n) { return f.elements[n].value; };
      var anySlot = [1, 2, 3].some(function (i) { return v('date' + i) || v('time' + i); });
      if (!v('availability').trim() && !anySlot) { err.textContent = 'Please describe your availability, or add at least one date and time.'; err.style.display = 'block'; return; }
      btn.disabled = true;
      var payload = {
        partner_name: v('partner_name'), company: v('company'), email: v('email'), phone: v('phone'),
        timezone: v('timezone'), note: v('note'), availability: v('availability'),
        slots: [1, 2, 3].map(function (i) { return { date: v('date' + i), time: v('time' + i) }; }).filter(function (s) { return s.date || s.time; }),
      };
      try {
        var res = await fetch('/api/partner-meetings/request', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
        if (!res.ok) {
          var body = await res.json().catch(function () { return {}; });
          err.textContent = body.error || 'Something went wrong. Please try again.';
          err.style.display = 'block'; btn.disabled = false; return;
        }
        f.style.display = 'none'; document.getElementById('pm-success').style.display = 'block';
      } catch (x) {
        err.textContent = 'Something went wrong. Please check your connection and try again.';
        err.style.display = 'block'; btn.disabled = false;
      }
    });
  </script>
</body></html>`)
})

// ---- a partner submits a request ----
router.post('/request', rateLimiter({ windowMs: 60 * 1000, max: 10 }), async (req, res) => {
  const b = req.body || {}
  const partner_name = String(b.partner_name || '').trim()
  const email = String(b.email || '').trim()
  const company = String(b.company || '').trim()
  const phone = String(b.phone || '').trim()
  const note = String(b.note || '').trim()
  const timezone = String(b.timezone || '').trim()

  if (!partner_name || partner_name.length > 120) return res.status(400).json({ error: 'Please enter your name.' })
  if (!EMAIL_RE.test(email) || email.length > 254) return res.status(400).json({ error: 'Please enter a valid email address.' })
  if (company.length > 160 || phone.length > 40 || note.length > 1000) return res.status(400).json({ error: 'One of the fields is too long.' })
  const availability = String(b.availability || '').trim()
  if (availability.length > 1000) return res.status(400).json({ error: 'Your availability is too long.' })
  const checked = validateOptionalSlots(b.slots, timezone)
  if (!checked.ok) return res.status(400).json({ error: checked.error })
  if (!availability && !checked.slots.length) return res.status(400).json({ error: 'Please describe your availability, or add at least one date and time.' })

  let requestId
  try {
    const { rows } = await db.query(
      `INSERT INTO partner_meeting_requests (partner_name, company, email, phone, timezone, slots, note, availability)
       VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8) RETURNING *`,
      [partner_name, company || null, email, phone || null, timezone, JSON.stringify(checked.slots), note || null, availability || null]
    )
    const request = rows[0]
    requestId = request.id
    const approveTokens = []
    for (let i = 0; i < checked.slots.length; i++) approveTokens.push(await createToken({ requestId, action: 'approve', slotIndex: i }))
    const setTimeToken = checked.slots.length ? null : await createToken({ requestId, action: 'set_time' })
    const callFirstToken = await createToken({ requestId, action: 'call_first' })
    const link = (t) => `${BACKEND_URL}/api/partner-meetings/confirm?token=${t}`

    const { subject, html } = internalRequestEmail({ request, approveUrls: approveTokens.map(link), callFirstUrl: link(callFirstToken), setTimeUrl: setTimeToken ? link(setTimeToken) : null })
    await sendEmail({
      to: PARTNER_MEETING_TO, cc: PARTNER_MEETING_CC, bcc: PARTNER_MEETING_BCC,
      replyTo: email, subject, html,
    })
    return res.status(201).json({ id: requestId })
  } catch (err) {
    console.error('[partner-meetings] POST /request failed:', err)
    // The request reaches Ben ONLY by this email. If it did not go out, remove
    // the saved request so the partner can safely submit again instead of
    // leaving a request nobody knows about.
    if (requestId) await db.query(`DELETE FROM partner_meeting_requests WHERE id = $1`, [requestId]).catch(() => {})
    return res.status(500).json({ error: 'Something went wrong sending your request. Please try again.' })
  }
})

// ---- Ben's email buttons ----
router.get('/confirm', rateLimiter({ windowMs: 10 * 60 * 1000, max: 40 }), async (req, res) => {
  try {
    const { token } = req.query
    if (!token) return res.status(400).send(resultPage('Missing link', 'This link is missing its token.'))
    const claim = await peekToken(String(token))
    if (!claim) return res.status(410).send(resultPage('Link expired or already used', 'This link has already been used, or has expired.'))
    const { rows } = await db.query(`SELECT * FROM partner_meeting_requests WHERE id = $1`, [claim.request_id])
    if (!rows[0]) return res.status(404).send(resultPage('Not found', 'This request no longer exists.'))
    const page = claim.action === 'approve'
      ? approveConfirmPage({ request: rows[0], slot: rows[0].slots[claim.slot_index], token: String(token) })
      : claim.action === 'set_time'
        ? setTimePage({ request: rows[0], token: String(token) })
        : callFirstConfirmPage({ request: rows[0], token: String(token) })
    return res.send(page)
  } catch (err) {
    console.error('[partner-meetings] GET /confirm failed:', err)
    return res.status(500).send(resultPage('Something went wrong', 'Please try again.'))
  }
})

router.post('/confirm', rateLimiter({ windowMs: 10 * 60 * 1000, max: 40 }), async (req, res) => {
  try {
    const token = String((req.body || {}).token || '')
    if (!token) return res.status(400).send(resultPage('Missing link', 'This link is missing its token.'))
    // A "pick a time" link is checked BEFORE it is used up, so a typo in the
    // date does not burn Ben's only link.
    let pickedSlot = null
    const peeked = await peekToken(token)
    if (peeked && peeked.action === 'set_time') {
      const { rows: pr } = await db.query(`SELECT * FROM partner_meeting_requests WHERE id = $1`, [peeked.request_id])
      if (!pr[0]) return res.status(404).send(resultPage('Not found', 'This request no longer exists.'))
      const date = String((req.body || {}).date || '').trim()
      const time = String((req.body || {}).time || '').trim()
      // Ben may enter the time in any zone; it is stored as the partner's wall clock.
      let tz = String((req.body || {}).tz || '').trim() || pr[0].timezone
      try { assertTimeZone(tz) } catch { tz = pr[0].timezone }
      const check = checkOneSlot(date, time, tz)
      if (!check.ok) return res.status(400).send(setTimePage({ request: pr[0], token, error: check.error, selectedTz: tz, date, time }))
      pickedSlot = utcToZonedParts(zonedTimeToUtc(date, time, tz), pr[0].timezone)
    }
    const claim = await consumeToken(token)
    if (!claim) return res.status(410).send(resultPage('Link expired or already used', 'This link has already been used, or has expired.'))
    const { rows: found } = await db.query(`SELECT * FROM partner_meeting_requests WHERE id = $1`, [claim.request_id])
    const request = found[0]
    if (!request) return res.status(404).send(resultPage('Not found', 'This request no longer exists.'))

    if (claim.action === 'call_first') {
      const { rows } = await db.query(
        `UPDATE partner_meeting_requests SET status='call_first', updated_at=NOW() WHERE id=$1 AND status='pending' RETURNING id`,
        [request.id]
      )
      if (!rows.length) return res.send(resultPage('Already handled', 'This request was already updated, so no changes were made.'))
      return res.send(resultPage('Marked as calling first', `Call ${oneLine(request.partner_name)}${request.phone ? ` at ${request.phone}` : ''} to agree a time. The Approve buttons in the original email still work once you do.`))
    }

    // Approve: the other proposed times and the call-first button are now moot.
    await invalidateOtherTokens(request.id, token)
    // A time Ben picked is stored as the request's single slot (index 0).
    const slotIndex = pickedSlot ? 0 : claim.slot_index
    const { rows: updated } = await db.query(
      `UPDATE partner_meeting_requests SET status='approved', confirmed_slot_index=$2, slots=COALESCE($3::jsonb, slots), updated_at=NOW()
       WHERE id=$1 AND status IN ('pending','call_first') RETURNING *`,
      [request.id, slotIndex, pickedSlot ? JSON.stringify([pickedSlot]) : null]
    )
    if (!updated.length) return res.send(resultPage('Already handled', 'This request was already updated, so no changes were made.'))

    const slot = pickedSlot || request.slots[claim.slot_index]
    const startUtc = zonedTimeToUtc(slot.date, slot.time, request.timezone)
    const event = {
      uid: `partner-meeting-${request.id}@aimdentallab.com`, startUtc, durationMin: MEETING_MINUTES,
      summary: `AIM Dental Laboratory partner meeting: ${who(request)}`,
      description: [`Partner: ${oneLine(request.partner_name)}`, request.company ? `Company: ${oneLine(request.company)}` : '', `Email: ${request.email}`, request.phone ? `Phone: ${request.phone}` : '', `Google Meet: ${MEET_LINK}`].filter(Boolean).join('\n'),
      location: MEET_LINK,
    }
    const ics = [{ filename: 'partner-meeting.ics', content: Buffer.from(buildIcs(event)), contentType: 'text/calendar; charset=utf-8; method=PUBLISH' }]

    const failed = []
    try {
      const { subject, html } = partnerConfirmationEmail({ request, slot, meetLink: MEET_LINK })
      await sendEmail({ to: [request.email], replyTo: PARTNER_MEETING_TO[0], subject, html, attachments: ics })
    } catch (err) {
      console.error('[partner-meetings] confirmation email to the partner failed (meeting is still approved):', err)
      failed.push('the partner')
    }
    try {
      const { subject, html } = benConfirmationEmail({ request, slot, meetLink: MEET_LINK, googleCalendarUrl: buildGoogleCalendarUrl(event) })
      await sendEmail({ to: PARTNER_MEETING_TO, cc: PARTNER_MEETING_CC, bcc: PARTNER_MEETING_BCC, subject, html, attachments: ics })
    } catch (err) {
      console.error('[partner-meetings] confirmation email to Ben failed (meeting is still approved):', err)
      failed.push('Ben')
    }
    if (failed.length) {
      return res.send(resultPage('Approved, but an email failed', `The meeting is approved for ${formatSlot(slot, request.timezone)}, but the email to ${failed.join(' and ')} did not send. Please forward the Meet link (${MEET_LINK}) to ${request.email} yourself.`))
    }
    return res.send(resultPage('Meeting confirmed', `${oneLine(request.partner_name)} has been sent the confirmation and Meet link, and you have your own copy with a calendar entry.`))
  } catch (err) {
    console.error('[partner-meetings] POST /confirm failed:', err)
    return res.status(500).send(resultPage('Something went wrong', 'Please try again, or contact the partner directly.'))
  }
})

module.exports = router
