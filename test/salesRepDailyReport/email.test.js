const test = require('node:test')
const assert = require('node:assert/strict')
const { salesRepDailyReportEmail } = require('../../src/services/email')

const SALES = { title: '$30K Monthly Sales - September 2026', metric: 'monthly_revenue', target: '30000', current_value: 1780.9, progress_pct: 6 }
const DOCTORS_GOAL = { title: 'New Doctors - September 2026', metric: 'new_doctors', target: 9, current_value: 2, progress_pct: 22 }

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
  salesGoal: SALES,
  doctorsGoal: DOCTORS_GOAL,
  daysLeft: 4,
}

test('greets the rep by first name and lists their doctors with status pills', () => {
  const html = salesRepDailyReportEmail(SAMPLE)
  assert.match(html, /Daily Sales Report/)
  assert.match(html, /James Delaney &nbsp;·&nbsp; Tuesday, September 15, 2026/)
  assert.match(html, /Tuesday, September 15, 2026/)
  assert.match(html, /Sent a case this week \(1\)/)
  assert.match(html, /Doctors and prospects to follow up with/)
  assert.match(html, /Dr\. Brian Gold/)
  assert.match(html, /Dr\. Cecilia U\. Schneuerman/)
  assert.match(html, />Submitted</)
  assert.match(html, />Reach out</)
  assert.doesNotMatch(html, />Not Submitted</)
})

test('leads with a monthly sales meter: amount, goal, percent, amount to go and business days left', () => {
  const html = salesRepDailyReportEmail(SAMPLE)
  assert.match(html, /Monthly Sales/)
  assert.match(html, />\$1,780\.90<span[^>]*> of \$30,000 goal<\/span>/)
  assert.match(html, />6%</)
  assert.match(html, /\$28,219\.10 to go[^<]*4 business days left this month/)
  // The meter comes before the doctor list.
  assert.ok(html.indexOf('Monthly Sales') < html.indexOf('Doctors and prospects to follow up with'))
})

test('shows a new-doctors meter for the month', () => {
  const html = salesRepDailyReportEmail(SAMPLE)
  assert.match(html, /New Doctors This Month/)
  assert.match(html, />2<span[^>]*> of 9 doctors<\/span>/)
  assert.match(html, /7 to go\. Every new doctor counts\./)
})

test('a goal that is reached shows a celebration instead of an amount to go', () => {
  const html = salesRepDailyReportEmail({
    ...SAMPLE,
    salesGoal: { ...SALES, current_value: 31000, progress_pct: 100 },
    doctorsGoal: { ...DOCTORS_GOAL, current_value: 9, progress_pct: 100 },
  })
  assert.match(html, /Goal reached\. Amazing work, James!/)
  assert.match(html, /Goal reached\. Fantastic, James!/)
})

test('a bar with any progress always shows a small sliver, and a zero bar is empty', () => {
  const tiny = salesRepDailyReportEmail({ ...SAMPLE, salesGoal: { ...SALES, current_value: 20, progress_pct: 0 } })
  assert.match(tiny, /width="3%"/)
  const zero = salesRepDailyReportEmail({ ...SAMPLE, salesGoal: { ...SALES, current_value: 0, progress_pct: 0 } })
  assert.doesNotMatch(zero, /width="3%"/)
  assert.match(zero, /width="100%"/)
})

test('omits a meter when its goal could not be computed (no fabricated $0)', () => {
  const html = salesRepDailyReportEmail({ ...SAMPLE, salesGoal: null, doctorsGoal: null })
  assert.ok(!html.includes('Monthly Sales'))
  assert.ok(!html.includes('New Doctors This Month'))
  assert.match(html, /Doctors and prospects to follow up with/)
})

test('the old weekly cards and weekly goal bar are gone', () => {
  const html = salesRepDailyReportEmail(SAMPLE)
  assert.ok(!html.includes("This Week's Cases"))
  assert.ok(!html.includes('Weekly Goal'))
  assert.ok(!html.includes('New Doctors This Week'))
  assert.ok(!html.includes('Active Doctors List'))
})

