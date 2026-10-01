// Fixed, user-approved list (2026-10-01) shown as checkboxes on the public
// Office Visit request form and validated against here. Duplicated in
// Frontend/src/lib/officeVisitCategories.js rather than fetched from an
// API, matching this codebase's convention for small fixed lists (see
// salesRepDailyReport.js's MONTHLY_NEW_DOCTOR_TARGETS).
const OFFICE_VISIT_CATEGORIES = [
  'Crowns & Bridges',
  'Removable Partials & Dentures',
  'Digital Scanning & Models',
  'Whitening & Cosmetic',
  'Implant Restorations',
  'General / Not Sure Yet',
]

module.exports = { OFFICE_VISIT_CATEGORIES }
