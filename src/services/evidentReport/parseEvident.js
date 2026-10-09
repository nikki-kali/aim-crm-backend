// Parses Evident Labs' nightly report emails and aggregates them into one
// combined figure set. Evident's HTML is old-school (unclosed <TR>/<TD>),
// so this uses tolerant regex splitting rather than a strict HTML parser -
// that's deliberate, not an oversight.

function stripTags(s) {
  return s.replace(/<[^>]*>/g, '').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').trim();
}

function toNum(s) {
  if (s === undefined || s === null) return 0;
  // Strips a literal "$" too, not just commas — Evident's own reports
  // never include one, but the real EviSmart Daily Sales Report email
  // does ("$121,610.28"), and parseFloat can't skip a leading "$" itself
  // (confirmed against real EviSmart fixture data, 2026-09-23). Safe for
  // every existing caller: a dollar sign has no other valid meaning in a
  // numeric cell.
  const cleaned = String(s).replace(/[,$]/g, '').trim();
  if (cleaned === '') return 0;
  const n = parseFloat(cleaned);
  return Number.isNaN(n) ? 0 : n;
}

// Parses the FIRST <table>...</table> in an HTML fragment into
// { headers: string[], rows: string[][] }. Returns null if no table found.
function parseTable(html) {
  const tableMatch = html.match(/<table[\s\S]*?<\/table>/i);
  if (!tableMatch) return null;
  const tableHtml = tableMatch[0];
  const rowChunks = tableHtml.split(/<tr[^>]*>/i).slice(1);
  const rows = [];
  for (const chunk of rowChunks) {
    const cellChunks = chunk.split(/<td[^>]*>/i).slice(1);
    const cells = cellChunks.map((c) => stripTags(c));
    if (cells.some((c) => c !== '')) rows.push(cells);
  }
  if (rows.length === 0) return null;
  const headers = rows[0].map((h) => h.trim());
  return { headers, rows: rows.slice(1) };
}

function rowToObj(headers, row) {
  const obj = {};
  headers.forEach((h, i) => {
    obj[h] = row[i] !== undefined ? row[i] : '';
  });
  return obj;
}

function classify(subject) {
  const s = subject.trim();
  if (/^Daily Booked Cases\s*-\s*James/i.test(s)) return { type: 'dailyBooked', rep: 'james' };
  if (/^Daily Booked Cases\s*-\s*William/i.test(s)) return { type: 'dailyBooked', rep: 'william' };
  if (/^MTD Booked Cases\s*-\s*James/i.test(s)) return { type: 'mtdBooked', rep: 'james' };
  if (/^MTD Booked Cases\s*-\s*William/i.test(s)) return { type: 'mtdBooked', rep: 'william' };
  if (/^YTD Booked Cases\s*-\s*James/i.test(s)) return { type: 'ytdBooked', rep: 'james' };
  if (/^YTD Booked Cases\s*-\s*William/i.test(s)) return { type: 'ytdBooked', rep: 'william' };
  if (/^Cases Currently In Progress/i.test(s)) return { type: 'wip' };
  if (/^Daily Booking Report\s*-\s*Nadine/i.test(s)) return { type: 'companyDailyBooked' };
  if (/^Daily Billed Report\s*-\s*Nadine/i.test(s)) return { type: 'companyDailyBilled' };
  if (/^Daily MTD Total Billed/i.test(s)) return { type: 'companyMtdBilled' };
  if (/^MTD Booked Daily Update/i.test(s)) return { type: 'companyMtdBooked' };
  if (/^YTD Billed Cases\s*-\s*Nadine/i.test(s)) return { type: 'companyYtdBilled' };
  return { type: 'other' };
}

// "Contains" match rather than exact, because Evident's headers have
// inconsistent capitalization/spacing across report types.
function findCol(headers, needle) {
  const lower = needle.toLowerCase();
  return headers.find((h) => h.toLowerCase().includes(lower));
}

// Row-level (not totals-row) customer names from a "Daily Booked Cases"
// email — used by salesRepDailyReport.js's new-doctor detection, which
// needs to know WHO booked, not just the day's combined totals every
// other parser in this file cares about. The totals row has a blank
// Customer Name (only its numeric columns are filled in), so it drops out
// on its own via the final filter — sliced off explicitly too, for
// clarity, matching how every other handler in this file treats the last
// row as the totals row.
function extractDailyBookedCustomerNames(html) {
  const table = parseTable(html);
  if (!table || table.rows.length === 0) return [];
  const { headers, rows } = table;
  const nameCol = findCol(headers, 'Customer Name') || findCol(headers, 'Customer');
  if (!nameCol) return [];
  return rows
    .slice(0, -1)
    .map((row) => rowToObj(headers, row)[nameCol])
    .filter(Boolean);
}

// Shared by dailyBooked/mtdBooked/ytdBooked parsing below AND by
// salesRepDailyReport.js's week-scoped booked/billed summary — a single
// email's totals row as { count, billed, wip, value, hasData }. "value"
// is derived as billed + wip rather than read from a "Sales Value
// (Total)" column, because the Daily report doesn't include that column
// at all (only MTD/YTD do) - billed+wip always equals it anyway (verified
// against real Evident data).
function extractCaseTotals(html) {
  const table = parseTable(html);
  if (!table || table.rows.length === 0) return { count: 0, billed: 0, wip: 0, value: 0, hasData: false };
  const { headers, rows } = table;
  const totalsRow = rowToObj(headers, rows[rows.length - 1]);
  const countCol = findCol(headers, 'Cases (Total)');
  const billedCol = findCol(headers, 'Total Billed');
  const wipCol = findCol(headers, 'Total WIP');
  const billed = toNum(totalsRow[billedCol]);
  const wip = toNum(totalsRow[wipCol]);
  return { count: toNum(totalsRow[countCol]), billed, wip, value: billed + wip, hasData: true };
}

