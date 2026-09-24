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

// One-time verified monthly baselines for Report #3's trend chart and
// "This Month vs. Last Month" KPI comparison — real June-August 2026
// totals, user-supplied
// 2026-09-19 from Evident's own EviSmart export (booked) and the custom
// billing reports pulled the same day (billed). Booked/billed use the
// "custom report" basis throughout, not the "financial ledger" basis
// (the user's own figures showed these differ slightly, e.g.
// $334,230.11 vs. $332,634.11 YTD as of 2026-09-18) — per the user's
// explicit instruction to use one basis consistently, every figure in
// this file is the custom-report basis. Same genuinely-temporary-exception
// status as the single-month baseline this replaces: once this pipeline's
// own real daily logging (started
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

const deltaColor = (cls) => (cls === 'up' ? BRAND.success : cls === 'down' ? BRAND.danger : BRAND.slate);

const sectionLabel = (text) => `<p style="margin:0 0 14px;font-family:${FONT_DATA};font-size:10px;font-weight:500;letter-spacing:.09em;text-transform:uppercase;color:${BRAND.slate}">${text}</p>`;

// Marks the boundary between the 3 formerly-separate reports when they're
// combined into one email (user request, 2026-09-23 — leadership wants
// them back in a single send; superseded Ben Silberstein's 2026-09-19
// "must be 3 distinct emails" spec, though each report's own internal
// structure/metrics are unchanged).
const groupDivider = (title) => `
  <div style="margin:32px 36px 0;padding-top:20px;border-top:2px solid ${BRAND.deep}">
    <h2 style="margin:0;font-family:${FONT_DISPLAY};font-size:21px;font-weight:700;color:${BRAND.ink}">${title}</h2>
  </div>`;

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
  <div style="background:${BRAND.glassBg};border:1px solid ${BRAND.glassBorder};border-radius:16px;padding:18px 14px;box-shadow:${BRAND.glassShadow}">
    <p style="margin:0 0 6px;font-family:${FONT_DATA};font-size:10px;font-weight:500;letter-spacing:.08em;text-transform:uppercase;color:${BRAND.deep}">${label}</p>
    <p style="margin:0;font-family:${FONT_DATA};font-size:19px;font-weight:500;color:${BRAND.deep};letter-spacing:-.02em;white-space:nowrap">${value}</p>
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
// elsewhere) — roughly half the padding and a smaller value size.
const miniStatCard = (label, value, sub) => `
  <div style="background:${BRAND.glassBg};border:1px solid ${BRAND.glassBorder};border-radius:10px;padding:9px 10px;box-shadow:${BRAND.glassShadow}">
    <p style="margin:0 0 3px;font-family:${FONT_DATA};font-size:8px;font-weight:500;letter-spacing:.06em;text-transform:uppercase;color:${BRAND.slate}">${label}</p>
    <p style="margin:0;font-family:${FONT_DATA};font-size:14px;font-weight:500;color:${BRAND.ink}">${value}${sub ? ` <span style="font-size:10px;font-weight:400;color:${BRAND.slate}">${sub}</span>` : ''}</p>
  </div>`;

