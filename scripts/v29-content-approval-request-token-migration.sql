-- v29-content-approval-request-token-migration.sql
-- Lets the "Approve & Send" token flow (src/services/reportApproval.js) back
-- the content approval request email too (src/services/contentApproval/
-- requestEmail.js): preview to the media inbox, one confirmed click sends it
-- to leadership. Widens the report_type check; existing rows are unaffected.

ALTER TABLE report_approval_tokens DROP CONSTRAINT IF EXISTS report_approval_tokens_report_type_check;
ALTER TABLE report_approval_tokens ADD CONSTRAINT report_approval_tokens_report_type_check
  CHECK (report_type IN ('evident-report', 'sales-rep-daily-report', 'content-approval-request'));
