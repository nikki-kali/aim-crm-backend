const test = require('node:test');
const assert = require('node:assert/strict');
const { deliverDailyReport } = require('../../src/jobs/evidentReport');

const makeFakes = (leadershipBehavior) => {
  const calls = [];
  return {
    calls,
    sendToLeadership: async () => { calls.push('leadership'); if (leadershipBehavior) throw leadershipBehavior; },
    sendPreview: async () => { calls.push('preview'); },
  };
};

test('switch off (default): only the approval preview is sent, never the leadership send', async () => {
  const f = makeFakes();
  assert.equal(await deliverDailyReport({ autoSend: false, ...f }), 'preview-sent');
  assert.deepEqual(f.calls, ['preview']);
});

test('switch on: the report goes straight to leadership', async () => {
  const f = makeFakes();
  assert.equal(await deliverDailyReport({ autoSend: true, ...f }), 'sent-to-leadership');
  assert.deepEqual(f.calls, ['leadership']);
});

test('switch on but EviSmart unavailable: nothing to leadership, the approver gets the preview instead', async () => {
  const f = makeFakes(Object.assign(new Error('no evismart'), { code: 'EVISMART_UNAVAILABLE' }));
  assert.equal(await deliverDailyReport({ autoSend: true, ...f }), 'preview-fallback');
  assert.deepEqual(f.calls, ['leadership', 'preview']);
});

test('switch on but today was already sent: nothing more is sent', async () => {
  const f = makeFakes(Object.assign(new Error('dup'), { code: 'ALREADY_SENT' }));
  assert.equal(await deliverDailyReport({ autoSend: true, ...f }), 'already-sent');
  assert.deepEqual(f.calls, ['leadership']);
});

test('switch on and an unexpected failure is not swallowed (so the run is retried), and no preview is sent', async () => {
  const f = makeFakes(new Error('boom'));
  await assert.rejects(() => deliverDailyReport({ autoSend: true, ...f }), /boom/);
  assert.deepEqual(f.calls, ['leadership']);
});
