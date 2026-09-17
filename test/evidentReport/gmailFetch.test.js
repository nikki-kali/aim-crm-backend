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
