-- v27-partner-meetings-migration.sql
-- Partner meeting requests: a partner proposes 3 times, Ben approves one (or
-- calls them first). Additive only: two new tables, nothing existing changes.
-- Apply by hand in the Supabase SQL editor, like the other scripts here.

CREATE TABLE IF NOT EXISTS partner_meeting_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  partner_name text NOT NULL,
  company text,
  email text NOT NULL,
  phone text,
  timezone text NOT NULL,
  slots jsonb NOT NULL,
  note text,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'call_first', 'approved')),
  confirmed_slot_index integer CHECK (confirmed_slot_index BETWEEN 0 AND 2),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_partner_meeting_requests_status ON partner_meeting_requests(status);

CREATE TABLE IF NOT EXISTS partner_meeting_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  token text UNIQUE NOT NULL,
  request_id uuid NOT NULL REFERENCES partner_meeting_requests(id) ON DELETE CASCADE,
  action text NOT NULL CHECK (action IN ('approve', 'call_first')),
  slot_index integer CHECK (slot_index BETWEEN 0 AND 2),
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_partner_meeting_tokens_token ON partner_meeting_tokens(token);
