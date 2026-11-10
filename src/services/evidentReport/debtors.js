// Outstanding money to collect ("Debtors"), shown in red at the top of the
// Leadership Dashboard (Ben, 2026-11-10: "everyone should see, every day, how
// much is outstanding and ready to collect"; it doesn't need to be exact).
//
// Source: Evident's "This Month" case report, emailed to media@ by Report
// Schedule 49 "Debtors Daily - AIM CRM" (Mon-Fri 04:00 Evident time = 5 AM
// New York, set up 2026-11-10). The email body is a short summary:
//   ### Debtors Total: 320,949
//   Current: 150,650 / 30 Day: 58,770 / 60 Day: 44,699 / 90 Day: 66,830
// It also carries Accounts and WIP lines, which are ignored here. Debtors is a
// balance at the moment the email was generated, not a per-day figure, so the
// newest email wins and its own "generated" date is shown with it.

function textOf(html) {
  return String(html || '')
    .replace(/<(br|\/p|\/div|\/tr|\/h\d|\/li|\/td)[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/[*]/g, '')
}

const num = (s) => Number(String(s).replace(/,/g, ''))

// { total, current, d30, d60, d90, asOf } or null when the email has no
// Debtors Total.
function parseDebtors(html) {
  const text = textOf(html)
  const start = text.search(/Debtors/i)
  if (start < 0) return null
  const rest = text.slice(start)
  const end = rest.search(/\bWIP\b|Legend:/i)
  const section = end > 0 ? rest.slice(0, end) : rest
  const pick = (label) => {
    const m = section.match(new RegExp(`${label}\\s*:?\\s*(-?[\\d,]+(?:\\.\\d+)?)`, 'i'))
    return m ? num(m[1]) : null
  }
  const total = pick('Total')
  if (total === null || Number.isNaN(total)) return null
  const asOfMatch = text.match(/(\d{1,2}\s+[A-Z][a-z]{2}\s+\d{4})\s+\d{1,2}:\d{2}/)
  return {
    total,
    current: pick('Current'),
    d30: pick('30\\s*Day'),
    d60: pick('60\\s*Day'),
    d90: pick('90\\s*Day'),
    asOf: asOfMatch ? asOfMatch[1].replace(/\s+/g, ' ') : null,
  }
}

// The newest Debtors reading among the fetched Evident emails, or null.
// Messages come newest first from Gmail, but sort by date anyway.
function latestDebtors(messages) {
  const candidates = (messages || [])
    .filter((m) => /Debtors/i.test(String(m.html || '')))
    .sort((a, b) => (b.internalDate || 0) - (a.internalDate || 0) || String(b.date || '').localeCompare(String(a.date || '')))
  for (const m of candidates) {
    const d = parseDebtors(m.html)
    if (d) return { ...d, emailDate: m.date || null }
  }
  return null
}

module.exports = { parseDebtors, latestDebtors }