// Row-level detail from "Daily Booking Report - Nadine" — every real
// booking event that day, company-wide (not just James'/William's own
// doctors, unlike extractDailyBookedCustomerNames above). Used by
// evidentCrmSync.js to create/update individual CRM `cases` rows, not
// just a combined total. Customer Name is trimmed (Evident's own HTML
// pads it with spaces); Salesperson is '' for the unattributed "N/A"
// bucket, a lowercase first name ('james'/'william') when attributed.
// Maps Evident's "Salesperson" cell to 'james' / 'william' / null. Evident
// truncates the rep's name in these cells ("james dela" for James Delaney,
// "william" for William), so matching the exact string 'james' silently
// dropped every one of James's rows (confirmed 2026-09-25 against real
// 23 and 24 Sep emails). Matches on the first name instead.
function repKeyFromSalesperson(salesperson) {
  const first = String(salesperson || '').trim().toLowerCase().split(/\s+/)[0];
  if (first === 'james') return 'james';
  if (first === 'william') return 'william';
  return null;
}

function extractBookingRows(html) {
  const table = parseTable(html);
  if (!table || table.rows.length === 0) return [];
  const { headers, rows } = table;
  const refCol = findCol(headers, 'Ref');
  const nameCol = findCol(headers, 'Customer Name');
  const valueCol = findCol(headers, 'Sales Value (Total)');
  const salespersonCol = findCol(headers, 'Salesperson');
  return rows
    .slice(0, -1) // drop the totals row (blank Ref)
    .map((row) => {
      const obj = rowToObj(headers, row);
      return {
        ref: (obj[refCol] || '').trim(),
        customerName: (obj[nameCol] || '').trim(),
        value: toNum(obj[valueCol]),
        salesperson: (obj[salespersonCol] || '').trim(),
      };
    })
    .filter((r) => r.ref);
}

// Row-level detail from "Daily Billed Report - Nadine" — every real
// billing event that day, company-wide. Same shape as
// extractBookingRows above plus billedValue, since this report's whole
// purpose is telling us how much of each case's value just got billed.
function extractBilledRows(html) {
  const table = parseTable(html);
  if (!table || table.rows.length === 0) return [];
  const { headers, rows } = table;
  const refCol = findCol(headers, 'Ref');
  const nameCol = findCol(headers, 'Customer Name');
  const valueCol = findCol(headers, 'Sales Value (Total)');
  const billedCol = findCol(headers, 'Sales Value (Total Billed)');
  const salespersonCol = findCol(headers, 'Salesperson');
  return rows
    .slice(0, -1)
    .map((row) => {
      const obj = rowToObj(headers, row);
      return {
        ref: (obj[refCol] || '').trim(),
        customerName: (obj[nameCol] || '').trim(),
        value: toNum(obj[valueCol]),
        billedValue: toNum(obj[billedCol]),
        salesperson: (obj[salespersonCol] || '').trim(),
      };
    })
    .filter((r) => r.ref);
}

// Reads the real per-rep breakdown Evident already puts in the totals row
// of "MTD Booked Daily Update" / "Daily MTD Total Billed" — both have N/A
// / Delaney, James / Alexander, WIlliam columns (real header, note the
// mixed-case typo) alongside the grand total. Used by Report #2's
// by-sales-rep MTD figures (Ben Silberstein's requirement, 2026-09-19)
// instead of re-deriving them from the row-level company-wide detail, so
// this exactly matches whatever total Evident itself considers each rep's
// MTD share to be. Returns null if any column is missing (report's shape
// changed) rather than silently returning zeros.
// Evident leaves a rep's column out entirely when that rep has nothing for
// the period (real 2026-10-01 MTD Booked Daily Update: no "Delaney, James"
// column because James had $0 booked) — so a missing column is $0 for that
// rep, not a reason to throw away every rep's figure.
function extractRepColumns(headers, totalsRow) {
  const naCol = findCol(headers, 'N/A');
  const jamesCol = findCol(headers, 'Delaney');
  const williamCol = findCol(headers, 'Alexander');
  if (!naCol && !jamesCol && !williamCol) return null;
  const val = (col) => (col ? toNum(totalsRow[col]) : 0);
  return { na: val(naCol), james: val(jamesCol), william: val(williamCol) };
}

