-- ================================================================
-- Aim Dental CRM — v6 Case Production Migration
-- Aligns the `cases` table with AIM's actual internal lab workflow:
-- sterilization -> Evident entry -> (Removables only) plaster check ->
-- delivery -> packing -> shipment to the outsourcing lab.
-- These are internal checkpoints, separate from the existing 8-stage
-- doctor-facing `status` pipeline — no doctor notifications are tied
-- to any of these columns.
-- Run in Supabase SQL Editor
-- ================================================================

-- ── Applies to every case ────────────────────────────────────────
ALTER TABLE cases
  ADD COLUMN IF NOT EXISTS product text,
  ADD COLUMN IF NOT EXISTS tooth_numbers text,
  ADD COLUMN IF NOT EXISTS quantity integer DEFAULT 1,
  ADD COLUMN IF NOT EXISTS shade text,
  ADD COLUMN IF NOT EXISTS special_instructions text,
  ADD COLUMN IF NOT EXISTS evident_case_number text,
  ADD COLUMN IF NOT EXISTS sterilized_by text,
  ADD COLUMN IF NOT EXISTS sterilized_at timestamptz,
  ADD COLUMN IF NOT EXISTS entered_by text,
  ADD COLUMN IF NOT EXISTS entered_at timestamptz;

-- ── Removable cases only (case_type IN ('Dentures','Partial')) ──
-- Plaster department -> delivery -> packing -> outsourcing shipment
ALTER TABLE cases
  ADD COLUMN IF NOT EXISTS plaster_checked_by text,
  ADD COLUMN IF NOT EXISTS plaster_checked_at timestamptz,
  ADD COLUMN IF NOT EXISTS delivered_by text,
  ADD COLUMN IF NOT EXISTS delivered_at timestamptz,
  ADD COLUMN IF NOT EXISTS packed_by text,
  ADD COLUMN IF NOT EXISTS packed_at timestamptz,
  ADD COLUMN IF NOT EXISTS outsourcing_return_date date,
  ADD COLUMN IF NOT EXISTS outsourcing_tracking_number text,
  ADD COLUMN IF NOT EXISTS shipped_to_outsourcing_at timestamptz;

CREATE INDEX IF NOT EXISTS idx_cases_ready_to_ship
  ON cases (case_type, packed_at, shipped_to_outsourcing_at);

-- ================================================================
-- Done! Cases table now tracks AIM's internal production workflow.
-- ================================================================
