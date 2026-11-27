-- v39: the daily Evident -> CRM case sync (user, 2026-11-28), built on the four
-- "- AIM CRM" Evident reports: Cases Booked Today (#120), Open Cases (#122),
-- Cases Sent Today (#121) and Invoices Today (#123). Additive only.

-- Every change of a case's Evident status, oldest first. The live tracker
-- shows it as a timeline and the doctor status emails are sent from it.
CREATE TABLE IF NOT EXISTS case_status_events (
  id bigserial PRIMARY KEY,
  case_id uuid NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
  evident_case_number text NOT NULL,
  from_status text,                 -- null for a case's first status
  to_status text NOT NULL,          -- Input, New, Arrived, Held, Complete, Sent, Cancelled, Closed
  status_date date NOT NULL,        -- the Evident business day the change was seen
  source text NOT NULL,             -- which report showed it (e.g. 'open-cases')
  created_at timestamptz NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_case_status_events_case ON case_status_events (case_id, created_at);

-- One row per case per invoice day, from Invoices Today (#123). Its daily
-- total equals report #118, so summing by invoice_date gives the month's
-- billing on the same basis as the KPI page. cases.billed_value is kept as
-- the sum of a case's billing (the 2026-11-25 history load, plus these rows).
CREATE TABLE IF NOT EXISTS evident_invoice_days (
  evident_case_number text NOT NULL,
  invoice_date date NOT NULL,
  amount numeric NOT NULL DEFAULT 0,
  customer_code text,
  updated_at timestamptz NOT NULL DEFAULT NOW(),
  PRIMARY KEY (evident_case_number, invoice_date)
);
CREATE INDEX IF NOT EXISTS idx_evident_invoice_days_date ON evident_invoice_days (invoice_date);
