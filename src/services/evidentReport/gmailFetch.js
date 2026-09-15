const { google } = require('googleapis')

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

module.exports = { fetchEvidentEmails, extractSubjectAndHtml }
