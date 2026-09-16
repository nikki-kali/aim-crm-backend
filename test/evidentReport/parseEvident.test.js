const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { parseAndAggregate } = require('../../src/services/evidentReport/parseEvident');
const { buildEmail } = require('../../src/services/evidentReport/buildReport');

function fixture(name) {
  return fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf-8');
}

// These fixtures are real emails pulled from media@aimdentallab.com
// (Sept 10-12 2026, plus 3 company-wide report types added 2026-09-16),
// not synthetic data - the numbers asserted below are the actual totals
// Evident sent.
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
];

test('parses and combines all 10 report types correctly', () => {
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
  assert.equal(agg.missing.length, 9);
  assert.ok(agg.missing.includes('Cases Currently In Progress'));
  assert.ok(agg.missing.includes('Daily Booking Report - Nadine'));
});

test('email copy has no em dashes and no removed footer line', () => {
  const agg = parseAndAggregate(ALL_MESSAGES, { runDate: '2026-09-11' });
  const { html, subject } = buildEmail(agg, []);

  assert.ok(!html.includes('—'), 'html should not contain an em dash character');
  assert.ok(!html.includes('&mdash;'), 'html should not contain an em dash entity');
  assert.ok(!html.includes('Generated automatically from Evident Labs'), 'old footer line should be gone');
  assert.ok(html.includes('A PDF copy of this report is attached.'));
  assert.ok(!html.includes('Kings Highway (KH)'), 'KH row was removed from the rep/brand breakdown');
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

test('Booked (MTD) accumulates from logged same-month days plus today', () => {
  const agg = parseAndAggregate(ALL_MESSAGES, { runDate: '2026-09-16' });
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