// Reads the "Totals" table from a real "EviSmart Daily Sales Report"
// email (user instruction, 2026-09-23 — the sole source for the
// Leadership Report's Daily/MTD/YTD Booked+Billed figures going forward,
// replacing the old company-wide multi-report parsing). This is a wholly
// separate email/sender (media@aimdentallab.com, not
// support@evidentlabs.com — see gmailFetch.js's fetchEviSmartEmails), so
// it's parsed and exported standalone rather than threaded through
// classify()/EXPECTED/parseAndAggregate's existing 11-report machinery.
// Real format confirmed against a real send, 2026-09-23 (see
// test/evidentReport/fixtures/evismart-daily-sales-report.html):
//   Daily Booked | <count> | <$amount>
//   Daily Billed | — | <$amount>          (billed rows have no case count)
//   MTD Booked   | <count> | <$amount>
//   MTD Billed   | — | <$amount>
//   YTD Total Sales (incl. unbilled WIP) | — | <$amount>   (= booked YTD)
//   YTD Billed only (through <date>)     | — | <$amount>
// A real send (2026-09-25) merged the last two rows into one — label
// "YTD Total Sales (2026)", amount cell "$<amount><br><span>(billed-only:
// $<amount>)</span>" — with no separate "YTD Billed only" row at all;
// extractEviSmartTotals below handles both layouts, the merged row's
// primary amount via its own dedicated regex (extractEviSmartRow requires
// a tag-free cell, which the nested <br><span> breaks) and the billed-only
// sub-figure via the existing ytdBilledValue fallback regex, which already
// reached into that same nested span.
// The YTD Billed row's own label carries a dynamic "(through <date>)"
// suffix, so it's matched by prefix, not full text. Each row is matched
// directly by its own regex rather than via the generic parseTable()
// helper — that helper treats the first real row as the header row,
// which doesn't fit this table's real <th>-only header + 6 fixed-label
// data rows. Returns null (not zeros) when the Totals table itself isn't
// found at all — e.g. a real "could not run (not logged in)" failure
// send (seen for real 2026-09-19/20) has no Totals table — so a missing
// real pull is never silently rendered as a fabricated $0 day.
function extractEviSmartRow(html, labelPrefix) {
  // (?:<b>)?...(?:<\/b>)? around the label and value text tolerates the
  // "FINAL SUMMARY" layout (real send, 2026-09-28), which bolds both the
  // label ("<b>MTD Billed (Sep 2026, company total, Report #40)</b>")
  // and the value ("<b>$154,783.41</b>") - the old plain-text assumption
  // (no tags between the cell's own <td> and </td>) broke on both.
  const re = new RegExp(
    `<td[^>]*>\\s*(?:<b>)?\\s*${labelPrefix}[^<]*(?:</b>)?\\s*</td>\\s*` +
    `<td[^>]*>\\s*(?:<b>)?\\s*([^<]*?)\\s*(?:</b>)?\\s*</td>\\s*` +
    `<td[^>]*>\\s*(?:<b>)?\\s*([^<]*?)\\s*(?:</b>)?\\s*</td>`,
    'i'
  );
  const m = html.match(re);
  if (!m) return null;
  const countRaw = m[1].trim();
  return {
    count: countRaw === '' || countRaw === '—' || countRaw === '-' ? null : toNum(countRaw),
    amount: toNum(m[2]),
  };
}

// The "MTD vs Last Month Comparison" table's last-month column (its header
// reads "<Month> (full month)", e.g. "August (full month)"). Returns null
// when the table or either figure is missing so callers show a notice
// instead of comparing against a made-up baseline.
function extractEviSmartLastMonth(html) {
  // Newer layout (from 2026-09-23 evening): last month sits in the Totals
  // table as "Last Month Booked (August 2026)" / "Last Month Billed (...)".
  const rowRe = (label) => new RegExp(`<td[^>]*>\\s*Last Month ${label}\\s*\\(\\s*([A-Za-z]+)\\s+\\d{4}\\s*\\)\\s*</td>\\s*<td[^>]*>[^<]*</td>\\s*<td[^>]*>\\s*(\\$[\\d,]+\\.\\d{2})`, 'i');
  const nb = html.match(rowRe('Booked'));
  const nl = html.match(rowRe('Billed'));
  if (nb && nl) return { monthName: nb[1], booked: toNum(nb[2]), billed: toNum(nl[2]) };

  // Real 2026-09-29 "(corrected)" resend: same figures, but the metric word
  // comes AFTER the parenthetical month instead of before it — "Last month
  // (August 2026) booked" / "Last month (August 2026) billed" — and "month"
  // is lowercase. Without this, the whole row silently failed to match and
  // the Leadership Report's month-over-month comparison showed as
  // unavailable despite the source email actually having the data.
  const rowRe2 = (label) => new RegExp(`<td[^>]*>\\s*Last month\\s*\\(\\s*([A-Za-z]+)\\s+\\d{4}\\s*\\)\\s*${label}\\s*</td>\\s*<td[^>]*>[^<]*</td>\\s*<td[^>]*>\\s*(\\$[\\d,]+\\.\\d{2})`, 'i');
  const nb2 = html.match(rowRe2('booked'));
  const nl2 = html.match(rowRe2('billed'));
  if (nb2 && nl2) return { monthName: nb2[1], booked: toNum(nb2[2]), billed: toNum(nl2[2]) };

  const header = html.match(/MTD vs Last Month Comparison[\s\S]*?<th[^>]*>[^<]*<\/th>\s*<th[^>]*>[^<]*<\/th>\s*<th[^>]*>\s*([A-Za-z]+)\s*\(full month\)/i);
  if (!header) return null;
  const table = html.slice(header.index);
  const cell = (label) => {
    const m = table.match(new RegExp(`<td[^>]*>\\s*${label}\\s*</td>\\s*<td[^>]*>[^<]*</td>\\s*<td[^>]*>\\s*(\\$[\\d,]+\\.\\d{2})`, 'i'));
    return m ? toNum(m[1]) : null;
  };
  const booked = cell('Booked');
  const billed = cell('Billed');
  if (booked == null || billed == null) return null;
  return { monthName: header[1], booked, billed };
}

const decodeEntities = (str) => str.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');

