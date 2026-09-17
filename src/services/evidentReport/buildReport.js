// Builds the consolidated HTML email from the aggregate figures, computing
// day-over-day deltas against the logged history rows. Visual language
// matches the CRM's other branded emails (weeklyRepReport.js /
// salesRepDailyReport.js's templates in ../email.js) — same fonts, colors,
// card treatment — kept as local constants rather than importing from
// ../email.js, matching this codebase's existing convention of duplicating
// brand hex/font values per template file (see CLAUDE.md's note on this).

const { buildWeeklyRevenueChartUrl } = require('./chart');
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
function buildEmail(agg, historyRows = [], overrides = {}) {
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
  const ytdBookedAccrued = historyRows
    .filter((r) => r.date && r.date > COMPANY_YTD_SNAPSHOT.asOfDate)
    .reduce((sum, r) => sum + Number(r.company_daily_booked_value || 0), 0)
    + (agg.runDate > COMPANY_YTD_SNAPSHOT.asOfDate ? agg.companyDailyBooked : 0);
  const ytdBilledAccrued = historyRows
    .filter((r) => r.date && r.date > COMPANY_YTD_SNAPSHOT.asOfDate)
    .reduce((sum, r) => sum + Number(r.company_daily_billed_value || 0), 0)
    + (agg.runDate > COMPANY_YTD_SNAPSHOT.asOfDate ? agg.companyDailyBilled : 0);
  const companyYtdBooked = COMPANY_YTD_SNAPSHOT.booked + ytdBookedAccrued;
  const companyYtdBilled = COMPANY_YTD_SNAPSHOT.billed + ytdBilledAccrued;
  const ytdNote = { text: `Baseline verified ${COMPANY_YTD_SNAPSHOT.asOfLabel} + daily activity since` };

  const dateLabel = new Date(`${agg.runDate}T00:00:00Z`).toLocaleDateString('en-US', {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    year: 'numeric',
  });

  const { url: chartUrl, weekCount: chartWeekCount } = buildWeeklyRevenueChartUrl(historyRows, agg);

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
    <div style="background-color:${BRAND.tealMist};background-image:linear-gradient(160deg,${BRAND.tealMist},${BRAND.blueMist});border:1px solid rgba(6,186,190,.28);border-radius:16px;padding:20px 20px">
      <p style="margin:0 0 6px;font-family:${FONT_DATA};font-size:10px;font-weight:500;letter-spacing:.08em;text-transform:uppercase;color:${BRAND.deep}">${label}</p>
      <p style="margin:0;font-family:${FONT_DATA};font-size:28px;font-weight:500;color:${BRAND.deep};letter-spacing:-.01em">${value}</p>
      ${sub ? `<p style="margin:6px 0 0;font-size:12px;color:${BRAND.slate}">${sub}</p>` : ''}
    </div>`;

  // `lines` is an array of { text, cls? } sub-lines rendered below the
  // value, e.g. a real day-over-day delta AND a fixed scope footnote
  // together (Billed (YTD) needs both) — kept as one card, not a
  // duplicate caption elsewhere, per the "one figure, one card" rule.
  const statCard = (label, value, lines = []) => `
    <div style="background:#f7faf9;border:1px solid #e5e7eb;border-radius:14px;padding:16px 14px">
      <p style="margin:0 0 6px;font-family:${FONT_DATA};font-size:9px;font-weight:500;letter-spacing:.07em;text-transform:uppercase;color:${BRAND.slate}">${label}</p>
      <p style="margin:0;font-family:${FONT_DATA};font-size:19px;font-weight:500;color:${BRAND.ink}">${value}</p>
      ${lines.filter((l) => l && l.text).map((l) => `<p style="margin:5px 0 0;font-family:${FONT_DATA};font-size:10px;color:${l.cls ? deltaColor(l.cls) : BRAND.slate}">${l.text}</p>`).join('')}
    </div>`;

  // Three-column row of separate cards with real gutters between them
  // (not just padding inside a shared cell) — a plain <table> can't put
  // margin between adjacent <td>s, so the gap is its own empty spacer
  // column, same trick used for the two-column "Today" row below.
  const cardRow = (cards) => {
    const width = (100 / cards.length - 2).toFixed(2);
    return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
      ${cards.map((c, i) => `${i > 0 ? `<td width="2%"></td>` : ''}<td width="${width}%" style="vertical-align:top">${c}</td>`).join('')}
    </tr></table>`;
  };

  const missingBanner = agg.missing.length
    ? `<div style="margin:30px 36px 0;padding:16px 19px;background:#fefaf1;border:1px solid #fde68a;border-left:3px solid #b45309;border-radius:4px 12px 12px 4px">
         <p style="margin:0;font-size:13.5px;line-height:1.55;color:${BRAND.ink}">Heads up: today's figures are missing ${agg.missing.length} of the ${agg.expectedCount} expected Evident reports (${agg.missing.join(', ')}). Numbers below may be understated.</p>
       </div>`
    : '';

  const chartNote = chartWeekCount < 2
    ? `<p style="margin:8px 0 0;font-size:11px;color:${BRAND.slate}">Only ${chartWeekCount === 0 ? 'no weeks' : 'one week'} showing so far. We only recently started receiving the company-wide Evident reports these figures come from. A new point will appear here each week as more real data logs.</p>`
    : '';

  const html = `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Cormorant+Garamond:wght@600;700&family=DM+Sans:wght@400;500;600;700&family=DM+Mono:wght@400;500&display=swap" rel="stylesheet">
</head>
<body style="margin:0;padding:0;background-color:${BRAND.deep};background-image:linear-gradient(160deg,${BRAND.skyBlue} 0%,${BRAND.deep} 100%);font-family:${FONT_BODY}">
<div style="max-width:600px;margin:40px auto;background:#fff;border-radius:24px;overflow:hidden;box-shadow:0 6px 28px rgba(32,114,144,.16)">

  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
    <tr>
      <td bgcolor="${BRAND.teal}" style="background-color:${BRAND.teal};background-image:linear-gradient(135deg,${BRAND.teal},${BRAND.deep});padding:34px 36px 28px">
        <h1 style="color:#fff;margin:0;font-family:${FONT_DISPLAY};font-size:30px;font-weight:700;letter-spacing:-.01em">AIM Leadership Report</h1>
        <p style="color:rgba(255,255,255,.72);margin:12px 0 0;font-size:13px">${dateLabel} &nbsp;·&nbsp; AIM Dental Laboratory</p>
      </td>
    </tr>
  </table>

  ${missingBanner}

  <div style="padding:30px 36px 0">
    ${sectionLabel('Today')}
    ${cardRow([
      todayCard('Booked', fmtMoney(agg.companyDailyBooked), `${agg.companyDailyBookedCount} case${agg.companyDailyBookedCount === 1 ? '' : 's'}`),
      todayCard('Billed', fmtMoney(agg.companyDailyBilled)),
    ])}
  </div>

  <div style="padding:26px 36px 0">
    ${sectionLabel('This Month &amp; Year')}
    ${cardRow([
      statCard('Booked (MTD)', fmtMoney(companyMtdBooked), overrides.companyMtdBooked != null ? [overrideNote] : []),
      statCard('Billed (MTD)', fmtMoney(companyMtdBilled), overrides.companyMtdBilled != null ? [overrideNote] : [{ text: billedMtdDelta.text, cls: billedMtdDelta.cls }]),
    ])}
    <div style="height:10px"></div>
    ${cardRow([
      statCard('Booked (YTD)', fmtMoney(companyYtdBooked), [ytdNote]),
      statCard('Billed (YTD)', fmtMoney(companyYtdBilled), [ytdNote]),
    ])}
  </div>

  <div style="margin:30px 36px 0;padding:20px 22px;background:${BRAND.tealMist};border:1px solid rgba(6,186,190,.2);border-radius:16px">
    ${sectionLabel('Weekly Booked vs. Billed Revenue')}
    <img src="${chartUrl}" alt="Weekly booked vs. billed revenue chart" style="max-width:100%;border-radius:8px;display:block" />
    ${chartNote}
  </div>

  <div style="margin:32px 36px 0;padding-top:20px;border-top:1px solid ${HAIRLINE}">
    <p style="margin:0;font-size:11px;color:${BRAND.slate}">A PDF copy of this report is attached.</p>
  </div>

  <div style="margin-top:36px;background:${BRAND.tealMist};padding:18px 36px;font-size:11.5px;color:${BRAND.slate};border-top:1px solid ${HAIRLINE}">
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
    company_daily_billed_value: agg.companyDailyBilled,
  };

  return {
    subject: `AIM Leadership Report - ${dateLabel}`,
    html,
    sheetRow,
  };
}

module.exports = { buildEmail };
