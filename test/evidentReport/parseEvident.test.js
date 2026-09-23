const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { parseAndAggregate, extractDailyBookedCustomerNames, extractCaseTotals, extractBookingRows, extractBilledRows, extractEviSmartTotals } = require('../../src/services/evidentReport/parseEvident');
const { buildReport1Email, buildReport2Email, buildReport3Email, buildCombinedLeadershipEmail } = require('../../src/services/evidentReport/buildReport');

function fixture(name) {
  return fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf-8');
}

// These fixtures are real emails pulled from media@aimdentallab.com
// (Sept 10-12 2026, plus 3 company-wide report types added 2026-09-16,
// plus a 4th — MTD Booked Daily Update — that started arriving
// 2026-09-16 too), not synthetic data - the numbers asserted below are
// the actual totals Evident sent (the MTD Booked Daily Update fixture is
// a trimmed-down real-shaped sample, not the full real row list, but its
// header/totals-row structure matches the real email exactly).
const ALL_MESSAGES = [
  { subject: "Daily Booked Cases - James' Doctors", html: fixture('daily-booked-james.html') },
  { subject: "Daily Booked Cases - William's Doctors", html: fixture('daily-booked-william-nodata.html') },
  { subject: "MTD Booked Cases - James' Doctors", html: fixture('mtd-booked-james.html') },
  { subject: "MTD Booked Cases - William's Doctors", html: fixture('mtd-booked-william.html') },
  { subject: 'Cases Currently In Progress', html: fixture('wip-cases-in-progress.html') },
  { subject: "YTD Booked Cases - James' Doctors", html: fixture('ytd-booked-james.html') },
  { subject: "YTD Booked Cases - William's Doctors", html: fixture('ytd-booked-william.html') },
  { subject: 'Daily Booking Report - Nadine', html: fixture('company-daily-booked-nadine.html') },
  { subject: 'Daily Billed Report - Nadine', html: fixture('company-daily-billed-nadine.html') },
  { subject: 'Daily MTD Total Billed', html: fixture('company-mtd-total-billed.html') },
  { subject: 'MTD Booked Daily Update', html: fixture('company-mtd-booked-daily-update.html') },
];

test('parses and combines all 11 report types correctly', () => {
  const agg = parseAndAggregate(ALL_MESSAGES, { runDate: '2026-09-11' });

  assert.equal(agg.missing.length, 0);

  // Daily: only James had a booking (1 case, $117 WIP, $0 billed); William had none.
  assert.equal(agg.booked.daily.count, 1);
  assert.equal(agg.booked.daily.billed, 0);
  assert.equal(agg.booked.daily.value, 117);

  // MTD: James 8 cases/$501 billed/$1061.91 WIP, William 4 cases/$77.49 billed/$262.47 WIP.
  assert.equal(agg.booked.mtd.count, 12);
  assert.equal(agg.booked.mtd.billed, 578.49);
  assert.equal(agg.booked.mtd.wip, 1324.38);
  assert.equal(Math.round(agg.booked.mtd.value * 100) / 100, 1902.87);

  // YTD: James 36 cases/$3866.85 billed/$515.94 WIP, William 38 cases/$4152.28 billed/$262.47 WIP.
  assert.equal(agg.booked.ytd.count, 74);
  assert.equal(Math.round(agg.booked.ytd.billed * 100) / 100, 8019.13);
  assert.equal(Math.round(agg.booked.ytd.wip * 100) / 100, 778.41);
  assert.equal(Math.round(agg.booked.ytd.value * 100) / 100, 8797.54);
  assert.equal(agg.booked.ytd.byRep.james.count, 36);
  assert.equal(agg.booked.ytd.byRep.william.count, 38);

  // WIP: 382 cases / $46,709.54 total, split AIM 166/$16,756.54 and KH 216/$29,953.
  assert.equal(agg.wip.cases, 382);
  assert.equal(agg.wip.value, 46709.54);
  assert.equal(agg.wip.kh.cases, 216);
  assert.equal(agg.wip.kh.value, 29953);
  assert.equal(agg.wip.aim.cases, 166);
  assert.equal(Math.round(agg.wip.aim.value * 100) / 100, 16756.54);
  assert.equal(agg.wip.byRep.james, 1061.91);
  assert.equal(agg.wip.byRep.william, 262.47);

  // Company-wide totals — real numbers from the 2026-09-16 Evident inbox.
  assert.equal(agg.companyDailyBooked, 8065.22);
  assert.equal(agg.companyDailyBookedCount, 94);
  assert.equal(agg.companyDailyBilled, 1622.74);
  assert.equal(agg.companyMtdBilled, 89442.46);
  assert.equal(agg.companyMtdBooked, 6935);
});

