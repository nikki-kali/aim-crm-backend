-- Add a reviewer_id column so the audit trail can tie a decision back to
-- the verified logged-in user, not just the display name string.
alter table content_approval_decisions add column if not exists reviewer_id integer;