// Row of separate cards with real gutters between them (not just padding
// inside a shared cell) — a plain <table> can't put margin between
// adjacent <td>s, so the gap is its own empty spacer column.
// table-layout:fixed is load-bearing on mobile — without it, auto layout
// sizes each <td> by its card's own content/padding rather than the
// specified percentage, and a 2-card row can render wider than the
// viewport (the second card cut off at the screen edge, confirmed via a
// real 390px-wide render before this fix).
const cardRow = (cards) => {
  const width = (100 / cards.length - 2).toFixed(2);
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="table-layout:fixed"><tr>
    ${cards.map((c, i) => `${i > 0 ? `<td width="2%"></td>` : ''}<td width="${width}%" style="vertical-align:top">${c}</td>`).join('')}
  </tr></table>`;
};

// Email-safe progress bar for Report #3 (Goal Progress) — a fixed-width
// outer cell with an inner cell sized by percentage, since flex/CSS width
// transitions aren't reliable across email clients but table cell widths
// are. Shows target, actual-to-date, percentage achieved (already
// (Actual / Target) * 100 via goalProgress.js's computeProgress, capped
// at 100 for the bar/display), and the remaining amount needed to reach
// target — all four required by Ben Silberstein's formal spec,
// 2026-09-19.
const goalBar = (goal) => {
  const pct = Math.min(goal.progress_pct || 0, 100);
  const isMoney = goal.metric === 'monthly_revenue';
  const fmt = (n) => isMoney ? fmtMoney(n) : Number(n).toLocaleString();
  const remaining = Math.max(Number(goal.target) - Number(goal.current_value), 0);
  return `
    <div style="margin:0 0 9px">
      <p style="margin:0;font-size:11.5px;color:${BRAND.ink}">${escapeHtml(goal.title)}</p>
      <p style="margin:1px 0 4px;font-family:${FONT_DATA};font-size:10px;color:${BRAND.slate}">${fmt(goal.current_value)} / ${fmt(goal.target)} (${pct}%)</p>
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse"><tr>
        <td style="background:${pct >= 100 ? BRAND.success : BRAND.teal};height:5px;border-radius:3px;width:${pct}%"></td>
        <td style="background:#eef2f1;height:5px;border-radius:3px;width:${100 - pct}%"></td>
      </tr></table>
      <p style="margin:3px 0 0;font-size:10px;color:${BRAND.slate}">${remaining <= 0 ? 'Target reached' : `${fmt(remaining)} remaining to reach target`}</p>
    </div>`;
};

// Shared email chrome (header/footer), used both by the 3 individual
// report builders (buildReport1/2/3Email, each still usable standalone)
// and by buildCombinedLeadershipEmail's single merged send. `title` is
// the header's own line; `body` is the report's (or combined reports')
// own section markup.
function emailShell(title, dateLabel, body) {
  return `<!DOCTYPE html>
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
        <h1 style="color:#fff;margin:0;font-family:${FONT_DISPLAY};font-size:30px;font-weight:700;letter-spacing:-.01em">${title}</h1>
        <p style="color:rgba(255,255,255,.72);margin:12px 0 0;font-size:13px">${dateLabel} &nbsp;·&nbsp; AIM Dental Laboratory</p>
      </td>
    </tr>
  </table>

  ${body}

  <div style="margin-top:28px;background:${BRAND.tealMist};padding:16px 36px;font-size:11.5px;color:${BRAND.slate};border-top:1px solid ${HAIRLINE}">
    Aim Dental Laboratory CRM &nbsp;·&nbsp; Daily Leadership Dashboard
  </div>
</div>
</body></html>`.trim();
}

function dateLabelFor(runDate) {
  return new Date(`${runDate}T00:00:00Z`).toLocaleDateString('en-US', {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    year: 'numeric',
  });
}

// Report #1: Leadership Sales Summary — Daily Booked (count + customer
// detail), Daily Billed (value only), MTD Booked (count + value), MTD
// Billed (value only), YTD Sales Value Total (booked, + the $2.7M goal
// progress bar), YTD Billed (value only). Daily/MTD/YTD Booked+Billed now
// come directly from the real "EviSmart Daily Sales Report" email
// (agg.eviSmart — see parseEvident.js's extractEviSmartTotals and
// gmailFetch.js's fetchEviSmartEmails), per explicit user instruction,
// 2026-09-23 — replaces the old self-accumulation-from-historyRows
// approach entirely (the removed computeCompanyMtd/COMPANY_YTD_SNAPSHOT).
// `historyRows`/`overrides` are no longer used by this function — kept in
// the signature only so index.js/buildCombinedLeadershipEmail/existing
// tests don't need to change just for this; EviSmart is now the sole
// source, so there's nothing left to override or accumulate from logged
// history. When agg.eviSmart is null (a real "could not run (not logged
// in)" pull failure, seen for real 2026-09-19/20), every figure below
// reads "—" rather than a fabricated $0, with a notice explaining why.
function buildReport1Body(agg, historyRows = [], overrides = {}) {
  const es = agg.eviSmart;
  // LEGACY_YTD_REVENUE_ADJUSTMENT (see clientRevenue.js) is always added
  // on top, per the user's standing instruction (2026-09-19) to include
  // it as a default on any company YTD sales figure — that $1,243,759 is
  // real historical revenue from AIM/Kings Highway's previous system
  // (before this CRM/Evident/EviSmart tracking existed), which EviSmart's
  // own YTD figure has no way to already include.
  const companyYtdSalesValueTotal = es ? es.ytdTotalSalesValue + LEGACY_YTD_REVENUE_ADJUSTMENT : null;
  // 'N/A', not an em dash — this file's own copy rules forbid em dashes
  // (see the "no em dashes" test), and '-' alone reads as a hyphen glued
  // to nothing rather than a clear "not available" signal.
  const fmtOrDash = (v) => (v == null ? 'N/A' : fmtMoney(v));

  const eviSmartMissingBanner = !es
    ? `<div style="margin:30px 36px 0;padding:16px 19px;background:#fefaf1;border:1px solid #fde68a;border-left:3px solid #b45309;border-radius:4px 12px 12px 4px">
         <p style="margin:0;font-size:13.5px;line-height:1.55;color:${BRAND.ink}">Heads up: today's EviSmart Daily Sales Report pull didn't come through, so Daily/MTD/YTD Booked and Billed figures below aren't available.</p>
       </div>`
    : '';

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
  // Sourced from the EviSmart Daily Sales Report's own "Daily Booked by
  // Customer" table (user instruction, 2026-09-24: totals only from that
  // email; the old Evident row list disagreed with it on a real day).
  const bookedByCustomer = es && es.dailyCustomers ? es.dailyCustomers : [];
  const bookedCaseCount = bookedByCustomer.reduce((sum, c) => sum + c.count, 0);

  const bookedRowsTable = bookedByCustomer.length === 0 ? '' : `
    <div style="margin:24px 36px 0;padding:16px 18px;background:${BRAND.glassBg};border:1px solid ${BRAND.glassBorder};border-radius:16px;box-shadow:${BRAND.glassShadow}">
      ${sectionLabel(`Today's Booked Cases (${bookedCaseCount} cases, ${bookedByCustomer.length} customers)`)}
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

  // $2.7M YTD Sales Value Total company goal (user instruction,
  // 2026-09-23) — reuses the same goalBar component the per-rep goals in
  // Report #3 use, via a synthetic goal object, so it's visually and
  // structurally consistent with every other goal in this report rather
  // than a bespoke one-off treatment.
  const ytdGoalCard = companyYtdSalesValueTotal == null ? '' : `
    <div style="margin-top:10px;padding:16px 14px;background:${BRAND.glassBg};border:1px solid ${BRAND.glassBorder};border-radius:14px;box-shadow:${BRAND.glassShadow}">
      ${goalBar({
        title: '$2.7M YTD Sales Value Total Goal',
        metric: 'monthly_revenue',
        target: 2700000,
        current_value: companyYtdSalesValueTotal,
        progress_pct: Math.min(Math.round((companyYtdSalesValueTotal / 2700000) * 100), 100),
      })}
    </div>`;

  // Split into `headlineSection` (Today/MTD/YTD cards + the $2.7M goal —
  // the "essential details" the user wants up top, 2026-09-23) and
  // `bookedRowsTable` (the long customer-detail list) as two separate
  // return values, not one combined `body` string — buildCombinedLeadershipEmail
  // needs to place them in different, non-adjacent spots (customer detail
  // moved to the very end of the whole combined email, below Report
  // #2/#3's content, since it's by far the longest section). Standalone
  // buildReport1Email below reassembles them in their original order, so
  // this split doesn't change that email's own layout at all.
  const headlineSection = `
  ${eviSmartMissingBanner}
  ${missingBanner}

  <div style="padding:22px 36px 0">
    ${sectionLabel('Today')}
    ${cardRow([
      todayCard('Booked', fmtOrDash(es && es.dailyBookedValue), es && es.dailyBookedCount != null ? `${es.dailyBookedCount} case${es.dailyBookedCount === 1 ? '' : 's'}` : null),
      todayCard('Billed', fmtOrDash(es && es.dailyBilledValue)),
    ])}
  </div>

  <div style="padding:20px 36px 0">
    ${sectionLabel('This Month &amp; Year')}
    ${cardRow([
      statCard('Booked (MTD)', fmtOrDash(es && es.mtdBookedValue), es && es.mtdBookedCount != null ? [{ text: `${es.mtdBookedCount.toLocaleString()} cases` }] : []),
      statCard('Billed (MTD)', fmtOrDash(es && es.mtdBilledValue)),
    ])}
    <div style="height:8px"></div>
    ${cardRow([
      statCard('YTD Sales Value Total', fmtOrDash(companyYtdSalesValueTotal), [{ text: 'Includes $1,243,759 from the previous system' }]),
      statCard('YTD Billed', fmtOrDash(es && es.ytdBilledValue)),
    ])}
    ${ytdGoalCard}
  </div>`;

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

  return { headlineSection, bookedRowsTable, sheetRow };
}

