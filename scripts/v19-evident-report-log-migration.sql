-- v19-evident-report-log-migration.sql
-- Day-over-day log for the Evident Consolidated Report (see
-- docs/superpowers/specs/2026-09-15-evident-consolidated-report-design.md).
-- Same column set as the standalone evident-report-project's Google Sheet
-- log, so buildReport.js's delta logic needed no changes when ported.

CREATE TABLE IF NOT EXISTS evident_report_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  date date NOT NULL UNIQUE,
  booked_daily_count integer NOT NULL DEFAULT 0,
  booked_daily_value numeric NOT NULL DEFAULT 0,
  booked_mtd_count integer NOT NULL DEFAULT 0,
  booked_mtd_billed numeric NOT NULL DEFAULT 0,
  booked_mtd_wip numeric NOT NULL DEFAULT 0,
  booked_mtd_value numeric NOT NULL DEFAULT 0,
  wip_cases integer NOT NULL DEFAULT 0,
  wip_value numeric NOT NULL DEFAULT 0,
  aim_wip_value numeric NOT NULL DEFAULT 0,
  kh_wip_value numeric NOT NULL DEFAULT 0,
  james_wip_value numeric NOT NULL DEFAULT 0,
  william_wip_value numeric NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);
