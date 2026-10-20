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
  assert.deepEqual(Object.keys(cronRoute.JOBS).sort(), ['content-approval-followup', 'evident-crm-sync', 'evident-report', 'evident-report-send', 'sales-rep-daily-report', 'sales-rep-daily-report-send', 'shot-list', 'whatsapp-post']);
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

test('n8n error alert: names the workflow and step, escapes text, links only https runs', () => {
  const { subject, html } = cronRoute.buildN8nErrorEmail({ workflow: 'AIM · 6:00 AM Leadership Dashboard preview', node: 'Run leadership preview', error: '<script>x</script> timeout', url: 'https://n8n.workflowautomate.tech/workflow/1/executions/9' });
  assert.equal(subject, 'n8n problem: AIM · 6:00 AM Leadership Dashboard preview failed');
  assert.match(html, /Run leadership preview/);
  assert.match(html, /&lt;script&gt;x&lt;\/script&gt; timeout/);
  assert.match(html, /href="https:\/\/n8n\.workflowautomate\.tech\/workflow\/1\/executions\/9"/);
  assert.doesNotMatch(cronRoute.buildN8nErrorEmail({ url: 'javascript:alert(1)' }).html, /href=/);
  assert.match(cronRoute.buildN8nErrorEmail({}).subject, /a workflow failed/);
});
