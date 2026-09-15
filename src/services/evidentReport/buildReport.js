// Builds the consolidated HTML email from the aggregate figures, computing
// day-over-day deltas against the logged history rows.

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

  const bookedMtdDelta = prior ? delta(agg.booked.mtd.value, Number(prior.booked_mtd_value)) : { text: '', cls: '' };
  const billedMtdDelta = prior ? delta(agg.booked.mtd.billed, Number(prior.booked_mtd_billed)) : { text: '', cls: '' };
  const wipDelta = prior ? delta(agg.wip.value, Number(prior.wip_value)) : { text: '', cls: '' };

  const missingBanner = agg.missing.length
    ? `<div style="background:#fff3cd;border:1px solid #ffe69c;color:#664d03;padding:10px 14px;border-radius:6px;font-size:13px;margin-bottom:16px;">
         Heads up: today's figures are missing ${agg.missing.length} of the 5 expected Evident reports (${agg.missing.join(', ')}). Numbers below may be understated.
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
  <h2 style="margin:0 0 4px;font-size:18px;">Evident Consolidated Report</h2>
  <p style="margin:0 0 18px;color:#6b7280;font-size:13px;">${dateLabel} · AIM Dental Laboratory + Kings Highway</p>
  ${missingBanner}

  <div style="display:flex;gap:12px;flex-wrap:wrap;margin-bottom:22px;">
    <div style="${tileStyle}">
      <p style="${labelStyle}">Booked (today)</p>
      <p style="${valueStyle}">${fmtMoney(agg.booked.daily.value)}</p>
      <p style="font-size:12px;color:#6b7280;margin:2px 0 0;">${agg.booked.daily.count} case${agg.booked.daily.count === 1 ? '' : 's'}</p>
    </div>
    <div style="${tileStyle}">
      <p style="${labelStyle}">Booked (MTD)</p>
      <p style="${valueStyle}">${fmtMoney(agg.booked.mtd.value)}</p>
      <p style="${deltaStyleFn(bookedMtdDelta.cls)}">${bookedMtdDelta.text}</p>
    </div>
    <div style="${tileStyle}">
      <p style="${labelStyle}">Billed (MTD)</p>
      <p style="${valueStyle}">${fmtMoney(agg.booked.mtd.billed)}</p>
      <p style="${deltaStyleFn(billedMtdDelta.cls)}">${billedMtdDelta.text}</p>
    </div>
    <div style="${tileStyle}">
      <p style="${labelStyle}">WIP (in lab)</p>
      <p style="${valueStyle}">${fmtMoney(agg.wip.value)}</p>
      <p style="${deltaStyleFn(wipDelta.cls)}">${agg.wip.cases} cases · ${wipDelta.text}</p>
    </div>
  </div>

  <h3 style="font-size:14px;margin:0 0 8px;color:#374151;">Breakdown by rep and brand</h3>
  <table style="width:100%;border-collapse:collapse;font-size:13px;">
    <tr style="background:#f3f4f6;text-align:left;">
      <th style="padding:8px 10px;border-bottom:1px solid #e5e7eb;">Segment</th>
      <th style="padding:8px 10px;border-bottom:1px solid #e5e7eb;">Booked (MTD)</th>
      <th style="padding:8px 10px;border-bottom:1px solid #e5e7eb;">Billed (MTD)</th>
      <th style="padding:8px 10px;border-bottom:1px solid #e5e7eb;">WIP (in lab)</th>
    </tr>
    <tr>
      <td style="padding:8px 10px;border-bottom:1px solid #f3f4f6;">AIM (James)</td>
      <td style="padding:8px 10px;border-bottom:1px solid #f3f4f6;">${fmtMoney(agg.booked.mtd.byRep.james.value)}</td>
      <td style="padding:8px 10px;border-bottom:1px solid #f3f4f6;">${fmtMoney(agg.booked.mtd.byRep.james.billed)}</td>
      <td style="padding:8px 10px;border-bottom:1px solid #f3f4f6;">${fmtMoney(agg.wip.byRep.james || 0)}</td>
    </tr>
    <tr>
      <td style="padding:8px 10px;border-bottom:1px solid #f3f4f6;">AIM (William)</td>
      <td style="padding:8px 10px;border-bottom:1px solid #f3f4f6;">${fmtMoney(agg.booked.mtd.byRep.william.value)}</td>
      <td style="padding:8px 10px;border-bottom:1px solid #f3f4f6;">${fmtMoney(agg.booked.mtd.byRep.william.billed)}</td>
      <td style="padding:8px 10px;border-bottom:1px solid #f3f4f6;">${fmtMoney(agg.wip.byRep.william || 0)}</td>
    </tr>
    <tr>
      <td style="padding:8px 10px;">Kings Highway (KH)</td>
      <td style="padding:8px 10px;color:#9ca3af;">N/A</td>
      <td style="padding:8px 10px;color:#9ca3af;">N/A</td>
      <td style="padding:8px 10px;">${fmtMoney(agg.wip.kh.value)}</td>
    </tr>
  </table>

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
    booked_mtd_billed: agg.booked.mtd.billed,
    booked_mtd_wip: agg.booked.mtd.wip,
    booked_mtd_value: agg.booked.mtd.value,
    wip_cases: agg.wip.cases,
    wip_value: agg.wip.value,
    aim_wip_value: agg.wip.aim.value,
    kh_wip_value: agg.wip.kh.value,
    james_wip_value: agg.wip.byRep.james || 0,
    william_wip_value: agg.wip.byRep.william || 0,
  };

  return {
    subject: `Evident Consolidated Report - ${dateLabel}`,
    html,
    sheetRow,
  };
}

module.exports = { buildEmail };
