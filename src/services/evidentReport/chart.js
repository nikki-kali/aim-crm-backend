// Builds a QuickChart.io URL for the Leadership Report's weekly
// booked/billed revenue chart. No server-side fetch and no client
// library — this is a plain GET URL that the recipient's mail client (or
// Puppeteer, during the PDF render) requests directly. Booked/billed real
// dollar figures are visible in this URL's query string to QuickChart's
// hosted service — confirmed acceptable per the design spec.

// Monday of the ISO week containing dateStr ('YYYY-MM-DD'), computed with
// Date.UTC so the result doesn't depend on the server process's own local
// timezone — pure calendar-day arithmetic, not a real moment in time. Same
// logic as salesRepDailyReport.js's mondayOfWeekEastern, duplicated here
// rather than cross-imported — matches this codebase's existing pattern of
// keeping each report pipeline's template code self-contained.
function mondayOfWeek(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  const day = date.getUTCDay();
  const diff = day === 0 ? 6 : day - 1;
  date.setUTCDate(date.getUTCDate() - diff);
  return date.toISOString().slice(0, 10);
}

function buildWeeklyRevenueChartUrl(historyRows, agg) {
  // Only chart company-wide-era rows (company_daily_booked_value is the
  // era signal — nullable/no-default, so a real value here means the row
  // was logged after this pipeline started tracking company-wide
  // figures). A pre-era row's booked_mtd_billed came from the old
  // James+William-only method, incomparable to the new figures — same
  // "no backfill" rule used elsewhere in this pipeline.
  const eraRows = (historyRows || []).filter((r) => r.date && r.company_daily_booked_value != null);

  // Group into Monday-start weeks (same week-start convention as
  // salesRepDailyReport.js). Booked = sum of each day's own
  // company_daily_booked_value within the week — a true weekly total.
  // Billed has no Evident-provided weekly figure at all (only a running
  // month-to-date total), so it's the LATEST logged row's booked_mtd_billed
  // within the week — an "MTD as of this week" snapshot rather than an
  // isolated weekly amount. This means the Billed line rises across the
  // weeks of a single month and drops back at the start of a new month
  // (MTD resetting) — an honest reflection of what Evident actually
  // provides, not a fabricated weekly-billed figure computed by subtracting
  // across a month boundary.
  const weeks = new Map(); // 'YYYY-MM-DD' (Monday) -> { booked, billedDate, billed }
  for (const r of eraRows) {
    const weekStart = mondayOfWeek(r.date);
    const bucket = weeks.get(weekStart) || { booked: 0, billedDate: null, billed: 0 };
    bucket.booked += Number(r.company_daily_booked_value || 0);
    if (!bucket.billedDate || r.date > bucket.billedDate) {
      bucket.billedDate = r.date;
      bucket.billed = Number(r.booked_mtd_billed || 0);
    }
    weeks.set(weekStart, bucket);
  }

  // Fold in today's own live figures (not yet in historyRows at build
  // time — appendRow() runs after this) into today's own week bucket.
  const todayWeek = mondayOfWeek(agg.runDate);
  const todayBucket = weeks.get(todayWeek) || { booked: 0, billedDate: null, billed: 0 };
  todayBucket.booked += Number(agg.companyDailyBooked || 0);
  todayBucket.billed = Number(agg.companyMtdBilled || 0); // today is always the most recent day
  weeks.set(todayWeek, todayBucket);

  const sortedWeeks = [...weeks.keys()].sort().slice(-12);
  const labels = sortedWeeks.map((w) =>
    'Wk of ' + new Date(`${w}T00:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
  );
  const booked = sortedWeeks.map((w) => weeks.get(w).booked);
  const billed = sortedWeeks.map((w) => weeks.get(w).billed);

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
    weekCount: sortedWeeks.length,
  };
}

// Two-point Last Month vs. This Month line comparison (user request,
// 2026-09-19, replacing the weekly line chart above — kept intact, not
// deleted, in case a weekly view is wanted again later). Both months'
// figures are passed in already resolved by the caller (buildReport.js)
// rather than computed here, same "chart.js stays a pure renderer"
// boundary as buildWeeklyRevenueChartUrl above.
function buildMonthComparisonChartUrl(lastMonth, thisMonth) {
  const config = {
    type: 'line',
    data: {
      labels: [lastMonth.label, thisMonth.label],
      datasets: [
        { label: 'Booked', data: [lastMonth.booked, thisMonth.booked], borderColor: '#06babe', backgroundColor: '#06babe', fill: false, pointRadius: 6 },
        { label: 'Billed', data: [lastMonth.billed, thisMonth.billed], borderColor: '#207290', backgroundColor: '#207290', fill: false, pointRadius: 6 },
      ],
    },
    options: { plugins: { legend: { display: true } } },
  };
  return `https://quickchart.io/chart?c=${encodeURIComponent(JSON.stringify(config))}`;
}

// Multi-point month-by-month Booked/Billed trend line (user request,
// 2026-09-19, superseding the two-point buildMonthComparisonChartUrl above
// as the report's chart — that function is kept intact, not deleted, in
// case a strict two-month comparison is wanted again later). `months` is
// an ordered array of { label, booked, billed } already resolved by the
// caller (buildReport.js) — same "chart.js stays a pure renderer" boundary
// as every other function in this file.
function buildMonthTrendChartUrl(months) {
  const config = {
    type: 'line',
    data: {
      labels: months.map((m) => m.label),
      datasets: [
        { label: 'Booked', data: months.map((m) => m.booked), borderColor: '#06babe', backgroundColor: '#06babe', fill: false, pointRadius: 5 },
        { label: 'Billed', data: months.map((m) => m.billed), borderColor: '#207290', backgroundColor: '#207290', fill: false, pointRadius: 5 },
      ],
    },
    options: { plugins: { legend: { display: true } } },
  };
  return `https://quickchart.io/chart?c=${encodeURIComponent(JSON.stringify(config))}`;
}

module.exports = { buildWeeklyRevenueChartUrl, buildMonthComparisonChartUrl, buildMonthTrendChartUrl };
