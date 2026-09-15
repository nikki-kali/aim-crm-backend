// Builds a QuickChart.io URL for the Leadership Report's 30-day
// booked/billed trend line. No server-side fetch and no client library —
// this is a plain GET URL that the recipient's mail client (or Puppeteer,
// during the PDF render) requests directly. Booked/billed real dollar
// figures are visible in this URL's query string to QuickChart's hosted
// service — confirmed acceptable per the design spec.

function buildTrendChartUrl(historyRows) {
  const rows = (historyRows || [])
    .filter((r) => r.date)
    .slice()
    .sort((a, b) => (a.date < b.date ? -1 : 1))
    .slice(-30);

  const labels = rows.map((r) =>
    new Date(`${r.date}T00:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
  );
  const booked = rows.map((r) => Number(r.booked_mtd_value));
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
