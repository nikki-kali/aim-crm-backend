// Parses Evident Labs' nightly report emails and aggregates them into one
// combined figure set. Evident's HTML is old-school (unclosed <TR>/<TD>),
// so this uses tolerant regex splitting rather than a strict HTML parser -
// that's deliberate, not an oversight.

function stripTags(s) {
  return s.replace(/<[^>]*>/g, '').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').trim();
}

function toNum(s) {
  if (s === undefined || s === null) return 0;
  const cleaned = String(s).replace(/,/g, '').trim();
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
      if (!table || table.rows.length === 0) { found.companyDailyBilled = 0; continue; }
      const { headers, rows } = table;
      const totalsRow = rowToObj(headers, rows[rows.length - 1]);
      const billedCol = findCol(headers, 'Total Billed');
      found.companyDailyBilled = toNum(totalsRow[billedCol]);
      continue;
    }

    if (cls.type === 'companyMtdBilled') {
      if (!table || table.rows.length === 0) { found.companyMtdBilled = 0; continue; }
      const { headers, rows } = table;
      const totalsRow = rowToObj(headers, rows[rows.length - 1]);
      const billedCol = findCol(headers, 'Total Billed');
      found.companyMtdBilled = toNum(totalsRow[billedCol]);
      continue;
    }

    // Company-wide (Aim + Kings Highway) MTD Booked total — same shape as
    // companyMtdBilled above (grand total in the last row, under "Sales
    // Value (Total)"). New as of 2026-09-16; before this, no automated
    // report gave a true company-wide MTD Booked figure at all, so
    // buildReport.js fell back to self-accumulating from daily totals.
    if (cls.type === 'companyMtdBooked') {
      if (!table || table.rows.length === 0) { found.companyMtdBooked = 0; continue; }
      const { headers, rows } = table;
      const totalsRow = rowToObj(headers, rows[rows.length - 1]);
      const totalCol = findCol(headers, 'Sales Value (Total)');
      found.companyMtdBooked = toNum(totalsRow[totalCol]);
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
    companyMtdBilled: found.companyMtdBilled || 0,
    companyMtdBooked: found.companyMtdBooked || 0,
    missing,
  };
}

module.exports = { parseAndAggregate, parseTable, classify, toNum, findCol, rowToObj, extractDailyBookedCustomerNames, extractCaseTotals, extractBookingRows, extractBilledRows };
