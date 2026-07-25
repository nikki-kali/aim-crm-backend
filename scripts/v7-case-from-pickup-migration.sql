-- ================================================================
-- Aim Dental CRM — v7 Migration
-- Links a case back to the pickup lead it was auto-created from
-- (Schedule Pickup lead marked Received -> new case). Mirrors the
-- existing clients.original_lead_id pattern used for lead->client
-- conversion.
-- ================================================================

ALTER TABLE cases
  ADD COLUMN IF NOT EXISTS original_lead_id uuid;

CREATE INDEX IF NOT EXISTS idx_cases_original_lead ON cases(original_lead_id);

-- ================================================================
-- Done!
-- ================================================================