test('a long roster shows at most 10 doctors to reach out to, with a "showing 10 of N" note and the small pick-3 step', () => {
  const many = Array.from({ length: 30 }, (_, i) => ({ doctor_name: 'Dr. Doc ' + String(i).padStart(2, '0'), clinic_name: null, submitted_this_week: false, first_case_pending: i >= 4 }))
  const html = salesRepDailyReportEmail({ ...SAMPLE, doctors: many, totalCount: 30, notSubmittedCount: 30 })
  assert.equal((html.match(/>Reach out</g) || []).length + (html.match(/>First case</g) || []).length, 10)
  assert.match(html, /Showing 10 of 30\./)
  assert.match(html, /pick 3 doctors from your list and reach out about a case/)
  assert.doesNotMatch(html, /check in with 30 doctors/)
  // The four active doctors always make the cut, ahead of first-case doctors.
  for (const n of ['00', '01', '02', '03']) assert.match(html, new RegExp('Dr\\. Doc ' + n))
})

test('doctors who sent a case are in their own separate panel, above the reach-out panel', () => {
  const html = salesRepDailyReportEmail({
    ...SAMPLE,
    doctors: [
      { doctor_name: 'Dr. Sent A', clinic_name: null, submitted_this_week: true, first_case_pending: false },
      { doctor_name: 'Dr. Sent B', clinic_name: null, submitted_this_week: true, first_case_pending: false },
      { doctor_name: 'Dr. Active', clinic_name: null, submitted_this_week: false, first_case_pending: false },
    ],
    totalCount: 3, notSubmittedCount: 1,
  })
  assert.match(html, /Sent a case this week \(2\)/)
  assert.ok(html.indexOf('Sent a case this week') < html.indexOf('Doctors and prospects to follow up with'))
  // Submitted doctors appear only in their own panel.
  const reachPanel = html.slice(html.indexOf('Doctors and prospects to follow up with'))
  assert.ok(!reachPanel.includes('Dr. Sent A'))
  // No submitted doctors: no empty submitted panel.
  const none = salesRepDailyReportEmail({ ...SAMPLE, doctors: [{ doctor_name: 'Dr. Active', clinic_name: null, submitted_this_week: false }], totalCount: 1, notSubmittedCount: 1 })
  assert.ok(!none.includes('Sent a case this week'))
})

