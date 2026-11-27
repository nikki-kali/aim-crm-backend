const test = require('node:test');
const assert = require('node:assert/strict');
const { sleep } = require('../../src/services/evidentReport/gmailFetch');

test('sleep resolves after approximately the requested delay', async () => {
  const start = Date.now();
  await sleep(30);
  const elapsed = Date.now() - start;
  assert.ok(elapsed >= 25, `expected at least ~30ms to pass, got ${elapsed}ms`);
});

test('sleep(0) resolves immediately without hanging the test', async () => {
  await sleep(0);
  assert.ok(true);
});

test('the EviSmart search accepts both accounts that send the report, and no other sender', () => {
  const { EVISMART_SENDERS, EVISMART_QUERY } = require('../../src/services/evidentReport/gmailFetch');
  assert.deepEqual(EVISMART_SENDERS, ['media@aimdentallab.com', 'valearningcenterphilippines@gmail.com']);
  assert.equal(EVISMART_QUERY, 'from:(media@aimdentallab.com OR valearningcenterphilippines@gmail.com) subject:"EviSmart Daily Sales Report" newer_than:5d');
});

// 2026-11-27: every Leadership Dashboard run failed with Gmail's "Quota
// exceeded ... Units per minute per user" once Evident's extra scheduled
// reports pushed the 5-day fetch past Google's per-minute limit.
test('a Gmail per-minute quota error waits and retries instead of failing the whole run', async () => {
  const { withQuotaRetry } = require('../../src/services/evidentReport/gmailFetch');
  const quota = Object.assign(new Error("Quota exceeded for quota metric 'Total Query Cost' and limit 'Units per minute per user'"), { code: 429 });
  let calls = 0;
  const waits = [];
  const result = await withQuotaRetry(async () => { calls += 1; if (calls < 3) throw quota; return 'ok'; }, { wait: async (ms) => { waits.push(ms); } });
  assert.equal(result, 'ok');
  assert.equal(calls, 3);
  assert.equal(waits.length, 2);
  assert.ok(waits.every((ms) => ms >= 60000), 'waits out the rest of the minute');
});

test('a quota error reported as 403 rateLimitExceeded is retried too', async () => {
  const { withQuotaRetry } = require('../../src/services/evidentReport/gmailFetch');
  const err = Object.assign(new Error('User Rate Limit Exceeded'), { code: 403, errors: [{ reason: 'userRateLimitExceeded' }] });
  let calls = 0;
  const result = await withQuotaRetry(async () => { calls += 1; if (calls === 1) throw err; return 'ok'; }, { wait: async () => {} });
  assert.equal(result, 'ok');
  assert.equal(calls, 2);
});

test('other Gmail errors are not retried', async () => {
  const { withQuotaRetry } = require('../../src/services/evidentReport/gmailFetch');
  let calls = 0;
  await assert.rejects(withQuotaRetry(async () => { calls += 1; throw Object.assign(new Error('invalid_grant'), { code: 400 }); }, { wait: async () => {} }), /invalid_grant/);
  assert.equal(calls, 1);
});

test('gives up after a few quota retries so a run cannot hang forever', async () => {
  const { withQuotaRetry } = require('../../src/services/evidentReport/gmailFetch');
  let calls = 0;
  await assert.rejects(withQuotaRetry(async () => { calls += 1; throw Object.assign(new Error('Quota exceeded'), { code: 429 }); }, { wait: async () => {} }), /Quota exceeded/);
  assert.equal(calls, 4);
});
