-- v22-company-daily-billed-migration.sql
-- Supports the Leadership Report's company-wide "Booked (YTD)"/"Billed
-- (YTD)" figures, which now auto-accrue day-by-day on top of a manually
-- verified baseline (Evident has no automated company-wide YTD report —
-- only per-rep YTD Booked Cases — so the running total is baseline +
-- every real company-wide daily booked/billed figure logged since).
--
-- Deliberately NULLABLE with NO DEFAULT, same reasoning as
-- v21-company-daily-booked-migration.sql's company_daily_booked_value: a
-- NULL here means "this row predates company-wide daily billed tracking"
-- (excluded from accrual), distinct from a real `0` (a genuine zero-billed
-- day, included in accrual as zero). A NOT NULL DEFAULT 0 could not make
-- that distinction and would misattribute pre-tracking history as real
-- zero-billed days.

ALTER TABLE evident_report_log
  ADD COLUMN IF NOT EXISTS company_daily_billed_value numeric;
