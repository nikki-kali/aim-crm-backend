-- ================================================================
-- Aim Dental CRM — v15 Evident Sales Value Migration
-- Splits `cases.value` into billed vs. WIP so the sales-value KPIs
-- (rep dashboard card, weekly report email) can reflect Evident's own
-- Billed/WIP split when cases are imported from an Evident export.
-- `value` remains the total (billed + wip) for existing call sites
-- that only care about one number.
-- Run in Supabase SQL Editor
-- ================================================================

ALTER TABLE cases
  ADD COLUMN IF NOT EXISTS billed_value numeric DEFAULT 0,
  ADD COLUMN IF NOT EXISTS wip_value numeric DEFAULT 0;

-- Import upserts match existing cases by evident_case_number (Evident's
-- own "Ref") to stay idempotent across repeated weekly exports.
CREATE INDEX IF NOT EXISTS idx_cases_evident_case_number
  ON cases (evident_case_number) WHERE evident_case_number IS NOT NULL;

-- ================================================================
-- Done! cases.billed_value / cases.wip_value ready for Evident imports.
-- ================================================================
