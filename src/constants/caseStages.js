// Single source of truth for case lifecycle stages — shared by routes/cases.js
// (staff-facing status changes + stage-change email notifications) and
// routes/trackCase.js (public case-status lookup), so the two can't drift.
const STAGES = [
  'Case Received', 'Awaiting Scan', 'Case Accepted',
  'In Production', 'Quality Control', 'Ready for Dispatch',
  'Dispatched', 'Completed',
]

module.exports = { STAGES }
