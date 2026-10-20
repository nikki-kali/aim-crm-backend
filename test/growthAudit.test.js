const test = require('node:test')
const assert = require('node:assert')
const { remakeCost } = require('../src/services/growthAudit/calc')
const { templateReport } = require('../src/services/growthAudit/report')
const { reportEmail } = require('../src/services/growthAudit/email')
const { stateFromAddress } = require('../src/routes/growthAudit')

test('remakeCost matches the website preview for the sample entry', () => {
  // 40 units, 3 remakes, 45 min at $700/hr, free remakes: the explainer's example.
  const c = remakeCost({ unitsPerMonth: 40, remakesPerMonth: 3, minutesPerRemake: 45, chairHourValue: 700, labFeePerRemake: 0 })
  assert.strictEqual(c.annualRemakes, 36)
  assert.strictEqual(c.total, 18900)
  assert.strictEqual(c.rate, 0.075)
  assert.strictEqual(c.aboveBenchmark, true)
  assert.strictEqual(c.scenarios[1].saved, 9450)
})

test('remakeCost ignores junk and clamps remakes to units', () => {
  const c = remakeCost({ unitsPerMonth: '10', remakesPerMonth: 50, minutesPerRemake: 'abc', chairHourValue: -5, labFeePerRemake: null })
  assert.strictEqual(c.inputs.remakes, 10)
  assert.strictEqual(c.inputs.minutes, 0)
  assert.strictEqual(c.total, 0)
})

test('stateFromAddress reads codes and spelled-out states', () => {
  assert.strictEqual(stateFromAddress('802 Myrtle Ave, Brooklyn, NY 11206'), 'NY')
  assert.strictEqual(stateFromAddress('123 Main St, Los Angeles, CA'), 'CA')
  assert.strictEqual(stateFromAddress('55 Ocean Blvd, Miami Florida 33101'), 'FL')
  assert.strictEqual(stateFromAddress('12 Elm St Springfield'), null)
})

test('report email escapes input and contains no em dashes', () => {
  const cost = remakeCost({ unitsPerMonth: 40, remakesPerMonth: 3, minutesPerRemake: 45, chairHourValue: 600, labFeePerRemake: 90 })
  const html = reportEmail({
    practice: '<script>x</script> Dental',
    cost,
    report: templateReport({ cost, pains: ['Shade'] }),
    contact: { name: 'James Delaney', firstName: 'James', region: 'New York City metro', email: 'james@aimdentallab.com', phone: '347-863-9787', phoneTel: '+13478639787' },
    repId: 'james',
  })
  assert.ok(!html.includes('<script>x</script>'))
  assert.ok(!/[—–]/.test(html))
  assert.ok(html.includes('utm_source=growth-audit-report'))
})

const { parseCallback, describeCallback, icsEvent } = require('../src/services/growthAudit/callback')

// A fixed "now": Monday 20 October 2026, 10:00 am in New York.
const NOW = new Date('2026-10-20T14:00:00Z')

test('call-backs start the next business day, never today, never weekends', () => {
  assert.strictEqual(parseCallback({ date: '2026-10-20', window: 'morning', repId: 'james', now: NOW }), null) // today
  assert.strictEqual(parseCallback({ date: '2026-10-19', window: 'morning', repId: 'james', now: NOW }), null) // past
  assert.strictEqual(parseCallback({ date: '2026-10-24', window: 'morning', repId: 'james', now: NOW }), null) // Saturday
  assert.strictEqual(parseCallback({ date: '2026-12-31', window: 'morning', repId: 'james', now: NOW }), null) // too far
  assert.strictEqual(parseCallback({ date: '2026-10-21', window: 'evening', repId: 'james', now: NOW }), null) // bad window
  assert.ok(parseCallback({ date: '2026-10-21', window: 'morning', repId: 'james', now: NOW }))
})

