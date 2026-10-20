-- v32-report-approval-sent-at-migration.sql
-- Approval links record when their report was actually sent. A click whose
-- send never finished (the server restarted mid-send, 20 Oct 2026) then
-- offers a fresh preview to the approver; it never re-sends. Existing used
-- links are marked sent so none of them offers one. Safe to re-run.

ALTER TABLE report_approval_tokens ADD COLUMN IF NOT EXISTS sent_at TIMESTAMPTZ;
UPDATE report_approval_tokens SET sent_at = used_at WHERE used_at IS NOT NULL AND sent_at IS NULL;
