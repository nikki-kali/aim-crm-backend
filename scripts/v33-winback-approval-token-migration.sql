-- v33-winback-approval-token-migration.sql
-- Adds the Dormant Accounts Re-engagement approval email (src/services/
-- winbackApproval) to the Approve & Send token flow. Existing rows unaffected.

ALTER TABLE report_approval_tokens DROP CONSTRAINT IF EXISTS report_approval_tokens_report_type_check;
ALTER TABLE report_approval_tokens ADD CONSTRAINT report_approval_tokens_report_type_check
  CHECK (report_type IN ('evident-report', 'sales-rep-daily-report', 'content-approval-request', 'content-approval-followup', 'content-approval-articles', 'winback-approval'));
