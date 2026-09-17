const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeDoctorName, gmailDateBounds } = require('../src/services/evidentCrmSync');

test('normalizeDoctorName lowercases, strips periods/commas, and collapses whitespace', () => {
  assert.equal(normalizeDoctorName('DR BRIAN GOLD'), 'dr brian gold');
  assert.equal(normalizeDoctorName('Dr. Brian Gold'), 'dr brian gold');
  assert.equal(normalizeDoctorName('DR SUSHILA L. CHAHAL, DDS'), 'dr sushila l chahal dds');
  assert.equal(normalizeDoctorName('  Sunset   Terrace  '), 'sunset terrace');
});

test('normalizeDoctorName handles null/undefined without throwing', () => {
  assert.equal(normalizeDoctorName(null), '');
  assert.equal(normalizeDoctorName(undefined), '');
  assert.equal(normalizeDoctorName(''), '');
});

test('gmailDateBounds brackets the target date with one day of slack on each side', () => {
  assert.equal(gmailDateBounds('2026-09-15'), 'after:2026/09/14 before:2026/09/17');
  // Month/year boundaries, since date math bugs love these.
  assert.equal(gmailDateBounds('2026-01-01'), 'after:2025/12/31 before:2026/01/03');
  assert.equal(gmailDateBounds('2026-02-28'), 'after:2026/02/27 before:2026/03/02');
});
