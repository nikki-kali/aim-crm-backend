const test = require('node:test')
const assert = require('node:assert')
const { validateComment } = require('../src/routes/contentApprovalDecisions')

test('validateComment accepts feedback and trims it', () => {
  const { data, error } = validateComment('nov05', { body: '  Remove the 24 hour rush.  ' })
  assert.strictEqual(error, undefined)
  assert.deepStrictEqual(data, { text: 'Remove the 24 hour rush.', parentId: null })
})

test('validateComment accepts a reply target', () => {
  assert.strictEqual(validateComment('nov05', { body: 'Fixed.', parentId: '12' }).data.parentId, 12)
})

test('validateComment rejects unknown posts, empty or oversized text, and bad reply targets', () => {
  assert.ok(validateComment('nope', { body: 'x' }).error)
  assert.ok(validateComment('nov05', { body: '   ' }).error)
  assert.ok(validateComment('nov05', { body: 'x'.repeat(4001) }).error)
  assert.ok(validateComment('nov05', { body: 'x', parentId: 'abc' }).error)
  assert.ok(validateComment('nov05', { body: 'x', parentId: -1 }).error)
})
