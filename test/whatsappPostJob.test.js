const test = require('node:test')
const assert = require('node:assert/strict')
const { runWhatsappPost, WHATSAPP_POST_RECIPIENT } = require('../src/jobs/whatsappPost')

const POST = {
  dateStr: '2026-10-08',
  caption: '*Good morning, team!*\n\n*James*\nSales: $234 of $50,000 (0%)\nNew doctors: 1 of 18 (6%)\nNew: Dr. Idelle Brand\n\n"Every no is one step closer to a yes."',
}
const make = (over = {}) => {
  const calls = { render: [], send: [], alert: [] }
  const deps = {
    dateStr: '2026-10-08',
    hasEviSmart: async () => true,
    buildPost: async () => POST,
    buildImageHtml: (post, msg) => `<html>${msg}</html>`,
    pickMessage: () => 'Consistency beats perfection every time.',
    render: async (html) => { calls.render.push(html); return Buffer.from('PNGDATA') },
    send: async (m) => { calls.send.push(m) },
    alertApprover: async (reason) => { calls.alert.push(reason) },
    final: false,
    ...over,
  }
  return { deps, calls }
}

test('the recipient is nadinekate.d.limjoco@gmail.com (standing rule, 2026-10-02)', () => {
  assert.equal(WHATSAPP_POST_RECIPIENT, 'nadinekate.d.limjoco@gmail.com')
})

test('EviSmart not here yet on an early attempt: nothing is built or sent, and no alert (a later attempt will try again)', async () => {
  const { deps, calls } = make({ hasEviSmart: async () => false })
  assert.equal(await runWhatsappPost(deps), 'waiting-for-evismart')
  assert.deepEqual([calls.render.length, calls.send.length, calls.alert.length], [0, 0, 0])
})

test('EviSmart still missing on the final attempt: nothing is sent and the approver is told', async () => {
  const { deps, calls } = make({ hasEviSmart: async () => false, final: true })
  assert.equal(await runWhatsappPost(deps), 'held')
  assert.equal(calls.send.length, 0)
  assert.equal(calls.alert.length, 1)
  assert.match(calls.alert[0], /EviSmart/)
})

test('a good day: renders the picture and emails it, with the caption, only to the standing recipient', async () => {
  const { deps, calls } = make()
  assert.equal(await runWhatsappPost(deps), 'sent')
  assert.equal(calls.render.length, 1)
  assert.match(calls.render[0], /Consistency beats perfection/)
  assert.equal(calls.send.length, 1)
  const m = calls.send[0]
  assert.deepEqual(m.to, ['nadinekate.d.limjoco@gmail.com'])
  assert.match(m.subject, /2026-10-08/)
  assert.match(m.html, /New: Dr\. Idelle Brand/)
  assert.equal(m.attachments[0].filename, 'sales-rep-progress-2026-10-08.png')
  assert.equal(m.attachments[0].contentType, 'image/png')
  assert.equal(m.attachments[0].content.toString(), 'PNGDATA')
  assert.equal(calls.alert.length, 0)
})

test('the caption is escaped in the email body', async () => {
  const { deps, calls } = make({ buildPost: async () => ({ ...POST, caption: 'Dr. <b>X</b> & Co' }) })
  await runWhatsappPost(deps)
  assert.doesNotMatch(calls.send[0].html, /<b>X<\/b>/)
  assert.match(calls.send[0].html, /&lt;b&gt;X&lt;\/b&gt; &amp; Co/)
})

test('a caption with missing numbers (a dash, undefined, NaN) is never sent; the approver is alerted', async () => {
  for (const bad of ['Sales: — of $50,000', 'Sales: undefined of 1', 'Sales: NaN of 1']) {
    const { deps, calls } = make({ buildPost: async () => ({ ...POST, caption: bad }) })
    assert.equal(await runWhatsappPost(deps), 'failed')
    assert.equal(calls.send.length, 0)
    assert.equal(calls.alert.length, 1)
  }
})

test('a dash inside the quoted motivational line is fine (it is not a number)', async () => {
  const { deps, calls } = make({ buildPost: async () => ({ ...POST, caption: 'Sales: $5 of $10\n\n"Plan — then act."' }) })
  assert.equal(await runWhatsappPost(deps), 'sent')
  assert.equal(calls.send.length, 1)
})

test('a render failure sends nothing and alerts the approver', async () => {
  const { deps, calls } = make({ render: async () => { throw new Error('chrome did not start') } })
  assert.equal(await runWhatsappPost(deps), 'failed')
  assert.equal(calls.send.length, 0)
  assert.match(calls.alert[0], /chrome did not start/)
})

test('no post data at all (no reps) sends nothing and alerts', async () => {
  const { deps, calls } = make({ buildPost: async () => null })
  assert.equal(await runWhatsappPost(deps), 'failed')
  assert.equal(calls.send.length, 0)
  assert.equal(calls.alert.length, 1)
})