// The "Daily Booked by Customer" table: one row per customer with its case
// count and dollar amount. Returns [] for a real no-bookings day (the email
// says "No cases were booked today.") and null when the section is absent
// entirely, so callers can tell "nothing booked" from "no data".
function extractEviSmartCustomers(html) {
  const start = html.search(/<h[23][^>]*>[^<]*Daily Booked by Customer/i);
  if (start === -1) return null;
  const rest = html.slice(start + 1);
  const next = rest.search(/<h[23]/i);
  const section = next === -1 ? rest : rest.slice(0, next);
  const num = '\\s*([\\d,]+)\\s*';
  const money = '\\s*(\\$[\\d,]+\\.\\d{2})\\s*';
  // Newer layout: Code | Customer | Cases | Value. Older: Customer (code
  // already prefixed) | Cases | Amount. Both end up as "CODE - NAME".
  const fourCol = new RegExp(`<tr>\\s*<td[^>]*>([^<]+)</td>\\s*<td[^>]*>([^<]+)</td>\\s*<td[^>]*>${num}</td>\\s*<td[^>]*>${money}</td>\\s*</tr>`, 'g');
  const threeCol = new RegExp(`<tr>\\s*<td[^>]*>([^<]+)</td>\\s*<td[^>]*>${num}</td>\\s*<td[^>]*>${money}</td>\\s*</tr>`, 'g');
  const rows = [];
  for (const m of section.matchAll(fourCol)) {
    rows.push({ name: `${decodeEntities(m[1].trim())} - ${decodeEntities(m[2].trim())}`, count: toNum(m[3]), value: toNum(m[4]) });
  }
  if (rows.length === 0) {
    for (const m of section.matchAll(threeCol)) {
      rows.push({ name: decodeEntities(m[1].trim()), count: toNum(m[2]), value: toNum(m[3]) });
    }
  }
  // The newer layout's grand-total row ("Total (53 customers)") is not a customer.
  return rows.filter((r) => !/^Total\b/i.test(r.name));
}

const MONTHS = {
  january: '01', february: '02', march: '03', april: '04', may: '05', june: '06',
  july: '07', august: '08', september: '09', october: '10', november: '11', december: '12',
  // Abbreviated forms - a real send (2026-09-28, subject prefixed
  // "FINAL SUMMARY:") used "Sep 28, 2026" instead of a full month name.
  jan: '01', feb: '02', mar: '03', apr: '04', jun: '06', jul: '07',
  aug: '08', sep: '09', oct: '10', nov: '11', dec: '12',
};

// "EviSmart Daily Sales Report - 23 September 2026" -> "2026-09-23"; null for
// subjects with no date (e.g. "could not run (not logged in)"). Also reads
// the "September 25, 2026" (month name first) form — a real send used this
// format on 2026-09-26 where every earlier send had used "25 September
// 2026", and the old day-first-only regex silently failed to match it,
// dropping that day's real EviSmart data from the report.
function eviSmartSubjectDate(subject) {
  const s = String(subject || '');
  const dayFirst = s.match(/(\d{1,2})\s+([A-Za-z]+)\s+(\d{4})/);
  if (dayFirst && MONTHS[dayFirst[2].toLowerCase()]) {
    return `${dayFirst[3]}-${MONTHS[dayFirst[2].toLowerCase()]}-${dayFirst[1].padStart(2, '0')}`;
  }
  const monthFirst = s.match(/([A-Za-z]+)\s+(\d{1,2}),?\s+(\d{4})/);
  if (monthFirst && MONTHS[monthFirst[1].toLowerCase()]) {
    return `${monthFirst[3]}-${MONTHS[monthFirst[1].toLowerCase()]}-${monthFirst[2].padStart(2, '0')}`;
  }
  return null;
}

// Picks the EviSmart email to report from for `runDate`: dated for that day
// (by subject) AND sent after the day ended (6 PM Eastern on runDate or
// later). Early-day pulls exist (a real 8:14 AM 23 Sep send showed $0
// booked) and would understate a full-day report, so they are ignored;
// null means "no usable pull" and the report says so instead of guessing.
// Newest first, first one whose Totals actually parse.
function pickEviSmartMessageForDate(messages, runDate) {
  const etParts = (ms) => {
    const d = new Date(ms).toLocaleString('en-CA', { timeZone: 'America/New_York', hour12: false });
    return { date: d.slice(0, 10), hour: Number(d.slice(12, 14)) };
  };
  const eligible = messages
    .filter((m) => eviSmartSubjectDate(m.subject) === runDate)
    .filter((m) => {
      const t = etParts(m.internalDate);
      return t.date > runDate || (t.date === runDate && t.hour >= 18);
    })
    .sort((a, b) => b.internalDate - a.internalDate);
  for (const m of eligible) {
    const totals = extractEviSmartTotals(m.html);
    if (totals) return { message: m, totals };
  }
  return null;
}

function pickEviSmartForDate(messages, runDate) {
  const hit = pickEviSmartMessageForDate(messages, runDate);
  return hit ? hit.totals : null;
}