test('windows are local time in the rep territory, across daylight saving', () => {
  const ny = parseCallback({ date: '2026-10-21', window: 'morning', repId: 'james', now: NOW })
  assert.strictEqual(ny.start.toISOString(), '2026-10-21T12:00:00.000Z') // 8 am EDT
  assert.strictEqual(ny.end.toISOString(), '2026-10-21T15:00:00.000Z') // 11 am EDT
  const la = parseCallback({ date: '2026-10-21', window: 'afternoon', repId: 'william', now: NOW })
  assert.strictEqual(la.start.toISOString(), '2026-10-21T21:00:00.000Z') // 2 pm PDT
  const afterDst = parseCallback({ date: '2026-11-02', window: 'morning', repId: 'james', now: NOW })
  assert.strictEqual(afterDst.start.toISOString(), '2026-11-02T13:00:00.000Z') // 8 am EST
  assert.strictEqual(describeCallback(ny), 'Wednesday, October 21, in the morning (8 to 11 am ET)')
})

test('calendar invite is a valid single event with a reminder', () => {
  const cb = parseCallback({ date: '2026-10-21', window: 'morning', repId: 'james', now: NOW })
  const ics = icsEvent({ uid: 'x@aim', start: cb.start, end: cb.end, summary: 'Call Dr A, Smile Co; NYC', description: 'Line one\nLine two', location: '555' }).toString()
  assert.ok(ics.startsWith('BEGIN:VCALENDAR\r\n'))
  assert.ok(ics.includes('DTSTART:20261021T120000Z'))
  assert.ok(ics.includes('SUMMARY:Call Dr A\\, Smile Co\\; NYC'))
  assert.ok(ics.includes('DESCRIPTION:Line one\\nLine two'))
  assert.ok(ics.includes('TRIGGER:-PT15M'))
  assert.ok(ics.split('\r\n').every((line) => Buffer.byteLength(line) <= 75))
})

test('report email states the booked call-back and offers a call, not a booking link', () => {
  const cost = remakeCost({ unitsPerMonth: 40, remakesPerMonth: 3, minutesPerRemake: 45, chairHourValue: 700, labFeePerRemake: 0 })
  const html = reportEmail({
    practice: 'Test Dental',
    cost,
    report: templateReport({ cost, pains: [] }),
    contact: { name: 'James Delaney', firstName: 'James', region: 'New York City metro', email: 'james@aimdentallab.com', phone: '347-863-9787', phoneTel: '+13478639787' },
    callback: 'Wednesday, October 21, in the morning (8 to 11 am ET)',
  })
  assert.ok(html.includes('Wednesday, October 21, in the morning (8 to 11 am ET)'))
  assert.ok(html.includes('href="tel:+13478639787"'))
  assert.ok(!html.includes('book-a-call'))
})

test('rep notification leads with the booked call-back, or says to call next business day', () => {
  const { leadNotificationEmail } = require('../src/services/growthAudit/email')
  const cost = remakeCost({ unitsPerMonth: 40, remakesPerMonth: 3, minutesPerRemake: 45, chairHourValue: 700, labFeePerRemake: 0 })
  const lead = { name: 'Test', practice: 'Test Dental', email: 't@example.com', phone: '555', address: '', pains: [], interest: '', message: '', attribution: '' }
  const base = { leadId: 1, lead, cost, contact: { name: 'James Delaney' }, routing: 'named by the practice', reportSource: 'template' }
  const booked = leadNotificationEmail({ ...base, callbackText: 'Wednesday, October 21, in the morning (8 to 11 am ET)', callbackBooked: true })
  assert.ok(booked.indexOf('Call-back booked') < booked.indexOf('Call back:'))
  const none = leadNotificationEmail({ ...base, callbackText: 'not booked', callbackBooked: false })
  assert.ok(none.includes('the next business day'))
  assert.ok(!none.includes('attached calendar invite'))
})

