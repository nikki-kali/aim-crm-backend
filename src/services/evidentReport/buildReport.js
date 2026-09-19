// Builds the consolidated HTML email from the aggregate figures, computing
// day-over-day deltas against the logged history rows. Visual language
// matches the CRM's other branded emails (weeklyRepReport.js /
// salesRepDailyReport.js's templates in ../email.js) — same fonts, colors,
// card treatment — kept as local constants rather than importing from
// ../email.js, matching this codebase's existing convention of duplicating
// brand hex/font values per template file (see CLAUDE.md's note on this).

const { buildMonthTrendChartUrl } = require('./chart');
const { LEGACY_YTD_REVENUE_ADJUSTMENT } = require('../clientRevenue');

const BRAND = {
  ink: '#10353f',
  slate: '#5b7a86',
  teal: '#06babe',
  deep: '#207290',
  tealMist: '#e6f9f9',
  blueMist: '#eaf3f7',
  skyBlue: '#a9cfe3',
  gold: '#d9a441',
  success: '#059669',
  danger: '#b91c1c',
  // Glassmorphism approximation (user request, 2026-09-19) — real
  // backdrop-filter blur isn't reliable across email clients (Outlook and
  // several mobile mail apps strip it), so the "glass" reads through
  // layered translucency, a soft white edge highlight, and a colored
  // shadow instead of actual blur. Confirmed this renders consistently by
  // checking a real render, not assumed.
  glassBg: 'rgba(255,255,255,.55)',
  glassBorder: 'rgba(255,255,255,.75)',
  glassShadow: '0 8px 24px rgba(32,114,144,.12)',
};
const FONT_DISPLAY = "'Cormorant Garamond',Georgia,'Times New Roman',serif";
const FONT_BODY = "'DM Sans',-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif";
const FONT_DATA = "'DM Mono',ui-monospace,SFMono-Regular,Menlo,monospace";
const HAIRLINE = '#dcebe9';

// A verified BASELINE, not a frozen number — Evident's automated daily
// emails only ever send YTD Booked/Billed Cases per rep (James/William),
// confirmed by searching 90 days of the real inbox on 2026-09-16: zero
// company-wide "- Nadine" YTD sends found, unlike Daily Booking/Billed/MTD
// figures, which already arrive as company-wide "- Nadine" reports daily.
// These two figures came from Elizabeth's own manual export of Evident's
// "YTD Booked Cases - Nadine" / "YTD Billed Cases - Nadine" dashboard
// views and were verified against each report's own totals row
// (363360.57 = 354353.54 + 4499.79 + 4507.24; 311452.46 = 302654.92 +
// 4382.79 + 4414.75 — the N/A + per-rep split summing to the stated total
// in both PDFs), as of asOfDate. From asOfDate forward, buildEmail() below
// auto-accrues every real logged company-wide daily booked/billed figure
// on top of this baseline — so the YTD tiles stay live without ever
// re-deriving a number Evident doesn't provide. Update the baseline by
// hand only if a fresher verified export arrives (e.g. to correct drift);
// once Evident sends a real company-wide YTD report daily (request
// pending, following the same precedent as the new MTD Booked Daily
// Update report), replace this block with real parsing entirely.
// billed adds LEGACY_YTD_REVENUE_ADJUSTMENT (see clientRevenue.js) on top of
// Evident's own verified 311452.46 YTD Billed figure above — that $1,243,759
// is real YTD Billed revenue from AIM/Kings Highway's previous system
// (before this CRM/Evident tracking existed), confirmed directly by the
// user, kept as a separate addend rather than folded into one baseline
// number so it stays auditable back to its own source.
const COMPANY_YTD_SNAPSHOT = {
  asOfDate: '2026-09-16',
  asOfLabel: 'Sep 16, 2026',
  booked: 363360.57,
  billed: 311452.46 + LEGACY_YTD_REVENUE_ADJUSTMENT,
};

