const test = require('node:test');
const assert = require('node:assert/strict');
const { isTestAccount } = require('../../src/services/evidentCrmSync');
const { parseAndAggregate } = require('../../src/services/evidentReport/parseEvident');

test('the EviSmart test account is recognized by its code or its name, and real doctors are not', () => {
  assert.equal(isTestAccount('AIM TEST', 'A10101'), true);
  assert.equal(isTestAccount('AIM TEST', undefined), true);
  assert.equal(isTestAccount('Aim  Test', ''), true); // spacing/case
  assert.equal(isTestAccount('Something else', 'a10101'), true); // by code
  assert.equal(isTestAccount('Dr. Brian Gold', 'A1164'), false);
  assert.equal(isTestAccount('AIM DENTAL SUPPLY', 'A2000'), false);
  assert.equal(isTestAccount('', ''), false);
  assert.equal(isTestAccount(undefined, undefined), false);
});
