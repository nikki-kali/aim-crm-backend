-- v37: trade-show offer redemptions (GNYDM 2026 scratch card).
-- One row per practice that registered to claim the show offer. The unique
-- indexes are the real once-per-practice guard: a second registration that
-- reuses the same email, phone, practice name or address for the same event
-- is rejected by the database itself, even if two arrive at the same moment.
-- Run once in the Supabase SQL editor before turning redemptions on.

CREATE TABLE IF NOT EXISTS event_redemptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_key text NOT NULL,
  prize text NOT NULL,
  doctor_name text NOT NULL,
  practice_name text NOT NULL,
  email text NOT NULL,
  phone text NOT NULL,
  street text NOT NULL,
  city text NOT NULL,
  state text NOT NULL,
  zip text NOT NULL,
  scanner text,
  case_interest text,
  marketing_consent boolean NOT NULL DEFAULT false,
  -- normalized copies used for the duplicate checks
  email_norm text NOT NULL,
  phone_norm text NOT NULL,
  practice_norm text NOT NULL,
  address_norm text NOT NULL,
  -- 'verified' = new practice, all checks passed
  -- 'needs_review' = matched an existing AIM client or clinic; the team decides
  status text NOT NULL CHECK (status IN ('verified', 'needs_review')),
  review_reason text,
  lead_id text,
  first_case_received_at timestamptz,
  attribution text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS event_redemptions_email_uq    ON event_redemptions (event_key, email_norm);
CREATE UNIQUE INDEX IF NOT EXISTS event_redemptions_phone_uq    ON event_redemptions (event_key, phone_norm);
CREATE UNIQUE INDEX IF NOT EXISTS event_redemptions_practice_uq ON event_redemptions (event_key, practice_norm);
CREATE UNIQUE INDEX IF NOT EXISTS event_redemptions_address_uq  ON event_redemptions (event_key, address_norm);
CREATE INDEX IF NOT EXISTS event_redemptions_event_created_idx  ON event_redemptions (event_key, created_at);
