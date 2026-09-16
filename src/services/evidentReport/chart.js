// Builds a QuickChart.io URL for the Leadership Report's 30-day
// booked/billed trend line. No server-side fetch and no client library —
// this is a plain GET URL that the recipient's mail client (or Puppeteer,
// during the PDF render) requests directly. Booked/billed real dollar
// figures are visible in this URL's query string to QuickChart's hosted
// service — confirmed acceptable per the design spec.

function buildTrendChartUrl(historyRows) {
  // Only chart company-wide-era rows (company_daily_booked_value is the
  // era signal — nullable/no-default, so a real string/number here means
  // the row was logged after this pipeline started tracking company-wide
  // figures). A pre-era row's booked_mtd_billed came from the old
  // James+William-only method — an incomparable measurement, not a smaller
  // real value. Charting it next to new-era figures would draw a
  // fabricated multi-thousand-dollar "spike" on the transition day. Same
  // "no backfill" rule already used elsewhere in this pipeline — the line
  // simply starts once real company-wide data exists.
  const eraRows = (historyRows || [])
    .filter((r) => r.date && r.company_daily_booked_value != null)
    .slice()
    .sort((a, b) => (a.date < b.date ? -1 : 1));

  const rows = eraRows.slice(-30);

  const labels = rows.map((r) =>
    new Date(`${r.date}T00:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
  );

  // Booked (MTD) has no Evident-provided company-wide equivalent (same as
  // the live "Booked (MTD)" tile in buildReport.js) — reconstruct each
  // point as the running sum of that day's own company_daily_booked_value
  // within its calendar month, mirroring buildReport.js's own accumulation
  // logic. Resets at each month boundary, same as the live tile does.
  const booked = rows.map((r) => {
    const month = r.date.slice(0, 7);
    return eraRows
      .filter((er) => er.date.slice(0, 7) === month && er.date <= r.date)
      .reduce((sum, er) => sum + Number(er.company_daily_booked_value || 0), 0);
  });
  // Billed (MTD) is Evident's own pre-aggregated company-wide figure,
  // logged directly as booked_mtd_billed (the repurposed column) — a
  // simple pass-through, no accumulation needed on our side.
  const billed = rows.map((r) => Number(r.booked_mtd_billed));

  const config = {
    type: 'line',
    data: {
      labels,
      datasets: [
        { label: 'Booked (MTD)', data: booked, borderColor: '#06babe', fill: false },
        { label: 'Billed (MTD)', data: billed, borderColor: '#207290', fill: false },
      ],
    },
    options: { plugins: { legend: { display: true } } },
  };

  return `https://quickchart.io/chart?c=${encodeURIComponent(JSON.stringify(config))}`;
}

module.exports = { buildTrendChartUrl };