test('security: impossible dates and prototype keys are rejected, never thrown', () => {
  for (const date of ['2026-10-99', '2026-02-30', '2026-13-01', '0000-00-00']) {
    assert.strictEqual(parseCallback({ date, window: 'morning', repId: 'james', now: NOW }), null, date)
  }
  for (const window of ['__proto__', 'toString', 'constructor', 'hasOwnProperty']) {
    assert.strictEqual(parseCallback({ date: '2026-10-21', window, repId: 'james', now: NOW }), null, window)
  }
})

test('security: control characters cannot break the invite structure', () => {
  const cb = parseCallback({ date: '2026-10-21', window: 'morning', repId: 'james', now: NOW })
  const ics = icsEvent({
    uid: 'x@aim\r\nATTENDEE:evil@example.com',
    start: cb.start,
    end: cb.end,
    summary: 'Dr A\rBEGIN:VEVENT\u0000\u000b',
    description: 'one\r\ntwo\rthree',
    location: '555',
  }).toString()
  const lines = ics.split('\r\n')
  assert.strictEqual(lines.filter((l) => l === 'BEGIN:VEVENT').length, 1)
  assert.ok(!lines.some((l) => l.startsWith('ATTENDEE')))
  assert.ok(!/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/.test(ics))
  assert.ok(ics.includes('DESCRIPTION:one\\ntwo\\nthree'))
})

const { buildReport, analyze, PROBLEMS } = require('../src/services/growthAudit/report')

test('rule-based report: rate bands drive the summary', () => {
  const mk = (remakes) => buildReport({ cost: remakeCost({ unitsPerMonth: 100, remakesPerMonth: remakes, minutesPerRemake: 45, chairHourValue: 600, labFeePerRemake: 0 }) })
  assert.match(mk(0).summary, /no remakes/)
  assert.match(mk(2).summary, /well below the 3\.8%/)
  assert.match(mk(3).summary, /close to the 3\.8%/)
  assert.match(mk(5).summary, /above the 3\.8%.*14 fewer remakes a year/)
  assert.match(mk(8).summary, /well above the 3\.8%.*pattern/)
})

test('rule-based report: benchmark gap, levers ranked by value, priority', () => {
  // 40 units, 3 remakes, 45 min at $700, $90 fee: 36 remakes, 18.24 at benchmark.
  const cost = remakeCost({ unitsPerMonth: 40, remakesPerMonth: 3, minutesPerRemake: 45, chairHourValue: 700, labFeePerRemake: 90 })
  const a = analyze(cost)
  assert.strictEqual(a.excessRemakes, 18)
  assert.strictEqual(a.benchmarkGap, 18 * cost.perRemake)
  assert.deepStrictEqual(a.levers.map((l) => l.id), ['benchmark', 'fees'])
  assert.strictEqual(a.priority, 'High')
  const r = buildReport({ cost, firstName: 'James', callback: 'Wednesday, October 21, in the morning (8 to 11 am ET)' })
  assert.match(r.headline, /\$14,310 a year of your remake cost is recoverable/)
  assert.strictEqual(r.sections[1].title, 'Your biggest savings, ranked')
  assert.match(r.sections[1].bullets[0], /^1\. .*18 fewer remakes/)
  assert.match(r.cta.title, /Your call with James is booked/)
  assert.match(r.cta.body, /on Wednesday, October 21.*no obligation/)
})

test('rule-based report: at-benchmark practices get the quarter-cut lever, not a gap', () => {
  const cost = remakeCost({ unitsPerMonth: 100, remakesPerMonth: 3, minutesPerRemake: 45, chairHourValue: 600, labFeePerRemake: 0 })
  const a = analyze(cost)
  assert.strictEqual(a.benchmarkGap, 0)
  assert.deepStrictEqual(a.levers.map((l) => l.id), ['quarter'])
  assert.strictEqual(a.priority, 'Moderate')
  const none = analyze(remakeCost({ unitsPerMonth: 100, remakesPerMonth: 0, minutesPerRemake: 45, chairHourValue: 600 }))
  assert.strictEqual(none.priority, 'Low')
  assert.strictEqual(buildReport({ cost: remakeCost({ unitsPerMonth: 100, remakesPerMonth: 0, minutesPerRemake: 45, chairHourValue: 600 }) }).sections.length, 3)
})

