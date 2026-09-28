const test = require('node:test')
const assert = require('node:assert/strict')
const { mondayOfWeekEastern } = require('../../src/services/salesRepDailyReport')

test('a Tuesday resolves to that week\'s Monday', () => {
  assert.equal(mondayOfWeekEastern('2026-09-15'), '2026-09-14')
})

test('Monday itself resolves to itself', () => {
  assert.equal(mondayOfWeekEastern('2026-09-14'), '2026-09-14')
})

test('a Sunday resolves to the Monday that started that week', () => {
  assert.equal(mondayOfWeekEastern('2026-09-20'), '2026-09-14')
})

test('monthWindow gives the calendar month a date falls in, with its label', () => {
  const { monthWindow, MONTHLY_SALES_TARGET } = require('../../src/services/salesRepDailyReport');
  assert.deepEqual(monthWindow('2026-09-25'), { start: '2026-09-01', end: '2026-09-30', monthName: 'September 2026' });
  assert.deepEqual(monthWindow('2026-02-10'), { start: '2026-02-01', end: '2026-02-28', monthName: 'February 2026' });
  assert.deepEqual(monthWindow('2028-02-29'), { start: '2028-02-01', end: '2028-02-29', monthName: 'February 2028' }); // leap year
  assert.deepEqual(monthWindow('2026-12-31'), { start: '2026-12-01', end: '2026-12-31', monthName: 'December 2026' });
  assert.equal(MONTHLY_SALES_TARGET, 30000);
});

test('businessDaysLeftInMonth counts weekdays after the given date through month end', () => {
  const { businessDaysLeftInMonth } = require('../../src/services/salesRepDailyReport');
  assert.equal(businessDaysLeftInMonth('2026-09-25'), 3); // Fri 25th: Mon 28, Tue 29, Wed 30
  assert.equal(businessDaysLeftInMonth('2026-09-30'), 0); // last day
  assert.equal(businessDaysLeftInMonth('2026-09-01'), 21); // Tue 1st: every weekday after it in September
});

test('each rep has their own monthly new-doctors target: James 16, William 12', () => {
  const { MONTHLY_NEW_DOCTOR_TARGETS } = require('../../src/services/salesRepDailyReport');
  assert.deepEqual(MONTHLY_NEW_DOCTOR_TARGETS, { 'james@aimdentallab.com': 16, 'williama@aimdentallab.com': 12 });
});
