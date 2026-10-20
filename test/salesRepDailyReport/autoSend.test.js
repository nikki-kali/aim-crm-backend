const test = require('node:test');
const assert = require('node:assert/strict');
const { deliverRepReports } = require('../../src/jobs/salesRepDailyReport');
const { verifyHold, buildHoldUrl } = require('../../src/services/reportHold');
const { injectApprovalBanner } = require('../../src/services/reportApproval');

const JAMES = { id: 'j', name: 'James Delaney', email: 'james@x' };
const WILLIAM = { id: 'w', name: 'William Alexander', email: 'william@x' };

// A fake world: records what happened to whom.
function world(over = {}) {
  const log = { sent: [], marked: [], released: [], alerts: [] };
  const deps = {
    held: async () => false,
    dataReady: async () => true,
    reps: [JAMES, WILLIAM],
    claimOnce: async () => true,
    takeOverLinks: async () => true,
    send: async (rep) => { log.sent.push(rep.email); },
    markSent: async (rep) => { log.marked.push(rep.email); },
    releaseOnce: async (rep) => { log.released.push(rep.email); },
    alertApprover: async (reason) => { log.alerts.push(reason); },
    ...over,
  };
  return { deps, log };
}

test('a normal day: each rep gets their report once and their links are marked sent', async () => {
  const { deps, log } = world();
  const r = await deliverRepReports(deps);
  assert.equal(r.outcome, 'done');
  assert.deepEqual(log.sent, ['james@x', 'william@x']);
  assert.deepEqual(log.marked, ['james@x', 'william@x']);
  assert.deepEqual(log.alerts, []);
});

test('held: nothing goes to any rep', async () => {
  const { deps, log } = world({ held: async () => true });
  assert.equal((await deliverRepReports(deps)).outcome, 'held-by-approver');
  assert.deepEqual(log.sent, []);
});

test("the day's figures aren't in: nothing is sent and the approver is told", async () => {
  const { deps, log } = world({ dataReady: async () => false });
  assert.equal((await deliverRepReports(deps)).outcome, 'data-not-ready');
  assert.deepEqual(log.sent, []);
  assert.equal(log.alerts.length, 1);
});

test('a rep the approver already approved (or is approving) is skipped; the other still gets theirs', async () => {
  const { deps, log } = world({ takeOverLinks: async (rep) => rep.id !== 'j' });
  const r = await deliverRepReports(deps);
  assert.equal(r.reps['james@x'], 'already-approved');
  assert.deepEqual(log.sent, ['william@x']);
});

test('a rep already handled by an earlier run that day is not sent again', async () => {
  const { deps, log } = world({ claimOnce: async (rep) => rep.id !== 'w' });
  const r = await deliverRepReports(deps);
  assert.equal(r.reps['william@x'], 'already-ran');
  assert.deepEqual(log.sent, ['james@x']);
});

test('a send failure: that rep stays used (never retried automatically), the approver is told, the other rep is unaffected', async () => {
  const { deps, log } = world({ send: async (rep) => { if (rep.id === 'j') throw new Error('mail down'); log.sent.push(rep.email); } });
  const r = await deliverRepReports(deps);
  assert.equal(r.outcome, 'partly-sent');
  assert.equal(r.reps['james@x'], 'failed');
  assert.deepEqual(log.sent, ['william@x']);
  assert.deepEqual(log.released, []); // links already taken over: fail closed
  assert.match(log.alerts[0], /James Delaney: mail down/);
});

test('a failure before the links were taken over leaves that rep free for a later run (nothing went out)', async () => {
  const { deps, log } = world({ takeOverLinks: async (rep) => { if (rep.id === 'j') throw new Error('db hiccup'); return true; } });
  await deliverRepReports(deps);
  assert.deepEqual(log.released, ['james@x']);
  assert.deepEqual(log.sent, ['william@x']);
});

test('hold links: the rep hold and the leadership hold are separate and cannot be swapped', () => {
  process.env.CRON_SECRET = 'test-secret';
  const reps = new URL(buildHoldUrl('2026-10-21', 'reps'));
  const lead = new URL(buildHoldUrl('2026-10-21'));
  assert.equal(reps.searchParams.get('kind'), 'reps');
  assert.equal(lead.searchParams.get('kind'), null); // leadership links keep their original form
  assert.equal(verifyHold('2026-10-21', reps.searchParams.get('sig'), 'reps'), true);
  assert.equal(verifyHold('2026-10-21', reps.searchParams.get('sig'), 'leadership'), false);
  assert.equal(verifyHold('2026-10-21', lead.searchParams.get('sig'), 'reps'), false);
  assert.equal(verifyHold('2026-10-21', lead.searchParams.get('sig')), true);
  assert.equal(verifyHold('2026-10-21', reps.searchParams.get('sig'), 'nonsense'), false);
});

test('the rep preview banner names the rep, the send time and the hold link', () => {
  const html = '<div style="max-width:600px;margin:40px auto;">report</div>';
  const out = injectApprovalBanner(html, { reportLabel: "James Delaney's Daily Sales Report", approveUrl: 'https://x/approve', autoSendAt: '9:00 AM ET (9:00 PM Manila)', autoSendTo: 'James', holdUrl: 'https://x/hold' });
  assert.match(out, /It goes to James automatically at <b>9:00 AM ET \(9:00 PM Manila\)<\/b>/);
  assert.match(out, /href="https:\/\/x\/hold"/);
});
