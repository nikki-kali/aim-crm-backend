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
