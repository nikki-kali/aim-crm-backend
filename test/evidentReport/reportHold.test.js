const test = require('node:test');
const assert = require('node:assert/strict');
process.env.CRON_SECRET = 'test-secret-value';
const { verifyHold, buildHoldUrl, holdDay, isHeld, HOLD_JOB } = require('../../src/services/reportHold');

const sigOf = (url) => new URL(url).searchParams.get('sig');

test('the hold link verifies for its own day only, and rejects tampering', () => {
  const url = buildHoldUrl('2026-09-28');
  assert.match(url, /\/api\/report-hold\?day=2026-09-28&sig=[0-9a-f]{64}$/);
  const sig = sigOf(url);
  assert.equal(verifyHold('2026-09-28', sig), true);
  assert.equal(verifyHold('2026-09-29', sig), false); // another day
  assert.equal(verifyHold('2026-09-28', sig.slice(0, -1) + (sig.endsWith('0') ? '1' : '0')), false); // tampered
  assert.equal(verifyHold('2026-09-28', 'short'), false);
  assert.equal(verifyHold('not-a-date', sig), false);
  assert.equal(verifyHold('2026-09-28', undefined), false);
});

test('without CRON_SECRET there is no hold link and nothing verifies', () => {
  const saved = process.env.CRON_SECRET;
  const sig = sigOf(buildHoldUrl('2026-09-28'));
  delete process.env.CRON_SECRET;
  assert.equal(buildHoldUrl('2026-09-28'), null);
  assert.equal(verifyHold('2026-09-28', sig), false);
  process.env.CRON_SECRET = saved;
});

test('holding a day is recorded once (idempotent) and read back as held', async () => {
  const rows = new Set();
  const query = async (sql, params) => {
    if (/INSERT/.test(sql)) { rows.add(params.join('|')); return { rows: [] }; }
    return { rows: rows.has(`${params[0]}|${params[1]}`) ? [{}] : [] };
  };
  assert.equal(await isHeld('2026-09-28', query), false);
  await holdDay('2026-09-28', query);
  await holdDay('2026-09-28', query);
  assert.equal(await isHeld('2026-09-28', query), true);
  assert.equal(await isHeld('2026-09-29', query), false);
  assert.equal(HOLD_JOB, 'evident-report-hold');
});
