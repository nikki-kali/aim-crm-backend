const test = require('node:test');
const assert = require('node:assert/strict');
const { buildTrendChartUrl } = require('../../src/services/evidentReport/chart');

function makeRows(n) {
  const rows = [];
  for (let i = 0; i < n; i++) {
    const d = new Date(Date.UTC(2026, 0, 1 + i));
    rows.push({
      date: d.toISOString().slice(0, 10),
      booked_mtd_value: String(1000 + i),
      booked_mtd_billed: String(500 + i),
      company_daily_booked_value: '10',
    });
  }
  return rows;
}

test('builds a QuickChart URL with a two-line Chart.js config', () => {
  const url = buildTrendChartUrl(makeRows(10));
  assert.match(url, /^https:\/\/quickchart\.io\/chart\?c=/);
  const config = JSON.parse(decodeURIComponent(url.split('?c=')[1]));
  assert.equal(config.type, 'line');
  assert.equal(config.data.datasets.length, 2);
  assert.equal(config.data.labels.length, 10);
});

test('trims to the trailing 30 rows when more history exists', () => {
  const url = buildTrendChartUrl(makeRows(45));
  const config = JSON.parse(decodeURIComponent(url.split('?c=')[1]));
  assert.equal(config.data.labels.length, 30);
  // Billed (MTD) reads booked_mtd_billed directly (no accumulation), so
  // it's the simplest series to verify the trailing-30 slice on.
  assert.equal(config.data.datasets[1].data[0], 515); // day index 15 (45-30) -> 500+15
  assert.equal(config.data.datasets[1].data[29], 544); // day index 44 -> 500+44
});

test('handles unsorted input by sorting on date before trimming', () => {
  const rows = makeRows(5).reverse();
  const url = buildTrendChartUrl(rows);
  const config = JSON.parse(decodeURIComponent(url.split('?c=')[1]));
  assert.equal(config.data.datasets[1].data[0], 500);
  assert.equal(config.data.datasets[1].data[4], 504);
});

test('excludes pre-company-wide-era rows (company_daily_booked_value null) from the chart entirely', () => {
  const rows = [
    { date: '2026-09-15', booked_mtd_value: '1902.87', booked_mtd_billed: '1124.46', company_daily_booked_value: null },
    { date: '2026-09-16', booked_mtd_value: '1902.87', booked_mtd_billed: '89442.46', company_daily_booked_value: '8065.22' },
  ];
  const url = buildTrendChartUrl(rows);
  const config = JSON.parse(decodeURIComponent(url.split('?c=')[1]));
  // Only the second (era-tagged) row should appear — the pre-migration row
  // is excluded entirely rather than plotted alongside data from a wholly
  // different, incomparable measurement method (same "no backfill" rule
  // used elsewhere in this pipeline for company_daily_booked_value itself).
  assert.equal(config.data.labels.length, 1);
  assert.equal(config.data.datasets[1].data[0], 89442.46);
});

test('Booked (MTD) line accumulates within each calendar month and resets at the month boundary', () => {
  const rows = [
    { date: '2026-01-30', booked_mtd_billed: '1000', company_daily_booked_value: '100' },
    { date: '2026-01-31', booked_mtd_billed: '1000', company_daily_booked_value: '100' },
    { date: '2026-02-01', booked_mtd_billed: '1000', company_daily_booked_value: '100' },
    { date: '2026-02-02', booked_mtd_billed: '1000', company_daily_booked_value: '100' },
  ];
  const url = buildTrendChartUrl(rows);
  const config = JSON.parse(decodeURIComponent(url.split('?c=')[1]));
  assert.deepEqual(config.data.datasets[0].data, [100, 200, 100, 200]);
});
