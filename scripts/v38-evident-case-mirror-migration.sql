-- v38: the CRM's copy of every Evident case (user, 2026-11-25/28: the CRM
-- tracks every case, aligned with Evident, as a step toward replacing it).
-- Additive only: new nullable columns, nothing existing changes.
--
-- cases.status keeps the CRM's own stages (lib/cases.js STAGES); Evident's
-- own status is kept beside it so the tracker can show e.g. "Held".
ALTER TABLE cases ADD COLUMN IF NOT EXISTS evident_status text;           -- Input, New, Arrived, Held, Complete, Sent, Cancelled
ALTER TABLE cases ADD COLUMN IF NOT EXISTS evident_customer_code text;    -- e.g. A1116, KH2101
ALTER TABLE cases ADD COLUMN IF NOT EXISTS booked_on date;                -- First Booking
ALTER TABLE cases ADD COLUMN IF NOT EXISTS arrived_on date;               -- First Arrival
ALTER TABLE cases ADD COLUMN IF NOT EXISTS ship_date date;                -- Last (Shipping): planned dispatch while open, actual once sent
ALTER TABLE cases ADD COLUMN IF NOT EXISTS last_invoice_date date;        -- Last (Invoice), only when it has happened
ALTER TABLE cases ADD COLUMN IF NOT EXISTS evident_completed_at timestamp; -- latest Date Completed (Evident's clock)
ALTER TABLE cases ADD COLUMN IF NOT EXISTS evident_synced_at timestamptz; -- when the CRM last copied this case from Evident

ALTER TABLE clients ADD COLUMN IF NOT EXISTS evident_customer_code text;

CREATE INDEX IF NOT EXISTS idx_cases_evident_status ON cases (evident_status) WHERE evident_status IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_clients_evident_customer_code ON clients (evident_customer_code) WHERE evident_customer_code IS NOT NULL;
