const test = require('node:test');
const assert = require('node:assert/strict');
const { pendingDates } = require('../../src/jobs/evidentCrmSync');

// The sync catches up every day it has not applied, so Monday's run picks up
// Friday, Saturday and Sunday (a plain "yesterday" once left Friday unsynced).
test('Monday syncs Friday, Saturday and Sunday', () => {
  const applied = new Set(['2026-11-26', '2026-11-27', '2026-11-28', '2026-11-29', '2026-11-30', '2026-12-01', '2026-12-02', '2026-12-03']);
  assert.deepEqual(pendingDates('2026-12-07', applied), ['2026-12-04', '2026-12-05', '2026-12-06']);
});

test('Tuesday to Friday sync just the previous day, once the days before are applied', () => {
  const applied = new Set(['2026-11-26', '2026-11-27', '2026-11-28', '2026-11-29', '2026-11-30']);
  assert.deepEqual(pendingDates('2026-12-02', applied), ['2026-12-01']);
});
