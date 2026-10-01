-- v26-office-visit-bookings-migration.sql
-- Office Visit Bookings: two-way scheduling between sales reps and
-- dental practices. See docs/superpowers/specs/2026-10-01-office-visit-bookings-design.md.

CREATE TABLE rep_territories (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  rep_id uuid NOT NULL REFERENCES users(id),
  region_name text NOT NULL,
  state_codes text[] NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE office_visit_bookings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source text NOT NULL CHECK (source IN ('public_form', 'rep_scheduled')),
  practice_name text,
  contact_name text NOT NULL,
  contact_role text,
  address_line1 text,
  address_line2 text,
  city text,
  state text,
  zip text,
  email text,
  phone text NOT NULL,
  message text,
  service_interests text[],
  requested_date date,
  requested_time time,
  confirmed_date date,
  confirmed_time time,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'time_suggested', 'declined')),
  assigned_rep_id uuid REFERENCES users(id),
  rep_notes text,
  brand text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_office_visit_bookings_status ON office_visit_bookings(status);
CREATE INDEX idx_office_visit_bookings_assigned_rep ON office_visit_bookings(assigned_rep_id);

CREATE TABLE office_visit_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  token text UNIQUE NOT NULL,
  booking_id uuid NOT NULL REFERENCES office_visit_bookings(id),
  action text NOT NULL CHECK (action IN ('approve', 'suggest_time')),
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_office_visit_tokens_token ON office_visit_tokens(token);

-- Real territory seed (user-confirmed, 2026-10-01): James covers NYC
-- (New York), William covers the West Coast (California).
INSERT INTO rep_territories (rep_id, region_name, state_codes)
SELECT id, 'NYC', ARRAY['NY'] FROM users WHERE email = 'james@aimdentallab.com';

INSERT INTO rep_territories (rep_id, region_name, state_codes)
SELECT id, 'West Coast', ARRAY['CA'] FROM users WHERE email = 'williama@aimdentallab.com';
