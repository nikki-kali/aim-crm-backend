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
  // Ascending order — oldest of the trailing 30 first, most recent last.
  assert.equal(config.data.datasets[0].data[0], 1015); // day index 15 (45-30)
  assert.equal(config.data.datasets[0].data[29], 1044); // day index 44
});

test('handles unsorted input by sorting on date before trimming', () => {
  const rows = makeRows(5).reverse();
  const url = buildTrendChartUrl(rows);
  const config = JSON.parse(decodeURIComponent(url.split('?c=')[1]));
  assert.equal(config.data.datasets[0].data[0], 1000);
  assert.equal(config.data.datasets[0].data[4], 1004);
});
