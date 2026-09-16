const test = require('node:test');
const assert = require('node:assert/strict');
const { buildMonthlyRevenueChartUrl } = require('../../src/services/evidentReport/chart');

test('builds a QuickChart line config with monthly data plus today', () => {
  const historyRows = [
    { date: '2026-09-14', booked_mtd_billed: '1000', company_daily_booked_value: '500' },
    { date: '2026-09-15', booked_mtd_billed: '1500', company_daily_booked_value: '300' },
  ];
  const agg = { runDate: '2026-09-16', companyDailyBooked: 200, companyMtdBilled: 2000 };
  const { url, monthCount } = buildMonthlyRevenueChartUrl(historyRows, agg);

  assert.match(url, /^https:\/\/quickchart\.io\/chart\?c=/);
  const config = JSON.parse(decodeURIComponent(url.split('?c=')[1]));
  assert.equal(config.type, 'line');
  assert.equal(config.data.datasets.length, 2);
  assert.equal(config.data.labels.length, 1); // all rows fall in September -> 1 month
  assert.equal(monthCount, 1);
  // Booked: 500 + 300 (history) + 200 (today) = 1000
  assert.equal(config.data.datasets[0].data[0], 1000);
  // Billed: today's companyMtdBilled is the most recent day in the month = 2000
  assert.equal(config.data.datasets[1].data[0], 2000);
});

test('groups into separate months and takes the latest billed figure per month', () => {
  const historyRows = [
    { date: '2026-07-30', booked_mtd_billed: '5000', company_daily_booked_value: '1000' },
    { date: '2026-07-31', booked_mtd_billed: '6000', company_daily_booked_value: '1000' }, // last day of July
    { date: '2026-08-15', booked_mtd_billed: '3000', company_daily_booked_value: '2000' },
  ];
  const agg = { runDate: '2026-08-16', companyDailyBooked: 500, companyMtdBilled: 3500 };
  const { url, monthCount } = buildMonthlyRevenueChartUrl(historyRows, agg);
  const config = JSON.parse(decodeURIComponent(url.split('?c=')[1]));

  assert.equal(monthCount, 2);
  assert.deepEqual(config.data.labels, ['Jul 26', 'Aug 26']);
  // July booked: 1000+1000=2000, billed: last logged July row (07-31) = 6000.
  // August booked: 2000 (history) + 500 (today) = 2500, billed: today's
  // companyMtdBilled (3500) overrides the 08-15 partial (3000) — today is
  // always the most recent day in its month.
  assert.deepEqual(config.data.datasets[0].data, [2000, 2500]);
  assert.deepEqual(config.data.datasets[1].data, [6000, 3500]);
});

test('excludes pre-company-wide-era rows (company_daily_booked_value null) from the chart entirely', () => {
  const historyRows = [
    { date: '2026-09-10', booked_mtd_billed: '1124.46', company_daily_booked_value: null },
  ];
  const agg = { runDate: '2026-09-16', companyDailyBooked: 8065.22, companyMtdBilled: 89442.46 };
  const { url, monthCount } = buildMonthlyRevenueChartUrl(historyRows, agg);
  const config = JSON.parse(decodeURIComponent(url.split('?c=')[1]));

  // Only today's month counts — the pre-migration row is excluded entirely
  // rather than plotted alongside data from an incomparable measurement
  // method (same "no backfill" rule used elsewhere in this pipeline).
  assert.equal(monthCount, 1);
  assert.deepEqual(config.data.labels, ['Sep 26']);
  assert.equal(config.data.datasets[0].data[0], 8065.22);
  assert.equal(config.data.datasets[1].data[0], 89442.46);
});

test('trims to the trailing 12 months when more history exists', () => {
  const historyRows = [];
  for (let m = 1; m <= 15; m++) {
    const y = 2025 + Math.floor((m - 1) / 12);
    const mo = ((m - 1) % 12) + 1;
    const dateStr = `${y}-${String(mo).padStart(2, '0')}-05`;
    historyRows.push({ date: dateStr, booked_mtd_billed: String(1000 + m), company_daily_booked_value: String(100 + m) });
  }
  const agg = { runDate: '2027-04-20', companyDailyBooked: 0, companyMtdBilled: 0 };
  const { url, monthCount } = buildMonthlyRevenueChartUrl(historyRows, agg);
  const config = JSON.parse(decodeURIComponent(url.split('?c=')[1]));

  assert.equal(monthCount, 12);
  assert.equal(config.data.labels.length, 12);
});
