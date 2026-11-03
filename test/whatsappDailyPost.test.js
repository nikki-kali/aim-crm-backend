require('dotenv').config()
const test = require('node:test')
const assert = require('node:assert/strict')
const db = require('../src/config/db')
// Sales figures come from Evident's MTD billed email; tests have no Gmail
// access, so stub that one lookup BEFORE whatsappDailyPost reads it.
const salesRepDailyReport = require('../src/services/salesRepDailyReport')
let mtdStub = async () => 1000
salesRepDailyReport.evidentMtdForRep = (...args) => mtdStub(...args)
// New doctors come from Evident's "New Doctors" emails; no Gmail in tests either.
let namesStub = async () => null
salesRepDailyReport.eviSmartNewDoctorsForRep = async (...args) => {
  const names = await namesStub(...args)
  return names && names.map((name) => ({ name, firstCaseIso: '2026-10-01' }))
}
const { buildWhatsappDailyPost, buildWhatsappImageHtml, pickDailyMessage, buildCaption, isOnPace, newDoctorsSinceLastPost } = require('../src/services/whatsappDailyPost')

test('the image and caption have no "acquired this week" section either', async () => {
  const post = await buildWhatsappDailyPost('2026-10-02', 2)
  assert.ok(post.reps.every((r) => r.doctorsThisWeek === undefined))
  assert.doesNotMatch(post.caption, /This week:/)
  const html = buildWhatsappImageHtml(post, 'msg')
  assert.doesNotMatch(html, /Acquired this week/i)
})

test('the image has no last-month section, and no last-month figures are fetched', async () => {
  const calls = []
  mtdStub = async (email, dateStr, kind) => { calls.push(dateStr); return 100 }
  try {
    const post = await buildWhatsappDailyPost('2026-10-02', 2)
    assert.ok(post.reps.every((r) => r.lastMonth === undefined))
    assert.deepEqual([...new Set(calls)], ['2026-10-02'], 'only this month\'s figure is requested')
    const html = buildWhatsappImageHtml(post, 'msg')
    assert.doesNotMatch(html, /Last month/i)
    assert.match(html, /This month/)
  } finally {
    mtdStub = async () => 1000
  }
})

test('pickDailyMessage returns a start-of-month themed message for the first 5 days of the month', () => {
  const msg = pickDailyMessage(2)
  assert.equal(typeof msg, 'string')
  assert.ok(msg.length > 0)
})

test('pickDailyMessage returns the normal rotating quote after the first 5 days of the month', () => {
  const { PUSH_QUOTES } = require('../src/services/email')
  const msg = pickDailyMessage(20)
  assert.ok(PUSH_QUOTES.includes(msg))
})

test('monthly sales come from Evident MTD billed (sales = billed), not the CRM case sum', async () => {
  mtdStub = async (email, dateStr, kind) => (kind === 'billed' && email === 'williama@aimdentallab.com' && dateStr === '2026-10-01' ? 569.96 : 0)
  try {
    const post = await buildWhatsappDailyPost('2026-10-01', 2)
    const william = post.reps.find((r) => r.firstName === 'William')
    assert.equal(william.salesCur, 569.96)
    assert.doesNotMatch(post.caption, /\$/, 'the caption carries no figures')
  } finally {
    mtdStub = async () => 1000
  }
})

test('when the Evident MTD billed email is unavailable, sales show "—" instead of a made-up number', async () => {
  mtdStub = async () => null
  try {
    const post = await buildWhatsappDailyPost('2026-10-01', 2)
    assert.ok(post.reps.every((r) => r.salesCur === null))
    assert.equal(post.team.salesCur, null)
    const html = buildWhatsappImageHtml(post, 'msg')
    assert.match(html, />—</)
    assert.doesNotMatch(html, /NaN/)
  } finally {
    mtdStub = async () => 1000
  }
})

test('each rep shows month-to-date BOOKED and BILLED (both from Evident) on the image, not in the caption', async () => {
  mtdStub = async (email, dateStr, kind) => {
    const william = email === 'williama@aimdentallab.com'
    if (kind === 'billed') return william ? 569.96 : 0
    return william ? 532.49 : 261
  }
  try {
    const post = await buildWhatsappDailyPost('2026-10-05', 6)
    const william = post.reps.find((r) => r.firstName === 'William')
    const james = post.reps.find((r) => r.firstName === 'James')
    assert.equal(william.salesCur, 569.96, 'billed still drives the Monthly sales bar')
    assert.equal(william.bookedCur, 532.49)
    assert.equal(james.bookedCur, 261)
    assert.equal(post.team.bookedCur, 793.49)
    assert.doesNotMatch(post.caption, /\$|Booked|Billed/)
    const text = buildWhatsappImageHtml(post, 'msg').replace(/<style[\s\S]*?<\/style>/gi, '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ')
    assert.match(text, /William Alexander|William/)
    assert.match(text, /Booked \$532 Billed \$570/)
    assert.match(text, /Booked \$261 Billed \$0/)
  } finally {
    mtdStub = async () => 1000
  }
})

test('a booked figure Evident did not provide shows a dash, not a made-up number, and does not break the billed figure', async () => {
  mtdStub = async (email, dateStr, kind) => (kind === 'booked' ? null : 100)
  try {
    const post = await buildWhatsappDailyPost('2026-10-05', 6)
    assert.ok(post.reps.every((r) => r.bookedCur === null && r.salesCur === 100))
    assert.equal(post.team.bookedCur, null)
    const html = buildWhatsappImageHtml(post, 'msg')
    assert.doesNotMatch(html, /NaN|undefined/)
  } finally {
    mtdStub = async () => 1000
  }
})

