-- ============================================================
-- v9 — Sales Rep role + per-user alert targeting
-- Run in Supabase SQL Editor (Dashboard → SQL Editor → New Query)
-- ============================================================

-- Add 'sales_rep' as a third valid role alongside 'admin' and 'staff'.
-- Drop whatever the existing check constraint on users.role happens to be
-- named (auto-generated, so don't assume "users_role_check") and replace it.
DO $$
DECLARE
  con text;
BEGIN
  SELECT pgc.conname INTO con
  FROM pg_constraint pgc
  JOIN pg_class rel ON rel.oid = pgc.conrelid
  WHERE rel.relname = 'users' AND pgc.contype = 'c' AND pg_get_constraintdef(pgc.oid) ILIKE '%role%';
  IF con IS NOT NULL THEN
    EXECUTE format('ALTER TABLE users DROP CONSTRAINT %I', con);
  END IF;
END $$;

ALTER TABLE users ADD CONSTRAINT users_role_check CHECK (role IN ('admin', 'staff', 'sales_rep'));

-- Alerts gain an optional owner. NULL = company-wide (the existing digest
-- behavior, visible to admins only going forward); a real user_id = an
-- individual notification visible only to that user. See
-- src/services/automations.js and src/services/workflowEngine.js for what
-- writes each kind.
ALTER TABLE alerts ADD COLUMN IF NOT EXISTS user_id UUID REFERENCES users(id) ON DELETE CASCADE;
CREATE INDEX IF NOT EXISTS idx_alerts_user_id ON alerts(user_id);
CREATE INDEX IF NOT EXISTS idx_alerts_type_user_read ON alerts(type, user_id, read);

-- ============================================================
-- Done!
-- ============================================================
