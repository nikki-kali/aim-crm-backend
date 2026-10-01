require('dotenv').config()
const test = require('node:test')
const assert = require('node:assert/strict')
const { matchRepByState } = require('../../src/services/repTerritories')

test('matchRepByState finds James for NY', async () => {
  const rep = await matchRepByState('NY')
  assert.equal(rep.email, 'james@aimdentallab.com')
})

test('matchRepByState finds William for CA', async () => {
  const rep = await matchRepByState('CA')
  assert.equal(rep.email, 'williama@aimdentallab.com')
})

test('matchRepByState returns null for an unmatched state', async () => {
  const rep = await matchRepByState('TX')
  assert.equal(rep, null)
})

test('matchRepByState returns null for a falsy state', async () => {
  assert.equal(await matchRepByState(null), null)
  assert.equal(await matchRepByState(''), null)
})

test('matchRepByState is case-insensitive', async () => {
  const rep = await matchRepByState('ny')
  assert.equal(rep.email, 'james@aimdentallab.com')
})
