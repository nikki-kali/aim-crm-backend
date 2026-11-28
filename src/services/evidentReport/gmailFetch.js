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

// Gmail's per-user, per-minute quota ("Quota exceeded for quota metric
// 'Total Query Cost' and limit 'Units per minute per user'"). Since Evident's
// extra scheduled reports started on 2026-11-25 the 5-day fetch is long
// enough to pass it, and on 2026-11-27 every Leadership Dashboard attempt
// failed on it. The limit resets each minute, so wait it out and carry on.
function isQuotaError(err) {
  if (!err) return false
  const reasons = (err.errors || []).map((e) => e && e.reason).join(' ')
  return err.code === 429 || Number(err.status) === 429 ||
    /rateLimitExceeded|userRateLimitExceeded|quotaExceeded/i.test(reasons) ||
    /Quota exceeded|Rate Limit Exceeded/i.test(String(err.message || ''))
}

const QUOTA_WAIT_MS = 61000

async function withQuotaRetry(fn, { wait = sleep, retries = 3 } = {}) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn()
    } catch (err) {
      if (!isQuotaError(err) || attempt >= retries) throw err
      console.warn(`[gmail] per-minute quota reached; waiting ${QUOTA_WAIT_MS / 1000}s and retrying (${attempt + 1} of ${retries})`)
      await wait(QUOTA_WAIT_MS)
    }
  }
}

