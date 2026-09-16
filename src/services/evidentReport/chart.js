// Builds a QuickChart.io URL for the Leadership Report's monthly
// booked/billed revenue chart. No server-side fetch and no client
// library — this is a plain GET URL that the recipient's mail client (or
// Puppeteer, during the PDF render) requests directly. Booked/billed real
// dollar figures are visible in this URL's query string to QuickChart's
// hosted service — confirmed acceptable per the design spec.

function buildMonthlyRevenueChartUrl(historyRows, agg) {
  // Only chart company-wide-era rows (company_daily_booked_value is the
  // era signal — nullable/no-default, so a real value here means the row
  // was logged after this pipeline started tracking company-wide
  // figures). A pre-era row's booked_mtd_billed came from the old
  // James+William-only method, incomparable to the new figures — same
  // "no backfill" rule used elsewhere in this pipeline.
  const eraRows = (historyRows || []).filter((r) => r.date && r.company_daily_booked_value != null);

  // Group into calendar months. Booked = sum of each day's own
  // company_daily_booked_value within the month. Billed = the LATEST
  // logged row's booked_mtd_billed within the month (Evident's own MTD
  // figure as of that day — the last logged day of a completed month IS
  // that month's full billed total; for an in-progress month it's the
  // most recent partial total).
  const months = new Map(); // 'YYYY-MM' -> { booked, billedDate, billed }
  for (const r of eraRows) {
    const month = r.date.slice(0, 7);
    const bucket = months.get(month) || { booked: 0, billedDate: null, billed: 0 };
    bucket.booked += Number(r.company_daily_booked_value || 0);
    if (!bucket.billedDate || r.date > bucket.billedDate) {
      bucket.billedDate = r.date;
      bucket.billed = Number(r.booked_mtd_billed || 0);
    }
    months.set(month, bucket);
  }

  // Fold in today's own live figures (not yet in historyRows at build
  // time — appendRow() runs after this) into today's own month bucket.
  const todayMonth = agg.runDate.slice(0, 7);
  const todayBucket = months.get(todayMonth) || { booked: 0, billedDate: null, billed: 0 };
  todayBucket.booked += Number(agg.companyDailyBooked || 0);
  todayBucket.billed = Number(agg.companyMtdBilled || 0); // today is always the most recent day
  months.set(todayMonth, todayBucket);

  const sortedMonths = [...months.keys()].sort().slice(-12);
  const labels = sortedMonths.map((m) => {
    const [y, mo] = m.split('-').map(Number);
    return new Date(Date.UTC(y, mo - 1, 1)).toLocaleDateString('en-US', { month: 'short', year: '2-digit' });
  });
  const booked = sortedMonths.map((m) => months.get(m).booked);
  const billed = sortedMonths.map((m) => months.get(m).billed);

  const config = {
    type: 'line',
    data: {
      labels,
      datasets: [
        { label: 'Booked', data: booked, borderColor: '#06babe', fill: false },
        { label: 'Billed', data: billed, borderColor: '#207290', fill: false },
      ],
    },
    options: { plugins: { legend: { display: true } } },
  };

  return {
    url: `https://quickchart.io/chart?c=${encodeURIComponent(JSON.stringify(config))}`,
    monthCount: sortedMonths.length,
  };
}

module.exports = { buildMonthlyRevenueChartUrl };
