// Builds the consolidated HTML email from the aggregate figures, computing
// day-over-day deltas against the logged history rows.

const { buildTrendChartUrl } = require('./chart');

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

function buildEmail(agg, historyRows = []) {
  const prior = historyRows
    .filter((r) => r.date && r.date < agg.runDate)
    .sort((a, b) => (a.date < b.date ? 1 : -1))[0];

  // Booked (MTD) has no Evident-provided company-wide equivalent — we
  // accumulate it ourselves from each day's own company-wide "Booked
  // (Today)" figure, logged daily. Sum every history row in the same
  // calendar month as today, plus today's own value (not yet in
  // historyRows at build time — appendRow() runs after this).
  const runMonth = agg.runDate.slice(0, 7); // 'YYYY-MM'
  const mtdBookedFromHistory = historyRows
    .filter((r) => r.date && r.date.slice(0, 7) === runMonth)
    .reduce((sum, r) => sum + Number(r.company_daily_booked_value || 0), 0);
  const companyMtdBooked = mtdBookedFromHistory + agg.companyDailyBooked;

  const bookedMtdDelta = prior ? delta(agg.booked.mtd.value, Number(prior.booked_mtd_value)) : { text: '', cls: '' };
  // Billed (MTD) now reads Evident's own company-wide "Daily MTD Total
  // Billed" figure instead of the James+William-only sum. A `prior` row
  // whose company_daily_booked_value is NULL predates this change (the
  // column is nullable with no default specifically so this check works —
  // see the migration's own comment) — its booked_mtd_billed value is
  // from the OLD, much-smaller data source, so comparing against it would
  // render a fabricated multi-thousand-dollar "spike" on the very first
  // day this ships. Same guard pattern already proven for ytd_billed_value.
  const billedMtdDelta = prior && prior.company_daily_booked_value != null
    ? delta(agg.companyMtdBilled, Number(prior.booked_mtd_billed))
    : { text: '', cls: '' };
  // `ytd_billed_value` is a newly-added column — production's one existing
  // log row (from before this column existed) has it at the column
  // default of 0, unbackfilled (deliberate, per the design spec's "no
  // backfill" decision). Treat a zero/missing prior specifically for this
  // tile as "no prior data" rather than computing a delta against 0, which
  // would render a fabricated, misleading spike on the first real run.
  // Self-heals once a second row with a genuine nonzero value exists.
  const ytdBilledDelta = prior && Number(prior.ytd_billed_value) > 0 ? delta(agg.booked.ytd.billed, Number(prior.ytd_billed_value)) : { text: '', cls: '' };

  const missingBanner = agg.missing.length
    ? `<div style="background:#fff3cd;border:1px solid #ffe69c;color:#664d03;padding:10px 14px;border-radius:6px;font-size:13px;margin-bottom:16px;">
         Heads up: today's figures are missing ${agg.missing.length} of the ${agg.expectedCount} expected Evident reports (${agg.missing.join(', ')}). Numbers below may be understated.
       </div>`
    : '';

  const dateLabel = new Date(`${agg.runDate}T00:00:00Z`).toLocaleDateString('en-US', {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    year: 'numeric',
  });

  const tileStyle = 'flex:1;min-width:150px;background:#f8f9fa;border:1px solid #e5e7eb;border-radius:8px;padding:14px 16px;';
  const labelStyle = 'font-size:12px;color:#6b7280;text-transform:uppercase;letter-spacing:.03em;margin:0 0 4px;';
  const valueStyle = 'font-size:22px;font-weight:600;color:#111827;margin:0;';
  const deltaStyleFn = (cls) => {
    const color = cls === 'up' ? '#059669' : cls === 'down' ? '#dc2626' : '#6b7280';
    return `font-size:12px;color:${color};margin:4px 0 0;`;
  };

  const html = `
<div style="font-family:Arial,Helvetica,sans-serif;max-width:640px;margin:0 auto;color:#111827;">
  <h2 style="margin:0 0 4px;font-size:18px;">AIM Leadership Report</h2>
  <p style="margin:0 0 18px;color:#6b7280;font-size:13px;">${dateLabel} · AIM Dental Laboratory + Kings Highway</p>
  ${missingBanner}

  <div style="display:flex;gap:14px;margin-bottom:16px;">
    <div style="flex:1;background-color:#e6f9f9;background-image:linear-gradient(160deg,#e6f9f9,#eaf3f7);border:1px solid #06babe;border-radius:12px;padding:20px 22px;">
      <p style="margin:0 0 6px;font-size:12px;font-weight:700;color:#207290;text-transform:uppercase;letter-spacing:.04em;">Booked (Today)</p>
      <p style="margin:0;font-size:36px;font-weight:700;color:#06babe;letter-spacing:-.01em;">${fmtMoney(agg.companyDailyBooked)}</p>
      <p style="margin:6px 0 0;font-size:13px;color:#374151;">${agg.companyDailyBookedCount} case${agg.companyDailyBookedCount === 1 ? '' : 's'}</p>
    </div>
    <div style="flex:1;background-color:#e6f9f9;background-image:linear-gradient(160deg,#e6f9f9,#eaf3f7);border:1px solid #06babe;border-radius:12px;padding:20px 22px;">
      <p style="margin:0 0 6px;font-size:12px;font-weight:700;color:#207290;text-transform:uppercase;letter-spacing:.04em;">Billed (Today)</p>
      <p style="margin:0;font-size:36px;font-weight:700;color:#06babe;letter-spacing:-.01em;">${fmtMoney(agg.companyDailyBilled)}</p>
    </div>
  </div>

  <div style="display:flex;gap:12px;flex-wrap:wrap;margin-bottom:22px;">
    <div style="${tileStyle}">
      <p style="${labelStyle}">Booked (MTD)</p>
      <p style="${valueStyle}">${fmtMoney(companyMtdBooked)}</p>
    </div>
    <div style="${tileStyle}">
      <p style="${labelStyle}">Billed (MTD)</p>
      <p style="${valueStyle}">${fmtMoney(agg.companyMtdBilled)}</p>
      <p style="${deltaStyleFn(billedMtdDelta.cls)}">${billedMtdDelta.text}</p>
    </div>
    <div style="${tileStyle}">
      <p style="${labelStyle}">Billed (YTD)</p>
      <p style="${valueStyle}">${fmtMoney(agg.booked.ytd.billed)}</p>
      <p style="${deltaStyleFn(ytdBilledDelta.cls)}">${ytdBilledDelta.text}</p>
    </div>
  </div>

  <h3 style="font-size:14px;margin:0 0 8px;color:#374151;">30-Day Booked vs. Billed Trend</h3>
  <img src="${buildTrendChartUrl(historyRows)}" alt="30-day booked vs. billed trend chart" style="max-width:100%;border:1px solid #e5e7eb;border-radius:8px;margin-bottom:22px;" />

  <p style="font-size:11px;color:#9ca3af;margin-top:22px;">
    A PDF copy of this report is attached.
  </p>
</div>
`.trim();

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
  };

  return {
    subject: `AIM Leadership Report - ${dateLabel}`,
    html,
    sheetRow,
  };
}

module.exports = { buildEmail };
