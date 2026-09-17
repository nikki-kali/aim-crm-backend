const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { parseAndAggregate, extractDailyBookedCustomerNames, extractCaseTotals } = require('../../src/services/evidentReport/parseEvident');
const { buildEmail } = require('../../src/services/evidentReport/buildReport');

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

test('email copy has no em dashes and no removed footer line', () => {
  const agg = parseAndAggregate(ALL_MESSAGES, { runDate: '2026-09-11' });
  const { html, subject } = buildEmail(agg, []);

  assert.ok(!html.includes('—'), 'html should not contain an em dash character');
  assert.ok(!html.includes('&mdash;'), 'html should not contain an em dash entity');
  assert.ok(!html.includes('Generated automatically from Evident Labs'), 'old footer line should be gone');
  assert.ok(html.includes('A PDF copy of this report is attached.'));
  assert.ok(!html.includes('Kings Highway'), 'Kings Highway should not appear anywhere in the email — removed from both the rep/brand breakdown and the header subtitle');
  assert.ok(subject.startsWith('AIM Leadership Report'));
});

test('Billed (MTD) delta shows against a logged prior day (guard allows it once company-wide tracking exists)', () => {
  const agg = parseAndAggregate(ALL_MESSAGES, { runDate: '2026-09-11' });
  const history = [{
    date: '2026-09-10', booked_mtd_value: '1702.87', booked_mtd_billed: '89242.46',
    wip_value: '46209.54', ytd_billed_value: '7519.13', company_daily_booked_value: '100',
  }];
  const { html } = buildEmail(agg, history);

  assert.match(html, /▲ \$200\.00 vs\. yesterday/);
});

test('Billed (MTD) shows no delta when the prior row predates company-wide tracking', () => {
  const agg = parseAndAggregate(ALL_MESSAGES, { runDate: '2026-09-11' });
  const history = [{
    date: '2026-09-10', booked_mtd_value: '1702.87', booked_mtd_billed: '1124.46',
    wip_value: '46209.54', ytd_billed_value: '0', company_daily_booked_value: null,
  }];
  const { html } = buildEmail(agg, history);

  assert.ok(!html.includes('vs. yesterday'), 'no delta anywhere — both the Billed (MTD) guard and the existing Billed (YTD) zero-guard should suppress their deltas on a pre-transition prior row');
});

test("Billed (MTD) suppresses its delta when today's own MTD Total Billed report is missing", () => {
  const messagesWithoutMtdBilled = ALL_MESSAGES.filter((m) => m.subject !== 'Daily MTD Total Billed');
  const agg = parseAndAggregate(messagesWithoutMtdBilled, { runDate: '2026-09-11' });
  assert.ok(agg.missing.includes('Daily MTD Total Billed'));
  assert.equal(agg.companyMtdBilled, 0);

  const history = [{
    date: '2026-09-10', booked_mtd_value: '1702.87', booked_mtd_billed: '89242.46',
    wip_value: '46209.54', ytd_billed_value: '7519.13', company_daily_booked_value: '100',
  }];
  const { html } = buildEmail(agg, history);

  // Without the guard, this would render a confident "▼ $89,242.46 vs.
  // yesterday" — a fabricated comparison against an absent-data 0, not a
  // real measured decline.
  assert.ok(!html.includes('$89,242.46'), 'fabricated delta must not render when the report that feeds it never arrived');
});

test('Booked (MTD) falls back to accumulating from logged same-month days plus today when MTD Booked Daily Update is missing', () => {
  const messagesWithoutMtdBooked = ALL_MESSAGES.filter((m) => m.subject !== 'MTD Booked Daily Update');
  const agg = parseAndAggregate(messagesWithoutMtdBooked, { runDate: '2026-09-16' });
  assert.ok(agg.missing.includes('MTD Booked Daily Update'));
  const history = [
    { date: '2026-09-14', company_daily_booked_value: '500' },
    { date: '2026-09-15', company_daily_booked_value: '300' },
    { date: '2026-08-30', company_daily_booked_value: '9999' },
  ];
  const { html } = buildEmail(agg, history);

  // 500 + 300 (same-month history) + 8065.22 (today's real companyDailyBooked) = 8865.22.
  // The 2026-08-30 row must NOT be included (different month).
  assert.match(html, /\$8,865\.22/);
});

test('Booked/Billed (YTD) auto-accrue real daily figures logged after the verified baseline date', () => {
  const agg = parseAndAggregate(ALL_MESSAGES, { runDate: '2026-09-18' });
  const history = [
    // Same date as the baseline itself — already reflected in the
    // verified snapshot, so it must NOT be double-counted.
    { date: '2026-09-16', company_daily_booked_value: '1000', company_daily_billed_value: '500' },
    // After the baseline — a real day of accrual.
    { date: '2026-09-17', company_daily_booked_value: '2000', company_daily_billed_value: '700' },
  ];
  const { html } = buildEmail(agg, history);

  // 363360.57 (baseline) + 2000 (09-17 only) + 8065.22 (today's real
  // companyDailyBooked from ALL_MESSAGES) = 373425.79.
  assert.match(html, /\$373,425\.79/);
  // 311452.46 (baseline) + 700 (09-17 only) + 1622.74 (today's real
  // companyDailyBilled from ALL_MESSAGES) = 313775.20.
  assert.match(html, /\$313,775\.20/);
  assert.match(html, /Baseline verified Sep 16, 2026 \+ daily activity since/);
});

test('Booked/Billed (YTD) show exactly the baseline, with no accrual, when run on the baseline date itself', () => {
  const agg = parseAndAggregate(ALL_MESSAGES, { runDate: '2026-09-16' });
  const { html } = buildEmail(agg, []);

  assert.match(html, /\$363,360\.57/);
  assert.match(html, /\$311,452\.46/);
});

test('Booked/Billed (YTD) accrual treats a NULL company_daily_billed_value as zero (pre-billed-tracking row)', () => {
  const agg = parseAndAggregate(ALL_MESSAGES, { runDate: '2026-09-18' });
  const history = [
    { date: '2026-09-17', company_daily_booked_value: '5000', company_daily_billed_value: null },
  ];
  const { html } = buildEmail(agg, history);

  // Booked: 363360.57 + 5000 + 8065.22 = 376425.79.
  assert.match(html, /\$376,425\.79/);
  // Billed: 311452.46 + 0 (NULL row contributes nothing) + 1622.74 = 313075.20.
  assert.match(html, /\$313,075\.20/);
});

test('Booked (MTD) prefers the real MTD Booked Daily Update figure over the self-accumulated fallback when it arrives', () => {
  const agg = parseAndAggregate(ALL_MESSAGES, { runDate: '2026-09-16' });
  assert.ok(!agg.missing.includes('MTD Booked Daily Update'));
  const history = [
    { date: '2026-09-14', company_daily_booked_value: '500' },
    { date: '2026-09-15', company_daily_booked_value: '300' },
  ];
  const { html } = buildEmail(agg, history);

  // The fixture's real MTD Booked Daily Update total (6935) wins over the
  // self-accumulated 500+300+8065.22=8865.22 fallback figure.
  assert.match(html, /\$6,935\.00/);
  assert.ok(!html.includes('$8,865.22'));
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

test('extractDailyBookedCustomerNames returns an empty array when there is no real data', () => {
  const names = extractDailyBookedCustomerNames(fixture('daily-booked-william-nodata.html'));
  assert.deepEqual(names, []);
});
