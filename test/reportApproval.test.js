const test = require('node:test');
const assert = require('node:assert/strict');
const { injectApprovalBanner } = require('../src/services/reportApproval');
const { buildCombinedLeadershipEmail } = require('../src/services/evidentReport/buildReport');
const { parseAndAggregate } = require('../src/services/evidentReport/parseEvident');

const SAMPLE_HTML = `<!DOCTYPE html>
<html><body>
<div style="max-width:600px;margin:40px auto;background:#fff;border-radius:24px;overflow:hidden;box-shadow:0 6px 28px rgba(32,114,144,.16)">
  <h1>Report content</h1>
</div>
</body></html>`;

test('injectApprovalBanner inserts the Approve & Send button right inside the report card', () => {
  const html = injectApprovalBanner(SAMPLE_HTML, { reportLabel: 'AIM Leadership Report', approveUrl: 'https://example.com/approve?token=abc' });
  assert.match(html, /Approve &amp; Send/);
  assert.match(html, /href="https:\/\/example\.com\/approve\?token=abc"/);
  assert.match(html, /AIM Leadership Report/);
  // Banner appears before the report's own content, not after.
  const bannerIndex = html.indexOf('Approve &amp; Send');
  const contentIndex = html.indexOf('Report content');
  assert.ok(bannerIndex < contentIndex, 'banner should appear before the report content');
});

test('injectApprovalBanner leaves the html untouched if the expected wrapper is missing (defensive, never drops the report)', () => {
  const withoutWrapper = '<html><body><h1>No wrapper here</h1></body></html>';
  const html = injectApprovalBanner(withoutWrapper, { reportLabel: 'X', approveUrl: 'https://example.com' });
  assert.equal(html, withoutWrapper);
});

test('injectApprovalBanner HTML-escapes reportLabel (it can carry a rep name/email pulled from the CRM, not a trusted constant)', () => {
  const html = injectApprovalBanner(SAMPLE_HTML, {
    reportLabel: `<script>alert('xss')</script>`,
    approveUrl: 'https://example.com/approve?token=abc',
  });
  assert.ok(!html.includes('<script>alert'), 'raw script tag must not appear unescaped');
  assert.match(html, /&lt;script&gt;alert\(&#39;xss&#39;\)&lt;\/script&gt;/);
});

test('injectApprovalBanner adds the Approve & Send button to the real Daily Leadership Dashboard (its restyled card once made the button silently vanish)', () => {
  const agg = parseAndAggregate([], { runDate: '2026-09-22' });
  agg.eviSmart = null;
  const { html } = buildCombinedLeadershipEmail(agg, [], [], {});
  const bannered = injectApprovalBanner(html, { reportLabel: 'Daily Leadership Dashboard', approveUrl: 'https://example.com/approve?token=abc' });
  assert.match(bannered, /Approve &amp; Send/);
  assert.ok(bannered.indexOf('Approve &amp; Send') < bannered.indexOf('Daily Leadership Dashboard</h1>') || bannered.indexOf('Approve &amp; Send') < bannered.indexOf('Sales Performance by Representative'));
});
