-- v28-partner-meetings-availability-migration.sql
-- Partners can now describe their availability in free text instead of giving
-- 3 exact times, and Ben can pick a time himself. Additive: one new column and
-- one widened CHECK. Apply by hand in the Supabase SQL editor.

ALTER TABLE partner_meeting_requests ADD COLUMN IF NOT EXISTS availability text;

ALTER TABLE partner_meeting_tokens DROP CONSTRAINT IF EXISTS partner_meeting_tokens_action_check;
ALTER TABLE partner_meeting_tokens ADD CONSTRAINT partner_meeting_tokens_action_check
  CHECK (action IN ('approve', 'call_first', 'set_time'));