test('rule-based report: picked problems drive causes, fixes and AIM help', () => {
  const cost = remakeCost({ unitsPerMonth: 40, remakesPerMonth: 3, minutesPerRemake: 45, chairHourValue: 700, labFeePerRemake: 90 })
  const r = buildReport({ cost, pains: ['Shade', 'Digital scan issues'], interest: 'Implant cases' })
  const causes = r.sections.find((s) => s.title.startsWith('Where')).bullets.join(' ')
  assert.ok(causes.includes(PROBLEMS.Shade.cause) && causes.includes(PROBLEMS['Digital scan issues'].fix))
  assert.match(causes, /Start with digital scan issues/)
  const help = r.sections.find((s) => s.title.startsWith('How AIM')).bullets.join(' ')
  assert.ok(help.includes(PROBLEMS.Shade.aim) && help.includes('$3,240 a year in remake fees'))
  assert.match(r.next_steps[0], /16 major implant systems/)
  assert.ok(r.next_steps.length <= 3)
})

test('rule-based report: unmatched rep reads naturally', () => {
  const cost = remakeCost({ unitsPerMonth: 40, remakesPerMonth: 3, minutesPerRemake: 45, chairHourValue: 700 })
  const r = buildReport({ cost, firstName: 'the AIM team' })
  assert.match(r.cta.title, /^Our team will call you/)
  assert.ok(!/[a-z,] Our team/.test([r.cta.body, ...r.next_steps].join(' ')))
})

test('rule-based report: same answers give the same report, with no em dashes', () => {
  const cost = remakeCost({ unitsPerMonth: 40, remakesPerMonth: 3, minutesPerRemake: 45, chairHourValue: 700, labFeePerRemake: 0 })
  const a = buildReport({ cost, pains: ['Margins or fit'], interest: 'Fewer remakes and adjustments' })
  const b = buildReport({ cost, pains: ['Margins or fit'], interest: 'Fewer remakes and adjustments' })
  assert.deepStrictEqual(a, b)
  const all = [a.headline, a.summary, ...Object.values(a.cta), ...a.sections.flatMap((s) => [s.title, ...s.bullets]), ...a.next_steps, ...Object.values(PROBLEMS).flatMap(Object.values)].join(' ')
  assert.ok(!/[—–]/.test(all))
})

test('printable report: print layout, no email-only wording, safe filename', () => {
  const { reportPdfFilename } = require('../src/services/growthAudit/pdf')
  const cost = remakeCost({ unitsPerMonth: 40, remakesPerMonth: 3, minutesPerRemake: 45, chairHourValue: 700, labFeePerRemake: 90 })
  const cb = 'Wednesday, October 21, in the morning (8 to 11 am ET)'
  const args = {
    practice: 'Smile Co Dental',
    cost,
    callback: cb,
    report: buildReport({ cost, pains: ['Shade'], firstName: 'James', callback: cb }),
    contact: { name: 'James Delaney', firstName: 'James', region: 'New York City metro', email: 'james@aimdentallab.com', phone: '347-863-9787', phoneTel: '+13478639787' },
  }
  const print = reportEmail({ ...args, print: true })
  assert.ok(print.includes('@page { size: Letter'))
  assert.ok(!print.includes('attached to this email') && !print.includes('Hello!'))
  assert.ok(print.includes('Call James: 347-863-9787'))
  assert.ok(!/[—–]/.test(print))
  assert.ok(reportEmail({ ...args, pdfAttached: true }).includes('printable PDF copy'))
  assert.ok(!reportEmail(args).includes('printable PDF copy'))
  assert.strictEqual(reportPdfFilename('Smile & Co. Dental <x>'), 'AIM-Growth-Audit-Smile-Co-Dental-x.pdf')
  assert.strictEqual(reportPdfFilename(''), 'AIM-Growth-Audit.pdf')
})