// The "MTD by sales rep" table every EviSmart Daily Sales Report carries:
// Billed (#40) and Booked (#12) month to date for each rep and the company,
// the two reports Elizabeth named as the source of truth (2026-10-02). Found
// 2026-10-06: when Evident skipped its own two MTD emails for Oct 5, this
// table still had every figure. Layouts vary by day ("James (Delaney)" or
// "Delaney, James"; a "No rep (N/A)" row on some days), and headers are <th>
// cells, so it is read here rather than with parseTable. Returns null when
// the table isn't there, never zeros.
function extractEviSmartRepMtd(html) {
  const tables = String(html || '').match(/<table[\s\S]*?<\/table>/gi) || [];
  const table = tables.find((t) => /Company total/i.test(t) && /Delaney/i.test(t) && /Alexander/i.test(t));
  if (!table) return null;
  const rows = table.split(/<tr[^>]*>/i).slice(1).map((r) => (r.match(/<(?:td|th)[^>]*>[\s\S]*?<\/(?:td|th)>/gi) || []).map(stripTags));
  const header = rows[0] || [];
  const billedCol = header.findIndex((h) => /billed/i.test(h));
  const bookedCol = header.findIndex((h) => /booked/i.test(h));
  if (billedCol < 1 || bookedCol < 1) return null;
  const pick = (re) => rows.slice(1).find((r) => re.test(r[0] || ''));
  const jamesRow = pick(/delaney|^james/i), williamRow = pick(/alexander|^william/i), naRow = pick(/n\/a|no rep/i), totalRow = pick(/company total/i);
  if (!jamesRow || !williamRow || !totalRow) return null;
  const col = (idx) => {
    const james = toNum(jamesRow[idx]), william = toNum(williamRow[idx]), company = toNum(totalRow[idx]);
    const na = naRow ? toNum(naRow[idx]) : Math.round((company - james - william) * 100) / 100;
    return { james, william, na, company };
  };
  return { billed: col(billedCol), booked: col(bookedCol) };
}

// Fills the two company/by-rep MTD figures from EviSmart's by-rep table ONLY
// when Evident's own email for that figure didn't arrive; an email that did
// arrive always wins. A filled figure is no longer reported as missing.
function applyEviSmartMtdFallback(agg, eviSmart) {
  const rep = eviSmart && eviSmart.repMtd;
  if (!rep) return agg;
  const out = { ...agg, missing: [...agg.missing] };
  const fill = (label, kind, totalKey, byRepKey) => {
    if (!out.missing.includes(label) || !rep[kind]) return;
    out[totalKey] = rep[kind].company;
    out[byRepKey] = { na: rep[kind].na, james: rep[kind].james, william: rep[kind].william };
    out.missing = out.missing.filter((l) => l !== label);
  };
  fill('MTD Booked Daily Update', 'booked', 'companyMtdBooked', 'companyMtdBookedByRep');
  fill('Daily MTD Total Billed', 'billed', 'companyMtdBilled', 'companyMtdBilledByRep');
  return out;
}