// One-time verified monthly baselines for the trend chart and the "Pace
// vs. Last Month" card — real June-August 2026 totals, user-supplied
// 2026-09-19 from Evident's own EviSmart export (booked) and the custom
// billing reports pulled the same day (billed). Booked/billed use the
// "custom report" basis throughout, not the "financial ledger" basis
// (the user's own figures showed these differ slightly, e.g.
// $334,230.11 vs. $332,634.11 YTD as of 2026-09-18) — per the user's
// explicit instruction to use one basis consistently, every figure in
// this file (COMPANY_YTD_SNAPSHOT included) is the custom-report basis.
// Same genuinely-temporary-exception status as the single-month baseline
// this replaces: once this pipeline's own real daily logging (started
// 2026-09-15) covers a complete month, that month can be read from real
// logged history instead of hardcoded here — starting with October 2026.
// Update this array by hand only to extend it with another pre-tracking
// month, never to alter an already-verified month's figures.
const MONTH_HISTORY = [
  { label: 'Jun 2026', booked: 12059.06, billed: 0 },
  { label: 'Jul 2026', booked: 99668.90, billed: 66311.90 },
  { label: 'Aug 2026', booked: 157654.32, billed: 147772.40 },
];

// Real customer/clinic names from Evident's own data — never a hardcoded
// constant, so this is the first place in this file that needs escaping
// before interpolation (see reportApproval.js's escapeHtml for the
// original real XSS this exact pattern caused elsewhere in this codebase).
function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function fmtMoney(n) {
  return '$' + Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function delta(curr, prev) {
  if (prev === undefined || prev === null) return { text: 'no prior data', cls: '' };
  const diff = curr - prev;
  if (Math.abs(diff) < 0.005) return { text: 'flat vs. yesterday', cls: 'flat' };
  const arrow = diff > 0 ? '▲' : '▼'; // ▲ / ▼
  const cls = diff > 0 ? 'up' : 'down';
  return { text: `${arrow} ${fmtMoney(Math.abs(diff))} vs. yesterday`, cls };
}

// `overrides` (optional) lets a specific day's run substitute the live
// Evident-parsed Booked/Billed (MTD) figures with numbers manually pulled
// from Evident's own dashboard — needed because the automated nightly
// batch reflects a fixed overnight cutoff, so same-day billing entered
// later in the business day doesn't show up until the FOLLOWING night's
// batch (seen 2026-09-17: automated Daily MTD Total Billed showed
// $89,442.46 while a same-day 5:40pm dashboard pull already showed
// $100,941.55 — not a parsing bug, just a same-day timing lag). Only
// affects what's DISPLAYED today; sheetRow below always persists the raw
// automated figures, so tomorrow's day-over-day delta keeps comparing
// like-sourced numbers rather than an override against an un-overridden
// baseline.
function buildEmail(agg, historyRows = [], overrides = {}, repGoals = []) {
  const prior = historyRows
    .filter((r) => r.date && r.date < agg.runDate)
    .sort((a, b) => (a.date < b.date ? 1 : -1))[0];

  // Booked (MTD) prefers Evident's own company-wide "MTD Booked Daily
  // Update" report (new as of 2026-09-16) when it arrived today. Before
  // that report existed, there was no company-wide equivalent at all, so
  // this falls back to self-accumulating from each day's own company-wide
  // "Booked (Today)" figure, logged daily — summing every history row in
  // the same calendar month as today, plus today's own value (not yet in
  // historyRows at build time — appendRow() runs after this). Kept as a
  // fallback rather than deleted, since the new report's daily arrival
  // isn't proven yet — if it stops showing up on some future day, the
  // report should self-heal to the old approximation, not a hard $0.
  const runMonth = agg.runDate.slice(0, 7); // 'YYYY-MM'
  const mtdBookedFromHistory = historyRows
    .filter((r) => r.date && r.date.slice(0, 7) === runMonth)
    .reduce((sum, r) => sum + Number(r.company_daily_booked_value || 0), 0);
  const selfAccumulatedMtdBooked = mtdBookedFromHistory + agg.companyDailyBooked;
  const companyMtdBookedLive = agg.missing.includes('MTD Booked Daily Update') ? null : agg.companyMtdBooked;
  const companyMtdBooked = overrides.companyMtdBooked != null
    ? overrides.companyMtdBooked
    : (companyMtdBookedLive != null ? companyMtdBookedLive : selfAccumulatedMtdBooked);

  // MTD Booked CASE COUNT (Ben Silberstein's requirement, 2026-09-18) — no
  // company-wide report from Evident gives this directly ("MTD Booked
  // Daily Update" is one row per customer, not per case, see
  // parseEvident.js), so it's always self-accumulated from each day's real
  // companyDailyBookedCount, same technique as the pre-9/16 Booked (MTD)
  // value fallback above. Rows logged before v24's migration have a NULL
  // company_daily_booked_count (column didn't exist yet), contributing
  // nothing — the count under-states true MTD volume for the first few
  // days after this ships, then self-heals as real days accumulate,
  // exactly like every other self-accumulated figure in this file.
  const mtdBookedCountFromHistory = historyRows
    .filter((r) => r.date && r.date.slice(0, 7) === runMonth)
    .reduce((sum, r) => sum + Number(r.company_daily_booked_count || 0), 0);
  const companyMtdBookedCount = mtdBookedCountFromHistory + agg.companyDailyBookedCount;

  // Billed (MTD) now reads Evident's own company-wide "Daily MTD Total
  // Billed" figure instead of the James+William-only sum. A `prior` row
  // whose company_daily_booked_value is NULL predates this change (the
  // column is nullable with no default specifically so this check works —
  // see the migration's own comment) — its booked_mtd_billed value is
  // from the OLD, much-smaller data source, so comparing against it would
  // render a fabricated multi-thousand-dollar "spike" on the very first
  // day this ships. Same guard pattern already proven for ytd_billed_value.
  // Also suppressed when today's own "Daily MTD Total Billed" report never
  // arrived — agg.companyMtdBilled would be a placeholder 0 in that case
  // (see the missing-reports banner below), and computing a delta against
  // it would render a confident, false "▼ $89,xxx.xx" rather than an
  // honest absence of data. Suppressed too when a manual override is in
  // play — the delta baseline (yesterday's automated figure) isn't
  // comparable to today's manually-corrected one.
  const companyMtdBilled = overrides.companyMtdBilled != null ? overrides.companyMtdBilled : agg.companyMtdBilled;
  const billedMtdDelta = overrides.companyMtdBilled == null && prior && prior.company_daily_booked_value != null && !agg.missing.includes('Daily MTD Total Billed')
    ? delta(agg.companyMtdBilled, Number(prior.booked_mtd_billed))
    : { text: '', cls: '' };
  const overrideNote = overrides.asOfLabel ? { text: `Verified via Evident dashboard, ${overrides.asOfLabel}` } : { text: '' };

  // Booked/Billed (YTD) auto-accrue on top of the verified
  // COMPANY_YTD_SNAPSHOT baseline: every real company-wide daily
  // booked/billed figure logged for a date AFTER the baseline's asOfDate
  // gets added on. This is the same self-accumulation technique already
  // proven for the old Booked (MTD) fallback above, just anchored to a
  // real verified starting point instead of $0 — the only way to keep a
  // live-feeling YTD figure honest when Evident provides no company-wide
  // YTD report at all. A history row's company_daily_booked_value or
  // company_daily_billed_value being NULL means that row predates this
  // tracking (or predates the billed column specifically) and
  // contributes nothing — same nullable-no-default guard pattern as
  // everywhere else in this file, never a fabricated number in the gap.
  // Today's own agg figures aren't yet in historyRows at build time
  // (appendRow() runs after this), so they're added in separately, and
  // only once agg.runDate is actually after the baseline date — otherwise
  // today's activity is already folded into the baseline itself and
  // adding it again would double-count.
  // companyYtdBooked (COMPANY_YTD_SNAPSHOT.booked + accrual) is deliberately
  // NOT derived/rendered here — Ben Silberstein's Report 1 spec
  // (2026-09-19) asks for a single "YTD - Total sales" figure only,
  // confirmed to mean billed. COMPANY_YTD_SNAPSHOT.booked itself is left
  // in place above, verified real data kept for provenance in case Booked
  // YTD needs to come back.
  const ytdBilledAccrued = historyRows
    .filter((r) => r.date && r.date > COMPANY_YTD_SNAPSHOT.asOfDate)
    .reduce((sum, r) => sum + Number(r.company_daily_billed_value || 0), 0)
    + (agg.runDate > COMPANY_YTD_SNAPSHOT.asOfDate ? agg.companyDailyBilled : 0);
  const companyYtdBilled = COMPANY_YTD_SNAPSHOT.billed + ytdBilledAccrued;
  const ytdNote = { text: `Baseline verified ${COMPANY_YTD_SNAPSHOT.asOfLabel} + daily activity since` };

  const dateLabel = new Date(`${agg.runDate}T00:00:00Z`).toLocaleDateString('en-US', {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    year: 'numeric',
  });

  // Month-by-month Booked/Billed trend (user request, 2026-09-19,
  // superseding the two-point Last Month vs. This Month chart) — the
  // verified MONTH_HISTORY baselines (Jun-Aug) plus the current live MTD
  // month, using the same final companyMtdBooked/companyMtdBilled values
  // the MTD cards above show (real, Evident-sourced MTD-to-date figures,
  // see the comments above on how those two are resolved).
  const thisMonthLabel = new Date(`${agg.runDate}T00:00:00Z`).toLocaleDateString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' });
  const lastMonth = MONTH_HISTORY[MONTH_HISTORY.length - 1];
  const trendMonths = [
    ...MONTH_HISTORY,
    { label: `${thisMonthLabel} (MTD)`, booked: companyMtdBooked, billed: companyMtdBilled },
  ];
  const monthChartUrl = buildMonthTrendChartUrl(trendMonths);

  const deltaColor = (cls) => (cls === 'up' ? BRAND.success : cls === 'down' ? BRAND.danger : BRAND.slate);

  const sectionLabel = (text) => `<p style="margin:0 0 14px;font-family:${FONT_DATA};font-size:10px;font-weight:500;letter-spacing:.09em;text-transform:uppercase;color:${BRAND.slate}">${text}</p>`;

  // Each figure gets its own bordered card — two figures sharing one card
  // reads as one combined number at a glance, which is exactly the
  // confusion this replaces. "Today" cards get the more prominent
  // teal-tinted treatment (the headline news); "This Month & Year" cards
  // are deliberately quieter (neutral background, smaller type) so the
  // hierarchy reads today > month/year without saying so explicitly.
  // Figure colors are `deep` (#207290), not the brighter `teal`
  // (#06babe) — teal-on-tealMist measured under 3:1 contrast, hard to
  // read; `deep` clears WCAG AA on every light background used here.
  const todayCard = (label, value, sub) => `
    <div style="background:${BRAND.glassBg};border:1px solid ${BRAND.glassBorder};border-radius:16px;padding:20px 20px;box-shadow:${BRAND.glassShadow}">
      <p style="margin:0 0 6px;font-family:${FONT_DATA};font-size:10px;font-weight:500;letter-spacing:.08em;text-transform:uppercase;color:${BRAND.deep}">${label}</p>
      <p style="margin:0;font-family:${FONT_DATA};font-size:28px;font-weight:500;color:${BRAND.deep};letter-spacing:-.01em">${value}</p>
      ${sub ? `<p style="margin:6px 0 0;font-size:12px;color:${BRAND.slate}">${sub}</p>` : ''}
    </div>`;

  // `lines` is an array of { text, cls? } sub-lines rendered below the
  // value, e.g. a real day-over-day delta AND a fixed scope footnote
  // together (Billed (YTD) needs both) — kept as one card, not a
  // duplicate caption elsewhere, per the "one figure, one card" rule.
  const statCard = (label, value, lines = []) => `
    <div style="background:${BRAND.glassBg};border:1px solid ${BRAND.glassBorder};border-radius:14px;padding:16px 14px;box-shadow:${BRAND.glassShadow}">
      <p style="margin:0 0 6px;font-family:${FONT_DATA};font-size:9px;font-weight:500;letter-spacing:.07em;text-transform:uppercase;color:${BRAND.slate}">${label}</p>
      <p style="margin:0;font-family:${FONT_DATA};font-size:19px;font-weight:500;color:${BRAND.ink}">${value}</p>
      ${lines.filter((l) => l && l.text).map((l) => `<p style="margin:5px 0 0;font-family:${FONT_DATA};font-size:10px;color:${l.cls ? deltaColor(l.cls) : BRAND.slate}">${l.text}</p>`).join('')}
    </div>`;

  // Compact variant for repeated/secondary data (By Sales Rep's 8 small
  // numbers don't need the same visual weight as the 4-5 headline figures
  // elsewhere) — roughly half the padding and a smaller value size, which
  // is most of where this email's overall length came from.
  const miniStatCard = (label, value, sub) => `
    <div style="background:${BRAND.glassBg};border:1px solid ${BRAND.glassBorder};border-radius:10px;padding:9px 10px;box-shadow:${BRAND.glassShadow}">
      <p style="margin:0 0 3px;font-family:${FONT_DATA};font-size:8px;font-weight:500;letter-spacing:.06em;text-transform:uppercase;color:${BRAND.slate}">${label}</p>
      <p style="margin:0;font-family:${FONT_DATA};font-size:14px;font-weight:500;color:${BRAND.ink}">${value}${sub ? ` <span style="font-size:10px;font-weight:400;color:${BRAND.slate}">${sub}</span>` : ''}</p>
    </div>`;

  // Three-column row of separate cards with real gutters between them
  // (not just padding inside a shared cell) — a plain <table> can't put
  // margin between adjacent <td>s, so the gap is its own empty spacer
  // column, same trick used for the two-column "Today" row below.
  // table-layout:fixed is load-bearing on mobile — without it, auto
  // layout sizes each <td> by its card's own content/padding rather than
  // the specified percentage, and a 2-card row can render wider than the
  // viewport (the second card cut off at the screen edge, confirmed via a
  // real 390px-wide render before this fix).
  const cardRow = (cards) => {
    const width = (100 / cards.length - 2).toFixed(2);
    return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="table-layout:fixed"><tr>
      ${cards.map((c, i) => `${i > 0 ? `<td width="2%"></td>` : ''}<td width="${width}%" style="vertical-align:top">${c}</td>`).join('')}
    </tr></table>`;
  };

  const missingBanner = agg.missing.length
    ? `<div style="margin:30px 36px 0;padding:16px 19px;background:#fefaf1;border:1px solid #fde68a;border-left:3px solid #b45309;border-radius:4px 12px 12px 4px">
         <p style="margin:0;font-size:13.5px;line-height:1.55;color:${BRAND.ink}">Heads up: today's figures are missing ${agg.missing.length} of the ${agg.expectedCount} expected Evident reports (${agg.missing.join(', ')}). Numbers below may be understated.</p>
       </div>`
    : '';

  // Customer-aggregated detail for Today's Booked (Ben Silberstein's
  // requirement, 2026-09-18; format confirmed 2026-09-18 against a real
  // "EviSmart Report Totals" email — Evident's own Report 13, the Daily
  // Activity Report, groups by customer with a case count, not one row
  // per case) — grouped from the same row-level company-wide data as
  // before, just aggregated here instead of listed raw. Company-wide,
  // unbounded (never caps a real list — see salesRepDailyReport.js's
  // Active Doctors List). Omitted entirely when there's nothing to show.
  // Placed at the END of the email (see the template below) rather than
  // right after the Today cards — reference detail, not the headline.
  const bookedByCustomer = (() => {
    const order = [];
    const byName = new Map();
    for (const r of agg.companyDailyBookedRows) {
      const name = r.customerName || '-';
      if (!byName.has(name)) { byName.set(name, { name, count: 0, value: 0 }); order.push(name); }
      const entry = byName.get(name);
      entry.count += 1;
      entry.value += r.value;
    }
    return order.map((name) => byName.get(name));
  })();

  const bookedRowsTable = bookedByCustomer.length === 0 ? '' : `
    <div style="margin:24px 36px 0;padding:16px 18px;background:${BRAND.glassBg};border:1px solid ${BRAND.glassBorder};border-radius:16px;box-shadow:${BRAND.glassShadow}">
      ${sectionLabel(`Today's Booked Cases (${agg.companyDailyBookedRows.length} cases, ${bookedByCustomer.length} customers)`)}
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;table-layout:fixed">
        <tr>
          <td width="56%" style="padding:0 0 5px;font-size:9px;font-weight:600;text-transform:uppercase;letter-spacing:.05em;color:${BRAND.slate}">Customer</td>
          <td width="16%" style="padding:0 0 5px;font-size:9px;font-weight:600;text-transform:uppercase;letter-spacing:.05em;color:${BRAND.slate};text-align:right">Cases</td>
          <td width="28%" style="padding:0 0 5px;font-size:9px;font-weight:600;text-transform:uppercase;letter-spacing:.05em;color:${BRAND.slate};text-align:right">Value</td>
        </tr>
        ${bookedByCustomer.map((c) => `
          <tr>
            <td width="56%" style="padding:4px 0;border-bottom:1px solid ${HAIRLINE};font-size:11.5px;line-height:1.35;color:${BRAND.ink};word-break:break-word">${escapeHtml(c.name)}</td>
            <td width="16%" style="padding:4px 0;border-bottom:1px solid ${HAIRLINE};font-size:11.5px;font-family:${FONT_DATA};color:${BRAND.slate};text-align:right">${c.count}</td>
            <td width="28%" style="padding:4px 0;border-bottom:1px solid ${HAIRLINE};font-size:11.5px;font-family:${FONT_DATA};color:${BRAND.slate};text-align:right;white-space:nowrap">${fmtMoney(c.value)}</td>
          </tr>`).join('')}
      </table>
    </div>`;

  // Report #2: by-sales-rep breakdown (Ben Silberstein's requirement,
  // 2026-09-19) — daily count+value grouped from the same row-level
  // company-wide data Report 1's customer-detail table already uses
  // (consistent source, not a second report type that could drift from
  // Report 1's totals); MTD value-only read directly from Evident's own
  // per-rep columns in "MTD Booked Daily Update"/"Daily MTD Total Billed"
  // (see extractRepColumns in parseEvident.js) rather than re-derived, so
  // it matches whatever Evident itself considers each rep's MTD share.
  // Only James/William shown — "by sales rep" excludes the N/A bucket,
  // which Report 1's company-wide totals already cover.
  // valueField differs by row type: booking rows only have `value` (Sales
  // Value Total); billed rows have both `value` and `billedValue` (Sales
  // Value Total Billed) — the latter is the real dollar amount billed,
  // which is what "Total Billed by sales rep" means, not the case's total
  // value.
  const groupRowsByRep = (rows, valueField = 'value') => {
    const g = { james: { count: 0, value: 0 }, william: { count: 0, value: 0 } };
    for (const r of rows) {
      const key = r.salesperson === 'james' ? 'james' : r.salesperson === 'william' ? 'william' : null;
      if (!key) continue;
      g[key].count += 1;
      g[key].value += r[valueField];
    }
    return g;
  };
  const dailyBookedByRep = groupRowsByRep(agg.companyDailyBookedRows, 'value');
  const dailyBilledByRep = groupRowsByRep(agg.companyDailyBilledRows, 'billedValue');

  // Stacked per-rep cards, not a wide 5-column table — a table with Rep +
  // 4 numeric columns has no room to breathe on a phone (confirmed on a
  // real 390px render: two figures collided into unreadable text like
  // "$0.00$1,458.97"). Reuses statCard/cardRow, the same building blocks
  // as every other section, so this also fixes the earlier inconsistency
  // of this being the one section with no card treatment at all.
  const repSubLabel = (text) => `<p style="margin:0 0 6px;font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.05em;color:${BRAND.slate}">${text}</p>`;
  // Single 4-column row of mini cards per rep, not two 2-card rows — half
  // the section's previous height, and the card is small/short enough
  // (5-char labels, short values) that 4-up still holds up at 390px, kept
  // to only 2 gutters wide overall.
  const repBlock = (repName, daily) => `
    ${repSubLabel(escapeHtml(repName))}
    ${cardRow([
      miniStatCard('Booked', `${daily.booked.count}`, fmtMoney(daily.booked.value)),
      miniStatCard('Billed', `${daily.billed.count}`, fmtMoney(daily.billed.value)),
      miniStatCard('MTD Bkd', daily.mtdBooked == null ? '-' : fmtMoney(daily.mtdBooked)),
      miniStatCard('MTD Bld', daily.mtdBilled == null ? '-' : fmtMoney(daily.mtdBilled)),
    ])}`;

  const repSection = `
    <div style="margin:24px 36px 0;padding:16px 18px;background:${BRAND.glassBg};border:1px solid ${BRAND.glassBorder};border-radius:16px;box-shadow:${BRAND.glassShadow}">
      ${sectionLabel('By Sales Rep')}
      ${repBlock('James Delaney', {
        booked: dailyBookedByRep.james,
        billed: dailyBilledByRep.james,
        mtdBooked: agg.companyMtdBookedByRep ? agg.companyMtdBookedByRep.james : null,
        mtdBilled: agg.companyMtdBilledByRep ? agg.companyMtdBilledByRep.james : null,
      })}
      <div style="height:12px"></div>
      ${repBlock('William Alexander', {
        booked: dailyBookedByRep.william,
        billed: dailyBilledByRep.william,
        mtdBooked: agg.companyMtdBookedByRep ? agg.companyMtdBookedByRep.william : null,
        mtdBilled: agg.companyMtdBilledByRep ? agg.companyMtdBilledByRep.william : null,
      })}
      <p style="margin:10px 0 0;font-size:9.5px;color:${BRAND.slate}">Booked/Billed = today's cases and value. "-" = no per-rep MTD breakdown today.</p>
    </div>`;

  // Report #3: goal progress (Ben Silberstein's requirement, 2026-09-19) —
  // repGoals is pre-fetched by the caller (evidentReport/index.js), not
  // queried here, so this file stays a pure function of its arguments
  // (see fetchRepGoalsWithProgress's own comment for why). Email-safe
  // progress bar: a fixed-width outer cell with an inner cell sized by
  // percentage, since flex/CSS width transitions aren't reliable across
  // email clients but table cell widths are.
  const goalBar = (goal) => {
    const pct = Math.min(goal.progress_pct || 0, 100);
    const isMoney = goal.metric === 'monthly_revenue';
    const fmt = (n) => isMoney ? fmtMoney(n) : Number(n).toLocaleString();
    return `
      <div style="margin:0 0 9px">
        <p style="margin:0 0 3px;font-size:11.5px;color:${BRAND.ink}">${escapeHtml(goal.title)}
          <span style="float:right;font-family:${FONT_DATA};font-size:10px;color:${BRAND.slate}">${fmt(goal.current_value)} / ${fmt(goal.target)} (${pct}%)</span>
        </p>
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse"><tr>
          <td style="background:${pct >= 100 ? BRAND.success : BRAND.teal};height:5px;border-radius:3px;width:${pct}%"></td>
          <td style="background:#eef2f1;height:5px;border-radius:3px;width:${100 - pct}%"></td>
        </tr></table>
      </div>`;
  };
  const goalsSection = repGoals.length === 0 || repGoals.every((r) => r.goals.length === 0) ? '' : `
    <div style="margin:24px 36px 0;padding:16px 18px;background:${BRAND.glassBg};border:1px solid ${BRAND.glassBorder};border-radius:16px;box-shadow:${BRAND.glassShadow}">
      ${sectionLabel('Goal Progress')}
      ${repGoals.filter((r) => r.goals.length > 0).map((r) => `
        <p style="margin:0 0 5px;font-size:10.5px;font-weight:600;text-transform:uppercase;letter-spacing:.05em;color:${BRAND.slate}">${escapeHtml(r.repName)}</p>
        ${r.goals.map(goalBar).join('')}
      `).join('')}
    </div>`;

  const chartNote = `<p style="margin:8px 0 0;font-size:11px;color:${BRAND.slate}">${thisMonthLabel} is real MTD-to-date, not a full month yet, so it isn't a like-for-like comparison against a completed month until the month ends.</p>`;

  // "Pace vs. Last Month" card (user request, 2026-09-19) — how much more
  // this month's MTD figure needs to reach last month's full-month total,
  // or by how much it has already surpassed it. Comparing a partial month
  // to a completed one is intentional (it's the pace question, not a
  // like-for-like one) — the chart above and its note already carry that
  // caveat, so this card doesn't repeat it.
  const paceCard = (label, current, lastMonthValue) => {
    const gap = current - lastMonthValue;
    const surpassed = gap >= 0;
    return statCard(label, fmtMoney(current), [
      { text: `${lastMonth.label}: ${fmtMoney(lastMonthValue)}` },
      surpassed
        ? { text: `Surpassed by ${fmtMoney(gap)}`, cls: 'up' }
        : { text: `${fmtMoney(Math.abs(gap))} more to surpass` },
    ]);
  };
  const paceSection = `
    <div style="margin:24px 36px 0;padding:16px 18px;background:${BRAND.glassBg};border:1px solid ${BRAND.glassBorder};border-radius:16px;box-shadow:${BRAND.glassShadow}">
      ${sectionLabel(`Pace vs. ${lastMonth.label}`)}
      ${cardRow([
        paceCard('Booked (MTD)', companyMtdBooked, lastMonth.booked),
        paceCard('Billed (MTD)', companyMtdBilled, lastMonth.billed),
      ])}
    </div>`;

  const html = `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Cormorant+Garamond:wght@600;700&family=DM+Sans:wght@400;500;600;700&family=DM+Mono:wght@400;500&display=swap" rel="stylesheet">
</head>
<body style="margin:0;padding:0;background-color:${BRAND.deep};background-image:linear-gradient(160deg,${BRAND.skyBlue} 0%,${BRAND.deep} 100%);font-family:${FONT_BODY}">
<div style="max-width:600px;margin:40px auto;background-color:rgba(255,255,255,.96);background-image:linear-gradient(175deg,rgba(255,255,255,.99) 0%,${BRAND.tealMist} 55%,${BRAND.blueMist} 100%);border:1px solid rgba(255,255,255,.6);border-radius:24px;overflow:hidden;box-shadow:0 10px 40px rgba(32,114,144,.22)">

  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
    <tr>
      <td bgcolor="${BRAND.teal}" style="background-color:${BRAND.teal};background-image:linear-gradient(135deg,${BRAND.teal},${BRAND.deep});padding:34px 36px 28px">
        <h1 style="color:#fff;margin:0;font-family:${FONT_DISPLAY};font-size:30px;font-weight:700;letter-spacing:-.01em">AIM Leadership Report</h1>
        <p style="color:rgba(255,255,255,.72);margin:12px 0 0;font-size:13px">${dateLabel} &nbsp;·&nbsp; AIM Dental Laboratory</p>
      </td>
    </tr>
  </table>

  ${missingBanner}

  <div style="padding:22px 36px 0">
    ${sectionLabel('Today')}
    ${cardRow([
      todayCard('Booked', fmtMoney(agg.companyDailyBooked), `${agg.companyDailyBookedCount} case${agg.companyDailyBookedCount === 1 ? '' : 's'}`),
      todayCard('Billed', fmtMoney(agg.companyDailyBilled)),
    ])}
  </div>

  <div style="padding:20px 36px 0">
    ${sectionLabel('This Month &amp; Year')}
    ${cardRow([
      statCard('Booked (MTD)', fmtMoney(companyMtdBooked), overrides.companyMtdBooked != null
        ? [overrideNote]
        : [{ text: `${companyMtdBookedCount} case${companyMtdBookedCount === 1 ? '' : 's'}` }]),
      statCard('Billed (MTD)', fmtMoney(companyMtdBilled), overrides.companyMtdBilled != null ? [overrideNote] : [{ text: billedMtdDelta.text, cls: billedMtdDelta.cls }]),
    ])}
    <div style="height:8px"></div>
    ${cardRow([
      statCard('YTD Total Sales (Billed)', fmtMoney(companyYtdBilled), [ytdNote]),
    ])}
  </div>

  <div style="margin:24px 36px 0;padding:16px 18px;background:${BRAND.glassBg};border:1px solid ${BRAND.glassBorder};border-radius:16px;box-shadow:${BRAND.glassShadow}">
    ${sectionLabel('Booked &amp; Billed by Month')}
    <img src="${monthChartUrl}" alt="Month-by-month booked and billed revenue trend chart" style="max-width:100%;border-radius:8px;display:block" />
    ${chartNote}
  </div>

  ${paceSection}

  ${repSection}

  ${goalsSection}

  ${bookedRowsTable}

  <div style="margin:24px 36px 0;padding-top:16px;border-top:1px solid ${HAIRLINE}">
    <p style="margin:0;font-size:11px;color:${BRAND.slate}">A PDF copy of this report is attached.</p>
  </div>

  <div style="margin-top:28px;background:${BRAND.tealMist};padding:16px 36px;font-size:11.5px;color:${BRAND.slate};border-top:1px solid ${HAIRLINE}">
    Aim Dental Laboratory CRM &nbsp;·&nbsp; Leadership Report
  </div>
</div>
</body></html>`.trim();

  const sheetRow = {
    date: agg.runDate,
    booked_daily_count: agg.booked.daily.count,
    booked_daily_value: agg.booked.daily.value,
    booked_mtd_count: agg.booked.mtd.count,
    booked_mtd_billed: agg.companyMtdBilled,
    booked_mtd_wip: agg.booked.mtd.wip,
    booked_mtd_value: agg.booked.mtd.value,
    wip_cases: agg.wip.cases,
    wip_value: agg.wip.value,
    aim_wip_value: agg.wip.aim.value,
    kh_wip_value: agg.wip.kh.value,
    james_wip_value: agg.wip.byRep.james || 0,
    william_wip_value: agg.wip.byRep.william || 0,
    ytd_billed_value: agg.booked.ytd.billed,
    company_daily_booked_value: agg.companyDailyBooked,
    company_daily_booked_count: agg.companyDailyBookedCount,
    company_daily_billed_value: agg.companyDailyBilled,
  };

  return {
    subject: `AIM Leadership Report - ${dateLabel}`,
    html,
    sheetRow,
  };
}

module.exports = { buildEmail };