function buildReport1Email(agg, historyRows = [], overrides = {}) {
  const dateLabel = dateLabelFor(agg.runDate);
  const { headlineSection, bookedRowsTable, sheetRow } = buildReport1Body(agg, historyRows, overrides);
  const body = `${headlineSection}\n\n  ${bookedRowsTable}`;
  return {
    subject: `Daily Sales Report - ${dateLabel}`,
    html: emailShell('Daily Sales Report', dateLabel, body),
    sheetRow,
  };
}

// Report #2: By Sales Rep — daily count+value grouped from the same
// row-level company-wide data Report #1's customer-detail table uses
// (consistent source, not a second report type that could drift from
// Report #1's totals); MTD value-only read directly from Evident's own
// per-rep columns in "MTD Booked Daily Update"/"Daily MTD Total Billed"
// (see extractRepColumns in parseEvident.js) rather than re-derived, so
// it matches whatever Evident itself considers each rep's MTD share. Only
// James/William shown — "by sales rep" excludes the N/A bucket, which
// Report #1's company-wide totals already cover. valueField differs by
// row type: booking rows only have `value` (Sales Value Total); billed
// rows have both `value` and `billedValue` (Sales Value Total Billed) —
// the latter is the real dollar amount billed, which is what "Total
// Billed by sales rep" means, not the case's total value. Its own
// separate email (Ben Silberstein's requirement, 2026-09-19).
//
// `repGoals` (optional) renders each rep's own goal-progress bars right
// under THEIR OWN MTD Booked/MTD Billed cards, not in a separate section
// further down — user request, 2026-09-23: "the goal tracking, since
// it's connected to both sales rep, please put under their MTD booked
// and MTD billed." Matched to a rep block by exact repName string (the
// same "James Delaney"/"William Alexander" labels this function already
// hardcodes) since repGoals carries no rep id, only whatever name
// fetchRepGoalsWithProgress pulled from the users table.
function buildReport2Body(agg, repGoals = []) {
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
  const goalsFor = (repName) => {
    const match = repGoals.find((r) => r.repName === repName);
    return match ? match.goals : [];
  };

  // Stacked per-rep cards, not a wide 5-column table — a table with Rep +
  // 4 numeric columns has no room to breathe on a phone (confirmed on a
  // real 390px render: two figures collided into unreadable text like
  // "$0.00$1,458.97"). Reuses statCard/cardRow, the same building blocks
  // as every other section.
  const repSubLabel = (text) => `<p style="margin:0 0 10px;font-size:12px;font-weight:600;text-transform:uppercase;letter-spacing:.05em;color:${BRAND.slate}">${text}</p>`;
  // Two rows of two cards per rep (Daily on top, MTD below), not one
  // 4-up row: a real 390px render showed 4-up cards wrapping labels to 3
  // lines at uneven heights and "$1,458.97" overflowing its card. That
  // rep's own goal bars (if any) render directly below their MTD row,
  // inside the same card, so "how they're doing this month" and "how
  // they're doing against their goal" read as one connected story.
  const repBlock = (repName, daily, goals) => `
    ${repSubLabel(escapeHtml(repName))}
    ${cardRow([
      miniStatCard('Total Daily Booked', `${daily.booked.count}`, fmtMoney(daily.booked.value)),
      miniStatCard('Total Daily Billed', `${daily.billed.count}`, fmtMoney(daily.billed.value)),
    ])}
    <div style="height:8px"></div>
    ${cardRow([
      miniStatCard('MTD Booked', daily.mtdBooked == null ? '-' : fmtMoney(daily.mtdBooked)),
      miniStatCard('MTD Billed', daily.mtdBilled == null ? '-' : fmtMoney(daily.mtdBilled)),
    ])}
    ${goals.length > 0 ? `
    <div style="margin-top:10px;padding:12px 12px 4px;background:rgba(255,255,255,.5);border:1px solid ${BRAND.glassBorder};border-radius:10px">
      ${goals.map(goalBar).join('')}
    </div>` : ''}`;

  const missingBanner = agg.missing.length
    ? `<div style="margin:30px 36px 0;padding:16px 19px;background:#fefaf1;border:1px solid #fde68a;border-left:3px solid #b45309;border-radius:4px 12px 12px 4px">
         <p style="margin:0;font-size:13.5px;line-height:1.55;color:${BRAND.ink}">Heads up: today's figures are missing ${agg.missing.length} of the ${agg.expectedCount} expected Evident reports (${agg.missing.join(', ')}). Numbers below may be understated.</p>
       </div>`
    : '';

  const jamesGoals = goalsFor('James Delaney');
  const williamGoals = goalsFor('William Alexander');
  const noGoalsNote = repGoals.length === 0 || (jamesGoals.length === 0 && williamGoals.length === 0)
    ? `<p style="margin:10px 0 0;font-size:9.5px;color:${BRAND.slate}">No active goals for James or William this period.</p>`
    : '';

  // One glass card per rep (user request, 2026-09-23) so each rep's
  // figures and goals read as their own unit instead of one long block.
  const repCard = (marginTop, content) => `
  <div style="margin:${marginTop}px 36px 0;padding:16px 18px;background:${BRAND.glassBg};border:1px solid ${BRAND.glassBorder};border-radius:16px;box-shadow:${BRAND.glassShadow}">
    ${content}
  </div>`;

  const body = `
  ${missingBanner}
  ${repCard(24, repBlock('James Delaney', {
    booked: dailyBookedByRep.james,
    billed: dailyBilledByRep.james,
    mtdBooked: agg.companyMtdBookedByRep ? agg.companyMtdBookedByRep.james : null,
    mtdBilled: agg.companyMtdBilledByRep ? agg.companyMtdBilledByRep.james : null,
  }, jamesGoals))}
  ${repCard(14, repBlock('William Alexander', {
    booked: dailyBookedByRep.william,
    billed: dailyBilledByRep.william,
    mtdBooked: agg.companyMtdBookedByRep ? agg.companyMtdBookedByRep.william : null,
    mtdBilled: agg.companyMtdBilledByRep ? agg.companyMtdBilledByRep.william : null,
  }, williamGoals))}
  <div style="margin:10px 36px 0">
    <p style="margin:0;font-size:9.5px;color:${BRAND.slate}">Total Daily Booked/Billed = the day's case count and value. "-" = no per-rep MTD breakdown today.</p>
    ${noGoalsNote}
  </div>`;

  return body;
}

