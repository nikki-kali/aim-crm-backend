-- v21-company-daily-booked-migration.sql
-- Supports the Leadership Report's company-wide "Booked (MTD)" figure,
-- accumulated locally day-by-day (no company-wide MTD-booked report
-- exists from Evident — see
-- docs/superpowers/specs/2026-09-16-leadership-report-company-wide-totals-design.md).
--
-- Deliberately NULLABLE with NO DEFAULT — this is not an oversight. A
-- NULL value on this column is how buildReport.js's Billed (MTD) delta
-- guard tells "this row predates the company-wide data source" (genuinely
-- NULL, since the column didn't exist yet) apart from "this row is from
-- the new source and the real figure happened to be zero" (a real `0`,
-- never NULL). A NOT NULL DEFAULT 0 column could not make that
-- distinction, and would reintroduce the exact "phantom spike on the
-- transition day" bug this codebase already found and fixed once for
-- ytd_billed_value.

ALTER TABLE evident_report_log
  ADD COLUMN IF NOT EXISTS company_daily_booked_value numeric;