test('matches the Leadership Dashboard: same page frame, glass panels with a solid fallback, teal header band', () => {
  const { buildCombinedLeadershipEmail } = require('../../src/services/evidentReport/buildReport')
  const html = salesRepDailyReportEmail(SAMPLE)
  // The same pale-teal card the dashboard uses (its own emailShell).
  assert.match(html, /max-width:600px;margin:40px auto;background-color:rgba\(255,255,255,\.96\);background-image:linear-gradient\(175deg/)
  assert.match(html, /linear-gradient\(135deg,#06babe,#207290\)/) // header band
  assert.match(html, /Aim Dental Laboratory CRM &nbsp;·&nbsp; Daily Sales Report/)
  // Glass panel: a solid color always precedes its translucent version.
  assert.match(html, /background-color:#ffffff;background-color:rgba\(255,255,255,\.55\)/)
  assert.match(html, /box-shadow:0 8px 24px rgba\(32,114,144,\.12\)/)
  // And the dashboard itself still says Daily Leadership Dashboard in its footer.
  const dash = buildCombinedLeadershipEmail({ ...require('../../src/services/evidentReport/parseEvident').parseAndAggregate([], { runDate: '2026-09-25' }), eviSmart: null }, [], [], {})
  assert.match(dash.html, /Aim Dental Laboratory CRM &nbsp;·&nbsp; Daily Leadership Dashboard/)
})

test('the focus box names how many doctors to check in with, or celebrates when everyone has sent a case', () => {
  assert.match(salesRepDailyReportEmail(SAMPLE), /Your 1% today:<\/b> check in with 1 doctor who hasn't sent a case this week/)
  const many = salesRepDailyReportEmail({ ...SAMPLE, notSubmittedCount: 3, totalCount: 3 })
  assert.match(many, /check in with 3 doctors who haven't sent a case this week/)
  const allDone = salesRepDailyReportEmail({ ...SAMPLE, notSubmittedCount: 0, submittedCount: 2 })
  assert.match(allDone, /All caught up, James\./)
})

test('has a hidden preview line, a 600px layout, and a tappable button', () => {
  const html = salesRepDailyReportEmail(SAMPLE)
  assert.match(html, /display:none[^>]*>James, you&#39;re 6% of the way to your monthly sales goal/)
  assert.match(html, /max-width:600px/)
  assert.match(html, /padding:14px 28px[^>]*>View my doctors</)
})

test('test send shows the TEST banner', () => {
  const html = salesRepDailyReportEmail({ ...SAMPLE, test: true })
  assert.match(html, /Test send/)
})

test('a rep with zero assigned doctors gets an empty-state message, not a broken table', () => {
  const html = salesRepDailyReportEmail({ ...SAMPLE, doctors: [], totalCount: 0, submittedCount: 0, notSubmittedCount: 0 })
  assert.match(html, /No doctors assigned yet/)
})

test('doctor and rep names are HTML-escaped (they come from the database)', () => {
  const html = salesRepDailyReportEmail({
    ...SAMPLE,
    repName: '<b>Evil</b> Rep',
    doctors: [{ doctor_name: '<script>alert(1)</script>', clinic_name: 'A & B <i>Dental</i>', submitted_this_week: false }],
    totalCount: 1,
    notSubmittedCount: 1,
  })
  assert.doesNotMatch(html, /<script>alert\(1\)<\/script>/)
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/)
  assert.match(html, /A &amp; B &lt;i&gt;Dental&lt;\/i&gt;/)
  assert.doesNotMatch(html, /<b>Evil<\/b>/)
})

const { repCoachMessage } = require('../../src/services/email')
const sales = (current, pct) => ({ target: '30000', current_value: current, progress_pct: pct })
const docs = (current, target = 16) => ({ target, current_value: current, progress_pct: Math.round((current / target) * 100) })
const coach = (overrides) => repCoachMessage({ firstName: 'James', salesGoal: sales(1780.9, 6), doctorsGoal: docs(4), daysLeft: 3, dayOfMonth: 26, ...overrides })

test('coach note: a rep who already has progress hears about their head start and one concrete next win', () => {
  const msg = coach()
  assert.match(msg, /\$1,781 in sales and 4 new doctors/)
  assert.match(msg, /One more new doctor takes you to 5 of 16\./)
})

test('coach note: close to the doctors goal highlights how near the finish line is', () => {
  assert.match(coach({ doctorsGoal: docs(15) }), /1 new doctor away from your monthly goal/)
  assert.match(coach({ doctorsGoal: docs(14) }), /2 new doctors away from your monthly goal/)
})

test('coach note: 75%+ of sales says home stretch with the amount to go and days left', () => {
  const msg = coach({ salesGoal: sales(24000, 80) })
  assert.match(msg, /80%/)
  assert.match(msg, /\$6,000 to go with 3 business days left|\$6,000 to go/)
})

test('coach note: past halfway celebrates momentum', () => {
  assert.match(coach({ salesGoal: sales(16000, 53) }), /halfway|More than halfway/)
})

test('coach note: both goals reached is a celebration', () => {
  assert.match(coach({ salesGoal: sales(31000, 100), doctorsGoal: docs(16) }), /hit both goals this month, James/)
})

test('coach note: a rep with nothing yet gets a fresh-start message, never a negative one', () => {
  const msg = coach({ salesGoal: sales(0, 0), doctorsGoal: docs(0) })
  assert.match(msg, /Everyone's bars start at zero, James/)
  assert.doesNotMatch(msg, /behind|failing|only|lazy|poor|worst/i)
})

test('coach note: nothing to say without goals, and it appears under the bars in the email', () => {
  assert.equal(repCoachMessage({ firstName: 'James', salesGoal: null, doctorsGoal: null }), '')
  const html = salesRepDailyReportEmail(SAMPLE)
  assert.match(html, /Keep going/)
  assert.ok(html.indexOf('New Doctors This Month') < html.indexOf('Keep going'))
  assert.ok(html.indexOf('Keep going') < html.indexOf('Your 1% today'))
})

test('reach-out panel lists active doctors before first-case doctors', () => {
  const html = salesRepDailyReportEmail({
    ...SAMPLE,
    doctors: [
      { doctor_name: 'Dr. Waiting', clinic_name: null, submitted_this_week: false, first_case_pending: true },
      { doctor_name: 'Dr. Active', clinic_name: null, submitted_this_week: false, first_case_pending: false },
    ],
    totalCount: 2, notSubmittedCount: 2,
  })
  assert.ok(html.indexOf('Dr. Active') < html.indexOf('Dr. Waiting'))
  assert.match(html, />First case</)
  assert.match(html, />Reach out</)
})
