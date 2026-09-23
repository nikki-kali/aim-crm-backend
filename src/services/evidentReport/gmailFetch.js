const { google } = require('googleapis')

// Real per-message delay between fetches in a wide-range pull — Gmail's
// per-minute quota was hit during design investigation for this feature
// (fetching 365 days' worth of messages one at a time). 300ms is a
// starting point, not load-tested at scale; tune upward if the backfill
// script (scripts/backfill-evident-crm-sync.js) still hits quota errors
// in practice.
const THROTTLE_MS = 300

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// Read-only Gmail fetch, ported from the standalone evident-report-project's
// gmail.js with its send half removed entirely (sending now goes through
// this repo's existing services/email.js instead of the Gmail API) — so
// the OAuth client here only ever needs the gmail.readonly scope. See
// docs/superpowers/specs/2026-09-15-evident-consolidated-report-design.md
// for the one-time OAuth consent-flow setup that produces
// GOOGLE_CLIENT_ID/GOOGLE_CLIENT_SECRET/GOOGLE_REFRESH_TOKEN.

function decodeBase64Url(data) {
  if (!data) return ''
  const b64 = data.replace(/-/g, '+').replace(/_/g, '/')
  return Buffer.from(b64, 'base64').toString('utf-8')
}

function findHtmlPart(part) {
  if (!part) return ''
  if (part.mimeType === 'text/html' && part.body && part.body.data) {
    return decodeBase64Url(part.body.data)
  }
  if (Array.isArray(part.parts)) {
    for (const p of part.parts) {
      const found = findHtmlPart(p)
      if (found) return found
    }
  }
  return ''
}

function extractSubjectAndHtml(message) {
  const headers = (message.payload && message.payload.headers) || []
  const subjectHeader = headers.find((h) => h.name.toLowerCase() === 'subject')
  const subject = subjectHeader ? subjectHeader.value : ''

  let html = ''
  if (message.payload) {
    if (message.payload.mimeType === 'text/html' && message.payload.body && message.payload.body.data) {
      html = decodeBase64Url(message.payload.body.data)
    } else {
      html = findHtmlPart(message.payload)
    }
  }
  if (!html) html = message.snippet || ''
  return { subject, html }
}

function getGmailAuth() {
  const client = new google.auth.OAuth2(process.env.GOOGLE_CLIENT_ID, process.env.GOOGLE_CLIENT_SECRET)
  client.setCredentials({ refresh_token: process.env.GOOGLE_REFRESH_TOKEN })
  return client
}

// Fetches every Evident Labs email received in roughly the last day and
// returns them as plain {subject, html} pairs, ready for parseEvident.js.
async function fetchEvidentEmails() {
  const auth = getGmailAuth()
  const gmail = google.gmail({ version: 'v1', auth })
  const listRes = await gmail.users.messages.list({
    userId: 'me',
    q: 'from:support@evidentlabs.com newer_than:1d',
  })
  const ids = (listRes.data.messages || []).map((m) => m.id)

  const messages = []
  for (const id of ids) {
    const res = await gmail.users.messages.get({ userId: 'me', id, format: 'full' })
    messages.push(extractSubjectAndHtml(res.data))
  }
  return messages
}

// Fetches the "EviSmart Daily Sales Report" email — the sole real source
// for the Leadership Report's Daily/MTD/YTD Booked+Billed figures as of
// 2026-09-23 (user instruction, replacing the old multi-report parsing
// approach). Distinct from Evident's own automated sends: this comes from
// media@aimdentallab.com (a person manually pulling EviSmart's dashboard
// and emailing the result), not support@evidentlabs.com, and its own
// subject carries the real business date — confirmed via a real 30-day
// inbox scan, 2026-09-23: "EviSmart Daily Sales Report - 23 September
// 2026" for a real send, "EviSmart Daily Sales Report - could not run
// (not logged in)" on days the pull itself failed (seen for real on
// 2026-09-19 and 2026-09-20). `newer_than:2d` (not `:1d` like
// fetchEvidentEmails) because this report has sometimes arrived as a
// same-day "updated pull" resend hours after an earlier pull — widening
// the window lets parseEvident.js's own pick-the-latest-message logic see
// both and prefer the fresher one, rather than this fetch silently
// missing an update that landed just outside a tighter window.
async function fetchEviSmartEmails() {
  const auth = getGmailAuth()
  const gmail = google.gmail({ version: 'v1', auth })
  const listRes = await gmail.users.messages.list({
    userId: 'me',
    q: 'from:media@aimdentallab.com subject:"EviSmart Daily Sales Report" newer_than:2d',
  })
  const ids = (listRes.data.messages || []).map((m) => m.id)

  const messages = []
  for (const id of ids) {
    const res = await gmail.users.messages.get({ userId: 'me', id, format: 'full' })
    const { subject, html } = extractSubjectAndHtml(res.data)
    messages.push({ subject, html, internalDate: Number(res.data.internalDate) })
  }
  return messages
}

// Like fetchEvidentEmails, but for an arbitrary Gmail search query
// (appended to the `from:support@evidentlabs.com` filter) and returning
// each message's own real calendar date (America/New_York) alongside its
// subject/html. Used by salesRepDailyReport.js's new-doctor detection,
// which needs a whole week's worth of a rep's own daily emails, not just
// today's.
async function fetchEvidentEmailsInRange(extraQuery) {
  const auth = getGmailAuth()
  const gmail = google.gmail({ version: 'v1', auth })
  const listRes = await gmail.users.messages.list({
    userId: 'me',
    q: `from:support@evidentlabs.com ${extraQuery}`,
    maxResults: 500,
  })
  const ids = (listRes.data.messages || []).map((m) => m.id)

  const messages = []
  for (const id of ids) {
    const res = await gmail.users.messages.get({ userId: 'me', id, format: 'full' })
    const { subject, html } = extractSubjectAndHtml(res.data)
    const date = new Date(Number(res.data.internalDate)).toLocaleDateString('en-CA', { timeZone: 'America/New_York' })
    messages.push({ subject, html, date })
    await sleep(THROTTLE_MS)
  }
  return messages
}

module.exports = { fetchEvidentEmails, fetchEviSmartEmails, fetchEvidentEmailsInRange, extractSubjectAndHtml, sleep, THROTTLE_MS }
