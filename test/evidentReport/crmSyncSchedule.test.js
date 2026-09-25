const test = require('node:test');
const assert = require('node:assert/strict');
const { datesToSync } = require('../../src/jobs/evidentCrmSync');

test('Monday syncs Friday, Saturday and Sunday (a plain "yesterday" left Friday unsynced)', () => {
  assert.deepEqual(datesToSync('2026-09-21'), ['2026-09-18', '2026-09-19', '2026-09-20']);
  // Across a month boundary.
  assert.deepEqual(datesToSync('2026-11-02'), ['2026-10-30', '2026-10-31', '2026-11-01']);
});

test('Tuesday to Friday sync just the previous day', () => {
  assert.deepEqual(datesToSync('2026-09-22'), ['2026-09-21']); // Tue
  assert.deepEqual(datesToSync('2026-09-23'), ['2026-09-22']); // Wed
  assert.deepEqual(datesToSync('2026-09-24'), ['2026-09-23']); // Thu
  assert.deepEqual(datesToSync('2026-09-25'), ['2026-09-24']); // Fri
});