test('the new doctor or practice names appear under each rep on the image', async () => {
  namesStub = async (email) => (email === 'james@aimdentallab.com' ? ['Dr. Idelle Brand', 'Domino Dental'] : [])
  try {
    const post = await buildWhatsappDailyPost('2026-10-08', 9)
    const james = post.reps.find((r) => r.firstName === 'James')
    assert.deepEqual(james.newDoctorNames, ['Dr. Idelle Brand', 'Domino Dental'])
    const william = post.reps.find((r) => r.firstName === 'William')
    assert.deepEqual(william.newDoctorNames, [])
    const text = buildWhatsappImageHtml(post, 'msg').replace(/<style[\s\S]*?<\/style>/gi, '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ')
    assert.match(text, /Dr\. Idelle Brand/)
    assert.match(text, /Domino Dental/)
  } finally {
    namesStub = async () => null
  }
})

test('names are escaped on the image, and an unavailable names lookup shows nothing and breaks nothing', async () => {
  namesStub = async () => ['<b>Evil</b> & Co']
  try {
    const post = await buildWhatsappDailyPost('2026-10-08', 9)
    const html = buildWhatsappImageHtml(post, 'msg')
    assert.doesNotMatch(html, /<b>Evil<\/b>/)
    assert.match(html, /&lt;b&gt;Evil&lt;\/b&gt; &amp; Co/)
  } finally {
    namesStub = async () => null
  }
  const post2 = await buildWhatsappDailyPost('2026-10-08', 9)
  assert.ok(post2.reps.every((r) => Array.isArray(r.newDoctorNames) && r.newDoctorNames.length === 0))
  assert.doesNotMatch(buildWhatsappImageHtml(post2, 'msg'), /undefined|NaN/)
})

// The caption: no figures, just the greeting, congratulations, good work and
// one neutral nudge (user request, 2026-11-03). Pure, so no DB or Gmail.
const rep = (over) => ({ firstName: 'Rep', salesCur: 0, salesTarget: 20000, signedSinceLastPost: [], ...over })

test('caption: greets the team and carries no numbers', () => {
  const c = buildCaption({ reps: [rep({ firstName: 'James', salesCur: 1234.56 })], dateStr: '2026-11-16', monthName: 'November' })
  assert.match(c, /^\*Good morning, team!\*/)
  assert.doesNotMatch(c, /\d/)
})

test('caption: congratulates a rep by name for each doctor signed since the last post', () => {
  const c = buildCaption({ reps: [rep({ firstName: 'William', signedSinceLastPost: ['A.R Assadian', 'Leslie Lopez'] }), rep({ firstName: 'James' })], dateStr: '2026-11-16', monthName: 'November' })
  assert.match(c, /Congratulations, William, on bringing in A\.R Assadian and Leslie Lopez!/)
  assert.doesNotMatch(c, /Congratulations, James/)
})

test('caption: "great work" only for a rep on pace for the monthly sales goal', () => {
  // 16 Nov 2026 is the 11th of 21 weekdays: even pace is 52%, on track from 47%.
  const c = buildCaption({ reps: [rep({ firstName: 'William', salesCur: 10000 }), rep({ firstName: 'James', salesCur: 2000 })], dateStr: '2026-11-16', monthName: 'November' })
  assert.match(c, /Great work, William: you're on track for your November sales goal/)
  assert.doesNotMatch(c, /Great work, James/)
})

test('caption: one neutral team-wide line when anyone is behind, naming no one', () => {
  const c = buildCaption({ reps: [rep({ firstName: 'William', salesCur: 10000 }), rep({ firstName: 'James', salesCur: 0 })], dateStr: '2026-11-16', monthName: 'November' })
  const neutral = c.split('\n').filter((l) => /slower than we'd like/.test(l))
  assert.equal(neutral.length, 1)
  assert.doesNotMatch(neutral[0], /James|William/)
})

test('caption: everyone on pace gets a momentum line instead of the neutral one', () => {
  const c = buildCaption({ reps: [rep({ firstName: 'William', salesCur: 15000 })], dateStr: '2026-11-16', monthName: 'November' })
  assert.doesNotMatch(c, /slower/)
  assert.match(c, /keep the momentum going/)
})

test('pace: an unavailable figure is never "on track"', () => {
  assert.equal(isOnPace(rep({ salesCur: null }), '2026-11-16'), false)
  assert.equal(isOnPace(rep({ salesCur: 1e9, salesTarget: 0 }), '2026-11-16'), false)
})

test('new since last post: the report day, plus a weekend before a Monday, but not the Friday before', () => {
  const list = [
    { name: 'Fri', firstCaseIso: '2026-10-30' },
    { name: 'Sat', firstCaseIso: '2026-10-31' },
    { name: 'Mon', firstCaseIso: '2026-11-02' },
  ]
  assert.deepEqual(newDoctorsSinceLastPost(list, '2026-11-02').map((d) => d.name), ['Sat', 'Mon'])
  assert.deepEqual(newDoctorsSinceLastPost(list, '2026-10-30').map((d) => d.name), ['Fri'])
  assert.deepEqual(newDoctorsSinceLastPost(null, '2026-11-02'), [])
})
