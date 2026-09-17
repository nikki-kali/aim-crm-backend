const test = require('node:test');
const assert = require('node:assert/strict');
const { buildWeeklyRevenueChartUrl } = require('../../src/services/evidentReport/chart');

test('builds a QuickChart line config with weekly data plus today', () => {
  // 2026-09-14/15/16 are Mon/Tue/Wed of the same ISO week.
  const historyRows = [
    { date: '2026-09-14', booked_mtd_billed: '1000', company_daily_booked_value: '500' },
    { date: '2026-09-15', booked_mtd_billed: '1500', company_daily_booked_value: '300' },
  ];
  const agg = { runDate: '2026-09-16', companyDailyBooked: 200, companyMtdBilled: 2000 };
  const { url, weekCount } = buildWeeklyRevenueChartUrl(historyRows, agg);

  assert.match(url, /^https:\/\/quickchart\.io\/chart\?c=/);
  const config = JSON.parse(decodeURIComponent(url.split('?c=')[1]));
  assert.equal(config.type, 'line');
  assert.equal(config.data.datasets.length, 2);
  assert.equal(config.data.labels.length, 1); // all rows fall in the same Mon-Sun week -> 1 week
  assert.equal(weekCount, 1);
  assert.equal(config.data.labels[0], 'Wk of Sep 14');
  // Booked: 500 + 300 (history) + 200 (today) = 1000
  assert.equal(config.data.datasets[0].data[0], 1000);
  // Billed: today's companyMtdBilled is the most recent day in the week = 2000
  assert.equal(config.data.datasets[1].data[0], 2000);
});

test('groups into separate weeks and takes the latest billed figure per week', () => {
  // 2026-09-19/20 are Sat/Sun of the week starting Mon 2026-09-14.
  // 2026-09-21/22 are Mon/Tue of the following week.
  const historyRows = [
    { date: '2026-09-19', booked_mtd_billed: '5000', company_daily_booked_value: '1000' },
    { date: '2026-09-20', booked_mtd_billed: '6000', company_daily_booked_value: '1000' },
    { date: '2026-09-21', booked_mtd_billed: '3000', company_daily_booked_value: '2000' },
  ];
  const agg = { runDate: '2026-09-22', companyDailyBooked: 500, companyMtdBilled: 3500 };
  const { url, weekCount } = buildWeeklyRevenueChartUrl(historyRows, agg);
  const config = JSON.parse(decodeURIComponent(url.split('?c=')[1]));

  assert.equal(weekCount, 2);
  assert.deepEqual(config.data.labels, ['Wk of Sep 14', 'Wk of Sep 21']);
  // Week of Sep 14: booked 1000+1000=2000, billed = last logged row that week (09-20) = 6000.
  // Week of Sep 21: booked 2000 (history) + 500 (today) = 2500, billed: today's
  // companyMtdBilled (3500) overrides the 09-21 partial (3000) — today is
  // always the most recent day in its week.
  assert.deepEqual(config.data.datasets[0].data, [2000, 2500]);
  assert.deepEqual(config.data.datasets[1].data, [6000, 3500]);
});

test('excludes pre-company-wide-era rows (company_daily_booked_value null) from the chart entirely', () => {
  const historyRows = [
    { date: '2026-09-10', booked_mtd_billed: '1124.46', company_daily_booked_value: null },
  ];
  const agg = { runDate: '2026-09-16', companyDailyBooked: 8065.22, companyMtdBilled: 89442.46 };
  const { url, weekCount } = buildWeeklyRevenueChartUrl(historyRows, agg);
  const config = JSON.parse(decodeURIComponent(url.split('?c=')[1]));

  // Only today's week counts — the pre-migration row is excluded entirely
  // rather than plotted alongside data from an incomparable measurement
  // method (same "no backfill" rule used elsewhere in this pipeline).
  assert.equal(weekCount, 1);
  assert.deepEqual(config.data.labels, ['Wk of Sep 14']);
  assert.equal(config.data.datasets[0].data[0], 8065.22);
  assert.equal(config.data.datasets[1].data[0], 89442.46);
});

test('trims to the trailing 12 weeks when more history exists', () => {
  const historyRows = [];
  for (let w = 0; w < 15; w++) {
    // 2026-01-05 is a Monday; stepping by 7 days lands on a fresh Monday each time.
    const d = new Date(Date.UTC(2026, 0, 5 + w * 7));
    const dateStr = d.toISOString().slice(0, 10);
    historyRows.push({ date: dateStr, booked_mtd_billed: String(1000 + w), company_daily_booked_value: String(100 + w) });
  }
  const agg = { runDate: '2026-12-31', companyDailyBooked: 0, companyMtdBilled: 0 };
  const { url, weekCount } = buildWeeklyRevenueChartUrl(historyRows, agg);
  const config = JSON.parse(decodeURIComponent(url.split('?c=')[1]));

  assert.equal(weekCount, 12);
  assert.equal(config.data.labels.length, 12);
});
