-- v24-company-daily-booked-count-migration.sql
-- Supports the Leadership Report's "Booked (MTD)" case count (Ben
-- Silberstein's requirement, 2026-09-18) — self-accumulated locally
-- day-by-day from each day's real companyDailyBookedCount, the same
-- pattern company_daily_booked_value already uses (see
-- v21-company-daily-booked-migration.sql). No company-wide MTD-booked
-- CASE COUNT report exists from Evident: "MTD Booked Daily Update" gives
-- one row per customer, not per case, so it can't be used for this.
--
-- Deliberately NULLABLE with NO DEFAULT, same reasoning as
-- company_daily_booked_value: a NULL row predates this column existing
-- (genuinely unknown), never conflated with a real `0` case day.

ALTER TABLE evident_report_log
  ADD COLUMN IF NOT EXISTS company_daily_booked_count integer;
