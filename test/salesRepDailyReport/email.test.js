const test = require('node:test')
const assert = require('node:assert/strict')
const { salesRepDailyReportEmail } = require('../../src/services/email')

const SAMPLE = {
  repName: 'James Delaney',
  dateLabel: 'Tuesday, September 15, 2026',
  doctors: [
    { doctor_name: 'Dr. Brian Gold', clinic_name: null, submitted_this_week: true },
    { doctor_name: 'Dr. Cecilia U. Schneuerman', clinic_name: null, submitted_this_week: false },
  ],
  totalCount: 2,
  submittedCount: 1,
  notSubmittedCount: 1,
  goal: { target: 5, current: 2, hasCustomGoal: false },
}

test('renders totals, doctor rows, and weekly goal progress', () => {
  const html = salesRepDailyReportEmail(SAMPLE)
  assert.match(html, /Daily Sales Report/)
  assert.match(html, /James Delaney/)
  assert.match(html, /Dr\. Brian Gold/)
  assert.match(html, /Dr\. Cecilia U\. Schneuerman/)
  // One unified "Active Doctors List" with a per-row status pill, not two
  // separate labeled lists.
  assert.match(html, /Active Doctors List &nbsp;\(2\)/)
  assert.match(html, />Submitted</)
  assert.match(html, />Not Submitted</)
  assert.match(html, />2 <span[^>]*>of 5 doctors this week<\/span></)
  // Verify CSS declarations are properly separated by semicolons (no concatenation bugs)
  assert.doesNotMatch(html, /border-top:1px solid #[0-9a-f]{6}text-align/)
})

test('top KPI row shows Assigned + New Doctors This Week, not the redundant Submitted/Not Submitted counts', () => {
  const html = salesRepDailyReportEmail(SAMPLE)
  assert.match(html, /New Doctors This Week/)
  // The stat-card label text is gone (it duplicated the per-doctor pills
  // in the Active Doctors List below) — only the pills themselves remain,
  // which the assertions above already cover.
  assert.doesNotMatch(html, /font-size:8\.5px[^<]*text-transform:uppercase[^<]*letter-spacing:\.06em">Not Submitted</)
  assert.doesNotMatch(html, /font-size:8\.5px[^<]*text-transform:uppercase[^<]*letter-spacing:\.06em">Submitted</)
})

test('New Doctors This Week card is color-coded by count: 0-1 red, 2-3 yellow, 4+ green', () => {
  // The card's own <div style="background:...;border:1px solid ...">
  // immediately precedes its "New Doctors This Week" label within the
  // same div — take the LAST background/border pair found before that
  // label text, which is this card's own, not the "Assigned" card's.
  const cardBackground = (current) => {
    const html = salesRepDailyReportEmail({ ...SAMPLE, goal: { target: 5, current, hasCustomGoal: false } })
    const before = html.slice(0, html.indexOf('New Doctors This Week'))
    const matches = [...before.matchAll(/background:(#[0-9a-f]{6});border:1px solid (#[0-9a-f]{6})/g)]
    const last = matches[matches.length - 1]
    return last ? { tint: last[1], border: last[2] } : null
  }
  assert.deepEqual(cardBackground(0), { tint: '#fef2f2', border: '#fecaca' }) // red
  assert.deepEqual(cardBackground(1), { tint: '#fef2f2', border: '#fecaca' }) // red
  assert.deepEqual(cardBackground(2), { tint: '#fefaf1', border: '#fde68a' }) // yellow/amber
  assert.deepEqual(cardBackground(3), { tint: '#fefaf1', border: '#fde68a' }) // yellow/amber
  assert.deepEqual(cardBackground(4), { tint: '#ecfdf5', border: '#a7f3d0' }) // green
  assert.deepEqual(cardBackground(5), { tint: '#ecfdf5', border: '#a7f3d0' }) // green
})

test('Active Doctors List includes every doctor with no cap, each with its own status pill', () => {
  const html = salesRepDailyReportEmail({
    ...SAMPLE,
    doctors: [
      { doctor_name: 'Dr. One', clinic_name: null, submitted_this_week: true },
      { doctor_name: 'Dr. Two', clinic_name: null, submitted_this_week: true },
      { doctor_name: 'Dr. Three', clinic_name: null, submitted_this_week: false },
      { doctor_name: 'Dr. Four', clinic_name: null, submitted_this_week: false },
      { doctor_name: 'Dr. Five', clinic_name: null, submitted_this_week: false },
      { doctor_name: 'Dr. Six', clinic_name: null, submitted_this_week: false },
    ],
    totalCount: 6,
    submittedCount: 2,
    notSubmittedCount: 4,
  })
  assert.match(html, /Active Doctors List &nbsp;\(6\)/)
  // All 6 real doctors appear somewhere — no truncation to a top-N sample.
  for (const name of ['Dr. One', 'Dr. Two', 'Dr. Three', 'Dr. Four', 'Dr. Five', 'Dr. Six']) {
    assert.ok(html.includes(name), `${name} should appear in the email`)
  }
  // 2 submitted pills, 4 not-submitted pills (matched on the pill's own
  // <span> wrapper, not the stat-card label text above, which also
  // contains the bare word "Submitted").
  assert.equal((html.match(/<span style="display:inline-block;[^>]*>Submitted<\/span>/g) || []).length, 2)
  assert.equal((html.match(/<span style="display:inline-block;[^>]*>Not Submitted<\/span>/g) || []).length, 4)
})

test('test send shows the TEST banner', () => {
  const html = salesRepDailyReportEmail({ ...SAMPLE, test: true })
  assert.match(html, /Test send/)
})

test('a rep with zero assigned doctors gets an empty-state message, not a broken table', () => {
  const html = salesRepDailyReportEmail({ ...SAMPLE, doctors: [], totalCount: 0, submittedCount: 0, notSubmittedCount: 0 })
  assert.match(html, /No doctors assigned yet/)
})

test("shows this week's booked cases and billed value when Evident data is available", () => {
  const html = salesRepDailyReportEmail({
    ...SAMPLE,
    bookedThisWeek: { count: 3, value: 4500.5, billed: 1200, wip: 3300.5, hasData: true },
  })
  assert.match(html, /This Week's Cases/)
  assert.match(html, /Cases Booked/)
  assert.match(html, />3</)
  assert.match(html, /Booked Value/)
  assert.match(html, /\$4,500\.5/)
  assert.match(html, /Billed/)
  assert.match(html, /\$1,200/)
})

test("omits the booked/billed section entirely when Evident data isn't available (no fabricated $0)", () => {
  const withoutData = salesRepDailyReportEmail({ ...SAMPLE, bookedThisWeek: { hasData: false } })
  assert.ok(!withoutData.includes("This Week's Cases"))

  const omitted = salesRepDailyReportEmail(SAMPLE)
  assert.ok(!omitted.includes("This Week's Cases"))
})