test('parseAndAggregate exposes companyDailyBookedRows for the Leadership Report customer-detail table', () => {
  const agg = parseAndAggregate(ALL_MESSAGES, { runDate: '2026-09-11' });
  assert.equal(agg.companyDailyBookedRows.length, 94);
  assert.deepEqual(agg.companyDailyBookedRows[0], { ref: '5569', customerName: 'SUNSET TERRACE', value: 0, salesperson: '' });
  assert.deepEqual(agg.companyDailyBookedRows[93], { ref: '5663', customerName: 'Dr. ALBERTO GONZALEZ', value: 0, salesperson: 'william' });
});

test("Today's Booked Cases table aggregates by customer (matches Evident's real Report 13 format), HTML-escaped, and is omitted when there are none", () => {
  const agg = parseAndAggregate(ALL_MESSAGES, { runDate: '2026-09-11' });
  const { html } = buildReport1Email(agg, []);
  // 94 real rows collapse to 47 unique customers (format confirmed
  // 2026-09-18 against a real "EviSmart Report Totals" email showing
  // Evident's own Report 13 aggregates the same way).
  assert.match(html, /Today's Booked Cases \(94 cases, 47 customers\)/);
  assert.match(html, />SUNSET TERRACE</);
  // SUNSET TERRACE has 9 real cases totaling $336.90 — the aggregated
  // count/value, not any single row's own value.
  assert.match(html, />SUNSET TERRACE<[\s\S]{0,300}?>9<[\s\S]{0,300}?\$336\.90/);
  assert.match(html, />Dr\. ALBERTO GONZALEZ</);

  const emptyAgg = { ...agg, companyDailyBookedRows: [] };
  const { html: emptyHtml } = buildReport1Email(emptyAgg, []);
  assert.doesNotMatch(emptyHtml, /Today's Booked Cases/);
});

test("Today's Booked Cases table HTML-escapes customer names (not a trusted constant — real Evident data)", () => {
  const agg = parseAndAggregate(ALL_MESSAGES, { runDate: '2026-09-11' });
  const withMaliciousName = {
    ...agg,
    companyDailyBookedRows: [{ ref: '1', customerName: '<script>alert(1)</script>', value: 10, salesperson: '' }],
  };
  const { html } = buildReport1Email(withMaliciousName, []);
  assert.doesNotMatch(html, /<script>alert\(1\)<\/script>/);
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
});

test('Report #1 renders Daily/MTD/YTD Booked+Billed straight from a real EviSmart Daily Sales Report, plus the $2.7M YTD goal bar', () => {
  const agg = parseAndAggregate(ALL_MESSAGES, { runDate: '2026-09-23' });
  agg.eviSmart = extractEviSmartTotals(fixture('evismart-daily-sales-report.html'));
  const { html } = buildReport1Email(agg);

  assert.match(html, /\$0\.00/); // Daily Booked value
  assert.match(html, />0 cases</); // Daily Booked count
  assert.match(html, /\$124\.00/); // Daily Billed
  assert.match(html, /\$121,610\.28/); // MTD Booked value
  assert.match(html, /1,292 cases/); // MTD Booked count
  assert.match(html, /\$124,786\.97/); // MTD Billed
  assert.match(html, /\$337,992\.27/); // YTD Billed (raw EviSmart figure, no legacy adjustment)
  // YTD Sales Value Total: 388621.46 (EviSmart) + 1243759 (legacy) = 1632380.46.
  assert.match(html, /\$1,632,380\.46/);
  assert.match(html, /Includes \$1,243,759 from the previous system/);
  // $2.7M goal bar, reusing the same goalBar component per-rep goals use.
  assert.match(html, /\$2\.7M YTD Sales Value Total Goal/);
  assert.match(html, /\$1,632,380\.46 \/ \$2,700,000\.00 \(60%\)/);
  assert.match(html, /\$1,067,619\.54 remaining to reach target/);
});

test('Report #1 shows "N/A" (not a fabricated $0) with a clear notice when today\'s EviSmart pull is unavailable', () => {
  const agg = parseAndAggregate(ALL_MESSAGES, { runDate: '2026-09-19' });
  agg.eviSmart = null; // a real "could not run (not logged in)" day
  const { html } = buildReport1Email(agg);

  assert.match(html, /today's EviSmart Daily Sales Report pull didn't come through/);
  assert.match(html, />N\/A</);
  assert.doesNotMatch(html, /\$2\.7M YTD Sales Value Total Goal/); // no fabricated goal progress either
});

test('parseAndAggregate exposes real per-rep MTD columns and Daily Billed rows for Report #2', () => {
  const agg = parseAndAggregate(ALL_MESSAGES, { runDate: '2026-09-11' });
  assert.deepEqual(agg.companyMtdBookedByRep, { na: 6935, james: 0, william: 0 });
  assert.deepEqual(agg.companyMtdBilledByRep, { na: 87486.04, james: 1458.97, william: 497.45 });
  assert.equal(agg.companyDailyBilledRows.length, 34);
});

test('By Sales Rep section (Report #2) renders real per-rep daily and MTD figures', () => {
  const agg = parseAndAggregate(ALL_MESSAGES, { runDate: '2026-09-11' });
  const { html } = buildReport2Email(agg);

  assert.match(html, /By Sales Rep/);
  assert.match(html, /James Delaney/);
  assert.match(html, /William Alexander/);
  // Real fixture: William has exactly 1 booked case (Dr. Alberto Gonzalez,
  // $0) and 1 billed case ($0) attributed to him; James has none of either.
  // Rendered as a compact mini stat card: count, then value inline.
  assert.match(html, />1 <span[\s\S]{0,100}?\$0\.00/);
  // Real per-rep MTD columns straight from Evident's own totals row.
  assert.match(html, /\$1,458\.97/); // James MTD Billed
  assert.match(html, /\$497\.45/); // William MTD Billed
});

test('By Sales Rep MTD columns show "-" (not a fabricated $0) when the report has no per-rep breakdown', () => {
  const messagesWithoutMtdBooked = ALL_MESSAGES.filter((m) => m.subject !== 'MTD Booked Daily Update');
  const agg = parseAndAggregate(messagesWithoutMtdBooked, { runDate: '2026-09-11' });
  assert.equal(agg.companyMtdBookedByRep, null);
  const { html } = buildReport2Email(agg);
  assert.match(html, /"-" = no per-rep MTD breakdown today/);
});

test('Goal Progress section (Report #3) renders real goal data passed in by the caller and is omitted when there are none', () => {
  const agg = parseAndAggregate(ALL_MESSAGES, { runDate: '2026-09-11' });
  const repGoals = [
    {
      repName: 'James Delaney',
      goals: [
        { title: '36 New Doctors by Dec 2026', metric: 'new_doctors', target: 36, current_value: 3, progress_pct: 8 },
        { title: '$30K Monthly Sales - September 2026', metric: 'monthly_revenue', target: 30000, current_value: 12450, progress_pct: 42 },
      ],
    },
    { repName: 'William Alexander', goals: [] },
  ];
  const { html } = buildReport3Email(agg, [], repGoals);

  assert.match(html, /Goal Progress/);
  assert.match(html, /James Delaney/);
  assert.match(html, /36 New Doctors by Dec 2026/);
  assert.match(html, /3 \/ 36 \(8%\)/);
  assert.match(html, /\$12,450\.00 \/ \$30,000\.00 \(42%\)/);
  // Remaining-to-target (Ben Silberstein's formal spec, 2026-09-19):
  // 36 - 3 = 33 doctors remaining; $30,000 - $12,450 = $17,550 remaining.
  assert.match(html, /33 remaining to reach target/);
  assert.match(html, /\$17,550\.00 remaining to reach target/);
  // William has zero active goals — his name should not appear in the
  // goals section since there's nothing real to show for him.
  const goalsSectionStart = html.indexOf('Goal Progress');
  const goalsSectionHtml = html.slice(goalsSectionStart, goalsSectionStart + 2000);
  assert.doesNotMatch(goalsSectionHtml, /William Alexander/);

  // Report #3 is its own email now, so an empty goals list still sends a
  // real "Goal Progress" section (with an explicit no-goals message)
  // rather than omitting the section entirely — unlike the old combined
  // layout, this report has nothing else in it to give an empty section
  // context.
  const { html: noGoalsHtml } = buildReport3Email(agg, [], []);
  assert.match(noGoalsHtml, /Goal Progress/);
  assert.match(noGoalsHtml, /No active goals for James or William this period\./);
});

test('Goal Progress "remaining to reach target" reads "Target reached" once a goal hits 100%', () => {
  const agg = parseAndAggregate(ALL_MESSAGES, { runDate: '2026-09-11' });
  const repGoals = [
    { repName: 'James Delaney', goals: [{ title: '36 New Doctors by Dec 2026', metric: 'new_doctors', target: 36, current_value: 40, progress_pct: 100 }] },
  ];
  const { html } = buildReport3Email(agg, [], repGoals);
  assert.match(html, /Target reached/);
  assert.doesNotMatch(html, /remaining to reach target/);
});

test('Goal Progress section HTML-escapes goal titles (not a trusted constant — admin-entered text)', () => {
  const agg = parseAndAggregate(ALL_MESSAGES, { runDate: '2026-09-11' });
  const repGoals = [
    { repName: 'James Delaney', goals: [{ title: '<script>alert(1)</script>', metric: 'new_doctors', target: 10, current_value: 1, progress_pct: 10 }] },
  ];
  const { html } = buildReport3Email(agg, [], repGoals);
  assert.doesNotMatch(html, /<script>alert\(1\)<\/script>/);
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
});

test('"No data was returned" reports as zero, not a crash', () => {
  const agg = parseAndAggregate(
    [{ subject: "Daily Booked Cases - William's Doctors", html: fixture('daily-booked-william-nodata.html') }],
    { runDate: '2026-09-11' }
  );
  assert.equal(agg.booked.daily.byRep.william.count, 0);
  assert.equal(agg.booked.daily.byRep.william.hasData, false);
});

test('flags missing reports instead of silently under-reporting', () => {
  const agg = parseAndAggregate(
    [{ subject: "Daily Booked Cases - James' Doctors", html: fixture('daily-booked-james.html') }],
    { runDate: '2026-09-11' }
  );
  assert.equal(agg.missing.length, 10);
  assert.ok(agg.missing.includes('Cases Currently In Progress'));
  assert.ok(agg.missing.includes('Daily Booking Report - Nadine'));
  assert.ok(agg.missing.includes('MTD Booked Daily Update'));
});

test('Report #3\'s month-by-month trend chart uses the verified Jun-Aug baselines and real EviSmart September MTD figures', () => {
  const agg = parseAndAggregate(ALL_MESSAGES, { runDate: '2026-09-23' });
  agg.eviSmart = extractEviSmartTotals(fixture('evismart-daily-sales-report.html'));
  const { html } = buildReport3Email(agg);

  assert.match(html, /September 2026 \(MTD\) vs\. Aug 2026/);
  // Verified pre-tracking months.
  assert.doesNotMatch(html, /Jun%202026/); // chart starts in July
  assert.match(html, /Jul%202026/);
  assert.match(html, /Aug%202026/);
  assert.doesNotMatch(html, /12059\.06/); // June not plotted
  assert.match(html, /99668\.9/); // July booked
  assert.match(html, /66311\.9/); // July billed
  assert.match(html, /157654\.32/); // August booked
  assert.match(html, /147772\.4/); // August billed
  // Current month, real September MTD, straight from the real EviSmart
  // Daily Sales Report fixture (121610.28 booked, 124786.97 billed).
  assert.match(html, /September%202026%20\(MTD\)/);
  assert.match(html, /121610\.28/); // September MTD booked
  assert.match(html, /124786\.97/); // September MTD billed
  assert.doesNotMatch(html, /Weekly Booked vs\. Billed Revenue/);

  // Report #1 no longer carries the chart or a month-over-month
  // comparison at all — moved entirely to Report #3 per Ben
  // Silberstein's formal spec, 2026-09-19.
  const { html: r1Html } = buildReport1Email(agg);
  assert.doesNotMatch(r1Html, /Booked &amp; Billed by Month/);
  assert.doesNotMatch(r1Html, /Pace vs\./);
});

test('Report #3\'s "This Month vs. Last Month" KPI cards show value for both periods, the numerical change, and the % change, from real EviSmart MTD figures', () => {
  const agg = parseAndAggregate(ALL_MESSAGES, { runDate: '2026-09-23' });
  agg.eviSmart = extractEviSmartTotals(fixture('evismart-daily-sales-report.html'));
  const { html } = buildReport3Email(agg);

  // Booked: EviSmart MTD (121610.28) vs. August full month (157654.32).
  assert.match(html, /Aug 2026: \$157,654\.32/);
  assert.match(html, /-\$36,044\.04 \(-22\.9%\)/);
  // Billed: EviSmart MTD (124786.97) vs. August full month (147772.40).
  assert.match(html, /Aug 2026: \$147,772\.40/);
  assert.match(html, /-\$22,985\.43 \(-15\.6%\)/);
  assert.match(html, /September 2026 \(MTD\) is real month-to-date, not a full month yet/);
});

test('Report #3 shows a clear notice instead of a fabricated comparison when today\'s EviSmart pull is unavailable', () => {
  const agg = parseAndAggregate(ALL_MESSAGES, { runDate: '2026-09-19' });
  agg.eviSmart = null;
  const { html } = buildReport3Email(agg);

  assert.match(html, /Today's EviSmart Daily Sales Report pull didn't come through, so this month's comparison isn't available/);
  assert.doesNotMatch(html, /quickchart\.io/);
});

test('email copy has no em dashes and no removed footer line, across all 3 separated reports', () => {
  const agg = parseAndAggregate(ALL_MESSAGES, { runDate: '2026-09-11' });
  const reports = [
    buildReport1Email(agg, []),
    buildReport2Email(agg),
    buildReport3Email(agg, [], []),
  ];

  for (const { html, subject } of reports) {
    assert.ok(!html.includes('—'), 'html should not contain an em dash character');
    assert.ok(!html.includes('&mdash;'), 'html should not contain an em dash entity');
    assert.ok(!html.includes('Generated automatically from Evident Labs'), 'old footer line should be gone');
    assert.ok(!html.includes('A PDF copy of this report is attached.'), 'PDF attachment was removed (user request, 2026-09-19) — footer should not reference it');
    assert.ok(!html.includes('Kings Highway'), 'Kings Highway should not appear anywhere in the email — removed from both the rep/brand breakdown and the header subtitle');
    assert.match(subject, /^(Daily Sales Report|Daily Sales by Sales Rep|Goal Progress Report) - /);
  }
});

test('Report #1/#2/#3 are three separate emails with distinct subjects (Ben Silberstein\'s requirement, 2026-09-19)', () => {
  const agg = parseAndAggregate(ALL_MESSAGES, { runDate: '2026-09-11' });
  const r1 = buildReport1Email(agg, []);
  const r2 = buildReport2Email(agg);
  const r3 = buildReport3Email(agg, [], []);

  assert.match(r1.subject, /^Daily Sales Report/);
  assert.match(r2.subject, /^Daily Sales by Sales Rep/);
  assert.match(r3.subject, /^Goal Progress Report/);

  // Each report's own content stays out of the other two's emails.
  assert.doesNotMatch(r2.html, /Today's Booked Cases/);
  assert.doesNotMatch(r2.html, /Goal Progress/);
  assert.doesNotMatch(r3.html, /By Sales Rep/);
  assert.doesNotMatch(r1.html, /Booked &amp; Billed by Month/);
  assert.doesNotMatch(r1.html, /By Sales Rep/);
  assert.doesNotMatch(r1.html, /Goal Progress/);
});

test('buildCombinedLeadershipEmail merges all 3 reports into one email with one subject (leadership request, 2026-09-23)', () => {
  const agg = parseAndAggregate(ALL_MESSAGES, { runDate: '2026-09-11' });
  agg.eviSmart = extractEviSmartTotals(fixture('evismart-daily-sales-report.html'));
  const repGoals = [
    { repName: 'James Delaney', goals: [{ title: '36 New Doctors by Dec 2026', metric: 'new_doctors', target: 36, current_value: 3, progress_pct: 8 }] },
  ];
  const { subject, html, sheetRow } = buildCombinedLeadershipEmail(agg, [], repGoals, {});

  assert.match(subject, /^AIM Leadership Report - /);
  // All 3 reports' real content present in the one email.
  assert.match(html, /Today's Booked Cases/);
  assert.match(html, /YTD Sales Value Total/);
  assert.match(html, /By Sales Rep/);
  assert.match(html, /James Delaney/);
  assert.match(html, /36 New Doctors by Dec 2026/);
  assert.match(html, /Goal Progress/);
  assert.match(html, /\$2\.7M YTD Sales Value Total Goal/);
  // Group dividers mark each section's boundary.
  assert.match(html, /Leadership Sales Summary/);
  assert.match(html, /Sales Performance by Representative/);
  assert.match(html, /Goal Tracking/);

  // Reordered layout (user request, 2026-09-23): essential headline
  // numbers first — Today/MTD/YTD cards, the $2.7M goal, then the trend
  // chart + This Month vs. Last Month KPI cards right below it, all
  // under one "Leadership Sales Summary" divider — with the long
  // customer-by-customer detail table moved to the very end, after Sales
  // Performance by Rep and Goal Tracking.
  const goalIdx = html.indexOf('$2.7M YTD Sales Value Total Goal');
  const kpiIdx = html.indexOf('vs. Aug 2026');
  const repIdx = html.indexOf('Sales Performance by Representative');
  const goalTrackingIdx = html.indexOf('Goal Tracking');
  const customerTableIdx = html.indexOf("Today's Booked Cases");
  assert.ok(goalIdx > 0 && kpiIdx > goalIdx, 'KPI trend/comparison section should come right after the $2.7M goal bar');
  assert.ok(kpiIdx < repIdx, 'headline section (incl. KPI) should come before Sales Performance by Representative');
  assert.ok(repIdx < goalTrackingIdx, 'Sales Performance by Representative should come before Goal Tracking');
  assert.ok(goalTrackingIdx < customerTableIdx, 'the long customer-detail table should be the very last section');

  // sheetRow (needed for the daily history log) still comes through,
  // same as Report #1's own standalone sheetRow.
  assert.equal(sheetRow.date, '2026-09-11');
  assert.equal(sheetRow.company_daily_booked_value, agg.companyDailyBooked);
});

test('extractDailyBookedCustomerNames pulls row-level Customer Name values, dropping the blank totals row', () => {
  const names = extractDailyBookedCustomerNames(fixture('daily-booked-james.html'));
  assert.deepEqual(names, ['DR BRIAN GOLD']);
});

test('extractCaseTotals reads the totals row into { count, billed, wip, value, hasData }', () => {
  const totals = extractCaseTotals(fixture('daily-booked-james.html'));
  assert.deepEqual(totals, { count: 1, billed: 0, wip: 117, value: 117, hasData: true });
});

test('extractCaseTotals returns a real zero with hasData:false when there is no real data', () => {
  const totals = extractCaseTotals(fixture('daily-booked-william-nodata.html'));
  assert.deepEqual(totals, { count: 0, billed: 0, wip: 0, value: 0, hasData: false });
});

test('extractBookingRows reads every real row from Daily Booking Report - Nadine, dropping the totals row', () => {
  const rows = extractBookingRows(fixture('company-daily-booked-nadine.html'));
  assert.equal(rows.length, 94); // 95 total rows in the fixture minus 1 totals row
  assert.deepEqual(rows[0], { ref: '5569', customerName: 'SUNSET TERRACE', value: 0, salesperson: '' });
  // Real row with a salesperson attributed — the last real data row in the fixture.
  assert.deepEqual(rows[rows.length - 1], { ref: '5663', customerName: 'Dr. ALBERTO GONZALEZ', value: 0, salesperson: 'william' });
});

test('extractBilledRows reads every real row from Daily Billed Report - Nadine, dropping the totals row', () => {
  const rows = extractBilledRows(fixture('company-daily-billed-nadine.html'));
  assert.equal(rows.length, 34); // 35 total rows in the fixture minus 1 totals row
  assert.deepEqual(rows[0], { ref: '4067', customerName: 'WYCKOFF HOSPITAL', value: 102.14, billedValue: 102.14, salesperson: '' });
  // Real row with a salesperson attributed and a blank (unbilled-this-row) billed value.
  assert.deepEqual(rows[rows.length - 1], { ref: '5663', customerName: 'Dr. ALBERTO GONZALEZ', value: 0, billedValue: 0, salesperson: 'william' });
});

test('extractBookingRows / extractBilledRows return an empty array when there is no real data', () => {
  assert.deepEqual(extractBookingRows('<TABLE><TR><TD>No data was returned, Please double check your filters</TABLE>'), []);
  assert.deepEqual(extractBilledRows('<TABLE><TR><TD>No data was returned, Please double check your filters</TABLE>'), []);
});

test('extractDailyBookedCustomerNames returns an empty array when there is no real data', () => {
  const names = extractDailyBookedCustomerNames(fixture('daily-booked-william-nodata.html'));
  assert.deepEqual(names, []);
});

test('extractEviSmartTotals reads all 6 real rows from a real EviSmart Daily Sales Report Totals table', () => {
  const totals = extractEviSmartTotals(fixture('evismart-daily-sales-report.html'));
  assert.deepEqual(totals, {
    dailyBookedCount: 0,
    dailyBookedValue: 0,
    dailyBilledValue: 124.00,
    mtdBookedCount: 1292,
    mtdBookedValue: 121610.28,
    mtdBilledValue: 124786.97,
    ytdTotalSalesValue: 388621.46,
    ytdBilledValue: 337992.27,
  });
});

test('extractEviSmartTotals returns null (not fabricated zeros) when the Totals table is absent — a real "could not run" failure send', () => {
  const totals = extractEviSmartTotals('<h2>EviSmart Daily Sales Report</h2><p>Could not run: not logged in.</p>');
  assert.equal(totals, null);
});
