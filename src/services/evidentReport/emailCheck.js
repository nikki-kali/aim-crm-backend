const { fetchEvidentSubjects, EVISMART_SENDERS } = require('./gmailFetch')
const { eviSmartSubjectDate } = require('./parseEvident')
const { lastBusinessDayEasternDateString } = require('../salesRepDailyReport')

// The Evident emails the reports now depend on (Elizabeth's rules,
// 2026-10-02): booked and billed come from these, not from EviSmart. If one
// is missing at report time, the figure it feeds shows N/A or a "missing
// reports" notice, so it is checked ahead of the 6:00 AM run.
const CRITICAL_EVIDENT_EMAILS = [
  'Daily Booking Report - Nadine',
  'Daily Billed Report - Nadine',
  'MTD Booked Daily Update',
  'Daily MTD Total Billed',
  'YTD Billed Cases - Nadine',
]

const AFFECTS = {
  'Daily Booking Report - Nadine': 'Daily Booked on the Leadership Dashboard',
  'Daily Billed Report - Nadine': "the reps' Daily Billed cards",
  'MTD Booked Daily Update': 'MTD Booked (company and each rep)',
  'Daily MTD Total Billed': 'MTD Billed and every rep\'s Monthly Sales bar',
  'YTD Billed Cases - Nadine': 'YTD Sales on the Leadership Dashboard',
}

const norm = (s) => String(s || '').trim().toLowerCase()

function findMissingEvidentEmails(messages) {
  const subjects = messages.map((m) => norm(m.subject))
  const present = CRITICAL_EVIDENT_EMAILS.filter((c) => subjects.some((s) => s.startsWith(norm(c))))
  return { present, missing: CRITICAL_EVIDENT_EMAILS.filter((c) => !present.includes(c)) }
}

const senderAddress = (from) => {
  const m = String(from || '').match(/<([^>]+)>/)
  return norm(m ? m[1] : from)
}

// Is there a usable EviSmart Daily Sales Report for `runDate`? Same rules the
// report itself applies (parseEvident.pickEviSmartForDate): dated for that day
// in the subject, from an accepted sender, sent at or after 6 PM ET on that
// day. 'missing' just means not here yet (it normally lands 5:30 to 7:00 AM);
// 'wrong_sender' and 'too_early' mean it IS here but the automation ignores it.
function assessEviSmart(messages, runDate) {
  const forDay = messages.filter((m) => eviSmartSubjectDate(m.subject) === runDate)
  if (!forDay.length) return { status: 'missing', senders: [] }
  const accepted = forDay.filter((m) => EVISMART_SENDERS.includes(senderAddress(m.sender)))
  if (!accepted.length) return { status: 'wrong_sender', senders: [...new Set(forDay.map((m) => senderAddress(m.sender)))] }
  const afterSix = accepted.filter((m) => {
    const d = new Date(m.internalDate).toLocaleString('en-CA', { timeZone: 'America/New_York', hour12: false })
    const date = d.slice(0, 10)
    return date > runDate || (date === runDate && Number(d.slice(12, 14)) >= 18)
  })
  return afterSix.length ? { status: 'ok', senders: [] } : { status: 'too_early', senders: [] }
}

// `fetchEmails` returns [{ subject, date }] with each email's own America/New_York
// calendar date; only emails dated for the report day count, never an older day's.
// `fetchEviSmart` (optional) adds the EviSmart check. Only a report that IS here
// but would be ignored (wrong sender) fails the check: at 5:30 AM the day's
// EviSmart email normally has not arrived, so "not yet" must not raise an alarm.
async function checkEvidentEmails({ fetchEmails = fetchEvidentSubjects, fetchEviSmart, runDate = lastBusinessDayEasternDateString() } = {}) {
  const all = await fetchEmails()
  const { present, missing } = findMissingEvidentEmails(all.filter((m) => m.date === runDate))
  const result = { ok: missing.length === 0, runDate, foundForRunDate: present.length, present, missing }
  if (fetchEviSmart) {
    result.eviSmart = assessEviSmart(await fetchEviSmart(), runDate)
    if (result.eviSmart.status === 'wrong_sender') result.ok = false
  }
  return result
}

const HTML_ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }
const escapeHtml = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => HTML_ESCAPES[c])

function buildMissingEmailsAlert({ runDate, missing, present = [], eviSmart }) {
  const dayLabel = new Date(`${runDate}T12:00:00Z`).toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', timeZone: 'UTC' })
  const wrongSender = eviSmart && eviSmart.status === 'wrong_sender'
  const items = missing.map((m) => `<li><b>${escapeHtml(m)}</b> &rarr; ${escapeHtml(AFFECTS[m] || 'a report figure')}</li>`).join('')
  return {
    subject: wrongSender && !missing.length
      ? `EviSmart report from an unrecognized sender for ${dayLabel}`
      : `Evident emails missing for ${dayLabel}: reports may be incomplete`,
    html: `<div style="font-family:-apple-system,Segoe UI,Arial,sans-serif;font-size:14px;line-height:1.55;color:#10353f;max-width:620px">
${missing.length ? `<p>The 5:30 AM check found <b>${missing.length} of ${missing.length + present.length}</b> expected Evident emails missing for <b>${escapeHtml(dayLabel)}</b>:</p>
<ul>${items}</ul>` : ''}
${wrongSender ? `<p>The EviSmart Daily Sales Report for <b>${escapeHtml(dayLabel)}</b> arrived from <b>${escapeHtml(eviSmart.senders.join(', '))}</b>, which the reports do not accept, so it would be ignored. Send it from media@aimdentallab.com or valearningcenterphilippines@gmail.com, or ask me to add that address.</p>` : ''}
<p>If they still haven't arrived by 6:00 AM ET, the preview will show N/A or a "missing reports" notice for those figures, and the 7:00 AM automatic send would go out the same way unless you use "Hold today's send" in the preview.</p>
<p style="color:#5b7a86;font-size:12px">Evident sends these around 8:00 PM ET the evening before. Holidays have none, so a missing set on a holiday is expected.</p>
</div>`,
  }
}

module.exports = { assessEviSmart, CRITICAL_EVIDENT_EMAILS, findMissingEvidentEmails, checkEvidentEmails, buildMissingEmailsAlert }
