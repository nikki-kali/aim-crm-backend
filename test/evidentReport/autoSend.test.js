const test = require('node:test');
const assert = require('node:assert/strict');
const { deliverToLeadership } = require('../../src/jobs/evidentReport');
const { injectApprovalBanner } = require('../../src/services/reportApproval');

const fakes = (leadershipError) => {
  const calls = [];
  return {
    calls,
    sendToLeadership: async () => { calls.push('leadership'); if (leadershipError) throw leadershipError; },
    alertApprover: async (reason) => { calls.push('alert:' + reason); },
  };
};

test('switch off: nothing is sent to leadership', async () => {
  const f = fakes();
  assert.equal(await deliverToLeadership({ autoSend: false, ...f }), 'switch-off');
  assert.deepEqual(f.calls, []);
});

test('switch on: the report goes to leadership', async () => {
  const f = fakes();
  assert.equal(await deliverToLeadership({ autoSend: true, ...f }), 'sent-to-leadership');
  assert.deepEqual(f.calls, ['leadership']);
});

test('EviSmart unavailable: nothing goes to leadership and the approver is alerted', async () => {
  const f = fakes(Object.assign(new Error('no evismart'), { code: 'EVISMART_UNAVAILABLE' }));
  assert.equal(await deliverToLeadership({ autoSend: true, ...f }), 'held');
  assert.deepEqual(f.calls, ['leadership', 'alert:no evismart']);
});

test('already sent (e.g. the approver clicked Approve & Send after the 6 AM preview): nothing more is sent', async () => {
  const f = fakes(Object.assign(new Error('dup'), { code: 'ALREADY_SENT' }));
  assert.equal(await deliverToLeadership({ autoSend: true, ...f }), 'already-sent');
  assert.deepEqual(f.calls, ['leadership']);
});

test('an unexpected failure is not swallowed (the run is released so it can retry) and no alert is sent', async () => {
  const f = fakes(new Error('boom'));
  await assert.rejects(() => deliverToLeadership({ autoSend: true, ...f }), /boom/);
  assert.deepEqual(f.calls, ['leadership']);
});

test('the preview banner says when leadership gets it automatically, and keeps the Approve & Send button', () => {
  const html = '<div style="max-width:600px;margin:40px auto;background:#fff"><h1>Report</h1></div>';
  const auto = injectApprovalBanner(html, { reportLabel: 'Daily Leadership Dashboard', approveUrl: 'https://example.com/a', autoSendAt: '7:00 AM ET' });
  assert.match(auto, /goes to leadership automatically at <b>7:00 AM ET<\/b>\. Click below to send it sooner\./);
  assert.match(auto, /Approve &amp; Send/);
  assert.doesNotMatch(auto, /Nothing has been sent yet/);
  const manual = injectApprovalBanner(html, { reportLabel: 'Daily Leadership Dashboard', approveUrl: 'https://example.com/a' });
  assert.match(manual, /Nothing has been sent yet\./);
});

test('a day the approver held is skipped: nothing goes to leadership and no alert is sent', async () => {
  const f = fakes();
  assert.equal(await deliverToLeadership({ autoSend: true, isHeld: async () => true, ...f }), 'held-by-approver');
  assert.deepEqual(f.calls, []);
});

test('the preview banner shows a Hold link only when one is provided', () => {
  const html = '<div style="max-width:600px;margin:40px auto;background:#fff"><h1>Report</h1></div>';
  const withHold = injectApprovalBanner(html, { reportLabel: 'X', approveUrl: 'https://example.com/a', autoSendAt: '7:00 AM ET', holdUrl: 'https://example.com/hold?day=2026-09-28&sig=abc' });
  assert.match(withHold, /Hold today's send<\/a>/);
  assert.match(withHold, /href="https:\/\/example\.com\/hold\?day=2026-09-28&sig=abc"/);
  assert.doesNotMatch(injectApprovalBanner(html, { reportLabel: 'X', approveUrl: 'https://example.com/a' }), /Hold today's send/);
});
