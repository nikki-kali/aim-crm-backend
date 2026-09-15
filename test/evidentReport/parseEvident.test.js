const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { parseAndAggregate } = require('../../src/services/evidentReport/parseEvident');
const { buildEmail } = require('../../src/services/evidentReport/buildReport');

function fixture(name) {
  return fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf-8');
}

// These 5 fixtures are real emails pulled from media@aimdentallab.com
// (Sept 10-12, 2026), not synthetic data - the numbers asserted below are
// the actual totals Evident sent that night.
const ALL_MESSAGES = [
  { subject: "Daily Booked Cases - James' Doctors", html: fixture('daily-booked-james.html') },
  { subject: "Daily Booked Cases - William's Doctors", html: fixture('daily-booked-william-nodata.html') },
  { subject: "MTD Booked Cases - James' Doctors", html: fixture('mtd-booked-james.html') },
  { subject: "MTD Booked Cases - William's Doctors", html: fixture('mtd-booked-william.html') },
  { subject: 'Cases Currently In Progress', html: fixture('wip-cases-in-progress.html') },
];

test('parses and combines all 5 report types correctly', () => {
  const agg = parseAndAggregate(ALL_MESSAGES, { runDate: '2026-09-11' });

  assert.equal(agg.missing.length, 0);

  // Daily: only James had a booking (1 case, $117 WIP, $0 billed); William had none.
  assert.equal(agg.booked.daily.count, 1);
  assert.equal(agg.booked.daily.value, 117);

  // MTD: James 8 cases/$501 billed/$1061.91 WIP, William 4 cases/$77.49 billed/$262.47 WIP.
  assert.equal(agg.booked.mtd.count, 12);
  assert.equal(agg.booked.mtd.billed, 578.49);
  assert.equal(agg.booked.mtd.wip, 1324.38);
  assert.equal(Math.round(agg.booked.mtd.value * 100) / 100, 1902.87);

  // WIP: 382 cases / $46,709.54 total, split AIM 166/$16,756.54 and KH 216/$29,953.
  assert.equal(agg.wip.cases, 382);
  assert.equal(agg.wip.value, 46709.54);
  assert.equal(agg.wip.kh.cases, 216);
  assert.equal(agg.wip.kh.value, 29953);
  assert.equal(agg.wip.aim.cases, 166);
  assert.equal(Math.round(agg.wip.aim.value * 100) / 100, 16756.54);
  assert.equal(agg.wip.byRep.james, 1061.91);
  assert.equal(agg.wip.byRep.william, 262.47);
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
  assert.equal(agg.missing.length, 4);
  assert.ok(agg.missing.includes('Cases Currently In Progress'));
});

test('email copy has no em dashes and no removed footer line', () => {
  const agg = parseAndAggregate(ALL_MESSAGES, { runDate: '2026-09-11' });
  const { html, subject } = buildEmail(agg, []);

  assert.ok(!html.includes('—'), 'html should not contain an em dash character');
  assert.ok(!html.includes('&mdash;'), 'html should not contain an em dash entity');
  assert.ok(!html.includes('Generated automatically from Evident Labs'), 'old footer line should be gone');
  assert.ok(html.includes('A PDF copy of this report is attached.'));
  assert.ok(html.includes('N/A'), 'KH booked/billed cells should read N/A');
  assert.ok(subject.startsWith('AIM Leadership Report'));
});

test('day-over-day delta shows against a logged prior day', () => {
  const agg = parseAndAggregate(ALL_MESSAGES, { runDate: '2026-09-11' });
  const history = [{ date: '2026-09-10', booked_mtd_value: '1702.87', booked_mtd_billed: '528.49', wip_value: '46209.54' }];
  const { html } = buildEmail(agg, history);

  assert.match(html, /▲ \$200\.00 vs\. yesterday/);
});
