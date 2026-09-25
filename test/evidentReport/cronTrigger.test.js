const test = require('node:test');
const assert = require('node:assert/strict');
const cronRoute = require('../../src/routes/cron');
const { claimJobRun, releaseJobRun } = require('../../src/services/cronRuns');

test('cron trigger only accepts the exact secret', () => {
  const { isAuthorized } = cronRoute;
  assert.equal(isAuthorized('s3cret', 's3cret'), true);
  assert.equal(isAuthorized('wrong!', 's3cret'), false);
  assert.equal(isAuthorized('s3cre', 's3cret'), false); // different length
  assert.equal(isAuthorized('', 's3cret'), false);
  assert.equal(isAuthorized(undefined, 's3cret'), false);
  assert.equal(isAuthorized('anything', undefined), false); // not configured: never authorized
});

test('cron trigger exposes exactly the daily jobs', () => {
  assert.deepEqual(Object.keys(cronRoute.JOBS).sort(), ['evident-crm-sync', 'evident-report', 'evident-report-send', 'sales-rep-daily-report']);
});

test('a job is claimed once per day: first caller runs it, a second is told it already ran', async () => {
  const seen = new Set();
  const query = async (sql, [job, date]) => {
    const key = `${job}|${date}`;
    if (seen.has(key)) return { rows: [] };
    seen.add(key);
    return { rows: [{ job }] };
  };
  assert.equal(await claimJobRun('evident-report', '2026-09-25', 'cron', query), true);
  assert.equal(await claimJobRun('evident-report', '2026-09-25', 'external', query), false);
  assert.equal(await claimJobRun('evident-report', '2026-09-28', 'cron', query), true); // next day is a fresh claim
});

test('if the run record is unreachable the job still runs (a missed report is worse than a duplicate preview)', async () => {
  const boom = async () => { throw new Error('db down'); };
  assert.equal(await claimJobRun('evident-crm-sync', '2026-09-25', 'cron', boom), true);
  await releaseJobRun('evident-crm-sync', '2026-09-25', boom); // must not throw
});
