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

test('an Evident email that arrives on the weekend counts as the Friday before', () => {
  const { evidentBusinessDate } = require('../../src/services/evidentReport/gmailFetch');
  const at = (iso) => Date.parse(iso);
  // Friday 13 Nov 2026's reports arrived Saturday 14 Nov (Eastern).
  assert.equal(evidentBusinessDate(at('2026-11-14T15:00:00Z'), 'Daily Booking Report - Nadine'), '2026-11-13');
  assert.equal(evidentBusinessDate(at('2026-11-15T15:00:00Z'), 'Daily Billed Report - Nadine'), '2026-11-13');
  // Weekday arrivals keep their own day, including late evening Eastern.
  assert.equal(evidentBusinessDate(at('2026-11-13T00:30:00Z'), 'Daily Booking Report - Nadine'), '2026-11-12');
  assert.equal(evidentBusinessDate(at('2026-11-13T23:00:00Z'), 'Daily Booking Report - Nadine'), '2026-11-13');
  // The next-morning arrivals report stays on the day it arrived.
  assert.equal(evidentBusinessDate(at('2026-11-14T10:00:00Z'), 'Daily Arrivals by Day - AIM CRM'), '2026-11-14');
});