// Every Gmail call in this file goes through the quota retry above.
function gmailClient(auth) {
  const gmail = google.gmail({ version: 'v1', auth })
  return {
    users: {
      messages: {
        list: (params) => withQuotaRetry(() => gmail.users.messages.list(params)),
        get: (params) => withQuotaRetry(() => gmail.users.messages.get(params)),
      },
    },
  }
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

// Fetches every Evident Labs email from the last 5 days, each tagged with
// its own real America/New_York calendar date (see fetchEvidentEmailsInRange
// below), so the caller filters to the exact business day it needs instead
// of assuming "whatever came back is today's". Previously queried
// `newer_than:1d` and returned bare {subject, html} with no date at all —
// on a Monday run that 1-day window only reaches back to Sunday, and
// Evident sends nothing over the weekend, so Friday's real emails (the ones
// the report actually needs) were silently never fetched (found for real,
// 2026-09-28: the Monday report came back blank even though Friday's source
// emails were sitting right there in the inbox). Same weekend-gap bug
// already fixed once for evidentCrmSync.js and already worked around below
// for fetchEviSmartEmails's own newer_than:5d. Delegates to
// fetchEvidentEmailsInRange, which already does exactly this correctly.
async function fetchEvidentEmails() {
  return fetchEvidentEmailsInRange('newer_than:5d')
}

// Evident's "This Month" report with the Debtors line (Report Schedule 49,
// "Debtors Daily - AIM CRM", 2026-11-10; see debtors.js). Kept apart from
// fetchEvidentEmails so no other report sees these emails. The one test send
// came from noreply@evidentlabs.com while the scheduled ones come from
// support@, so both are allowed, but only emails that carry "Debtors Total".
const DEBTORS_QUERY = 'from:(support@evidentlabs.com OR noreply@evidentlabs.com) "Debtors Total" newer_than:5d'

async function fetchDebtorsEmails() {
  const auth = getGmailAuth()
  const gmail = gmailClient(auth)
  const listRes = await gmail.users.messages.list({ userId: 'me', q: DEBTORS_QUERY, maxResults: 12 })
  const ids = (listRes.data.messages || []).map((m) => m.id)
  const messages = []
  for (const id of ids.slice(0, 12)) {
    const res = await gmail.users.messages.get({ userId: 'me', id, format: 'full' })
    const { subject, html } = extractSubjectAndHtml(res.data)
    const internalDate = Number(res.data.internalDate)
    const date = new Date(internalDate).toLocaleDateString('en-CA', { timeZone: 'America/New_York' })
    messages.push({ subject, html, date, internalDate })
    await sleep(THROTTLE_MS)
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
// 2026-09-19 and 2026-09-20). `newer_than:5d` (not `:1d` like
// fetchEvidentEmails) because this report has sometimes arrived as a
// same-day "updated pull" resend hours after an earlier pull — widening
// the window (and 5 days so a Monday-morning run still reaches Friday
// evening's end-of-day send) lets parseEvident.js's pickEviSmartForDate see
// both and prefer the fresher one, rather than this fetch silently
// missing an update that landed just outside a tighter window.
// The EviSmart report is sent by whichever account runs the browser extension:
// media@aimdentallab.com until 2026-09-29, and valearningcenterphilippines@
// gmail.com since (found 2026-10-05: Friday's report arrived from that
// account and was silently ignored, blanking Daily Billed). Both are the
// user's own accounts; any other sender is still ignored.
const EVISMART_SENDERS = ['media@aimdentallab.com', 'valearningcenterphilippines@gmail.com']
const EVISMART_QUERY = `from:(${EVISMART_SENDERS.join(' OR ')}) subject:"EviSmart Daily Sales Report" newer_than:5d`

async function fetchEviSmartEmails() {
  const auth = getGmailAuth()
  const gmail = gmailClient(auth)
  const listRes = await gmail.users.messages.list({
    userId: 'me',
    q: EVISMART_QUERY,
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
  const gmail = gmailClient(auth)
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
    const internalDate = Number(res.data.internalDate)
    const date = new Date(internalDate).toLocaleDateString('en-CA', { timeZone: 'America/New_York' })
    messages.push({ subject, html, date, internalDate, authResults: gmailAuthResults(res.data), from: fromAddress(res.data), sentDate: sentDateEt(res.data) })
    await sleep(THROTTLE_MS)
  }
  return messages
}

// Gmail's own verdict on where a message came from: the Authentication-Results
// header Gmail's receiving server adds. A message carrying more than one is
// rejected (''), since any beyond Gmail's own were written by the sender.
function gmailAuthResults(message) {
  const headers = (message.payload && message.payload.headers) || []
  const all = headers.filter((x) => String(x.name).toLowerCase() === 'authentication-results')
  return all.length === 1 ? String(all[0].value || '') : ''
}

const headerValue = (message, name) => {
  const h = ((message.payload && message.payload.headers) || []).find((x) => String(x.name).toLowerCase() === name)
  return h ? String(h.value || '') : ''
}

// The sender's mailbox from the From header ("evidentlabs.com" <support@evidentlabs.com>).
function fromAddress(message) {
  const v = headerValue(message, 'from')
  const m = v.match(/<([^<>\s]+@[^<>\s]+)>\s*$/) || v.match(/^\s*([^<>\s"]+@[^<>\s"]+)\s*$/)
  return m ? m[1].toLowerCase() : ''
}

// The email's own Date header as a New York calendar date (Evident signs it
// with DKIM), or null. Used to tie a report to the day it was sent.
function sentDateEt(message) {
  const t = Date.parse(headerValue(message, 'date'))
  return Number.isNaN(t) ? null : new Date(t).toLocaleDateString('en-CA', { timeZone: 'America/New_York' })
}

// Gmail's verdict split into clauses ({ method, result, props }), after
// removing comments "(...)" and quoted strings, which can carry text the
// sender chose. The first part is the server that wrote it (authserv-id).
function parseAuthResults(value) {
  const cleaned = String(value || '')
    .replace(/"(?:[^"\\]|\\.)*"/g, '""')
    .replace(/\((?:[^()\\]|\\.)*\)/g, ' ')
  const [authserv, ...rest] = cleaned.split(';')
  const clauses = rest.map((c) => {
    const tokens = c.trim().split(/\s+/).filter(Boolean)
    const [method, result] = (tokens[0] || '').toLowerCase().split('=')
    const props = {}
    for (const t of tokens.slice(1)) {
      const i = t.indexOf('=')
      if (i > 0) props[t.slice(0, i).toLowerCase()] = t.slice(i + 1).toLowerCase()
    }
    return { method, result, props }
  })
  return { authserv: String(authserv || '').trim().toLowerCase(), clauses }
}

// True only when Gmail itself verified the message as sent by evidentlabs.com:
// a DKIM signature by evidentlabs.com that passed, DMARC passed for it, and no
// evidentlabs.com check failed.
function isVerifiedEvident(authResults) {
  const { authserv, clauses } = parseAuthResults(authResults)
  if (authserv !== 'mx.google.com') return false
  const dkimOk = clauses.some((c) => c.method === 'dkim' && c.result === 'pass' && (c.props['header.i'] === '@evidentlabs.com' || c.props['header.d'] === 'evidentlabs.com'))
  const dmarcOk = clauses.some((c) => c.method === 'dmarc' && c.result === 'pass' && c.props['header.from'] === 'evidentlabs.com')
  const anyFail = clauses.some((c) => (c.method === 'dkim' || c.method === 'dmarc') && c.result !== 'pass'
    && (c.props['header.i'] === '@evidentlabs.com' || c.props['header.d'] === 'evidentlabs.com' || c.props['header.from'] === 'evidentlabs.com'))
  return dkimOk && dmarcOk && !anyFail
}

// Subjects and ET dates only (Gmail "metadata" format: no email bodies), so a
// completeness check over the last 5 days takes seconds instead of the
// ~30s of fetchEvidentEmails — important on the free Render plan, where a
// cold start already eats most of a request's time.
async function fetchEvidentSubjects() {
  const auth = getGmailAuth()
  const gmail = gmailClient(auth)
  const listRes = await gmail.users.messages.list({ userId: 'me', q: 'from:support@evidentlabs.com newer_than:5d', maxResults: 500 })
  const ids = (listRes.data.messages || []).map((m) => m.id)
  const out = []
  for (let i = 0; i < ids.length; i += 10) {
    const batch = await Promise.all(ids.slice(i, i + 10).map(async (id) => {
      const res = await gmail.users.messages.get({ userId: 'me', id, format: 'metadata', metadataHeaders: ['Subject'] })
      const subject = ((res.data.payload.headers || []).find((h) => h.name.toLowerCase() === 'subject') || {}).value || ''
      const date = new Date(Number(res.data.internalDate)).toLocaleDateString('en-CA', { timeZone: 'America/New_York' })
      return { subject, date }
    }))
    out.push(...batch)
  }
  return out
}

// EviSmart Daily Sales Report emails from ANY sender (headers only, no
// bodies): the 5:30 AM check uses it to tell "not here yet" apart from "sent
// from an address the automation does not accept".
async function fetchEviSmartHeaders() {
  const auth = getGmailAuth()
  const gmail = gmailClient(auth)
  const listRes = await gmail.users.messages.list({ userId: 'me', q: 'subject:"EviSmart Daily Sales Report" newer_than:5d', maxResults: 50 })
  const out = []
  for (const { id } of listRes.data.messages || []) {
    const res = await gmail.users.messages.get({ userId: 'me', id, format: 'metadata', metadataHeaders: ['Subject', 'From'] })
    const h = Object.fromEntries((res.data.payload.headers || []).map((x) => [x.name.toLowerCase(), x.value]))
    out.push({ subject: h.subject || '', sender: h.from || '', internalDate: Number(res.data.internalDate) })
  }
  return out
}

module.exports = { gmailAuthResults, parseAuthResults, fromAddress, sentDateEt, isVerifiedEvident, withQuotaRetry, isQuotaError, fetchEviSmartHeaders, fetchEvidentSubjects, EVISMART_SENDERS, EVISMART_QUERY, fetchEvidentEmails, fetchDebtorsEmails, DEBTORS_QUERY, fetchEviSmartEmails, fetchEvidentEmailsInRange, extractSubjectAndHtml, sleep, THROTTLE_MS }
