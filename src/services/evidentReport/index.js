const { fetchEvidentEmails } = require('./gmailFetch')
const { parseAndAggregate } = require('./parseEvident')
const { buildEmail } = require('./buildReport')
const { getHistory, appendRow } = require('./log')
const { renderPdf } = require('./pdf')
const { sendEmail } = require('../email')

const RECIPIENTS = ['ben@aimdentallab.com', 'execassistant@aimdentallab.com', 'yoel@khdentallab.com']

// Anchored to America/New_York (the cron's own timezone) rather than
// falling back to parseEvident.js's UTC-derived default — the admin manual
// -send route has no guarantee it's invoked during the same UTC calendar
// day as ET, and writing "tomorrow's" date would collide with the next
// morning's real cron run on evident_report_log.date's UNIQUE constraint.
// 'en-CA' reliably formats as YYYY-MM-DD (verified against this Node
// version before relying on it here).
function todayEasternDateString() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' })
}

// Runs the full pipeline once: fetch → parse → build → render → send →
// log. Used both by jobs/evidentReport.js's daily cron and the admin
// manual test-send route (routes/reports.js's POST /evident-report/send).
async function runEvidentReport() {
  const runDate = todayEasternDateString()

  // Pre-flight duplicate check, before fetching Gmail or sending anything.
  // evident_report_log.date is UNIQUE, so a same-day re-run was already
  // guaranteed to fail on the later appendRow() — but that happened AFTER
  // sendEmail(), so a re-run sent a real duplicate to leadership first and
  // only failed loudly on the write. Checking history up front means the
  // duplicate send itself is prevented, not just the duplicate DB row.
  console.log('[evident-report] reading history log...')
  const historyRows = await getHistory()
  if (historyRows.some((r) => r.date === runDate)) {
    throw new Error(`[evident-report] a report for ${runDate} was already sent today — refusing to send a duplicate`)
  }

  console.log('[evident-report] fetching last night\'s Evident emails...')
  const messages = await fetchEvidentEmails()
  console.log(`[evident-report] found ${messages.length} Evident email(s)`)

  const aggregate = parseAndAggregate(messages, { runDate })
  if (aggregate.missing.length > 0) {
    console.warn(`[evident-report] missing reports: ${aggregate.missing.join(', ')}`)
  }

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
        'PDF attachment unavailable for this run. Figures above are unaffected.'
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

  // Only log today's row when all 5 expected Evident reports actually came
  // in — a zeroed sheetRow from a Gmail outage / sender-address change
  // would otherwise get persisted and poison TOMORROW's delta computation
  // with a fabricated zero baseline (a confident, unflagged "▲ $X vs.
  // yesterday" comparing against garbage), and burn today's UNIQUE `date`
  // slot so a corrected re-run isn't possible without manual DB surgery.
  if (aggregate.missing.length === 0) {
    console.log('[evident-report] logging today\'s totals...')
    await appendRow(sheetRow)
  } else {
    console.warn(
      `[evident-report] NOT logging today's (${runDate}) totals — ${aggregate.missing.length} of 5 expected reports were missing (${aggregate.missing.join(', ')}). ` +
      'Tomorrow\'s delta will compare against an older day instead of a fabricated zero baseline.'
    )
  }

  console.log('[evident-report] done.')
  return { aggregate, subject }
}

module.exports = { runEvidentReport }