function buildReport2Email(agg, repGoals = []) {
  const dateLabel = dateLabelFor(agg.runDate);
  const body = buildReport2Body(agg, repGoals);
  return {
    subject: `Daily Sales by Sales Rep - ${dateLabel}`,
    html: emailShell('Daily Sales by Sales Rep', dateLabel, body),
  };
}

// Report #3: KPI and Goal Tracking (Ben Silberstein's formal spec,
// 2026-09-19) — two sections: (1) a company-wide "This Month vs. Last
// Month" KPI comparison (value for both periods, numerical change, %
// change, clearly labeled periods), which absorbs the month-by-month
// trend chart and the old Pace vs. Last Month card that used to live in
// Report #1 (neither is part of Report #1's defined metrics); (2) each
// rep's goal progress. This month's Booked/Billed MTD now comes from the
// same real EviSmart Daily Sales Report as Report #1 (agg.eviSmart, user
// instruction 2026-09-23) rather than the removed computeCompanyMtd — the
// whole combined report reads one MTD figure from one source, never two
// different numbers for the same thing. `historyRows` is no longer used
// (kept in the signature for call-site compatibility, same as
// buildReport1Body).
function buildReport3Body(agg, historyRows = [], repGoals = []) {
  const es = agg.eviSmart;

  // Last month's Booked/Billed come from the SAME EviSmart Daily Sales
  // Report as every other total (user instruction, 2026-09-24: only use
  // that email for totals). Its own "MTD vs Last Month Comparison" table
  // supplies them, so the earlier hardcoded August figure (which differed
  // for Billed: $147,772.40 vs. EviSmart's $145,872.42) is no longer used
  // for the comparison. MONTH_HISTORY still supplies only the older chart
  // point(s) EviSmart doesn't report.
  const priorMonthStart = new Date(Date.UTC(
    Number(agg.runDate.slice(0, 4)),
    Number(agg.runDate.slice(5, 7)) - 2,
    1
  ));
  const lastMonth = es && es.lastMonth
    ? {
        label: `${es.lastMonth.monthName.slice(0, 3)} ${priorMonthStart.getUTCFullYear()}`,
        booked: es.lastMonth.booked,
        billed: es.lastMonth.billed,
      }
    : null;
  const thisMonthLabel = new Date(`${agg.runDate}T00:00:00Z`).toLocaleDateString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' });
  const thisMonthShort = new Date(`${agg.runDate}T00:00:00Z`).toLocaleDateString('en-US', { month: 'short', year: 'numeric', timeZone: 'UTC' });
  const thisPeriodLabel = `${thisMonthLabel} (MTD)`;

  // Percentage change is undefined (not zero, not infinite) when the
  // prior period was itself zero — rendered as "N/A" rather than a
  // fabricated +/-Infinity or a misleading 0%.
  const pctChange = (curr, prev) => (prev === 0 ? null : ((curr - prev) / prev) * 100);

  const momCard = (label, current, previous) => {
    const change = current - previous;
    const pct = pctChange(current, previous);
    const cls = change > 0 ? 'up' : change < 0 ? 'down' : '';
    const pctText = pct == null ? 'N/A' : `${pct >= 0 ? '+' : ''}${pct.toFixed(1)}%`;
    return statCard(label, fmtMoney(current), [
      { text: `${lastMonth.label}: ${fmtMoney(previous)}` },
      { text: `${change >= 0 ? '+' : '-'}${fmtMoney(Math.abs(change))} (${pctText})`, cls },
    ]);
  };

  // No fabricated comparison when today's EviSmart pull (or its last-month
  // column) is unavailable — a compact notice instead of the chart/cards.
  const kpiNotice = (text) => `
  <div style="padding:22px 36px 0">
    ${sectionLabel(`${thisPeriodLabel} vs. last month`)}
    <div style="padding:16px 18px;background:${BRAND.glassBg};border:1px solid ${BRAND.glassBorder};border-radius:16px;box-shadow:${BRAND.glassShadow}">
      <p style="margin:0;font-size:13px;color:${BRAND.slate}">${text}</p>
    </div>
  </div>`;

  const kpiSection = !es
    ? kpiNotice("Today's EviSmart Daily Sales Report pull didn't come through, so this month's comparison isn't available.")
    : !lastMonth
      ? kpiNotice("Last month's totals weren't included in today's EviSmart Daily Sales Report, so the month-over-month comparison isn't available.")
      : `
  <div style="padding:22px 36px 0">
    ${sectionLabel(`${thisPeriodLabel} vs. ${lastMonth.label}`)}
    <div style="margin:0 0 14px;padding:16px 18px;background:${BRAND.glassBg};border:1px solid ${BRAND.glassBorder};border-radius:16px;box-shadow:${BRAND.glassShadow}">
      <img src="${buildMonthTrendChartUrl([...MONTH_HISTORY.filter((m) => m.label !== lastMonth.label).slice(-1), lastMonth, { label: thisPeriodLabel, booked: es.mtdBookedValue, billed: es.mtdBilledValue }])}" alt="Month-by-month booked and billed revenue trend chart" style="max-width:100%;border-radius:8px;display:block" />
      <p style="margin:8px 0 0;font-size:11px;color:${BRAND.slate}">${thisPeriodLabel} is real month-to-date, not a full month yet, so it isn't a like-for-like comparison against a completed month until the month ends.</p>
    </div>
    ${cardRow([
      momCard(`Booked - ${thisMonthShort}`, es.mtdBookedValue, lastMonth.booked),
      momCard(`Billed - ${thisMonthShort}`, es.mtdBilledValue, lastMonth.billed),
    ])}
  </div>`;

  const hasGoals = repGoals.length > 0 && repGoals.some((r) => r.goals.length > 0);
  const repCard = (r) => `
  <div style="margin:14px 36px 0;padding:16px 18px;background:${BRAND.glassBg};border:1px solid ${BRAND.glassBorder};border-radius:16px;box-shadow:${BRAND.glassShadow}">
    <p style="margin:0 0 10px;font-size:13px;font-weight:600;color:${BRAND.ink}">${escapeHtml(r.repName)}</p>
    ${r.goals.map(goalBar).join('')}
  </div>`;
  const goalsSection = hasGoals ? `
  <div style="padding:24px 36px 0">${sectionLabel('Goal Progress')}</div>
  ${repGoals.filter((r) => r.goals.length > 0).map(repCard).join('')}` : `
  <div style="margin:24px 36px 0;padding:16px 18px;background:${BRAND.glassBg};border:1px solid ${BRAND.glassBorder};border-radius:16px;box-shadow:${BRAND.glassShadow}">
    ${sectionLabel('Goal Progress')}
    <p style="margin:0;font-size:13px;color:${BRAND.slate}">No active goals for James or William this period.</p>
  </div>`;

  return { kpiSection, goalsSection };
}

