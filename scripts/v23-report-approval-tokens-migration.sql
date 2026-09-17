-- v23-report-approval-tokens-migration.sql
-- Backs the "Approve & Send" button embedded in preview emails (see
-- src/services/reportApproval.js) — clicking it hits a public,
-- unauthenticated GET route (the only kind an email client can trigger),
-- so a real random unguessable token stands in for auth. Single-use
-- (used_at) and time-limited (expires_at, 24h) so a stale or forwarded
-- link can't fire a duplicate or long-delayed real send.

CREATE TABLE IF NOT EXISTS report_approval_tokens (
  token text PRIMARY KEY,
  report_type text NOT NULL CHECK (report_type IN ('evident-report', 'sales-rep-daily-report')),
  rep_id uuid REFERENCES users(id),
  report_date date NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  used_at timestamptz
);
