const { fetchEvidentEmails } = require('./gmailFetch')
const { parseAndAggregate } = require('./parseEvident')
const { buildEmail } = require('./buildReport')
const { getHistory, appendRow } = require('./log')
const { renderPdf } = require('./pdf')
const { sendEmail } = require('../email')

const RECIPIENTS = ['ben@aimdentallab.com', 'execassistant@aimdentallab.com', 'yoel@khdentallab.com']

// Runs the full pipeline once: fetch → parse → build → render → send →
// log. Used both by jobs/evidentReport.js's daily cron and the admin
// manual test-send route (routes/reports.js's POST /evident-report/send).
async function runEvidentReport() {
  console.log('[evident-report] fetching last night\'s Evident emails...')
  const messages = await fetchEvidentEmails()
  console.log(`[evident-report] found ${messages.length} Evident email(s)`)

  const aggregate = parseAndAggregate(messages)
  if (aggregate.missing.length > 0) {
    console.warn(`[evident-report] missing reports: ${aggregate.missing.join(', ')}`)
  }

  console.log('[evident-report] reading history log...')
  const historyRows = await getHistory()

  const { subject, html, sheetRow } = buildEmail(aggregate, historyRows)

  // Best-effort: a PDF failure shouldn't block the report from sending at
  // all — it sends HTML-only instead, loudly logged, never silent.
  let pdfBuffer = null
  try {
    console.log('[evident-report] rendering PDF...')
    pdfBuffer = await renderPdf(html)
  } catch (err) {
    console.error('[evident-report] PDF render failed, sending HTML-only:', err)
  }

  const finalHtml = pdfBuffer
    ? html
    : html.replace(
        'A PDF copy of this report is attached.',
        'PDF attachment unavailable for this run — figures above are unaffected.'
      )

  console.log(`[evident-report] sending to ${RECIPIENTS.join(', ')}...`)
  await sendEmail({
    to: RECIPIENTS,
    subject,
    html: finalHtml,
    ...(pdfBuffer
      ? { attachments: [{ filename: `evident-report-${aggregate.runDate}.pdf`, content: pdfBuffer, contentType: 'application/pdf' }] }
      : {}),
  })

  console.log('[evident-report] logging today\'s totals...')
  await appendRow(sheetRow)

  console.log('[evident-report] done.')
  return { aggregate, subject }
}

module.exports = { runEvidentReport }
