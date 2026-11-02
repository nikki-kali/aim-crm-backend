const test = require('node:test')
const assert = require('node:assert')
const { buildPostInput } = require('../src/services/buffer')
const { planActions } = require('../src/jobs/bufferPublish')

const NOW = Date.parse('2026-11-04T00:00:00Z')
const entry = (over = {}) => ({ postId: 'nov05', platform: 'instagram', dueAt: '2026-11-05T17:30:00.000Z', text: 'Hi', images: ['https://marketing.aimdentallab.com/approvals/a.jpg'], ...over })
const row = (over = {}) => ({ id: 1, post_id: 'nov05', platform: 'instagram', due_at: '2026-11-05T17:30:00Z', buffer_post_id: 'b1', status: 'queued', ...over })

test('queues an approved post that is not in Buffer yet', () => {
  const plan = planActions({ entries: [entry()], approvedIds: new Set(['nov05']), rows: new Map(), now: NOW })
  assert.strictEqual(plan.create.length, 1)
  assert.strictEqual(plan.withdraw.length, 0)
})

test('skips posts that are unapproved, blocked, already queued, failed or about to go out', () => {
  const approved = new Set(['nov05'])
  assert.strictEqual(planActions({ entries: [entry()], approvedIds: new Set(), rows: new Map(), now: NOW }).create.length, 0)
  assert.strictEqual(planActions({ entries: [entry({ blocked: 'x' })], approvedIds: approved, rows: new Map(), now: NOW }).create.length, 0)
  assert.strictEqual(planActions({ entries: [entry()], approvedIds: approved, rows: new Map([['nov05|instagram', row()]]), now: NOW }).create.length, 0)
  assert.strictEqual(planActions({ entries: [entry()], approvedIds: approved, rows: new Map([['nov05|instagram', row({ status: 'error' })]]), now: NOW }).create.length, 0)
  const soon = Date.parse('2026-11-05T17:25:00Z')
  assert.strictEqual(planActions({ entries: [entry()], approvedIds: approved, rows: new Map(), now: soon }).create.length, 0)
  assert.strictEqual(planActions({ entries: [entry({ platform: 'facebook' })], approvedIds: approved, rows: new Map(), now: NOW }).create.length, 0)
})

test('ignores entries with unknown post ids or media from another site, and caps a run', () => {
  const approved = new Set(['nov05', 'evil'])
  assert.strictEqual(planActions({ entries: [entry({ postId: 'evil' })], approvedIds: approved, rows: new Map(), now: NOW }).create.length, 0)
  assert.strictEqual(planActions({ entries: [entry({ images: ['https://evil.example/a.jpg'] })], approvedIds: approved, rows: new Map(), now: NOW }).create.length, 0)
  assert.strictEqual(planActions({ entries: [entry({ images: ['https://marketing.aimdentallab.com/approvals/../x.jpg'] })], approvedIds: approved, rows: new Map(), now: NOW }).create.length, 0)
  const many = ['instagram', 'linkedin', 'youtube'].flatMap((platform) => ['nov04', 'nov05', 'nov06', 'nov07', 'nov09', 'nov10'].map((postId) => entry({ postId, platform })))
  const all = new Set(many.map((e) => e.postId))
  assert.strictEqual(planActions({ entries: many, approvedIds: all, rows: new Map(), now: NOW }).create.length, 15)
})

test('re-queues a withdrawn post once it is approved again', () => {
  const plan = planActions({ entries: [entry()], approvedIds: new Set(['nov05']), rows: new Map([['nov05|instagram', row({ status: 'withdrawn' })]]), now: NOW })
  assert.strictEqual(plan.create.length, 1)
})

test('withdraws a queued post whose approval was taken back, unless it is about to go out', () => {
  const rows = new Map([['nov05|instagram', row()]])
  assert.strictEqual(planActions({ entries: [entry()], approvedIds: new Set(), rows, now: NOW }).withdraw.length, 1)
  assert.strictEqual(planActions({ entries: [entry()], approvedIds: new Set(['nov05']), rows, now: NOW }).withdraw.length, 0)
  assert.strictEqual(planActions({ entries: [entry()], approvedIds: new Set(), rows, now: Date.parse('2026-11-05T17:28:00Z') }).withdraw.length, 0)
})

test('builds Buffer inputs for each media type', () => {
  const image = buildPostInput(entry({ altText: 'Alt' }))
  assert.strictEqual(image.mode, 'customScheduled')
  assert.strictEqual(image.assets[0].image.metadata.altText, 'Alt')
  assert.deepStrictEqual(image.metadata, { instagram: { type: 'post', shouldShareToFeed: true } })

  const carousel = buildPostInput(entry({ images: ['https://x/1.jpg', 'https://x/2.jpg'] }))
  assert.strictEqual(carousel.assets.length, 2)
  assert.strictEqual(carousel.metadata.instagram.type, 'post')

  const reel = buildPostInput(entry({ images: undefined, video: { url: 'https://x/v.mp4', thumbnailUrl: 'https://x/c.jpg' } }))
  assert.strictEqual(reel.metadata.instagram.type, 'reel')
  assert.deepStrictEqual(reel.assets[0].video, { url: 'https://x/v.mp4' })

  const pdf = buildPostInput(entry({ platform: 'linkedin', images: undefined, document: { url: 'https://x/d.pdf', title: 'T' } }))
  assert.strictEqual(pdf.assets[0].document.url, 'https://x/d.pdf')
  assert.strictEqual(pdf.metadata, undefined)

  const short = buildPostInput(entry({ platform: 'youtube', images: undefined, video: { url: 'https://x/v.mp4' }, title: 'Title' }))
  assert.strictEqual(short.metadata.youtube.title, 'Title')
  assert.strictEqual(short.metadata.youtube.categoryId, '27')
  assert.throws(() => buildPostInput(entry({ platform: 'youtube', images: undefined, video: { url: 'https://x/v.mp4' } })), /title/)
  assert.throws(() => buildPostInput(entry({ images: [] })), /no image/)
})