// ---- the EviSmart email's own extra tables (last month, new doctors) ----
// 2026-10-09: EviSmart's report now carries "Last month" figures and a "New
// doctors by rep" table (first case in the month, from Customer List). Read
// by table content, not position, so a reordered email still parses. Returns
// null for a part the email does not have (unknown, never zero).
const cellText = (c) => String(c).replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/&nbsp;/g, ' ').replace(/&#39;/g, "'").replace(/\s+/g, ' ').trim();
function emailTables(html) {
  return (String(html || '').match(/<table[\s\S]*?<\/table>/gi) || []).map((t) =>
    (t.match(/<tr[\s\S]*?<\/tr>/gi) || []).map((r) => (r.match(/<t[hd][^>]*>([\s\S]*?)<\/t[hd]>/gi) || []).map(cellText)));
}
const moneyOf = (s) => { const m = String(s || '').match(/\$\s*([\d,]+(?:\.\d+)?)/); return m ? Number(m[1].replace(/,/g, '')) : null; };

function extractEviSmartExtras(html) {
  const tables = emailTables(html);
  let lastMonth = null;
  for (const rows of tables) {
    const booked = rows.find((r) => /^Last month booked \(/i.test(r[0] || ''));
    const billed = rows.find((r) => /^Last month billed/i.test(r[0] || ''));
    if (booked && billed) {
      const name = (booked[0].match(/\(([A-Za-z]+)\s+\d{4}/) || [])[1];
      const count = Number(String(booked[1] || '').replace(/,/g, ''));
      lastMonth = { monthName: name || null, bookedCount: Number.isFinite(count) ? count : null, booked: moneyOf(booked[2]), billed: moneyOf(billed[2]) };
      break;
    }
  }
  // The first table headed Rep | Code | Doctor | First case | Cases is this
  // month; a later one with the same header is the September reference list.
  const docTable = tables.find((rows) => rows[0] && /^Rep$/i.test(rows[0][0]) && /^Code$/i.test(rows[0][1]) && /^Doctor$/i.test(rows[0][2]));
  let newDoctors = null;
  if (docTable) {
    newDoctors = { james: [], william: [] };
    for (const r of docTable.slice(1)) {
      const key = /^James/i.test(r[0]) ? 'james' : /^William/i.test(r[0]) ? 'william' : null;
      if (!key || !r[1] || /^none/i.test(r[2] || '')) continue;
      newDoctors[key].push({ code: r[1], name: r[2], firstCase: r[3] || null, cases: Number(r[4]) || 0 });
    }
  }
  return { lastMonth, newDoctors };
}

function extractEviSmartTotals(html) {
  const dailyBooked = extractEviSmartRow(html, 'Daily Booked');
  const dailyBilled = extractEviSmartRow(html, 'Daily Billed');
  const mtdBooked = extractEviSmartRow(html, 'MTD Booked');
  const mtdBilled = extractEviSmartRow(html, 'MTD Billed');
  // Matched by a dedicated regex, not extractEviSmartRow, because a real
  // send (2026-09-25) embeds a nested <br><span>(billed-only: $X)</span>
  // inside this row's amount cell — extractEviSmartRow requires a tag-free
  // cell and silently returned null for the whole row, which made
  // ytdTotalSalesValue fall back to 0 and the Leadership Report's YTD
  // figure sit at a flat, never-updating $1,243,759 (the legacy adjustment
  // alone — see buildReport.js's companyYtdSalesValueTotal). This regex
  // captures just the leading $amount and stops naturally at the first
  // '<', so it reads both the old plain-cell layout and this new one.
  const ytdTotalSalesMatch = html.match(/YTD Total Sales[^<]*<\/td>\s*<td[^>]*>[^<]*<\/td>\s*<td[^>]*>\s*(\$[\d,]+\.\d{2})/i);
  const ytdBilled = extractEviSmartRow(html, 'YTD Billed only');

  if (!dailyBooked && !mtdBooked && !ytdTotalSalesMatch) return null;

  return {
    dailyBookedCount: dailyBooked ? dailyBooked.count : null,
    dailyBookedValue: dailyBooked ? dailyBooked.amount : 0,
    dailyBilledValue: dailyBilled ? dailyBilled.amount : 0,
    mtdBookedCount: mtdBooked ? mtdBooked.count : null,
    mtdBookedValue: mtdBooked ? mtdBooked.amount : 0,
    mtdBilledValue: mtdBilled ? mtdBilled.amount : 0,
    ytdTotalSalesValue: ytdTotalSalesMatch ? toNum(ytdTotalSalesMatch[1]) : 0,
    // Three real layouts seen for the billed-only YTD figure: a dedicated
    // "YTD Billed only" row (ytdBilled above), a "(billed-only: $X)" phrase
    // inside the YTD Total Sales cell, or — the real 2026-09-29 "(corrected)"
    // resend — a bare "$main ($billed-only)" bracket with no label text at
    // all right after the main YTD dollar amount. Checked in that order;
    // without the third pattern this silently fell back to 0 (a real,
    // never-updating billed-only YTD figure on that send).
    ytdBilledValue: ytdBilled
      ? ytdBilled.amount
      : toNum(
          (html.match(/YTD Total Sales[\s\S]{0,300}?billed-only:\s*(\$[\d,]+\.\d{2})/i) || [])[1]
          || (html.match(/YTD Total Sales[^<]*<\/td>\s*<td[^>]*>[^<]*<\/td>\s*<td[^>]*>\s*\$[\d,]+\.\d{2}\s*\(\s*(\$[\d,]+\.\d{2})\s*\)/i) || [])[1]
          || '0'
        ),
    lastMonth: extractEviSmartLastMonth(html),
    repMtd: extractEviSmartRepMtd(html),
    dailyCustomers: extractEviSmartCustomers(html),
    cumulativeAsOf: (html.match(/\(\s*(?:MTD )?through (\d{1,2} [A-Za-z]{3})/) || [])[1] || null,
  };
}

// Overlays company-wide MTD Booked/Billed from the two dedicated Evident
// emails ("MTD Booked Daily Update" / "Daily MTD Total Billed", parsed
// into agg.companyMtdBooked/companyMtdBilled above) onto the EviSmart
// Daily Sales Report totals — Elizabeth reported the Leadership Report's
// MTD figures as wrong (2026-09-29); the report reads EviSmart for
// everything per the 2026-09-23 "one source" instruction, but EviSmart's
// own MTD Booked/Billed already differs from these two dedicated MTD
// emails on a real day (25 Sep: Billed $153,193.25 in the email vs.
// $151,750.25 from EviSmart), so the two dedicated reports are the more
// direct source for just those two figures. Everything else on `es`
// (case counts, YTD, last month, daily) is untouched — the emails don't
// carry those. Falls back to EviSmart's own figure per-metric when that
// day's email didn't arrive (agg.missing), rather than silently zeroing
// it, since agg.companyMtdBooked/Billed default to 0 when their EXPECTED
// entry is missing. Returns null unchanged when EviSmart itself has no
// usable pull that day (nothing to overlay onto).
// Elizabeth, 2026-10-02: use only Reports #12 (booked), #40 (billed) and
// #41 (booked cross-check) — not EviSmart's #92 (MTD booked), #97 (daily
// booked) or #94 (YTD). So booked figures come from Evident's own emails
// that match #12, billed MTD from the email matching #40, and YTD from
// "YTD Billed Cases" (sales = billed). EviSmart still supplies Daily Billed
// (Financials > Customer Activity, which she named as a reliable source).
// A missing Evident email shows "N/A", never an EviSmart #92/#97/#94 value.
function applyEmailMtdTotals(eviSmart, agg) {
  const has = (label) => !agg.missing.includes(label);
  // EviSmart now supplies ONLY Daily Billed. When its pull didn't come
  // through, every other figure still comes from the Evident emails, so the
  // report is built anyway with Daily Billed unavailable (found 2026-10-05:
  // an absent EviSmart email blanked the whole company section).
  return {
    ...(eviSmart || { dailyBilledValue: null, mtdBilledValue: null, dailyBilledMissing: true }),
    dailyBookedValue: has('Daily Booking Report - Nadine') ? agg.companyDailyBooked : null,
    dailyBookedCount: has('Daily Booking Report - Nadine') ? agg.companyDailyBookedCount : null,
    mtdBookedValue: has('MTD Booked Daily Update') ? agg.companyMtdBooked : null,
    mtdBookedCount: null,
    mtdBilledValue: has('Daily MTD Total Billed') ? agg.companyMtdBilled : eviSmart.mtdBilledValue,
    ytdTotalSalesValue: agg.companyYtdBilled,
  };
}

const EXPECTED = [
  { type: 'dailyBooked', rep: 'james', label: "Daily Booked Cases - James' Doctors" },
  { type: 'dailyBooked', rep: 'william', label: "Daily Booked Cases - William's Doctors" },
  { type: 'mtdBooked', rep: 'james', label: "MTD Booked Cases - James' Doctors" },
  { type: 'mtdBooked', rep: 'william', label: "MTD Booked Cases - William's Doctors" },
  { type: 'ytdBooked', rep: 'james', label: "YTD Booked Cases - James' Doctors" },
  { type: 'ytdBooked', rep: 'william', label: "YTD Booked Cases - William's Doctors" },
  { type: 'wip', rep: null, label: 'Cases Currently In Progress' },
  { type: 'companyDailyBooked', rep: null, label: 'Daily Booking Report - Nadine' },
  { type: 'companyDailyBilled', rep: null, label: 'Daily Billed Report - Nadine' },
  { type: 'companyMtdBilled', rep: null, label: 'Daily MTD Total Billed' },
  { type: 'companyMtdBooked', rep: null, label: 'MTD Booked Daily Update' },
];

/**
 * @param {{subject: string, html: string}[]} messages
 * @returns aggregate object with combined + per-rep + per-brand figures
 */
function parseAndAggregate(messages, { runDate } = {}) {
  const found = {
    dailyBooked: {}, mtdBooked: {}, ytdBooked: {}, wip: null,
    companyDailyBooked: null, companyDailyBilled: null, companyMtdBilled: null, companyMtdBooked: null,
    companyYtdBilled: null, companyYtdBilledByRep: null,
  };

  for (const msg of messages) {
    const cls = classify(msg.subject || '');
    if (cls.type === 'other') continue;

    const table = parseTable(msg.html || '');

    if (cls.type === 'wip') {
      if (!table || table.rows.length === 0) {
        found.wip = { cases: 0, value: 0, kh: { cases: 0, value: 0 }, aim: { cases: 0, value: 0 }, byRep: {} };
        continue;
      }
      const { headers, rows } = table;
      const totalsRow = rowToObj(headers, rows[rows.length - 1]);
      const casesCol = findCol(headers, 'Cases (in Lab)') || findCol(headers, 'Cases');
      const wipCol = findCol(headers, 'Total WIP');
      const jamesCol = headers.find((h) => /delaney/i.test(h) || /james/i.test(h));
      const williamCol = headers.find((h) => /alexander/i.test(h) || /william/i.test(h));

      const totalCases = toNum(totalsRow[casesCol]);
      const totalWip = toNum(totalsRow[wipCol]);

      // KH's row is identified by "KINGS" in the Company/Ref cell rather than
      // by position, since Evident may reorder or add rows.
      const khRow = rows.find((r) => r.some((c) => /^kings$/i.test(c.trim())));
      const khObj = khRow ? rowToObj(headers, khRow) : null;
      const khCases = khObj ? toNum(khObj[casesCol]) : 0;
      const khWip = khObj ? toNum(khObj[wipCol]) : 0;

      found.wip = {
        cases: totalCases,
        value: totalWip,
        kh: { cases: khCases, value: khWip },
        aim: { cases: totalCases - khCases, value: totalWip - khWip },
        byRep: {
          james: jamesCol ? toNum(totalsRow[jamesCol]) : 0,
          william: williamCol ? toNum(totalsRow[williamCol]) : 0,
        },
      };
      continue;
    }

    if (cls.type === 'companyDailyBooked') {
      if (!table || table.rows.length === 0) { found.companyDailyBooked = 0; found.companyDailyBookedCount = 0; found.companyDailyBookedRows = []; continue; }
      const { headers, rows } = table;
      const totalsRow = rowToObj(headers, rows[rows.length - 1]);
      const totalCol = findCol(headers, 'Sales Value (Total)');
      found.companyDailyBooked = toNum(totalsRow[totalCol]);
      found.companyDailyBookedCount = rows.length - 1;
      // Per-case customer detail for the Leadership Report's Daily Booked
      // section (Ben Silberstein's requirement, 2026-09-18) — same rows
      // extractBookingRows gives evidentCrmSync.js, re-parsed here rather
      // than shared since this file's convention is small self-contained
      // extractors, not threading a parsed table through multiple callers.
      found.companyDailyBookedRows = extractBookingRows(msg.html || '');
      continue;
    }

    if (cls.type === 'companyDailyBilled') {
      if (!table || table.rows.length === 0) { found.companyDailyBilled = 0; found.companyDailyBilledRows = []; continue; }
      const { headers, rows } = table;
      const totalsRow = rowToObj(headers, rows[rows.length - 1]);
      const billedCol = findCol(headers, 'Total Billed');
      found.companyDailyBilled = toNum(totalsRow[billedCol]);
      // Per-case detail for Report #2's by-rep breakdown (Ben Silberstein's
      // requirement, 2026-09-19) — same reasoning as companyDailyBookedRows
      // above.
      found.companyDailyBilledRows = extractBilledRows(msg.html || '');
      continue;
    }

    if (cls.type === 'companyMtdBilled') {
      if (!table || table.rows.length === 0) { found.companyMtdBilled = 0; found.companyMtdBilledByRep = null; continue; }
      const { headers, rows } = table;
      const totalsRow = rowToObj(headers, rows[rows.length - 1]);
      const billedCol = findCol(headers, 'Total Billed');
      found.companyMtdBilled = toNum(totalsRow[billedCol]);
      found.companyMtdBilledByRep = extractRepColumns(headers, totalsRow);
      continue;
    }

    // Company-wide (Aim + Kings Highway) MTD Booked total — same shape as
    // companyMtdBilled above (grand total in the last row, under "Sales
    // Value (Total)"). New as of 2026-09-16; before this, no automated
    // report gave a true company-wide MTD Booked figure at all, so
    // buildReport.js fell back to self-accumulating from daily totals.
    // Company YTD billed (invoice date Jan 1 to date) — the YTD Total Sales
    // figure since "sales = billed" (Elizabeth/user, 2026-10-02), replacing
    // EviSmart's Report #94 row. Not in EXPECTED: its absence just shows
    // "N/A" for YTD rather than gating the day's log write.
    if (cls.type === 'companyYtdBilled') {
      if (!table || table.rows.length === 0) continue;
      const { headers, rows } = table;
      const totalsRow = rowToObj(headers, rows[rows.length - 1]);
      found.companyYtdBilled = toNum(totalsRow[findCol(headers, 'Sales Value (Total Billed)')]);
      found.companyYtdBilledByRep = extractRepColumns(headers, totalsRow);
      continue;
    }

    if (cls.type === 'companyMtdBooked') {
      if (!table || table.rows.length === 0) { found.companyMtdBooked = 0; found.companyMtdBookedByRep = null; continue; }
      const { headers, rows } = table;
      const totalsRow = rowToObj(headers, rows[rows.length - 1]);
      const totalCol = findCol(headers, 'Sales Value (Total)');
      found.companyMtdBooked = toNum(totalsRow[totalCol]);
      found.companyMtdBookedByRep = extractRepColumns(headers, totalsRow);
      // Deliberately NOT deriving a case count from this table's row
      // count — each row here is one CUSTOMER's month-to-date total, not
      // one case (verified against the real email: ~150 rows for ~17
      // days of MTD activity, far fewer than the real daily case volume
      // would produce). The real case count is self-accumulated in
      // buildReport.js from each day's companyDailyBookedCount instead.
      continue;
    }

    if (cls.type === 'ytdBooked') {
      found.ytdBooked[cls.rep] = extractCaseTotals(msg.html || '');
      continue;
    }

    // dailyBooked / mtdBooked.
    found[cls.type][cls.rep] = extractCaseTotals(msg.html || '');
  }

  const zero = { count: 0, billed: 0, wip: 0, value: 0, hasData: false };
  const dj = found.dailyBooked.james || zero;
  const dw = found.dailyBooked.william || zero;
  const mj = found.mtdBooked.james || zero;
  const mw = found.mtdBooked.william || zero;
  const yj = found.ytdBooked.james || zero;
  const yw = found.ytdBooked.william || zero;
  const wip = found.wip || {
    cases: 0,
    value: 0,
    kh: { cases: 0, value: 0 },
    aim: { cases: 0, value: 0 },
    byRep: {},
  };

  const missing = EXPECTED.filter((e) => {
    if (e.type === 'wip') return !found.wip;
    if (e.type === 'companyDailyBooked') return found.companyDailyBooked === null;
    if (e.type === 'companyDailyBilled') return found.companyDailyBilled === null;
    if (e.type === 'companyMtdBilled') return found.companyMtdBilled === null;
    if (e.type === 'companyMtdBooked') return found.companyMtdBooked === null;
    return !found[e.type][e.rep];
  }).map((e) => e.label);

  return {
    runDate: runDate || new Date().toISOString().slice(0, 10),
    expectedCount: EXPECTED.length,
    booked: {
      daily: {
        count: dj.count + dw.count,
        billed: dj.billed + dw.billed,
        value: dj.value + dw.value,
        byRep: { james: dj, william: dw },
      },
      mtd: {
        count: mj.count + mw.count,
        billed: mj.billed + mw.billed,
        wip: mj.wip + mw.wip,
        value: mj.value + mw.value,
        byRep: { james: mj, william: mw },
      },
      ytd: {
        count: yj.count + yw.count,
        billed: yj.billed + yw.billed,
        wip: yj.wip + yw.wip,
        value: yj.value + yw.value,
        byRep: { james: yj, william: yw },
      },
    },
    wip,
    companyDailyBooked: found.companyDailyBooked || 0,
    companyDailyBookedCount: found.companyDailyBookedCount || 0,
    companyDailyBookedRows: found.companyDailyBookedRows || [],
    companyDailyBilled: found.companyDailyBilled || 0,
    companyDailyBilledRows: found.companyDailyBilledRows || [],
    companyMtdBilled: found.companyMtdBilled || 0,
    companyMtdBilledByRep: found.companyMtdBilledByRep || null,
    companyMtdBooked: found.companyMtdBooked || 0,
    companyMtdBookedByRep: found.companyMtdBookedByRep || null,
    companyYtdBilled: found.companyYtdBilled,
    companyYtdBilledByRep: found.companyYtdBilledByRep,
    missing,
  };
}

module.exports = { extractEviSmartExtras, pickEviSmartMessageForDate, parseAndAggregate, parseTable, classify, toNum, findCol, rowToObj, extractDailyBookedCustomerNames, extractCaseTotals, extractBookingRows, extractBilledRows, extractRepColumns, extractEviSmartTotals, extractEviSmartRepMtd, applyEviSmartMtdFallback, eviSmartSubjectDate, pickEviSmartForDate, repKeyFromSalesperson, applyEmailMtdTotals };
