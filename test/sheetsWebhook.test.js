// appendLogRow's Apps Script webhook mode, with fetch stubbed (no network).
const test = require('node:test')
const assert = require('node:assert')
const { appendLogRow } = require('../src/services/sheets')

test('appendLogRow posts the row and secret to the sheet webhook', async () => {
  const calls = []
  const realFetch = global.fetch
  global.fetch = async (url, opts) => { calls.push({ url, body: JSON.parse(opts.body) }); return { ok: true, status: 200, text: async () => '{"ok":true}' } }
  try {
    const ok = await appendLogRow({ webhookUrl: 'https://script.example/exec', webhookSecret: 's3', header: ['A'], row: ['1'] })
    assert.strictEqual(ok, true)
    assert.deepStrictEqual(calls[0].body, { secret: 's3', tab: 'Sheet1', header: ['A'], row: ['1'] })
  } finally { global.fetch = realFetch }
})

test('appendLogRow reports a rejected webhook and skips when no secret is set', async () => {
  const realFetch = global.fetch
  global.fetch = async () => ({ ok: true, status: 200, text: async () => '{"ok":false,"message":"unauthorized"}' })
  try {
    await assert.rejects(appendLogRow({ webhookUrl: 'https://script.example/exec', webhookSecret: 'bad', header: [], row: [] }))
    assert.strictEqual(await appendLogRow({ webhookUrl: 'https://script.example/exec', header: [], row: [] }), false)
  } finally { global.fetch = realFetch }
})