function buildReport3Email(agg, historyRows = [], repGoals = []) {
  const dateLabel = dateLabelFor(agg.runDate);
  const { kpiSection, goalsSection } = buildReport3Body(agg, historyRows, repGoals);
  const body = `${kpiSection}\n\n  ${goalsSection}`;
  return {
    subject: `Goal Progress Report - ${dateLabel}`,
    html: emailShell('Goal Progress Report', dateLabel, body),
  };
}

// Combined single-email send (user request, 2026-09-23 — leadership wants
// the 3 reports back in one email; supersedes Ben Silberstein's
// 2026-09-19 "must be 3 distinct emails" instruction). Reuses each
// report's own section-builders unchanged, so a future request to split
// them back into 3 separate emails needs no re-derivation of the report
// content itself — only this assembly layer changes. `overrides` only
// ever applies to Report #1's MTD figures (see buildReport1Body's own
// comment); Report #2/#3 have none.
//
// Section ORDER here is deliberately not "Report 1, then 2, then 3" —
// reordered per explicit user request, 2026-09-23, "make sure UI and UX
// of this report is perfect": essential headline numbers first (Today,
// MTD/Year, the $2.7M goal, then the trend chart + This Month vs. Last
// Month KPI cards right below that goal, since they're all part of the
// same "how are we doing" story), by-rep and goal-progress detail next,
// and the long customer-by-customer table (Today's Booked Cases — by far
// the longest section) very last, since it's reference detail someone
// scrolls to on purpose, not something that should push the headline
// numbers below the fold.
function buildCombinedLeadershipEmail(agg, historyRows = [], repGoals = [], overrides = {}) {
  const dateLabel = dateLabelFor(agg.runDate);
  const { headlineSection, bookedRowsTable, sheetRow } = buildReport1Body(agg, historyRows, overrides);
  // repGoals now renders inline under each rep's own MTD cards inside
  // buildReport2Body (user request, 2026-09-23 — goals are "connected to
  // both sales rep," so they belong with that rep's own numbers, not a
  // separate section further down). Only kpiSection is pulled from
  // Report #3 here; its goalsSection is unused in the combined layout
  // (buildReport3Email standalone still renders it, unaffected).
  const report2Body = buildReport2Body(agg, repGoals);
  const { kpiSection } = buildReport3Body(agg, historyRows, repGoals);

  // Where the numbers come from (user request, 2026-09-24), so a leadership
  // reader can trace every figure. When EviSmart's cumulative figures are
  // dated later than the report day (a corrected resend carries MTD/YTD
  // "through 23 Sep" into a 22 Sep report), say so instead of implying they
  // match the report date.
  const es = agg.eviSmart;
  const reportDay = new Date(`${agg.runDate}T00:00:00Z`);
  const reportDayShort = `${reportDay.getUTCDate()} ${reportDay.toLocaleDateString('en-US', { month: 'short', timeZone: 'UTC' })}`;
  const asOfNote = es && es.cumulativeAsOf && es.cumulativeAsOf !== reportDayShort
    ? `<p style="margin:8px 0 0;font-size:11px;line-height:1.5;color:${BRAND.slate}">Month-to-date, year-to-date and last-month figures are as of ${escapeHtml(es.cumulativeAsOf)}, the most recent full EviSmart pull. Daily figures are for ${escapeHtml(reportDayShort)}.</p>`
    : '';
  const sourceNote = `
  <div style="margin:24px 36px 0;padding:14px 18px;background:${BRAND.blueMist};border:1px solid ${HAIRLINE};border-radius:14px">
    <p style="margin:0 0 6px;font-family:${FONT_DATA};font-size:10px;font-weight:500;letter-spacing:.09em;text-transform:uppercase;color:${BRAND.slate}">Where these numbers come from</p>
    <p style="margin:0;font-size:11px;line-height:1.5;color:${BRAND.slate}">All company totals (Today, Month &amp; Year, last month, and the booked cases by customer list) come from the EviSmart Daily Sales Report. James and William's daily and MTD figures come from Evident's per-rep daily emails, since EviSmart does not break results out by rep. Goal progress comes from the CRM.</p>
    ${asOfNote}
  </div>`;

  const body = `
  ${headlineSection}
  ${kpiSection}

  ${groupDivider('Sales Performance by Representative')}
  ${report2Body}

  ${bookedRowsTable}
  ${sourceNote}`;

  return {
    subject: `Daily Leadership Dashboard - ${dateLabel}`,
    html: emailShell('Daily Leadership Dashboard', dateLabel, body),
    sheetRow,
  };
}

module.exports = { buildReport1Email, buildReport2Email, buildReport3Email, buildCombinedLeadershipEmail };
